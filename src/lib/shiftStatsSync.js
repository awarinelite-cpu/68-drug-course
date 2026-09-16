import { doc, runTransaction, serverTimestamp, collection, getDocs } from "firebase/firestore";
import { db } from "../firebase.js";
import { WARDS, reportDateId, defaultWardDoc, DEMOGRAPHIC_SEXES } from "./nurses-report-common.js";
import { reportWardKeysForPatientWard, patientWardAndBedTypeForReportKey } from "./wardNameMatch.js";
import { wardHeadcount } from "./wardCensus.js";

// Best-effort live headcount for a report ward key, used only to seed a
// brand-new day's doc (see bumpShiftStat below) with the real starting
// occupancy instead of a bare zero. Mirrors the same lookup WardNurse.jsx
// does for its own Previous-Occ auto-fill. Read outside any transaction,
// same as that page does — a plain collection read isn't something a
// Firestore transaction can do, and it doesn't need to be transactional:
// worst case it's a shift stale by the couple of patient events that
// might land in the same instant, far better than defaulting to 0.
async function liveHeadcountForWardKey(wardKey) {
  const patientWardInfo = patientWardAndBedTypeForReportKey(wardKey);
  if (!patientWardInfo) return null;
  try {
    const patientsSnap = await getDocs(collection(db, 'patients'));
    const patients = [];
    patientsSnap.forEach(d => patients.push(d.data()));
    return wardHeadcount(patients, patientWardInfo.wardLabel, patientWardInfo.bedType);
  } catch (e) {
    return null;
  }
}

// Ward-local (WAT, UTC+1) hour — same convention as reportDateId in
// nurses-report-common.js — used only to decide which shift ("am"/"pm")
// an automatic bump lands on.
function wardLocalHour(d = new Date()) {
  return new Date(d.getTime() + 60 * 60 * 1000).getUTCHours();
}

// Matches the ward's actual shift pattern (morning shift 8AM-5PM, night
// shift 5PM-8AM — see nurses-report-common.js's SHIFTS/reportDateId
// comments): whichever shift is in progress right now is where a live
// patient-status event should be counted.
export function currentShiftKey(d = new Date()) {
  const h = wardLocalHour(d);
  return (h >= 8 && h < 17) ? 'am' : 'pm';
}

// Automatically bumps one movement column (adm/disch/dama/transferIn/
// transferOut/ext/extOut/absc/death/sc/vsc/bid — see STAT_FIELDS) on a
// ward's live Shift Statistics table by `delta`, the same field a nurse
// would otherwise type a number into by hand in WardNurse.jsx's
// ShiftTable. This is always a background side effect of something that
// already happened elsewhere (a registration, discharge, transfer,
// readmit) — it never throws. An unrecognized ward key is silently
// skipped rather than blocking whatever real action triggered it.
//
// Gated on `locked` alone (not `submitted`) — same as `editable` in
// WardNurse.jsx — since Overall Nurse can reopen a submitted report by
// clearing just `locked` (see toggleLock in OverallNurse.jsx), and a
// nurse can then go back to editing it by hand; an automatic bump
// should be allowed to land the same way a manual edit would. While
// actually locked, a bump isn't dropped anymore — it's queued onto the
// doc's own pendingStatBumps (a new admission/discharge/transfer/etc.
// that happens after a ward's report was filed for the day shouldn't
// just vanish from that day's figures). It stays queued, invisible to
// the totals, until Overall Nurse deliberately reopens that report —
// see applyPendingStatBumps below, which replays it then. This is
// intentionally not automatic: a filed report shouldn't silently
// rewrite itself days later just because e.g. a Readmit reverses an
// old exit; only an explicit reopen replays anything.
//
// Returns the exact {wardKey, statKey, dateId, shiftKey} target actually
// written (queued or applied), or null if nothing happened at all —
// callers that trigger an exit event (discharge/refer/DAMA/absconded)
// save this alongside the patient record so a later Readmit can hand it
// straight back here with delta: -1 for an exact reversal, instead of
// guessing which day/shift the original count landed on.
export async function bumpShiftStat(wardKey, statKey, delta = 1, { dateId, shiftKey } = {}) {
  const w = WARDS.find(x => x.key === wardKey);
  if (!w) return null;
  const useDateId = dateId || reportDateId();
  const useShiftKey = shiftKey || currentShiftKey();
  const ref = doc(db, 'nurseReports', useDateId, 'wards', wardKey);
  const fieldPath = 'shifts.' + useShiftKey + '.' + statKey;
  // Looked up before the transaction starts (see liveHeadcountForWardKey) so
  // a brand-new day's doc, if we end up creating one below, seeds Occ from
  // the real patient census rather than 0. Only actually used if the doc
  // turns out not to exist yet once the transaction runs.
  const seedHeadcount = await liveHeadcountForWardKey(wardKey);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        const startOcc = typeof seedHeadcount === 'number' ? seedHeadcount : 0;
        const seed = defaultWardDoc(w, startOcc);
        seed.shifts[useShiftKey][statKey] = Math.max(0, delta);
        tx.set(ref, { ...seed, updatedAt: serverTimestamp() });
        return;
      }
      const data = snap.data();
      if (data.locked) {
        const pending = Array.isArray(data.pendingStatBumps) ? data.pendingStatBumps.slice() : [];
        pending.push({ shiftKey: useShiftKey, statKey, delta, queuedAt: new Date().toISOString() });
        tx.update(ref, { pendingStatBumps: pending });
        return;
      }
      const shiftObj = (data.shifts && data.shifts[useShiftKey]) || {};
      const current = typeof shiftObj[statKey] === 'number' ? shiftObj[statKey] : 0;
      const next = Math.max(0, current + delta);
      tx.update(ref, { [fieldPath]: next, updatedAt: serverTimestamp() });
    });
  } catch (e) {
    console.warn('bumpShiftStat failed for', wardKey, statKey, e);
    return null;
  }
  return { wardKey, statKey, dateId: useDateId, shiftKey: useShiftKey };
}

