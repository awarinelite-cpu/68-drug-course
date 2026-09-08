import { WARDS } from "./nurses-report-common.js";
import { WARD_OPTIONS } from "./drugChartHelpers.js";

// Patient charts (WARD_OPTIONS, in drugChartHelpers.js) and nurse reports
// (WARDS, in nurses-report-common.js) were built as two separate lists and
// don't line up 1:1 — the report splits Maternity and Pediatric into
// Bed/Cot, abbreviates several names (ORTHO, MMW), and has a few wards
// (ECO I/II, AMENITY, FSW EXT) patient charts have no equivalent for.
// Rather than guess at a semantic mapping, we only treat two wards as
// "the same ward" when their names already match once normalized —
// case, punctuation, and the standalone word "WARD" stripped out. That
// catches e.g. '"A" WARD' (patient) === 'A WARD' (report `award`), but
// deliberately leaves e.g. ORTHOPEDIC WARD vs ORTHO unmatched.
function normalizeWardLabel(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/["']/g, '')
    .split(/\s+/)
    .filter(w => w && w !== 'WARD')
    .join(' ')
    .trim();
}

// Given a patient-chart ward label (a value from WARD_OPTIONS), returns
// the matching nurse-report ward key (from WARDS), or null if none of
// the report wards normalize to the same name.
export function reportWardKeyForPatientWard(patientWardLabel) {
  const norm = normalizeWardLabel(patientWardLabel);
  if (!norm) return null;
  const match = WARDS.find(w => normalizeWardLabel(w.label) === norm);
  return match ? match.key : null;
}

// A handful of patient-chart wards (WARD_OPTIONS) cover what the nurse
// report tracks as two separate physical areas with their own Occ each
// (see nurses-report-common.js's WARD_GROUPS comment) — normalized-name
// matching alone can't find these since e.g. "PEDIATRIC/NICU WARD"
// shares no words with "PAED BED" or "PAED COT". Listed here explicitly
// so callers that need every report ward behind a patient ward (e.g. Home
// page Occ counts) get both instead of just the first normalized match.
const SPLIT_PATIENT_WARDS = {
  'PEDIATRIC/NICU WARD': ['paedbed', 'paedcot']
};

// Given a patient-chart ward label, returns every matching nurse-report
// ward key — normally zero or one (see reportWardKeyForPatientWard), but
// two for a known split ward like PEDIATRIC/NICU WARD.
export function reportWardKeysForPatientWard(patientWardLabel) {
  const upper = String(patientWardLabel || '').toUpperCase().trim();
  if (SPLIT_PATIENT_WARDS[upper]) return SPLIT_PATIENT_WARDS[upper];
  const single = reportWardKeyForPatientWard(patientWardLabel);
  return single ? [single] : [];
}

// The reverse lookup: given a nurse-report ward key, returns the matching
// patient-chart ward label (a value from WARD_OPTIONS), or null if none
// of the patient wards normalize to the same name.
export function patientWardForReportKey(reportWardKey) {
  const w = WARDS.find(x => x.key === reportWardKey);
  if (!w) return null;
  const norm = normalizeWardLabel(w.label);
  return WARD_OPTIONS.find(label => normalizeWardLabel(label) === norm) || null;
}
