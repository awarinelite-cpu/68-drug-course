export default function PatientForm({ form, setForm }) {
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  return (
    <>
      <div className="field"><label>Name</label><input type="text" value={form.name} onChange={set('name')} /></div>
      <div className="field"><label>EMR Number</label><input type="text" value={form.emr} onChange={set('emr')} /></div>
      <div className="field"><label>Diagnosis</label><input type="text" value={form.diagnosis} onChange={set('diagnosis')} /></div>
      <div className="field"><label>Ward</label><input type="text" value={form.ward} onChange={set('ward')} /></div>
      <div className="field"><label>Age</label><input type="text" value={form.age} onChange={set('age')} /></div>
      <div className="field"><label>Hospital No</label><input type="text" value={form.hospNo} onChange={set('hospNo')} /></div>
      <div className="field"><label>Date of Admission</label><input type="date" value={form.admissionDate} onChange={set('admissionDate')} /></div>
      <div className="field"><label>Allergies</label><input type="text" placeholder="None known / list allergies" value={form.allergies} onChange={set('allergies')} /></div>
    </>
  );
}
