import { doc, runTransaction, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { WARDS, reportDateId, defaultWardDoc } from "./nurses-report-common.js";
import { reportWardKeysForPatientWard } from "./wardNameMatch.js";

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
// readmit) — it never throws. An unrecognized ward key, or a report
// that's already been submitted/locked, is silently skipped rather than
// blocking whatever real action triggered it or corrupting a report
// that's already been filed.
//
// Returns the exact {wardKey, statKey, dateId, shiftKey} target actually
// written, or null if nothing was written — callers that trigger an
// exit event (discharge/refer/DAMA/absconded) save this alongside the
// patient record so a later Readmit can hand it straight back here with
// delta: -1 for an exact reversal, instead of guessing which day/shift
// the original count landed on.
export async function bumpShiftStat(wardKey, statKey, delta = 1, { dateId, shiftKey } = {}) {
  const w = WARDS.find(x => x.key === wardKey);
  if (!w) return null;
  const useDateId = dateId || reportDateId();
  const useShiftKey = shiftKey || currentShiftKey();
  const ref = doc(db, 'nurseReports', useDateId, 'wards', wardKey);
  const fieldPath = 'shifts.' + useShiftKey + '.' + statKey;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        const seed = defaultWardDoc(w);
        seed.shifts[useShiftKey][statKey] = Math.max(0, delta);
        tx.set(ref, { ...seed, updatedAt: serverTimestamp() });
        return;
      }
      const data = snap.data();
      // A submitted/locked report has already been filed — it reflects
      // what really happened on that day/shift, and shouldn't be
      // reopened by a later reversal (e.g. a Readmit days after the
      // original discharge). The live report currently open is where
      // that correction belongs instead; this call just becomes a no-op.
      if (data.submitted || data.locked) return;
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
