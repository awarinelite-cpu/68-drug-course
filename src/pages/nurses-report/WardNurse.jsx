import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, getDocs, collection, query, where, limit, setDoc, serverTimestamp } from "firebase/firestore";
import { getDocSafe, getDocsSafe } from "../../lib/firestoreOffline.js";
import { db } from "../../firebase.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useGoBack } from "../../hooks/useGoBack.js";
import {
  WARDS, SHIFT_STAT_FIELDS, SHIFTS, PATIENT_FIELDS, PATIENT_STATUS_OPTIONS,
  DEMOGRAPHIC_FIELDS, computeDemographicTotals, movementColorClass,
  reportDateId, occDelta, blankShift, defaultWardDoc, wardSelectorOptions,
  isWardDocUntouched
} from "../../lib/nurses-report-common.js";
import { patientWardAndBedTypeForReportKey } from "../../lib/wardNameMatch.js";
import { wardHeadcount } from "../../lib/wardCensus.js";
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
            <td className={"stat-beds" + (s.key === 'am' ? '' : ' mirrored')}>
              {s.key === 'am'
                ? <input type="number" inputMode="numeric" disabled={!editable} value={wardDoc.beds} onChange={(e) => onBeds(e.target.value)} />
                : census.beds}
            </td>
            <td className="computed stat-occ">{census.perShiftOcc[s.key]}</td>
            <td className="computed stat-vac">{census.beds - census.perShiftOcc[s.key]}</td>
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
          <td className="stat-beds">{census.beds}</td>
          <td className="stat-occ">{census.occ}</td>
          <td className="stat-vac">{census.vac}</td>
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

