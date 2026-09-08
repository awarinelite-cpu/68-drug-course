import { WARD_OPTIONS, PED_BED_TYPES } from "../lib/drugChartHelpers.js";

export default function PatientForm({ form, setForm }) {
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const setWard = (e) => setForm({ ...form, ward: e.target.value, pedBedType: e.target.value === 'PEDIATRIC/NICU WARD' ? form.pedBedType : '' });
  return (
    <>
      <div className="field"><label>Name</label><input type="text" value={form.name} onChange={set('name')} /></div>
      <div className="field"><label>EMR Number</label><input type="text" value={form.emr} onChange={set('emr')} /></div>
      <div className="field"><label>Diagnosis</label><input type="text" value={form.diagnosis} onChange={set('diagnosis')} /></div>
      <div className="field">
        <label>Ward</label>
        <select value={form.ward} onChange={setWard}>
          <option value="">Select ward…</option>
          {WARD_OPTIONS.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>
      {form.ward === 'PEDIATRIC/NICU WARD' && (
        <div className="field">
          <label>Bed / Cot</label>
          <select value={form.pedBedType || ''} onChange={set('pedBedType')}>
            <option value="">Select…</option>
            {PED_BED_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      )}
      <div className="field"><label>Age</label><input type="text" value={form.age} onChange={set('age')} /></div>
      <div className="field"><label>Hospital No</label><input type="text" value={form.hospNo} onChange={set('hospNo')} /></div>
      <div className="field"><label>Date of Admission</label><input type="date" value={form.admissionDate} onChange={set('admissionDate')} /></div>
      <div className="field"><label>Allergies</label><input type="text" placeholder="None known / list allergies" value={form.allergies} onChange={set('allergies')} /></div>
    </>
  );
}
