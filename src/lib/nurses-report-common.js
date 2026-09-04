// Shared constants and date helpers for the Nurses Report feature
// (role-select.html, overall-nurse.html, and eventually ward-nurse.html).

import { doc, getDoc, setDoc } from 'firebase/firestore';

// The hospital's fixed ward list, in the same order as the paper "24 Hours
// Overall Report" — beds is the default bed capacity, editable per ward.
export const WARDS = [
  { key: 'ae',       label: 'A/E',       beds: 20 },
  { key: 'matbed',   label: 'MATBED',    beds: 20 },
  { key: 'matcot',   label: 'MAT COT',   beds: 20 },
  { key: 'officers', label: 'OFFICERS',  beds: 9  },
  { key: 'fmw1',     label: 'FMW I',     beds: 18 },
  { key: 'fsw2',     label: 'FSW II',    beds: 20 },
  { key: 'mmw',      label: 'MMW',       beds: 20 },
  { key: 'paedbed',  label: 'PAED BED',  beds: 10 },
  { key: 'paedcot',  label: 'PAED COT',  beds: 18 },
  { key: 'ortho',    label: 'ORTHO',     beds: 20 },
  { key: 'gynae',    label: 'GYNAE',     beds: 18 },
  { key: 'award',    label: 'A WARD',    beds: 44 },
  { key: 'fswext',   label: 'FSW EXT',   beds: 20 },
  { key: 'eco1',     label: 'ECO I',     beds: 3  },
  { key: 'eco2',     label: 'ECO II',    beds: 3  },
  { key: 'icu',      label: 'ICU',       beds: 6  },
  { key: 'amenity',  label: 'AMENITY',   beds: 3  },
  { key: 'msw',      label: 'MSW',       beds: 18 },
  { key: 'esw',      label: 'ESW',       beds: 20 }
];

// Ward keys and bed counts are fixed, but an admin can rename a ward's
// display label (e.g. if a ward is physically renamed or relabelled).
// Overrides live in a single Firestore doc so every page/device shows the
// same names. defaultLabel is captured once here so a rename can always be
// reverted, and WARDS is mutated in place — every module that imports
// WARDS shares this one array instance, so applying an override here
// updates the label everywhere it's used without any extra plumbing.
WARDS.forEach(w => { w.defaultLabel = w.label; });

export const WARD_NAMES_COLLECTION = 'nurseReportConfig';
export const WARD_NAMES_DOC = 'wardNames';

// Applies a {wardKey: customLabel} map to WARDS. A missing or blank entry
// falls back to the ward's original hospital name.
export function applyWardNameOverrides(overrides) {
  const map = overrides || {};
  WARDS.forEach(w => {
    const custom = map[w.key];
    w.label = (typeof custom === 'string' && custom.trim()) ? custom.trim() : w.defaultLabel;
  });
}

// Fetches the current overrides doc and applies it to WARDS. Safe to call
// even if no one has renamed a ward yet — falls back to the default
// hospital names.
export async function loadWardNameOverrides(db) {
  try {
    const snap = await getDoc(doc(db, WARD_NAMES_COLLECTION, WARD_NAMES_DOC));
    applyWardNameOverrides(snap.exists() ? snap.data() : {});
  } catch (e) {
    // Non-fatal — page just keeps showing the default hospital ward names.
  }
}

// Renames one ward (admin/subadmin action) and keeps WARDS in sync locally
// so the caller doesn't need to reload. Persists via a merge so other
// wards' overrides already stored in the same doc aren't clobbered.
export async function saveWardNameOverride(db, wardKey, newLabel) {
  const trimmed = (newLabel || '').trim();
  const w = WARDS.find(x => x.key === wardKey);
  const valueToStore = trimmed && w && trimmed !== w.defaultLabel ? trimmed : null;
  await setDoc(doc(db, WARD_NAMES_COLLECTION, WARD_NAMES_DOC), { [wardKey]: valueToStore }, { merge: true });
  if (w) w.label = trimmed || w.defaultLabel;
}

