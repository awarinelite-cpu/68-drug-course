import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { getDocSafe } from "../../lib/firestoreOffline.js";
import { db } from "../../firebase.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useGoBack } from "../../hooks/useGoBack.js";
import {
  WARDS, SHIFT_STAT_FIELDS, SHIFTS, PATIENT_FIELDS, PATIENT_STATUS_OPTIONS,
  DEMOGRAPHIC_FIELDS, computeDemographicTotals, movementColorClass,
  reportDateId, occDelta, blankShift, defaultWardDoc
} from "../../lib/nurses-report-common.js";
import Topbar from "../../components/Topbar.jsx";

const movementFields = SHIFT_STAT_FIELDS;
const byKey = k => movementFields.find(f => f.key === k);
const SOLO_BEFORE = ['adm', 'disch', 'dama'].map(byKey);
const SOLO_AFTER = ['sc', 'vsc', 'absc', 'bid', 'death'].map(byKey);
const TRANSFER_PAIR = [byKey('transferIn'), byKey('transferOut')];
const EXT_PAIR = [byKey('ext'), byKey('extOut')];
const ORDERED_MOVEMENT = [...SOLO_BEFORE, ...TRANSFER_PAIR, ...EXT_PAIR, ...SOLO_AFTER];

const dateId = reportDateId();