// All of one ward's report state/logic — loading, editing, saving,
// submitting — with no rendering. Extracted out of WardReportPanel so
// MergedWardReportPanel below can run two of these (one per member
// ward) and feed both into a single shared Shift Statistics table,
// while everything else about each ward (Previous Occ, Demographics,
// Patients, Save/Submit) still saves to that ward's own Firestore doc
// completely independently, same as before this split existed.
function useWardReport(wardKey, isAdmin, profile, user) {
  const [wardDoc, setWardDoc] = useState(null);
  const [adminEditOverride, setAdminEditOverride] = useState(false);
  const [nightUpdateOpen, setNightUpdateOpen] = useState(false);
  const [topStatus, setTopStatus] = useState({ text: 'Loading…', error: false });
  const [saveStatus, setSaveStatus] = useState({ text: '', error: false });
  // Per-patient status for the EMR auto-fill lookup (see
  // lookupPatientByEmr below) — keyed by patient id, e.g.
  // { text: 'Filled from patient record.', error: false }. Purely for
  // showing the nurse a small note under the EMR field; never persisted.
  const [emrLookup, setEmrLookup] = useState({});
  const patientCounter = useRef(0);
  const w = WARDS.find(x => x.key === wardKey);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAdminEditOverride(false); // default to read-only even for admin; they tap ✏️ per ward
      setWardDoc(null);
      setTopStatus({ text: 'Loading…', error: false });
      const ref = doc(db, 'nurseReports', dateId, 'wards', wardKey);
      let snap;
      try {
        snap = await getDocSafe(ref);
      } catch (e) {
        if (!cancelled) setTopStatus({ text: "Couldn't load this ward's report: " + (e.code || e.message || 'unknown error'), error: true });
        return;
      }
      let next = snap.exists() ? Object.assign(defaultWardDoc(w), snap.data()) : defaultWardDoc(w);
      next.shifts = next.shifts || {};
      SHIFTS.forEach(s => { next.shifts[s.key] = Object.assign(blankShift(), next.shifts[s.key] || {}); });
      next.patients = Array.isArray(next.patients) ? next.patients : [];
      next.patients.forEach(p => { if (!p.id) p.id = 'p' + Math.random().toString(36).slice(2); if (typeof p.status !== 'string') p.status = ''; });
      next.nightUpdate = typeof next.nightUpdate === 'string' ? next.nightUpdate : '';
      next.nightUpdateBy = next.nightUpdateBy || '';

      // On taking over — the first time this ward's report for today is
      // opened, OR any later time it's opened while still untouched (no
      // shift figures entered yet, e.g. because a patient was registered
      // on the ward after someone merely opened this page without
      // entering anything) — Previous Occ should equal what the nurse
      // actually meets on the patient list, not a number carried forward
      // or stuck at a stale zero. Re-seeding an untouched doc loses
      // nothing, since there's no real shift data on it yet. Only
      // possible for wards whose name matches a patient-chart ward (see
      // wardNameMatch.js); everything else keeps the old carry-forward
      // behavior.
      if (!snap.exists() || isWardDocUntouched(next)) {
        const patientWardInfo = patientWardAndBedTypeForReportKey(wardKey);
        let filledFromPatients = false;
        if (patientWardInfo) {
          try {
            const patientsSnap = await getDocs(collection(db, 'patients'));
            const patients = [];
            patientsSnap.forEach(d => patients.push(d.data()));
            const headcount = wardHeadcount(patients, patientWardInfo.wardLabel, patientWardInfo.bedType);
            next = { ...next, startOcc: headcount, occ: headcount, vac: (next.beds || 0) - headcount };
            filledFromPatients = true;
          } catch (e) { /* fall through to the old carry-forward below */ }
        }
        if (!filledFromPatients && !snap.exists()) {
          try {
            const prevRef = doc(db, 'nurseReports', prevDateId(dateId), 'wards', wardKey);
            const prevSnap = await getDocSafe(prevRef);
            if (prevSnap.exists() && typeof prevSnap.data().occ === 'number') next = { ...next, startOcc: prevSnap.data().occ };
          } catch (e) { /* non-fatal — leave startOcc at 0, nurse can correct it */ }
        }
      }

      if (cancelled) return;
      setTopStatus({ text: '', error: false });
      setNightUpdateOpen(!!next.nightUpdate);
      setWardDoc(next);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wardKey]);

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

  // Looks the typed EMR number up against the existing 'patients'
  // collection (the same master record used by the drug-course-chart
  // side of the app) and, if found, fills in Age/Name/Sex/DOA — but only
  // the fields that are still blank, so it never clobbers anything the
  // nurse already typed. Sex isn't tracked on the patient master record,
  // so that field is left for the nurse either way. Fires on blur of the
  // EMR input rather than every keystroke.
  async function lookupPatientByEmr(id, rawEmr) {
    const emr = (rawEmr || '').trim();
    if (!emr) { setEmrLookup((s) => ({ ...s, [id]: null })); return; }
    setEmrLookup((s) => ({ ...s, [id]: { text: 'Looking up patient…', error: false } }));
    try {
      const q = query(collection(db, 'patients'), where('emr', '==', emr), limit(1));
      const snap = await getDocsSafe(q);
      if (snap.empty) {
        setEmrLookup((s) => ({ ...s, [id]: { text: 'No patient found with that EMR number — fill in details manually.', error: false } }));
        return;
      }
      const record = snap.docs[0].data();
      setWardDoc((d) => ({
        ...d,
        patients: d.patients.map((p) => {
          if (p.id !== id) return p;
          const next = { ...p };
          if (!next.name && record.name) next.name = record.name;
          if (!next.age && record.age) next.age = record.age;
          if (!next.doa && record.admissionDate) next.doa = record.admissionDate;
          return next;
        })
      }));
      setEmrLookup((s) => ({ ...s, [id]: { text: 'Filled in from the patient record.', error: false } }));
    } catch (e) {
      setEmrLookup((s) => ({ ...s, [id]: { text: "Couldn't look up patient: " + (e.code || e.message || 'unknown error'), error: true } }));
    }
  }

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

  const editable = wardDoc ? ((isAdmin && adminEditOverride) || !wardDoc.locked) : false;

  async function saveReport() {
    if (!wardDoc || !editable) return;
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
    if (!wardDoc || !editable) return;
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

  return {
    w, wardDoc, adminEditOverride, setAdminEditOverride, nightUpdateOpen, topStatus, saveStatus, emrLookup,
    census, movementTotals, demographicTotals, editable,
    updateWardDoc, updateShiftField, updateDuty, updateBeds, updateStartOcc,
    addPatient, removePatient, updatePatientField, updatePatientStatus, lookupPatientByEmr,
    openNightUpdate, saveReport, submitReport, pillClass, pillText
  };
}

