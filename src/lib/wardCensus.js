// Counts real patient chart documents currently on a ward — the single
// source of truth for "how many patients are actually on this ward",
// used both for the Home page's ward patient count and to auto-fill a
// matching ward report's Previous Occ on shift handover (see
// wardNameMatch.js), so the two numbers a nurse sees can't drift apart.
//
// Patients mid-transfer (pendingTransfer set) are excluded — they aren't
// settled on any ward's census yet, the same rule Home.jsx's patient
// list uses to hide them until a nurse on the receiving ward accepts or
// rejects them.
export function wardHeadcount(patients, wardLabel) {
  if (!wardLabel) return (patients || []).filter(p => !p.pendingTransfer).length;
  return (patients || []).filter(p => !p.pendingTransfer && p.ward === wardLabel).length;
}
