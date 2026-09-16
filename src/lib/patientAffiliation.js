// Auto-detects whether a patient counts as "Military" or "Civilian" for
// the Patient Demographics table (see DEMOGRAPHIC_AFFILIATIONS in
// nurses-report-common.js). This is never a manual choice on the patient
// form — it's recomputed from two fields the nurse actually fills in
// (Army Number and Insurance) every time either one is saved, via
// recomputeMilitaryCivilian below, so the value shown on the patient's
// profile and the value fed into the ward's demographic counts can never
// drift apart.
//
// Army Number shapes confirmed by the hospital — examples, not exact
// numbers to match:
//   06NA/59/5240   ->  <digits/letters>NA/<digits>/<digits>
//   N/764521       ->  N/<digits>
// Any Insurance entry naming NHIS \u2013 Defence Health Maintenance Limited
// (DHML), or carrying an NHIS No. in one of those same shapes, also
// marks the patient as military (that's the DHML military scheme).
const ARMY_NUMBER_PATTERNS = [
  /^[A-Za-z0-9]{0,6}NA\/\d+(?:\/\d+)*$/i, // e.g. 06NA/59/5240, 12NA/34/5678
  /^N\/\d+$/i                              // e.g. N/764521, N/745163
];

// Same two shapes, but findable inside a longer free-text Insurance
// string (e.g. "NHIS \u2013 DHML, NHIS No: 06NA/59/5240") rather than
// requiring the whole field to be just the number.
const ARMY_NUMBER_LOOKALIKE = /\b([A-Za-z0-9]{0,6}NA\/\d+(?:\/\d+)*|N\/\d+)\b/i;

export function looksLikeArmyNumber(value) {
  const v = (value || '').trim();
  if (!v) return false;
  return ARMY_NUMBER_PATTERNS.some((re) => re.test(v));
}

export function looksLikeMilitaryInsurance(value) {
  const v = (value || '').trim();
  if (!v) return false;
  if (/dhml/i.test(v) || /defence health/i.test(v)) return true;
  return ARMY_NUMBER_LOOKALIKE.test(v);
}

// 'mil' | 'civ' \u2014 matches DEMOGRAPHIC_AFFILIATIONS keys in
// nurses-report-common.js, so a caller can drop this straight into a
// DEMOGRAPHIC_FIELDS key (`${category}_${affiliation}${sex}`).
export function classifyAffiliation(patientLike) {
  const p = patientLike || {};
  if (looksLikeArmyNumber(p.armyNumber)) return 'mil';
  if (looksLikeMilitaryInsurance(p.insurance)) return 'mil';
  return 'civ';
}

export const AFFILIATION_LABEL = { mil: 'Military', civ: 'Civilian' };

// Recomputes militaryCivilian from whatever Army Number / Insurance a
// form currently holds \u2014 called wherever a patient record is written
// (Home.jsx's createPatient, Patient.jsx's saveEditPatient) so the
// stored field always matches the two inputs it's derived from.
export function recomputeMilitaryCivilian(patientLike) {
  return classifyAffiliation(patientLike);
}
