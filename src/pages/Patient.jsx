import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { doc, getDoc, setDoc, deleteDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { usePatientHeader } from "../hooks/usePatientHeader.js";
import Topbar from "../components/Topbar.jsx";
import PatientBanner from "../components/PatientBanner.jsx";
import PatientForm from "../components/PatientForm.jsx";

const SELECTED_PATIENT_KEY = 'selectedPatientId';

export default function Patient() {
  const { profile, user } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/');
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get('patient');

  const { patient: loadedPatient, loading, error: patientError } = usePatientHeader(patientId);
  const [patient, setPatient] = useState(null);

  const [showEditForm, setShowEditForm] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [editMsg, setEditMsg] = useState('');

  const [allocatedToMe, setAllocatedToMe] = useState(false);
  const [allocBusy, setAllocBusy] = useState(false);

  useEffect(() => {
    if (loadedPatient) setPatient(loadedPatient);
  }, [loadedPatient]);

  // Kept in sync so NavDrawer's Overview/Calculators shortcuts still work
  // from pages (like Profile or Community) that don't carry ?patient= in
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
      age: patient.age || '', hospNo: patient.hospNo || '',
      admissionDate: patient.admissionDate || '', allergies: patient.allergies || ''
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
      diagnosis: editForm.diagnosis.trim(), ward: editForm.ward.trim(), age: editForm.age.trim(),
      hospNo: editForm.hospNo.trim(), admissionDate: editForm.admissionDate.trim(), allergies: editForm.allergies.trim(),
      updatedAt: serverTimestamp()
    };
    // Not awaited — same offline-hang reason as toggleAllocation above.
    updateDoc(doc(db, 'patients', patient.id), updates).catch((e) => {
      console.warn('Patient edit queued locally; will retry once back online:', e);
    });
    setPatient({ ...patient, ...updates });
    setShowEditForm(false);
  }

  function openChart(chartName) {
    if (!patient) return;
    navigate('/charts/' + chartName + '?patient=' + patient.id);
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
              patient={patient}
              extra={
                <>
                  <button className="btn btn-secondary edit-patient-btn" title="Edit patient information" onClick={openEditPatient}>✎</button>
                  <button className={"btn " + (allocatedToMe ? 'btn-success' : 'btn-secondary')}
                    style={{ padding: '4px 10px', fontSize: 12, marginLeft: 6 }}
                    disabled={allocBusy} onClick={toggleAllocation}>
                    {allocBusy ? '…' : (allocatedToMe ? '✓ Allocated — tap to remove' : 'Allocate to Me')}
                  </button>
                  <button className="btn btn-purple" style={{ padding: '4px 10px', fontSize: 12, marginLeft: 6 }} onClick={openOverview}>Overview</button>
                </>
              }
            />

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
