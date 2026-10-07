// Standing patient census for the Patient Demographics / Records tables.
//
// The daily movement figures (Admission, Disch, Dead, BID) live on each
// day's ward report and start from zero every day, so on their own the
// Admission block went blank after 24 hours. The census here is counted
// straight from the real patient charts instead: admitting a patient adds
// to it, and discharge / death / BID (which remove the chart from the
// ward) subtract from it. It never resets and never depends on whether a
// ward report exists for the day.
//
// Result shape: { [reportWardKey]: { adm_milM, adm_milF, adm_civM, adm_civF, offr_adm } }
// — the same field names the Admission block already uses, so the Records
// sheet and the demographics tables can read it with no other changes.
import { reportWardKeysForPatientWard } from "./wardNameMatch.js";
import { classifyAffiliation, isOfficerArmyNumber } from "./patientAffiliation.js";

export function buildLiveCensus(patients) {
  const out = {};
  (patients || []).forEach((p) => {
    if (!p || p.pendingTransfer) return; // mid-transfer patients aren't settled on any ward yet
    const keys = reportWardKeysForPatientWard(p.ward);
    if (!keys.length) return;
    let key = keys[0];
    if (keys.length > 1) {
      const want = p.pedBedType === "Cot" ? "paedcot" : "paedbed";
      key = keys.includes(want) ? want : keys[0];
    }
    const cell = out[key] || (out[key] = { adm_milM: 0, adm_milF: 0, adm_civM: 0, adm_civF: 0, offr_adm: 0 });
    const aff = classifyAffiliation(p);
    if (p.gender === "M" || p.gender === "F") cell["adm_" + aff + p.gender] += 1;
    if (aff === "mil" && isOfficerArmyNumber(p.armyNumber)) cell.offr_adm += 1;
  });
  return out;
}

// Returns a copy of a { wardKey: wardDoc } map whose Admission fields are
// replaced by the standing census for every ward key in `wardKeys`.
export function applyCensusToWards(wardsMap, census, wardKeys) {
  const merged = { ...wardsMap };
  wardKeys.forEach((wk) => {
    const c = census[wk] || {};
    merged[wk] = {
      ...(merged[wk] || {}),
      adm_milM: c.adm_milM || 0, adm_milF: c.adm_milF || 0,
      adm_civM: c.adm_civM || 0, adm_civF: c.adm_civF || 0,
      offr_adm: c.offr_adm || 0
    };
  });
  return merged;
}
