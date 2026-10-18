// Works out which patients make up a number in the Statistics / Patient
// Demographics tables, using the patient list of each ward (the write-up cards
// on the ward report, which cover every patient on the ward and carry the
// movement stamp: NEW PATIENT, DISCHARGE, DEATH ...). Nobody types anything:
// tapping a number just reads this list.
import { doc } from 'firebase/firestore';
import { db } from '../firebase.js';
import { getDocSafe } from './firestoreOffline.js';
import { classifyAffiliation } from './patientAffiliation.js';
import { patientWardAndBedTypeForReportKey } from './wardNameMatch.js';
import { loadPatientsForWardLabels } from './patientDirectory.js';

// Write-up status stamp -> Shift Statistics column it was counted under.
export const STATUS_TO_STAT = {
  'NEW PATIENT': 'adm',
  'TRANS IN FROM A&E': 'transferIn',
  'INT TRANS IN': 'transferIn',
  'EXT TRANS IN': 'ext',
  'DISCHARGE': 'disch',
  'INT TRANS OUT': 'transferOut',
  'TRANS OUT': 'extOut',
  'DEATH': 'death',
  'DAMA': 'dama',
  'ABSC': 'absc'
};

// Write-up status stamp -> Patient Demographics category.
const STATUS_TO_DEMO = { 'DISCHARGE': 'disch', 'DEATH': 'dead' };

// Statuses meaning the patient has left (or is off) the ward's roster.
const LEFT_WARD = new Set(['DISCHARGE', 'TRANS OUT', 'INT TRANS OUT', 'DEATH', 'DAMA', 'ABSC', 'PAROLE', 'D/PAROLE']);

export const LISTABLE_STAT_KEYS = new Set(['occ', 'adm', 'disch', 'dama', 'transferIn', 'transferOut', 'ext', 'extOut', 'absc', 'death', 'parole', 'dParole']);
export const LISTABLE_DEMO_CATEGORIES = new Set(['adm', 'disch', 'dead']);

const sexOf = (p) => String((p && p.sex) || '').trim().charAt(0).toUpperCase();
const hasWho = (p) => !!(p && (String(p.name || '').trim() || String(p.emr || '').trim()));

function writeUps(docs, wardKeys) {
  const seen = new Set();
  const out = [];
  (wardKeys || []).forEach((k) => {
    const list = docs && docs[k] && Array.isArray(docs[k].patients) ? docs[k].patients : [];
    list.forEach((p) => {
      if (!hasWho(p)) return;
      const id = p.sourcePatientId || (p.emr ? 'emr:' + String(p.emr).trim().toLowerCase() : 'w:' + k + ':' + p.id);
      if (seen.has(id)) return;
      seen.add(id);
      out.push(p);
    });
  });
  return out;
}

const shape = (p) => ({ name: String(p.name || '').trim() || 'Unnamed', emr: String(p.emr || '').trim() });
const byName = (a, b) => a.name.localeCompare(b.name);

export function statPatients(docs, wardKeys, statKey) {
  if (statKey === 'parole' || statKey === 'dParole') {
    const listKey = statKey === 'parole' ? 'paroleList' : 'dParoleList';
    return (wardKeys || []).flatMap((k) => (docs && docs[k] && Array.isArray(docs[k][listKey]) ? docs[k][listKey] : []))
      .filter(hasWho).map(shape).sort(byName);
  }
  const ups = writeUps(docs, wardKeys);
  const picked = statKey === 'occ'
    ? ups.filter((p) => !LEFT_WARD.has(p.status))
    : ups.filter((p) => STATUS_TO_STAT[p.status] === statKey);
  return picked.map(shape).sort(byName);
}

// Occ = everybody still on the ward right now, so the names come from the
// ward's real patient list (the patient charts on that ward), not only from
// the write-up cards -- a patient nobody has written up yet is still counted
// in Occ. Mid-transfer patients are left out, same rule as the headcount that
// seeds Previous Occ. Returns null when a ward has no patient-chart
// equivalent (ECO, Amenity ...) so the caller can fall back to write-up cards.
async function liveWardPatients(wardKeys) {
  const infos = (wardKeys || []).map((k) => patientWardAndBedTypeForReportKey(k)).filter(Boolean);
  if (!infos.length) return null;
  const all = await loadPatientsForWardLabels(infos.map((i) => i.wardLabel));
  const seen = new Set();
  const out = [];
  infos.forEach(({ wardLabel, bedType }) => {
    all.forEach((p) => {
      if (!p || p.pendingTransfer || p.ward !== wardLabel) return;
      if (bedType && (p.pedBedType || '') !== bedType) return;
      if (!hasWho(p)) return;
      const id = p.emr ? 'emr:' + String(p.emr).trim().toLowerCase() : 'n:' + wardLabel + ':' + String(p.name).trim().toLowerCase();
      if (seen.has(id)) return;
      seen.add(id);
      out.push(p);
    });
  });
  return out;
}

export async function occPatients(docs, wardKeys) {
  const live = await liveWardPatients(wardKeys);
  return live ? live.map(shape).sort(byName) : null;
}

const affCache = new Map();
async function affiliationOf(p) {
  const id = p.sourcePatientId;
  if (!id) return '';
  if (affCache.has(id)) return affCache.get(id);
  let aff = '';
  try {
    const snap = await getDocSafe(doc(db, 'patients', id));
    if (snap.exists()) aff = classifyAffiliation(snap.data());
  } catch (e) { /* leave unclassified */ }
  affCache.set(id, aff);
  return aff;
}

// fieldKey looks like 'adm_milM' / 'disch_civF' / 'dead_milM'.
export async function demoPatients(docs, wardKeys, fieldKey, archive) {
  const m = /^([a-z]+)_(mil|civ)([MF])$/.exec(fieldKey || '');
  if (!m) return [];
  const [, category, aff, sex] = m;
  // Admission block = the standing census of the ward, so on a live page the
  // names come straight from the ward's patient list (sex and Mil/Civ read
  // from each patient chart, the same way the census counts them).
  if (category === 'adm' && !archive) {
    const live = await liveWardPatients(wardKeys);
    if (live) {
      return live
        .filter((p) => String(p.gender || p.sex || '').trim().charAt(0).toUpperCase() === sex && classifyAffiliation(p) === aff)
        .map(shape).sort(byName);
    }
  }
  const ups = writeUps(docs, wardKeys);
  const candidates = ups.filter((p) => {
    if (sexOf(p) !== sex) return false;
    if (category === 'adm') return !LEFT_WARD.has(p.status); // standing census of the ward
    return STATUS_TO_DEMO[p.status] === category;
  });
  const affs = await Promise.all(candidates.map(affiliationOf));
  return candidates.filter((_, i) => affs[i] === aff).map(shape).sort(byName);
}