// Everything about one ward's report except the Shift Statistics table
// itself: header/status/archive, locked notice, Previous Occ, [the
// Shift Statistics table, when includeShiftTable], Patient Demographics,
// Patients, Night Update, Save/Submit. `includeShiftTable` is false for
// a mergedTable group's members (MergedWardReportPanel renders one
// shared table above instead) and true everywhere else. Likewise
// `includePreviousOcc` is false for a mergedTable group's members —
// MergedWardReportPanel renders both members' Previous Occ inline atop
// the shared table instead of as a separate card down here.
// `includeHeader` is false for a mergedTable group's non-lead member
// (Cots) — MergedWardReportPanel doesn't render this component for that
// member at all. `onSave`/`onSubmit`, when passed, replace the default
// per-ward save/submit handlers — MergedWardReportPanel uses these so
// the one Save/Submit bar shown (Mothers') saves both member wards'
// data together, since Cots' own numeric figures (entered in the shared
// table above) would otherwise have no button of their own to save.
function WardPanelRest({ h, showLabel, isAdmin, navigate, includeShiftTable = true, includePreviousOcc = true, includeHeader = true, onSave, onSubmit }) {
  const {
    w, wardDoc, topStatus, saveStatus, editable, adminEditOverride, setAdminEditOverride,
    census, movementTotals, demographicTotals, emrLookup,
    updateWardDoc, updateShiftField, updateDuty, updateBeds, updateStartOcc,
    addPatient, removePatient, updatePatientField, updatePatientStatus, lookupPatientByEmr,
    nightUpdateOpen, openNightUpdate, saveReport, submitReport, pillClass, pillText
  } = h;

  return (
    <>
      {includeHeader && (
        <div className="card-box">
          <div className="ward-select-row">
            {showLabel && <h2 style={{ margin: 0 }}>{w?.label}</h2>}
            {wardDoc && <span className={"status-pill " + pillClass}>{pillText}</span>}
            {w && (
              <button className="btn btn-secondary" style={{ padding: '6px 12px' }} type="button"
                onClick={() => navigate('/nurses-report/archive-list?type=ward&ward=' + encodeURIComponent(w.key) + '&label=' + encodeURIComponent(w.label))}>
                {'\uD83D\uDCC1 Archive'}
              </button>
            )}
          </div>
          <div className="save-status" style={{ color: topStatus.error ? '#dc2626' : '#6b7280' }}>{topStatus.text}</div>
        </div>
      )}

      {wardDoc && (
        <>
          {wardDoc.locked && (
            <div className="locked-notice">
              {isAdmin ? "This ward's report is locked." : "This ward's report is locked. Ask the Overall Nurse to grant access before editing."}
              {isAdmin && !adminEditOverride && <button className="admin-edit-btn" onClick={() => setAdminEditOverride(true)}>{'\u270F\uFE0F'}</button>}
            </div>
          )}

          {includePreviousOcc && (
            <div className="card-box">
              <h2>Previous Occ</h2>
              <div className="patient-field" style={{ maxWidth: 140 }}>
                <input type="number" inputMode="numeric" disabled={!editable} value={wardDoc.startOcc} onChange={(e) => updateStartOcc(e.target.value)} />
              </div>
            </div>
          )}

          {includeShiftTable && (
            <div className="card-box">
              <h2>Shift Statistics</h2>
              <div className="table-wrap">
                <ShiftTable wardDoc={wardDoc} census={census} movementTotals={movementTotals} editable={editable}
                  onBeds={updateBeds} onField={updateShiftField} onDuty={updateDuty} />
              </div>
            </div>
          )}

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
                            : <input type="text" value={p[f.key] || ''} onChange={(e) => updatePatientField(p.id, f.key, e.target.value)}
                                onBlur={f.key === 'emr' ? (e) => lookupPatientByEmr(p.id, e.target.value) : undefined} />}
                          {f.key === 'emr' && emrLookup[p.id] && (
                            <div className="emr-lookup-note" style={{ color: emrLookup[p.id].error ? '#dc2626' : '#6b7280' }}>
                              {emrLookup[p.id].text}
                            </div>
                          )}
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
                <button className="btn btn-secondary" style={{ flex: 1, padding: 12 }} onClick={onSave || saveReport}>Save</button>
                <button className="btn btn-primary" style={{ flex: 1, padding: 12 }} onClick={onSubmit || submitReport}>Submit Report</button>
              </div>
            )}
            <div className="save-status" style={{ color: saveStatus.error ? '#dc2626' : '#6b7280' }}>{saveStatus.text}</div>
          </div>
        </>
      )}
    </>
  );
}