function prevDateId(id) {
  const [y, m, d] = id.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

function computeCensus(wardDoc) {
  const beds = typeof wardDoc.beds === 'number' ? wardDoc.beds : 0;
  const start = typeof wardDoc.startOcc === 'number' ? wardDoc.startOcc : 0;
  let occ = start;
  const perShiftOcc = {};
  SHIFTS.forEach(s => {
    occ += occDelta(wardDoc.shifts[s.key] || {});
    if (occ < 0) occ = 0;
    perShiftOcc[s.key] = occ;
  });
  return { beds, occ, vac: beds - occ, perShiftOcc };
}

function computeMovementTotals(wardDoc) {
  const totals = {};
  movementFields.forEach(f => {
    let sum = 0;
    SHIFTS.forEach(s => { const v = wardDoc.shifts[s.key][f.key]; sum += typeof v === 'number' ? v : 0; });
    totals[f.key] = sum;
  });
  return totals;
}

// A nurse's free-text write-up often has its own section headers inside it
// (LEFT UPPER LIMB FRACTURE / NURSING DIAGNOSIS / etc, by convention typed
// in ALL CAPS on their own line). Detect those and render as bold
// sub-headings within the note, splitting the surrounding text into
// justified paragraphs around them — still one continuous note.
function isNoteHeadingLine(line) {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase();
}
function NoteLines({ text }) {
  const lines = String(text).split('\n');
  const blocks = [];
  let paraLines = [];
  function flushPara() {
    if (paraLines.length) blocks.push({ type: 'p', text: paraLines.join('\n') });
    paraLines = [];
  }
  lines.forEach(line => {
    if (isNoteHeadingLine(line)) { flushPara(); blocks.push({ type: 'h', text: line.trim() }); }
    else paraLines.push(line);
  });
  flushPara();
  return blocks.map((b, i) => b.type === 'h'
    ? <h4 className="patient-note-subheading" key={i}>{b.text}</h4>
    : <p className="patient-note-text" key={i}>{b.text}</p>);
}

function PatientBlockView({ p }) {
  const summaryFields = PATIENT_FIELDS.filter(f => f.type !== 'textarea');
  const textFields = PATIENT_FIELDS.filter(f => f.type === 'textarea');
  return (
    <div className="patient-block">
      {p.status && <div className="status-stamp">{p.status}</div>}
      {summaryFields.map(f => p[f.key] ? (
        <div className="patient-line" key={f.key}><h3>{f.label}: </h3>{p[f.key]}</div>
      ) : null)}
      {textFields.map(f => p[f.key] ? (
        <div key={f.key}>
          <h3 className="patient-note-label">{f.label}:</h3>
          <NoteLines text={p[f.key]} />
        </div>
      ) : null)}
    </div>
  );
}

function ShiftTable({ wardDoc, census, movementTotals, editable, onBeds, onField, onDuty }) {
  return (
    <table className="shift">
      <thead>
        <tr>
          <th rowSpan={2}>Shift</th><th rowSpan={2}>Beds</th><th rowSpan={2}>Occ</th><th rowSpan={2}>Vac</th>
          {SOLO_BEFORE.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
          <th colSpan={2}>Int. Transfer</th>
          <th colSpan={2}>Ext. Transfer</th>
          {SOLO_AFTER.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
          <th rowSpan={2}>Nurses on Duty</th>
        </tr>
        <tr>{['In', 'Out', 'In', 'Out'].map((l, i) => <th key={i}>{l}</th>)}</tr>
      </thead>
      <tbody>
        {SHIFTS.map((s) => (
          <tr key={s.key}>
            <td className="shift-name">{s.label}</td>
            <td className={s.key === 'am' ? '' : 'mirrored'}>
              {s.key === 'am'
                ? <input type="number" inputMode="numeric" disabled={!editable} value={wardDoc.beds} onChange={(e) => onBeds(e.target.value)} />
                : census.beds}
            </td>
            <td className="computed">{census.perShiftOcc[s.key]}</td>
            <td className="computed">{census.beds - census.perShiftOcc[s.key]}</td>
            {ORDERED_MOVEMENT.map((f) => (
              <td key={f.key} className={movementColorClass(f.key)}>
                <input type="number" inputMode="numeric" disabled={!editable}
                  value={wardDoc.shifts[s.key][f.key]} onChange={(e) => onField(s.key, f.key, e.target.value)} />
              </td>
            ))}
            <td>
              <input type="text" className="duty-input" placeholder="Nurse name(s)" disabled={!editable}
                value={wardDoc.shifts[s.key].nurseOnDuty} onChange={(e) => onDuty(s.key, e.target.value)} />
            </td>
          </tr>
        ))}
        <tr className="total-row">
          <td className="shift-name">Total</td>
          <td>{census.beds}</td>
          <td>{census.occ}</td>
          <td>{census.vac}</td>
          {ORDERED_MOVEMENT.map((f) => <td key={f.key} className={movementColorClass(f.key)}>{movementTotals[f.key]}</td>)}
          <td style={{ textAlign: 'left' }}>{wardDoc.shifts.pm.nurseOnDuty || '\u2014'}</td>
        </tr>
      </tbody>
    </table>
  );
}

function DemographicsTable({ wardDoc, totals, editable, onField }) {
  return (
    <table className="shift">
      <thead>
        <tr>
          <th>Shift</th>
          {DEMOGRAPHIC_FIELDS.map(f => <th key={f.key}>{f.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {SHIFTS.map((s) => (
          <tr key={s.key}>
            <td className="shift-name">{s.label}</td>
            {DEMOGRAPHIC_FIELDS.map((f) => (
              <td key={f.key}>
                <input type="number" inputMode="numeric" disabled={!editable}
                  value={wardDoc.shifts[s.key][f.key]} onChange={(e) => onField(s.key, f.key, e.target.value)} />
              </td>
            ))}
          </tr>
        ))}
        <tr className="total-row">
          <td className="shift-name">Total</td>
          {DEMOGRAPHIC_FIELDS.map(f => <td key={f.key}>{totals[f.key]}</td>)}
        </tr>
      </tbody>
    </table>
  );
}

export default function WardNurse() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/nurses-report/role-select');

  const [wardKey, setWardKey] = useState('');
  const [wardDoc, setWardDoc] = useState(null);
  const [adminEditOverride, setAdminEditOverride] = useState(false);
  const [nightUpdateOpen, setNightUpdateOpen] = useState(false);
  const [topStatus, setTopStatus] = useState({ text: '', error: false });
  const [saveStatus, setSaveStatus] = useState({ text: '', error: false });
  const patientCounter = useRef(0);

  async function loadWard(key) {
    setWardKey(key);
    setAdminEditOverride(false); // default to read-only even for admin; they tap ✏️ per ward
    setWardDoc(null);
    setTopStatus({ text: 'Loading…', error: false });
    const w = WARDS.find(x => x.key === key);
    const ref = doc(db, 'nurseReports', dateId, 'wards', key);
    let snap;
    try {
      snap = await getDocSafe(ref);
    } catch (e) {
      setTopStatus({ text: "Couldn't load this ward's report: " + (e.code || e.message || 'unknown error'), error: true });
      return;
    }
    let next = snap.exists() ? Object.assign(defaultWardDoc(w), snap.data()) : defaultWardDoc(w);
    next.shifts = next.shifts || {};
    SHIFTS.forEach(s => { next.shifts[s.key] = Object.assign(blankShift(), next.shifts[s.key] || {}); });
    next.patients = Array.isArray(next.patients) ? next.patients : [];
    next.patients.forEach(p => { if (!p.id) p.id = 'p' + Math.random().toString(36).slice(2); if (typeof p.status !== 'string') p.status = ''; });
    next.nightUpdate = typeof next.nightUpdate === 'string' ? next.nightUpdate : '';
    next.nightUpdateBy = next.nightUpdateBy || '';

    if (!snap.exists()) {
      try {
        const prevRef = doc(db, 'nurseReports', prevDateId(dateId), 'wards', key);
        const prevSnap = await getDocSafe(prevRef);
        if (prevSnap.exists() && typeof prevSnap.data().occ === 'number') next = { ...next, startOcc: prevSnap.data().occ };
      } catch (e) { /* non-fatal — leave startOcc at 0, nurse can correct it */ }
    }

    setTopStatus({ text: '', error: false });
    setNightUpdateOpen(!!next.nightUpdate);
    setWardDoc(next);
  }

  function updateWardDoc(patch) { setWardDoc((d) => ({ ...d, ...patch })); }
  function updateShiftField(shiftKey, fieldKey, raw) {
    const num = parseFloat(raw);
    setWardDoc((d) => ({ ...d, shifts: { ...d.shifts, [shiftKey]: { ...d.shifts[shiftKey], [fieldKey]: isNaN(num) ? 0 : num } } }));
  }
  function updateDuty(shiftKey, value) {
    setWardDoc((d) => ({ ...d, shifts: { ...d.shifts, [shiftKey]: { ...d.shifts[shiftKey], nurseOnDuty: value } } }));
  }
  function updateBeds(raw) { const n = parseFloat(raw); updateWardDoc({ beds: isNaN(n) ? 0 : n }); }
  function updateStartOcc(raw) { const n = parseFloat(raw); updateWardDoc({ startOcc: isNaN(n) ? 0 : n }); }

  function addPatient() {
    patientCounter.current += 1;
    const id = 'p' + Date.now() + '_' + patientCounter.current;
    const blank = { id, status: '' };
    PATIENT_FIELDS.forEach(f => { blank[f.key] = ''; });
    setWardDoc((d) => ({ ...d, patients: [...d.patients, blank] }));
  }
  function removePatient(id) { setWardDoc((d) => ({ ...d, patients: d.patients.filter(p => p.id !== id) })); }
  function updatePatientField(id, key, value) { setWardDoc((d) => ({ ...d, patients: d.patients.map(p => p.id === id ? { ...p, [key]: value } : p) })); }
  function updatePatientStatus(id, value) { setWardDoc((d) => ({ ...d, patients: d.patients.map(p => p.id === id ? { ...p, status: value } : p) })); }

  function openNightUpdate() {
    if (!editable) return;
    const opening = !nightUpdateOpen;
    setNightUpdateOpen(opening);
    if (!opening) return;
    if (!wardDoc.shifts.pm.nurseOnDuty && profile?.name) updateDuty('pm', profile.name);
  }

  const census = useMemo(() => wardDoc ? computeCensus(wardDoc) : null, [wardDoc]);
  const movementTotals = useMemo(() => wardDoc ? computeMovementTotals(wardDoc) : null, [wardDoc]);
  const demographicTotals = useMemo(() => wardDoc ? computeDemographicTotals(wardDoc) : null, [wardDoc]);

  const isAdmin = profile?.role === 'admin';
  const editable = wardDoc ? ((isAdmin && adminEditOverride) || !wardDoc.locked) : false;

  async function saveReport() {
    if (!wardKey || !wardDoc || !editable) return;
    let doc_ = wardDoc;
    if (!doc_.shifts.am.nurseOnDuty && profile?.name) {
      doc_ = { ...doc_, shifts: { ...doc_.shifts, am: { ...doc_.shifts.am, nurseOnDuty: profile.name } } };
      setWardDoc(doc_);
    }
    const ref = doc(db, 'nurseReports', dateId, 'wards', wardKey);
    const finalDoc = { ...doc_, occ: census.occ, vac: census.vac, ...movementTotals, ...demographicTotals };
    try {
      await setDoc(ref, { ...finalDoc, updatedAt: serverTimestamp(), updatedBy: profile.name || 'Unknown' }, { merge: true });
      setSaveStatus({ text: 'Saved.', error: false });
    } catch (e) {
      setSaveStatus({ text: "Couldn't save: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  async function submitReport() {
    if (!wardKey || !wardDoc || !editable) return;
    const hasNightUpdate = !!(wardDoc.nightUpdate && wardDoc.nightUpdate.trim());
    let doc_ = wardDoc;
    if (hasNightUpdate && !doc_.shifts.pm.nurseOnDuty && profile?.name) {
      doc_ = { ...doc_, shifts: { ...doc_.shifts, pm: { ...doc_.shifts.pm, nurseOnDuty: profile.name } } };
    }
    const finalDoc = { ...doc_, occ: census.occ, vac: census.vac, ...movementTotals, ...demographicTotals };
    const ref = doc(db, 'nurseReports', dateId, 'wards', wardKey);
    const payload = {
      ...finalDoc, submitted: true, locked: true,
      submittedBy: profile.name || 'Unknown', submittedByUid: user?.uid || null, submittedAt: serverTimestamp(),
      updatedAt: serverTimestamp(), updatedBy: profile.name || 'Unknown'
    };
    if (hasNightUpdate) {
      payload.nightUpdateBy = doc_.nightUpdateBy || profile.name || 'Unknown';
      payload.nightUpdatedAt = doc_.nightUpdatedAt || serverTimestamp();
    }
    try {
      await setDoc(ref, payload, { merge: true });
      setSaveStatus({ text: 'Report submitted.', error: false });
      setWardDoc((d) => ({ ...d, ...doc_, submitted: true, locked: true, nightUpdateBy: payload.nightUpdateBy || d.nightUpdateBy }));
    } catch (e) {
      setSaveStatus({ text: "Couldn't submit: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  const pillClass = !wardDoc ? '' : wardDoc.locked ? 'locked' : wardDoc.submitted ? 'submitted' : 'draft';
  const pillText = !wardDoc ? '' : wardDoc.locked ? 'Locked' : wardDoc.submitted ? 'Submitted' : 'Draft';
  const w = WARDS.find(x => x.key === wardKey);

  return (
    <>
      <Topbar brand="Ward Nurse">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>
      <div className="container">
        <div className="card-box">
          <div className="ward-select-row">
            <select value={wardKey} onChange={(e) => { if (e.target.value) loadWard(e.target.value); else { setWardKey(''); setWardDoc(null); } }}>
              <option value="">-- Select your ward --</option>
              {WARDS.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
            </select>
            {wardDoc && <span className={"status-pill " + pillClass}>{pillText}</span>}
            {wardKey && w && (
              <button className="btn btn-secondary" style={{ padding: '6px 12px' }} type="button"
                onClick={() => navigate('/nurses-report/archive-list?type=ward&ward=' + encodeURIComponent(wardKey) + '&label=' + encodeURIComponent(w.label))}>
                {'\uD83D\uDCC1 Archive'}
              </button>
            )}
          </div>
          <div className="save-status" style={{ color: topStatus.error ? '#dc2626' : '#6b7280' }}>{topStatus.text}</div>
        </div>

        {wardDoc && (
          <>
            {wardDoc.locked && (
              <div className="locked-notice">
                {isAdmin ? "This ward's report is locked." : "This ward's report is locked. Ask the Overall Nurse to grant access before editing."}
                {isAdmin && !adminEditOverride && <button className="admin-edit-btn" onClick={() => setAdminEditOverride(true)}>{'\u270F\uFE0F'}</button>}
              </div>
            )}

            <div className="card-box">
              <h2>Previous Occ</h2>
              <div className="patient-field" style={{ maxWidth: 140 }}>
                <input type="number" inputMode="numeric" disabled={!editable} value={wardDoc.startOcc} onChange={(e) => updateStartOcc(e.target.value)} />
              </div>
            </div>

            <div className="card-box">
              <h2>Shift Statistics</h2>
              <div className="table-wrap">
                <ShiftTable wardDoc={wardDoc} census={census} movementTotals={movementTotals} editable={editable}
                  onBeds={updateBeds} onField={updateShiftField} onDuty={updateDuty} />
              </div>
            </div>

            <div className="card-box">
              <h2>Patient Demographics</h2>
              <div className="table-wrap">
                <DemographicsTable wardDoc={wardDoc} totals={demographicTotals} editable={editable} onField={updateShiftField} />
              </div>
            </div>

            <div className="card-box">
              <h2>Patients</h2>
              {editable ? (
                <>
                  {wardDoc.patients.map((p) => (
                    <div className="patient-card" key={p.id}>
                      <button type="button" className="remove-btn" onClick={() => removePatient(p.id)}>Remove</button>
                      <div className="patient-field">
                        <label>Status:</label>
                        <select className={"status-select" + (p.status ? ' set' : '')} value={p.status || ''} onChange={(e) => updatePatientStatus(p.id, e.target.value)}>
                          <option value="">{'\u2014 Select status \u2014'}</option>
                          {PATIENT_STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                      </div>
                      <div className="patient-grid">
                        {PATIENT_FIELDS.map((f) => (
                          <div className="patient-field" key={f.key} style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
                            <label>{f.label}:</label>
                            {f.type === 'textarea'
                              ? <textarea className={f.big ? 'big' : ''} value={p[f.key] || ''} onChange={(e) => updatePatientField(p.id, f.key, e.target.value)} />
                              : <input type="text" value={p[f.key] || ''} onChange={(e) => updatePatientField(p.id, f.key, e.target.value)} />}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  <button className="add-patient-btn" type="button" onClick={addPatient}>+ Add Patient</button>
                </>
              ) : wardDoc.patients.length === 0 ? (
                <div className="no-patients">No patient write-ups on this report.</div>
              ) : (
                wardDoc.patients.map((p) => <PatientBlockView p={p} key={p.id} />)
              )}

              <h2 className="night-update-heading">Night Update</h2>
              {editable && <button className="btn btn-secondary" type="button" onClick={openNightUpdate}>{'\uD83C\uDF19 Night Update'}</button>}
              {editable && nightUpdateOpen && (
                <div className="patient-field" style={{ marginTop: 10 }}>
                  <label className="patient-note-label" style={{ marginTop: 0 }}>Night update:</label>
                  <textarea id="nightUpdateInput" placeholder="Type the night update here…" style={{ minHeight: 140 }}
                    value={wardDoc.nightUpdate} onChange={(e) => updateWardDoc({ nightUpdate: e.target.value })} />
                </div>
              )}
              {!editable && wardDoc.nightUpdate && (
                <div className="night-update-block">
                  <h3 className="patient-note-label">{'Night Update' + (wardDoc.nightUpdateBy ? ' — ' + wardDoc.nightUpdateBy : '') + ':'}</h3>
                  <p className="patient-note-text">{wardDoc.nightUpdate}</p>
                </div>
              )}
              {editable && <div className="night-update-meta">{wardDoc.nightUpdateBy ? 'Added by ' + wardDoc.nightUpdateBy : ''}</div>}
            </div>

            <div className="card-box">
              {editable && (
                <div className="submit-bar">
                  <button className="btn btn-secondary" style={{ flex: 1, padding: 12 }} onClick={saveReport}>Save</button>
                  <button className="btn btn-primary" style={{ flex: 1, padding: 12 }} onClick={submitReport}>Submit Report</button>
                </div>
              )}
              <div className="save-status" style={{ color: saveStatus.error ? '#dc2626' : '#6b7280' }}>{saveStatus.text}</div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
