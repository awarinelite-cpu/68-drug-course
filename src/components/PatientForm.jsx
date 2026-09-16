import { WARD_OPTIONS, PED_BED_TYPES } from "../lib/drugChartHelpers.js";
import { classifyAffiliation, AFFILIATION_LABEL } from "../lib/patientAffiliation.js";

// lockWard: true on the Patient page's own Edit Patient Information form
// (see Patient.jsx) — ward is deliberately not editable there anymore.
// A patient's ward should only ever change through an action that also
// keeps Shift Statistics and the roster honest about it: Transfer,
// Admit Patient, Register New Patient (reusing an existing record), or
// Readmit — all in patientAdmissionStatus.js. Editing it free-form here
// let it drift out of sync with what those flows and the ward's own
// census actually reflect. Register New Patient's own form (Home.jsx)
// is unaffected — picking a ward there is exactly how that admission
// itself happens, not an edit to an existing one.
export default function PatientForm({ form, setForm, lockWard }) {
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const setWard = (e) => setForm({ ...form, ward: e.target.value, pedBedType: e.target.value === 'PEDIATRIC/NICU WARD' ? form.pedBedType : '' });
  return (
    <>
      <div className="field"><label>Name</label><input type="text" value={form.name} onChange={set('name')} /></div>
      <div className="field"><label>EMR Number</label><input type="text" value={form.emr} onChange={set('emr')} /></div>
      <div className="field"><label>Diagnosis</label><input type="text" value={form.diagnosis} onChange={set('diagnosis')} /></div>
      <div className="field">
        <label>Ward</label>
        {lockWard ? (
          <>
            <input type="text" value={form.ward || 'Not admitted'} disabled />
            {form.ward === 'PEDIATRIC/NICU WARD' && form.pedBedType && (
              <input type="text" value={form.pedBedType} disabled style={{ marginTop: 6 }} />
            )}
            <div className="field-hint">To change ward, use Transfer, Admit Patient, or Readmit instead.</div>
          </>
        ) : (
          <select value={form.ward} onChange={setWard}>
            <option value="">Select ward…</option>
            {WARD_OPTIONS.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        )}
      </div>
      {!lockWard && form.ward === 'PEDIATRIC/NICU WARD' && (
        <div className="field">
          <label>Bed / Cot</label>
          <select value={form.pedBedType || ''} onChange={set('pedBedType')}>
            <option value="">Select…</option>
            {PED_BED_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      )}
      <div className="field">
        <label>Gender</label>
        <select value={form.gender || ''} onChange={set('gender')}>
          <option value="">Select…</option>
          <option value="M">Male</option>
          <option value="F">Female</option>
        </select>
      </div>
      <div className="field"><label>Age</label><input type="text" value={form.age} onChange={set('age')} /></div>
      <div className="field"><label>Hospital Bed No</label><input type="text" value={form.hospNo} onChange={set('hospNo')} /></div>
      <div className="field"><label>Date of Admission</label><input type="date" value={form.admissionDate} onChange={set('admissionDate')} /></div>
      <div className="field"><label>Allergies</label><input type="text" placeholder="None known / list allergies" value={form.allergies} onChange={set('allergies')} /></div>
      <div className="field"><label>Insurance</label><input type="text" placeholder="e.g. NHIS, Private, HMO name" value={form.insurance || ''} onChange={set('insurance')} /></div>
      <div className="field">
        <label>Army Number</label>
        <input type="text" placeholder="e.g. 06NA/59/5240 or N/764521" value={form.armyNumber || ''} onChange={set('armyNumber')} />
      </div>
      {/* Read-only \u2014 never a manual choice. Recomputed live from Insurance
          and Army Number above (see classifyAffiliation in
          patientAffiliation.js) so a nurse can see at a glance which way
          this patient will be counted on the ward's Patient Demographics
          table (adm/disch/dead x Military/Civilian x M/F), the same
          detection the saved record itself uses. */}
      <div className="field">
        <label>Military / Civilian</label>
        <input type="text" value={AFFILIATION_LABEL[classifyAffiliation(form)]} disabled />
      </div>
    </>
  );
}