// One ward's full report — Previous Occ, Shift Statistics, Patient
// Demographics, Patients, Night Update, Save/Submit. Used once per
// selected ward, and twice side-by-side when the nurse picks a grouped
// option that isn't a mergedTable group (e.g. PAED WARD) — each
// instance loads and saves its own Firestore doc under its own
// wardKey, completely independently.
function WardReportPanel({ wardKey, showLabel, isAdmin, profile, user, navigate }) {
  const h = useWardReport(wardKey, isAdmin, profile, user);
  return <WardPanelRest h={h} showLabel={showLabel} isAdmin={isAdmin} navigate={navigate} includeShiftTable />;
}

// One shared, editable Shift Statistics table for a mergedTable group
// (currently just MATERNITY WARD) — matches the paper Minute Book
// exactly: a Morning section with a Mothers row then a Cots row, a
// Night section the same way, and one combined Total row. `panels` is
// one entry per member ward, each still writing to its own wardDoc/
// Firestore record via its own handlers — this table only combines how
// they're displayed and totalled, never the underlying data.
function MergedShiftTable({ panels }) {
  const totalBeds = panels.reduce((s, p) => s + p.census.beds, 0);
  const totalOcc = panels.reduce((s, p) => s + p.census.occ, 0);
  const totalVac = panels.reduce((s, p) => s + p.census.vac, 0);
  const totalMovement = {};
  ORDERED_MOVEMENT.forEach((f) => {
    totalMovement[f.key] = panels.reduce((s, p) => s + (typeof p.movementTotals[f.key] === 'number' ? p.movementTotals[f.key] : 0), 0);
  });
  const dutyNames = panels.map((p) => p.wardDoc.shifts.pm.nurseOnDuty).filter(Boolean).join(', ');
  const colSpanAll = 4 + ORDERED_MOVEMENT.length + 1;

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
          <Fragment key={s.key}>
            <tr className="shift-section-row"><td colSpan={colSpanAll}>{s.label === 'Am' ? 'Morning' : 'Night'}</td></tr>
            {panels.map((p) => (
              <tr key={p.w.key}>
                <td className="shift-name">{p.w.label}</td>
                <td className={"stat-beds" + (s.key === 'am' ? '' : ' mirrored')}>
                  {s.key === 'am'
                    ? <input type="number" inputMode="numeric" disabled={!p.editable} value={p.wardDoc.beds} onChange={(e) => p.updateBeds(e.target.value)} />
                    : p.census.beds}
                </td>
                <td className="computed stat-occ">{p.census.perShiftOcc[s.key]}</td>
                <td className="computed stat-vac">{p.census.beds - p.census.perShiftOcc[s.key]}</td>
                {ORDERED_MOVEMENT.map((f) => (
                  <td key={f.key} className={movementColorClass(f.key)}>
                    <input type="number" inputMode="numeric" disabled={!p.editable}
                      value={p.wardDoc.shifts[s.key][f.key]} onChange={(e) => p.updateShiftField(s.key, f.key, e.target.value)} />
                  </td>
                ))}
                <td>
                  <input type="text" className="duty-input" placeholder="Nurse name(s)" disabled={!p.editable}
                    value={p.wardDoc.shifts[s.key].nurseOnDuty} onChange={(e) => p.updateDuty(s.key, e.target.value)} />
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
        <tr className="total-row">
          <td className="shift-name">Total</td>
          <td className="stat-beds">{totalBeds}</td>
          <td className="stat-occ">{totalOcc}</td>
          <td className="stat-vac">{totalVac}</td>
          {ORDERED_MOVEMENT.map((f) => <td key={f.key} className={movementColorClass(f.key)}>{totalMovement[f.key]}</td>)}
          <td style={{ textAlign: 'left' }}>{dutyNames || '\u2014'}</td>
        </tr>
      </tbody>
    </table>
  );
}

// A mergedTable group's full report (currently just MATERNITY WARD): one
// shared editable Shift Statistics table for both member wards
// (Mothers/Cots) with both members' Previous Occ inline just above it,
// and one Archive button covering the whole group. Nurses only write
// patient-level reports for Mothers — babies in Cots don't get their
// own write-ups — so only Mothers' Demographics/Patients/Night Update
// section renders below the table. Its Save/Submit buttons save BOTH
// member wards' data together (via onSave/onSubmit below), since Cots'
// own numeric figures — entered directly in the shared table above —
// would otherwise have no button of their own to save. Assumes exactly
// two member wards, true for every mergedTable group defined today; a
// third member would need a third useWardReport call added here
// explicitly (hooks can't be called from a loop).
function MergedWardReportPanel({ group, isAdmin, profile, user, navigate }) {
  const hA = useWardReport(group.wardKeys[0], isAdmin, profile, user);
  const hB = useWardReport(group.wardKeys[1], isAdmin, profile, user);
  const hooks = [hA, hB];
  const bothLoaded = hooks.every((h) => h.wardDoc);

  async function saveBoth() { await Promise.all([hA.saveReport(), hB.saveReport()]); }
  async function submitBoth() { await Promise.all([hA.submitReport(), hB.submitReport()]); }

  return (
    <>
      {bothLoaded && (
        <div className="card-box">
          <div className="ward-select-row">
            <h2 style={{ margin: 0 }}>{group.label} — Shift Statistics</h2>
            <button className="btn btn-secondary" style={{ padding: '6px 12px' }} type="button"
              onClick={() => navigate('/nurses-report/archive-list?type=ward&ward=' + encodeURIComponent(hA.w.key) + '&label=' + encodeURIComponent(group.label))}>
              {'\uD83D\uDCC1 Archive'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12, marginBottom: 12 }}>
            {hooks.map((h) => (
              <div className="patient-field" style={{ maxWidth: 140 }} key={h.w.key}>
                <label>{'Previous Occ (' + h.w.label + ')'}</label>
                <input type="number" inputMode="numeric" disabled={!h.editable} value={h.wardDoc.startOcc} onChange={(e) => h.updateStartOcc(e.target.value)} />
              </div>
            ))}
          </div>
          <div className="table-wrap">
            <MergedShiftTable panels={hooks.map((h) => ({
              w: h.w, wardDoc: h.wardDoc, census: h.census, movementTotals: h.movementTotals,
              editable: h.editable, updateBeds: h.updateBeds, updateShiftField: h.updateShiftField, updateDuty: h.updateDuty
            }))} />
          </div>
        </div>
      )}
      <WardPanelRest h={hA} showLabel={false} isAdmin={isAdmin} navigate={navigate}
        includeShiftTable={false} includePreviousOcc={false} includeHeader={false}
        onSave={saveBoth} onSubmit={submitBoth} />
    </>
  );
}

export default function WardNurse() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/nurses-report/role-select');

  const wardOptions = useMemo(() => wardSelectorOptions(), []);
  const [groupKey, setGroupKey] = useState('');
  const activeOption = wardOptions.find(o => o.key === groupKey) || null;
  const isAdmin = profile?.role === 'admin';

  return (
    <>
      <Topbar brand="Ward Nurse">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>
      <div className="container">
        <div className="card-box">
          <div className="ward-select-row">
            <select value={groupKey} onChange={(e) => setGroupKey(e.target.value)}>
              <option value="">-- Select your ward --</option>
              {wardOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {activeOption && (
          activeOption.mergedTable
            ? <MergedWardReportPanel group={activeOption} isAdmin={isAdmin} profile={profile} user={user} navigate={navigate} />
            : activeOption.wardKeys.map(key => (
                <WardReportPanel key={key} wardKey={key} showLabel={activeOption.wardKeys.length > 1}
                  isAdmin={isAdmin} profile={profile} user={user} navigate={navigate} />
              ))
        )}
      </div>
    </>
  );
}