// Replays every stat bump queued while a ward's report was locked (see
// the queuing branch in bumpShiftStat above) — a new admission, trans
// in, discharge, DAMA, ABSC, trans out, etc. that happened after that
// day's report was filed, none of which touched the figures at the
// time. Called once, the moment Overall Nurse actually reopens the
// report (see toggleLock in OverallNurse.jsx unlocking it) — never on a
// timer or automatically, so a filed report only ever changes because
// someone deliberately chose to reopen it. Applies each queued delta in
// the order it was queued, then clears the queue; anything that queues
// afterward (while reopened and then locked again) waits for the next
// reopen the same way. A no-op if there's nothing queued.
//
// Entries queued by bumpDemographicStat below carry `demographic: true`
// and a top-level `fieldKey` instead of a `shiftKey` (Patient
// Demographics is one daily total per ward, not per-shift — see
// DEMOGRAPHIC_FIELDS in nurses-report-common.js) — those are applied
// straight onto the doc's own field rather than under `shifts`.
export async function applyPendingStatBumps(wardKey, dateId) {
  const ref = doc(db, 'nurseReports', dateId, 'wards', wardKey);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const data = snap.data();
      const pending = Array.isArray(data.pendingStatBumps) ? data.pendingStatBumps : [];
      if (!pending.length) return;
      const shifts = { ...(data.shifts || {}) };
      const topLevel = {};
      pending.forEach((entry) => {
        if (entry.demographic) {
          const current = typeof data[entry.fieldKey] === 'number' ? data[entry.fieldKey] : 0;
          topLevel[entry.fieldKey] = Math.max(0, (topLevel[entry.fieldKey] ?? current) + entry.delta);
          return;
        }
        const { shiftKey, statKey, delta } = entry;
        const shiftObj = { ...(shifts[shiftKey] || {}) };
        const current = typeof shiftObj[statKey] === 'number' ? shiftObj[statKey] : 0;
        shiftObj[statKey] = Math.max(0, current + delta);
        shifts[shiftKey] = shiftObj;
      });
      tx.update(ref, { shifts, ...topLevel, pendingStatBumps: [], updatedAt: serverTimestamp() });
    });
  } catch (e) {
    console.warn('applyPendingStatBumps failed for', wardKey, dateId, e);
  }
}

