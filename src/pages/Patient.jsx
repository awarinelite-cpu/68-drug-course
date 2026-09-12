import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { doc, getDoc, setDoc, deleteDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { useBackLock } from "../hooks/useBackLock.js";
import { usePatientHeader } from "../hooks/usePatientHeader.js";
import { getDocSafe } from "../lib/firestoreOffline.js";
import { applyPatientStatus } from "../lib/patientAdmissionStatus.js";
import { STATUS_LABELS, WARD_OPTIONS } from "../lib/drugChartHelpers.js";
import Topbar from "../components/Topbar.jsx";
import PatientBanner from "../components/PatientBanner.jsx";
import PatientForm from "../components/PatientForm.jsx";

const SELECTED_PATIENT_KEY = 'selectedPatientId';

export default function Patient() {
  const { profile, user } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/');
  useBackLock('/');
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get('patient');

  const { patient: loadedPatient, loading, error: patientError } = usePatientHeader(patientId);
  const [patient, setPatient] = useState(null);

  const [showEditForm, setShowEditForm] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [editMsg, setEditMsg] = useState('');

  const [allocatedToMe, setAllocatedToMe] = useState(false);
  const [allocBusy, setAllocBusy] = useState(false);

  const [chartDiagnosis, setChartDiagnosis] = useState('');

  const [showStatusForm, setShowStatusForm] = useState(false);
  const [statusAction, setStatusAction] = useState('');
  const [transferWard, setTransferWard] = useState('');
  const [statusApplying, setStatusApplying] = useState(false);
  const [statusMsg, setStatusMsg] = useState({ color: '', text: '' });

  useEffect(() => {
    if (loadedPatient) setPatient(loadedPatient);
  }, [loadedPatient]);

  // Kept in sync so NavDrawer's Overview/Calculators shortcuts still work
  // from pages (like Profile) that don't carry ?patient= in
  // their own URL.
  useEffect(() => {
    if (patientId) sessionStorage.setItem(SELECTED_PATIENT_KEY, patientId);
  }, [patientId]);

  function allocationDocRef() {
    return doc(db, 'allocations', 'alloc_' + user.uid + '_' + patientId);
  }

  // Africa/Lagos (WAT) is UTC+1 with no DST, so shifting the UTC clock by
  // 1hr gives WAT wall-clock hours via the UTC getters. Morning 8:00–16:59,
  // Night 17:00–7:59.
  function currentShiftLabel() {
    const watHour = new Date(Date.now() + 60 * 60 * 1000).getUTCHours();
    return (watHour >= 8 && watHour < 17) ? 'Morning' : 'Night';
  }

  useEffect(() => {
    if (!patient || !user) { setAllocatedToMe(false); return; }
    let cancelled = false;
    getDoc(allocationDocRef()).then(snap => {
      if (!cancelled) setAllocatedToMe(snap.exists());
    }).catch(() => {
      // Can't confirm current state (offline, etc.) — leave the button
      // usable rather than stuck disabled; toggleAllocation() re-derives
      // the actual state from its own write attempt either way.
      if (!cancelled) setAllocatedToMe(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patient, user]);

  useEffect(() => {
    if (!patientId) { setChartDiagnosis(''); return; }
    let cancelled = false;
    getDocSafe(doc(db, 'patients', patientId, 'drugCourseChart', 'main')).then((snap) => {
      if (!cancelled && snap.exists()) setChartDiagnosis(snap.data().f_diagnosis || '');
    }).catch(() => {
      // No connection and nothing cached — fall back to the patient
      // record's own diagnosis field further down.
    });
    return () => { cancelled = true; };
  }, [patientId]);

  async function toggleAllocation() {
    if (!patient || !user) return;
    setAllocBusy(true);
    const ref = allocationDocRef();
    // Not awaited — with offline persistence the write queues locally and
    // syncs automatically, but the Promise itself won't resolve until back
    // online, which would leave the Allocate button stuck disabled
    // indefinitely while offline.
    if (allocatedToMe) {
      deleteDoc(ref).catch((e) => console.warn('Allocation removal queued locally; will retry once back online:', e));
      setAllocatedToMe(false);
    } else {
      setDoc(ref, {
        uid: user.uid,
        nurseName: profile?.name || '',
        patientId: patient.id,
        patientName: patient.name || 'Unnamed',
        patientEmr: patient.emr || '',
        patientWard: patient.ward || '',
        patientDiagnosis: patient.diagnosis || '',
        shift: currentShiftLabel(),
        allocatedAt: serverTimestamp()
      }).catch((e) => console.warn('Allocation queued locally; will retry once back online:', e));
      setAllocatedToMe(true);
    }
    setAllocBusy(false);
  }

  function openEditPatient() {
    if (!patient) return;
    setEditForm({
      name: patient.name || '', emr: patient.emr || '',
      diagnosis: patient.diagnosis || '', ward: patient.ward || '',
      pedBedType: patient.pedBedType || '',
      age: patient.age || '', hospNo: patient.hospNo || '',
      admissionDate: patient.admissionDate || '', allergies: patient.allergies || '',
      insurance: patient.insurance || ''
    });
    setEditMsg('');
    setShowEditForm(true);
  }

  async function saveEditPatient() {
    if (!patient) return;
    const name = editForm.name.trim();
    const emr = editForm.emr.trim();
    setEditMsg('');
    if (!name || !emr) { setEditMsg('Name and EMR number are required.'); return; }
    const updates = {
      name, emr,
      diagnosis: editForm.diagnosis.trim(), ward: editForm.ward.trim(),
      pedBedType: editForm.ward.trim() === 'PEDIATRIC/NICU WARD' ? (editForm.pedBedType || '') : '',
      age: editForm.age.trim(),
      hospNo: editForm.hospNo.trim(), admissionDate: editForm.admissionDate.trim(), allergies: editForm.allergies.trim(),
      insurance: editForm.insurance.trim(),
      updatedAt: serverTimestamp()
    };
    // Not awaited — same offline-hang reason as toggleAllocation above.
    updateDoc(doc(db, 'patients', patient.id), updates).catch((e) => {
      console.warn('Patient edit queued locally; will retry once back online:', e);
    });
    setPatient({ ...patient, ...updates });
    setShowEditForm(false);
  }

  async function applyStatus() {
    if (!patient) return;
    const reason = statusAction;
    if (!reason) { setStatusMsg({ color: '#dc2626', text: 'Please select an action first.' }); return; }
    if (reason === 'transferred' && !transferWard) {
      setStatusMsg({ color: '#dc2626', text: 'Please select which ward the patient is being transferred to.' });
      return;
    }

    // Same as the Drug Course Chart's own Patient Status control: discharging
    // or referring reads across five collections and then deletes the live
    // entries once archived, so those two are blocked until back online
    // rather than made offline-tolerant like the rest of this page's edits.
    // Transferring wards no longer touches any of that — it's just a single
    // pendingTransfer write — so it doesn't need this gate.
    if (reason !== 'transferred' && !navigator.onLine) {
      setStatusMsg({ color: '#dc2626', text: "This needs an internet connection — referring or discharging archives records from several charts at once and then clears them, and doing that safely requires reading the real data rather than whatever's cached locally. Please try again once online." });
      return;
    }

    const label = reason === 'transferred' ? ('Transferred to ' + transferWard) : STATUS_LABELS[reason];
    const confirmBody = reason === 'transferred'
      ? 'The patient moves to ' + transferWard + '\u2019s New Patient queue \u2014 a nurse there still has to accept them before they show up on that ward\u2019s patient list. Their drug chart, vitals, glycemic chart, intake & output, and seizure chart all stay exactly as they are; care just continues on the new ward.'
      : 'All care records for this admission (drug chart, vitals, glycemic chart, intake & output, seizure chart) will be saved together to Overview, and fresh charts will open for this patient.';
    if (!confirm('Confirm: ' + label + '?\n\n' + confirmBody)) return;

    setStatusApplying(true);
    setStatusMsg({ color: '#555', text: reason === 'transferred' ? 'Sending transfer…' : 'Saving all charts for this admission…' });

    const result = await applyPatientStatus({ patientId: patient.id, reason, transferWard, fromWard: patient.ward, transferredByName: profile?.name });
    if (!result.ok) {
      setStatusMsg({ color: '#dc2626', text: result.message });
      setStatusApplying(false);
      return;
    }

    setStatusMsg({
      color: '#16a34a',
      text: reason === 'transferred'
        ? 'Sent to ' + transferWard + ' \u2014 awaiting acceptance there. Redirecting…'
        : 'Saved to Overview. Redirecting…'
    });
    setTimeout(() => navigate('/'), 900);
  }

  function openChart(chartName) {
    if (!patient) return;
    navigate('/charts/' + chartName + '?patient=' + patient.id + '&from=patient');
  }

  function openOverview() {
    if (!patient) return;
    navigate('/charts/overview?patient=' + patient.id);
  }

  return (
    <>
      <Topbar brand="Patient">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container">
        {loading && <div className="card-box">Loading patient…</div>}
        {patientError && <div className="card-box error-msg">{patientError}</div>}

        {patient && (
          <div className="card-box">
            <PatientBanner
              patient={{ ...patient, diagnosis: chartDiagnosis || patient.diagnosis }}
              ward={patient.ward}
              extra={
                <>
                  <button className="btn btn-secondary edit-patient-btn" title="Edit patient information" onClick={openEditPatient}>✎</button>
                  <button className={"btn " + (allocatedToMe ? 'btn-success' : 'btn-secondary')}
                    style={{ padding: '4px 10px', fontSize: 12, marginLeft: 6, whiteSpace: 'normal', lineHeight: 1.25, textAlign: 'center' }}
                    disabled={allocBusy} onClick={toggleAllocation}>
                    {allocBusy ? '…' : (allocatedToMe
                      ? <>✓ Allocated<br /><span style={{ fontSize: 10, fontWeight: 400 }}>tap to remove</span></>
                      : 'Allocate to Me')}
                  </button>
                  <button className="btn btn-purple" style={{ padding: '4px 10px', fontSize: 12, marginLeft: 6 }} onClick={openOverview}>Overview</button>
                  <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12, marginLeft: 6 }} onClick={() => setShowStatusForm((v) => !v)}>Status</button>
                </>
              }
            />

            {showStatusForm && (
              <div className="card-box" style={{ marginTop: 12, boxShadow: 'none', border: '1px solid #e5e7eb' }}>
                <label style={{ fontWeight: 'bold', fontSize: 13, display: 'block', marginBottom: 6 }}>Patient Status</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <select style={{ width: 'auto', minWidth: 220 }} value={statusAction} onChange={(e) => setStatusAction(e.target.value)}>
                    <option value="">Select action…</option>
                    <option value="discharged">{STATUS_LABELS.discharged}</option>
                    <option value="transferred">{STATUS_LABELS.transferred}</option>
                    <option value="referred">{STATUS_LABELS.referred}</option>
                    <option value="died">{STATUS_LABELS.died}</option>
                  </select>
                  {statusAction === 'transferred' && (
                    <select style={{ width: 'auto', minWidth: 220 }} value={transferWard} onChange={(e) => setTransferWard(e.target.value)}>
                      <option value="">Select ward…</option>
                      {WARD_OPTIONS.map(w => <option key={w} value={w}>{w}</option>)}
                    </select>
                  )}
                  <button className="btn btn-primary" style={{ padding: '8px 14px', fontSize: 13 }} disabled={statusApplying} onClick={applyStatus}>Apply</button>
                </div>
                {statusMsg.text && <div style={{ fontSize: 12, marginTop: 8, color: statusMsg.color }}>{statusMsg.text}</div>}
              </div>
            )}

            {showEditForm && editForm && (
              <div className="card-box" style={{ marginTop: 12, boxShadow: 'none', border: '1px solid #e5e7eb' }}>
                <h3 style={{ marginTop: 0 }}>Edit Patient Information</h3>
                <PatientForm form={editForm} setForm={setEditForm} />
                <button className="btn btn-primary" onClick={saveEditPatient}>Save Changes</button>
                <button className="btn btn-secondary" onClick={() => setShowEditForm(false)}>Cancel</button>
                {editMsg && <div className="error-msg">{editMsg}</div>}
              </div>
            )}

            <div className="chart-grid">
              <div className="chart-card" onClick={() => openChart('drug-course-chart')}><span className="icon">💊</span>Drug Course Chart</div>
              <div className="chart-card" onClick={() => openChart('vitals')}><span className="icon">❤️</span>Vital Signs</div>
              <div className="chart-card" onClick={() => openChart('intake-output')}><span className="icon">💧</span>Intake &amp; Output</div>
              <div className="chart-card" onClick={() => openChart('blood-glucose')}><span className="icon">🩸</span>Blood Glucose</div>
              <div className="chart-card" onClick={() => openChart('seizure')}><span className="icon">⚡</span>Seizure Chart</div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