// Numeric columns, in display order, matching the ward-level "24Hrs Ward
// Report" paper form. 'beds' is listed separately in the UI (it's capacity,
// not a daily movement figure) but included here too since it's still
// summed in the totals row.
export const STAT_FIELDS = [
  { key: 'beds',        label: 'Beds' },
  { key: 'occ',         label: 'Occ' },
  { key: 'vac',         label: 'Vac' },
  { key: 'adm',         label: 'Adm' },
  { key: 'disch',       label: 'Disch' },
  { key: 'dama',        label: 'Dama' },
  { key: 'transferIn',  label: 'Transfer In' },
  { key: 'transferOut', label: 'Transfer Out' },
  { key: 'ext',         label: 'Ext In' },
  { key: 'extOut',      label: 'Ext Out' },
  { key: 'sc',          label: 'S/C' },
  { key: 'vsc',         label: 'VS/C' },
  { key: 'absc',        label: 'Absc' },
  { key: 'bid',         label: 'BID' },
  { key: 'death',       label: 'Death' }
];

// Column headers can be corrected/renamed by an admin without touching the
// underlying key or calculations (mirrors the ward-name mechanism above).
// This covers every real STAT_FIELDS entry (mutated on f.label in place, so
// every table that reads f.label picks it up automatically) plus the two
// grouped "Int./Ext. Transfer" headers, which aren't real fields and are
// looked up by id via headerLabel() instead.
STAT_FIELDS.forEach(f => { f.defaultLabel = f.label; });

export const HEADER_LABELS_COLLECTION = 'nurseReportConfig';
export const HEADER_LABELS_DOC = 'headerLabels';
export const HEADER_LABEL_OVERRIDES = {};
export const GROUP_LABEL_IDS = { intTransfer: '_group_int_transfer', extTransfer: '_group_ext_transfer' };

export function applyHeaderLabelOverrides(overrides) {
  Object.keys(HEADER_LABEL_OVERRIDES).forEach(k => delete HEADER_LABEL_OVERRIDES[k]);
  Object.assign(HEADER_LABEL_OVERRIDES, overrides || {});
  STAT_FIELDS.forEach(f => {
    const custom = HEADER_LABEL_OVERRIDES[f.key];
    f.label = (typeof custom === 'string' && custom.trim()) ? custom.trim() : f.defaultLabel;
  });
}

export async function loadHeaderLabelOverrides(db) {
  try {
    const snap = await getDoc(doc(db, HEADER_LABELS_COLLECTION, HEADER_LABELS_DOC));
    applyHeaderLabelOverrides(snap.exists() ? snap.data() : {});
  } catch (e) {
    // Non-fatal — page just keeps showing the default column names.
  }
}

// id is either a real STAT_FIELDS key (keeps f.label in sync too) or one
// of the synthetic GROUP_LABEL_IDS above.
export async function saveHeaderLabelOverride(db, id, newLabel, defaultLabel) {
  const trimmed = (newLabel || '').trim();
  const valueToStore = trimmed && trimmed !== defaultLabel ? trimmed : null;
  await setDoc(doc(db, HEADER_LABELS_COLLECTION, HEADER_LABELS_DOC), { [id]: valueToStore }, { merge: true });
  if (valueToStore) HEADER_LABEL_OVERRIDES[id] = valueToStore; else delete HEADER_LABEL_OVERRIDES[id];
  const f = STAT_FIELDS.find(x => x.key === id);
  if (f) f.label = trimmed || f.defaultLabel;
}

export function headerLabel(id, defaultLabel) {
  return HEADER_LABEL_OVERRIDES[id] || defaultLabel;
}

// Admin-added free-text columns layered on top of the fixed STAT_FIELDS
// list (e.g. "Consultant", "Diet"). Ward-level, not per-shift, and never
// summed in a totals row since they're text, not counts. Order is
// preserved as one array in a single config doc; CUSTOM_TEXT_COLUMNS is
// mutated in place (never reassigned) so every importer shares updates.
export const CUSTOM_COLUMNS_COLLECTION = 'nurseReportConfig';
export const CUSTOM_COLUMNS_DOC = 'customColumns';
export const CUSTOM_TEXT_COLUMNS = [];