// Resolves a patient-chart ward label (+ pedBedType, only meaningful for
// the PEDIATRIC/NICU WARD split) to its Shift Statistics ward key(s) and
// bumps each — the entry point every patient-status call site actually
// uses, so none of them need to think about wardNameMatch.js directly.
// A ward with no report-side equivalent (e.g. FSW EXT) is silently
// skipped, same as every other feature keyed off that same mapping.
export async function bumpShiftStatForPatientWard(patientWardLabel, pedBedType, statKey, delta = 1, opts) {
  const keys = reportWardKeysForPatientWard(patientWardLabel);
  if (!keys.length) return null;
  const targets = keys.length > 1
    ? keys.filter(k => (pedBedType === 'Cot' ? k === 'paedcot' : k === 'paedbed'))
    : keys;
  const results = await Promise.all((targets.length ? targets : keys).map(k => bumpShiftStat(k, statKey, delta, opts)));
  return results.find(Boolean) || null;
}

// Automatically bumps one cell of the Patient Demographics table — the
// automatic counterpart to a nurse typing a number into
// DemographicsTable in WardNurse.jsx by hand. Unlike bumpShiftStat, this
// writes a single top-level field on the ward doc (Demographics is one
// daily total per ward, not per-shift — see DEMOGRAPHIC_FIELDS in
// nurses-report-common.js), keyed `${category}_${affiliation}${sex}`
// (e.g. 'adm_milM'). `category` is one of DEMOGRAPHIC_CATEGORIES'
// keys ('adm'/'disch'/'dead'/'bid'), `affiliation` one of
// DEMOGRAPHIC_AFFILIATIONS' keys ('mil'/'civ' — see
// classifyAffiliation in patientAffiliation.js), `sex` 'M' or 'F'.
// Best-effort and never throws; a patient with no recorded gender
// simply doesn't get counted here (same as a blank cell a nurse never
// filled in), so this never blocks the admission/exit it's attached to.
export async function bumpDemographicStat(wardKey, category, affiliation, sex, delta = 1, { dateId } = {}) {
  if (!category || !affiliation || !DEMOGRAPHIC_SEXES.includes(sex)) return null;
  const w = WARDS.find(x => x.key === wardKey);
  if (!w) return null;
  const useDateId = dateId || reportDateId();
  const fieldKey = category + '_' + affiliation + sex;
  const ref = doc(db, 'nurseReports', useDateId, 'wards', wardKey);
  const seedHeadcount = await liveHeadcountForWardKey(wardKey);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        const startOcc = typeof seedHeadcount === 'number' ? seedHeadcount : 0;
        const seed = defaultWardDoc(w, startOcc);
        seed[fieldKey] = Math.max(0, delta);
        tx.set(ref, { ...seed, updatedAt: serverTimestamp() });
        return;
      }
      const data = snap.data();
      if (data.locked) {
        const pending = Array.isArray(data.pendingStatBumps) ? data.pendingStatBumps.slice() : [];
        pending.push({ demographic: true, fieldKey, delta, queuedAt: new Date().toISOString() });
        tx.update(ref, { pendingStatBumps: pending });
        return;
      }
      const current = typeof data[fieldKey] === 'number' ? data[fieldKey] : 0;
      tx.update(ref, { [fieldKey]: Math.max(0, current + delta), updatedAt: serverTimestamp() });
    });
  } catch (e) {
    console.warn('bumpDemographicStat failed for', wardKey, fieldKey, e);
    return null;
  }
  return { wardKey, category, affiliation, sex, dateId: useDateId };
}

// Resolves a patient-chart ward label the same way
// bumpShiftStatForPatientWard does, then bumps the matching
// Demographics cell on whichever report ward(s) that resolves to.
export async function bumpDemographicStatForPatientWard(patientWardLabel, pedBedType, category, affiliation, sex, delta = 1, opts) {
  const keys = reportWardKeysForPatientWard(patientWardLabel);
  if (!keys.length) return null;
  const targets = keys.length > 1
    ? keys.filter(k => (pedBedType === 'Cot' ? k === 'paedcot' : k === 'paedbed'))
    : keys;
  const results = await Promise.all((targets.length ? targets : keys).map(k => bumpDemographicStat(k, category, affiliation, sex, delta, opts)));
  return results.find(Boolean) || null;
}