export function applyCustomColumns(list) {
  CUSTOM_TEXT_COLUMNS.length = 0;
  (Array.isArray(list) ? list : []).forEach(c => {
    if (c && c.key && c.label) CUSTOM_TEXT_COLUMNS.push({ key: c.key, label: c.label });
  });
}

export async function loadCustomColumns(db) {
  try {
    const snap = await getDoc(doc(db, CUSTOM_COLUMNS_COLLECTION, CUSTOM_COLUMNS_DOC));
    applyCustomColumns(snap.exists() ? snap.data().columns : []);
  } catch (e) {
    // Non-fatal — page just shows no custom columns.
  }
}

// Generates a short, collision-resistant key from the label so an admin
// never has to think about keys — just names.
function slugColumnKey(label) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'col';
  return 'custom_' + slug + '_' + Math.random().toString(36).slice(2, 6);
}

export async function addCustomColumn(db, label) {
  const trimmed = (label || '').trim();
  if (!trimmed) throw new Error('A column name is required.');
  const col = { key: slugColumnKey(trimmed), label: trimmed };
  const next = CUSTOM_TEXT_COLUMNS.concat([col]);
  await setDoc(doc(db, CUSTOM_COLUMNS_COLLECTION, CUSTOM_COLUMNS_DOC), { columns: next }, { merge: true });
  applyCustomColumns(next);
  return col;
}

// Renames an existing custom column in place — key and column order are
// unchanged, so already-entered data under that key is unaffected.
export async function renameCustomColumn(db, key, newLabel) {
  const trimmed = (newLabel || '').trim();
  if (!trimmed) throw new Error('A column name is required.');
  const next = CUSTOM_TEXT_COLUMNS.map(c => (c.key === key ? { key, label: trimmed } : c));
  await setDoc(doc(db, CUSTOM_COLUMNS_COLLECTION, CUSTOM_COLUMNS_DOC), { columns: next }, { merge: true });
  applyCustomColumns(next);
}

// Removes a custom column from the config doc entirely. Already-entered
// per-ward data under that key is simply orphaned (no longer displayed or
// summed) rather than actively wiped from Firestore ward docs.
export async function removeCustomColumn(db, key) {
  const next = CUSTOM_TEXT_COLUMNS.filter(c => c.key !== key);
  await setDoc(doc(db, CUSTOM_COLUMNS_COLLECTION, CUSTOM_COLUMNS_DOC), { columns: next }, { merge: true });
  applyCustomColumns(next);
}

// A ward report is entered per shift, then totalled. 'beds' isn't collected
// per shift (it's the ward's fixed capacity) — every other STAT_FIELDS key
// is summed across shifts for the Total row and for the figure that feeds
// the Overall Nurse's ward-totals table.
export const SHIFTS = [
  { key: 'am', label: 'Am' },
  { key: 'pm', label: 'Pm' }
];

// Occ and Vac are census figures, not events — they are NOT summed across
// shifts (a ward that had 8 patients in the morning and still had 8 in the
// evening has 8, not 16). Only the true movement/event columns below are
// entered per shift and summed for the Total row.
export const SHIFT_STAT_FIELDS = STAT_FIELDS.filter(
  f => f.key !== 'beds' && f.key !== 'occ' && f.key !== 'vac'
);

// Which movement columns move the Occ count, and which way. Confirmed with
// the ward: Adm, (internal) Transfer In, and (external) Ext In increase the
// census; Disch, Dama, Transfer Out, Ext Out, and Death decrease it. S/C,
// VS/C, and BID do not change Occ.
export const OCC_INCREASE_KEYS = ['adm', 'transferIn', 'ext'];
export const OCC_DECREASE_KEYS = ['disch', 'dama', 'transferOut', 'extOut', 'absc', 'death'];

// CSS class for a movement-figure cell, so every table (Ward Nurse's own
// shift table, the Overall Nurse's per-ward shift table, and the All Wards
// statistics table) colors incoming vs outgoing patient counts the same
// way: outgoing (Disch/Dama/Transfer Out/Ext Out/Absc/Death) in red,
// incoming (Adm/Transfer In/Ext In) in blue. Anything else (S/C, VS/C, BID)
// gets no color.
export function movementColorClass(key) {
  if (OCC_DECREASE_KEYS.includes(key)) return 'stat-out';
  if (OCC_INCREASE_KEYS.includes(key)) return 'stat-in';
  return '';
}

// Net change to Occ contributed by one shift's movement figures.
export function occDelta(shiftData) {
  const get = k => (typeof shiftData[k] === 'number' ? shiftData[k] : 0);
  const inc = OCC_INCREASE_KEYS.reduce((sum, k) => sum + get(k), 0);
  const dec = OCC_DECREASE_KEYS.reduce((sum, k) => sum + get(k), 0);
  return inc - dec;
}

// A fresh, unsubmitted shift's movement figures. Every count starts at
// zero and no nurse is recorded yet. Used to build a blank ward doc, and
// to reset one after the Overall Nurse archives the day's reports.
export function blankShift() {
  const s = {};
  SHIFT_STAT_FIELDS.forEach(f => { s[f.key] = 0; });
  DEMOGRAPHIC_FIELDS.forEach(f => { s[f.key] = 0; });
  s.nurseOnDuty = '';
  return s;
}

// The empty-state shape for one ward's live report: no shifts entered,
// nothing submitted, nothing locked. Used both on a ward's first-ever
// load and to reset a ward's live doc once its report has been filed to
// the archive. `startOcc` seeds the new period's opening census: pass
// the ward's closing Occ from the just-archived report to carry it
// forward as the new period's starting figure, or omit it for a truly
// blank ward with no prior report.
export function defaultWardDoc(w, startOcc = 0) {
  const occ = typeof startOcc === 'number' ? startOcc : 0;
  const d = {
    label: w.label, beds: w.beds, startOcc: occ, occ: occ, vac: w.beds - occ,
    locked: false, submitted: false,
    shifts: {}, patients: [], nightUpdate: '', nightUpdateBy: '', nightUpdatedAt: null
  };
  SHIFTS.forEach(s => { d.shifts[s.key] = blankShift(); });
  SHIFT_STAT_FIELDS.forEach(f => { d[f.key] = 0; });
  DEMOGRAPHIC_FIELDS.forEach(f => { d[f.key] = 0; });
  return d;
}

// Net totals across shifts for the demographic breakdown, mirroring
// computeMovementTotals()'s shape for STAT_FIELDS. Used by the Ward Nurse
// Total row, and to persist the day's ward-level demographic totals so the
// Overall Nurse / archive views can compile them without re-summing shifts.
export function computeDemographicTotals(wardDoc) {
  const totals = {};
  DEMOGRAPHIC_FIELDS.forEach(f => {
    let sum = 0;
    SHIFTS.forEach(s => { const v = wardDoc.shifts[s.key]?.[f.key]; sum += typeof v === 'number' ? v : 0; });
    totals[f.key] = sum;
  });
  return totals;
}

// Small "Patient Demographics" breakdown — NOT part of STAT_FIELDS, never
// fed into Occ or any STAT_FIELDS total. Purely descriptive: who was
// admitted, broken down by sex/age-group/affiliation. Entered per shift on
// the Ward Nurse page (own small table below Shift Statistics), compiled
// read-only on the Overall Nurse page, and shown read-only (with admin edit
// mode) on archived reports.
export const DEMOGRAPHIC_FIELDS = [
  { key: 'male',     label: 'Male' },
  { key: 'female',   label: 'Female' },
  { key: 'child',    label: 'Children' },
  { key: 'soldier',  label: 'Soldiers' },
  { key: 'civilian', label: 'Civilians' }
];

// Structured fields for each patient write-up under a ward's report,
// matching the paper form's per-patient block (name/age/sex/EMR/DOA up
// top, then one large free-text area for diagnosis, orders, and any
// nursing notes — matching how the paper form actually reads).
export const PATIENT_FIELDS = [
  { key: 'name',      label: 'Name',      type: 'text' },
  { key: 'age',       label: 'Age',       type: 'text' },
  { key: 'sex',       label: 'Sex',       type: 'text' },
  { key: 'emr',       label: 'EMR',       type: 'text' },
  { key: 'doa',       label: 'DOA',       type: 'text' },
  { key: 'diagnosis', label: 'Diagnosis / Notes', type: 'textarea', big: true }
];

// Toggleable patient status, shown as a stamp on the write-up (both the
// ward nurse's own view and the Overall Nurse's compiled report).
export const PATIENT_STATUS_OPTIONS = [
  'DISCHARGE',
  'TRANS OUT',
  'NEW PATIENT',
  'TRANS IN FROM A&E',
  'DEATH',
  'ONGOING RX'
];

function pad(n) { return String(n).padStart(2, '0'); }

// Ward is Africa/Lagos — WAT, UTC+1 year-round, no DST — matching the
// convention already used in functions/index.js and js/push.js, so this
// doesn't depend on whatever timezone the nurse's own device is set to.
function wardLocalParts(d) {
  const wat = new Date(d.getTime() + 60 * 60 * 1000);
  return { y: wat.getUTCFullYear(), m: wat.getUTCMonth(), day: wat.getUTCDate(), hour: wat.getUTCHours() };
}

// 24-hour report periods run 9:00 AM to 9:00 AM the next day — the ward's
// morning shift runs 8AM-5PM and the night shift 5PM-8AM, so 9AM (shortly
// after morning handover) is when the new report day actually begins and
// the previous day's report is swept to archive. A time before 9 AM still
// belongs to the period that started the previous day. (The Intake &
// Output chart's PERIOD_START_HOUR is a separate, unrelated convention —
// left at 6 AM.)
export function reportDateId(d = new Date()) {
  const p = wardLocalParts(d);
  const base = new Date(Date.UTC(p.y, p.m, p.day - (p.hour < 9 ? 1 : 0)));
  return base.getUTCFullYear() + '-' + pad(base.getUTCMonth() + 1) + '-' + pad(base.getUTCDate());
}

// Matches the paper report's header line, e.g.
// "24 HOURS OVERALL REPORT WEF 0900HRS OF 15/08/26 TO 0900HRS OF 16/08/26"
// `kind` swaps in for a per-ward archive file's heading, e.g.
// "24 HOURS WARD REPORT WEF 0900HRS OF 15/08/26 TO 0900HRS OF 16/08/26"
export function reportPeriodLabel(dateId, kind = 'OVERALL') {
  const [y, m, d] = dateId.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 1));
  const fmt = dt => pad(dt.getUTCDate()) + '/' + pad(dt.getUTCMonth() + 1) + '/' + String(dt.getUTCFullYear()).slice(2);
  return '24 HOURS ' + kind + ' REPORT WEF 0900HRS OF ' + fmt(start) + ' TO 0900HRS OF ' + fmt(end);
}

// The Archive file name for one ward's daily report — see reportPeriodLabel.
export function wardReportPeriodLabel(dateId) {
  return reportPeriodLabel(dateId, 'WARD');
}

// The Overall Nurse role runs Monday–Sunday, identified by that Monday's
// ward-local date — avoids ISO week-number ambiguity across year boundaries.
export function weekId(d = new Date()) {
  const p = wardLocalParts(d);
  const date = new Date(Date.UTC(p.y, p.m, p.day));
  const dow = date.getUTCDay(); // 0=Sun..6=Sat
  date.setUTCDate(date.getUTCDate() - ((dow + 6) % 7));
  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
}
