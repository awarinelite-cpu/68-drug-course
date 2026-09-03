import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, addDoc, updateDoc, doc, getDoc, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { avatarMarkup } from "../lib/avatar.js";
import Topbar from "../components/Topbar.jsx";
import PatientBanner from "../components/PatientBanner.jsx";

const SELECTED_PATIENT_KEY = 'selectedPatientId';
const EMPTY_FORM = { name: '', emr: '', diagnosis: '', ward: '', age: '', hospNo: '', admissionDate: '', allergies: '' };

export default function Home() {
  const { profile, user, logout } = useAuth();
  const navigate = useNavigate();
  const searchInputRef = useRef(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null); // null = no search yet
  const [allPatients, setAllPatients] = useState(null);

  const [selectedPatient, setSelectedPatient] = useState(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY_FORM);
  const [newMsg, setNewMsg] = useState('');

  const [showEditForm, setShowEditForm] = useState(false);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editMsg, setEditMsg] = useState('');

  const [allocatedToMe, setAllocatedToMe] = useState(false);
  const [allocBusy, setAllocBusy] = useState(false);

  useEffect(() => {
    if (window.location.hash === '#search' && searchInputRef.current) {
      searchInputRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      searchInputRef.current.focus();
    }
    restoreSelectedPatient();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function restoreSelectedPatient() {
    const storedId = sessionStorage.getItem(SELECTED_PATIENT_KEY);
    if (!storedId) return;
    try {
      const snap = await getDoc(doc(db, 'patients', storedId));
      if (snap.exists()) selectPatient({ id: snap.id, ...snap.data() });
      else sessionStorage.removeItem(SELECTED_PATIENT_KEY);
    } catch (e) { /* offline/permissions — just leave the search screen showing */ }
  }

  async function loadAllPatients(force) {
    if (allPatients && !force) return allPatients;
    const snap = await getDocs(collection(db, 'patients'));
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    setAllPatients(list);
    return list;
  }

  async function doSearch() {
    const q = searchQuery.trim().toLowerCase();
    if (!q) { setSearchResults(null); return; }
    setSearchResults('loading');
    const patients = await loadAllPatients();
    const matches = patients.filter(p =>
      (p.emr || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)
    );
    setSearchResults(matches);
  }

  function selectPatient(p) {
    setSelectedPatient(p);
    sessionStorage.setItem(SELECTED_PATIENT_KEY, p.id);
    setSearchResults(null);
    setSearchQuery('');
    setShowNewForm(false);
    setShowEditForm(false);
  }

  // One doc per (nurse, patient) pair, so this ID is stable and idempotent
  // to create/overwrite/delete regardless of how many other nurses have
  // their own allocation doc for the same patient. Allocation isn't
  // exclusive and ends only when a nurse manually removes it (here or
  // from My Patients) — there's no automatic clearing at shift change.
  function allocationDocRef(patientId) {
    return doc(db, 'allocations', 'alloc_' + user.uid + '_' + patientId);
  }

  // Recorded on the allocation doc purely for handover visibility on My
  // Patients ("allocated 07:32am · Morning shift") — Africa/Lagos (WAT) is
  // UTC+1 with no DST, so shifting the UTC clock by 1hr gives WAT
  // wall-clock hours via the UTC getters. Morning 8:00–16:59, Night
  // 17:00–7:59.
  function currentShiftLabel() {
    const watHour = new Date(Date.now() + 60 * 60 * 1000).getUTCHours();
    return (watHour >= 8 && watHour < 17) ? 'Morning' : 'Night';
  }

  useEffect(() => {
    if (!selectedPatient || !user) { setAllocatedToMe(false); return; }
    let cancelled = false;
    getDoc(allocationDocRef(selectedPatient.id)).then(snap => {
      if (!cancelled) setAllocatedToMe(snap.exists());
    }).catch(() => {
      // Can't confirm current state (offline, etc.) — leave the button
      // usable rather than stuck disabled; toggleAllocation() re-derives
      // the actual state from its own write attempt either way.
      if (!cancelled) setAllocatedToMe(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPatient, user]);

  async function toggleAllocation() {
    if (!selectedPatient || !user) return;
    setAllocBusy(true);
    const ref = allocationDocRef(selectedPatient.id);
    try {
      if (allocatedToMe) {
        await deleteDoc(ref);
        setAllocatedToMe(false);
      } else {
        await setDoc(ref, {
          uid: user.uid,
          nurseName: profile?.name || '',
          patientId: selectedPatient.id,
          patientName: selectedPatient.name || 'Unnamed',
          patientEmr: selectedPatient.emr || '',
          patientWard: selectedPatient.ward || '',
          patientDiagnosis: selectedPatient.diagnosis || '',
          shift: currentShiftLabel(),
          allocatedAt: serverTimestamp()
        });
        setAllocatedToMe(true);
      }
    } catch (e) {
      alert("Couldn't update allocation: " + (e.code || e.message || 'unknown error'));
    }
    setAllocBusy(false);
  }

  function openEditPatient() {
    if (!selectedPatient) return;
    setEditForm({
      name: selectedPatient.name || '', emr: selectedPatient.emr || '',
      diagnosis: selectedPatient.diagnosis || '', ward: selectedPatient.ward || '',
      age: selectedPatient.age || '', hospNo: selectedPatient.hospNo || '',
      admissionDate: selectedPatient.admissionDate || '', allergies: selectedPatient.allergies || ''
    });
    setEditMsg('');
    setShowEditForm(true);
  }

  async function saveEditPatient() {
    if (!selectedPatient) return;
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
    try {
      await updateDoc(doc(db, 'patients', selectedPatient.id), updates);
    } catch (e) {
      setEditMsg('Save failed: ' + (e.code || e.message || 'unknown error'));
      return;
    }
    const updated = { ...selectedPatient, ...updates };
    delete updated.updatedAt;
    await loadAllPatients(true);
    setShowEditForm(false);
    selectPatient(updated);
  }

  async function createPatient() {
    const name = newForm.name.trim();
    const emr = newForm.emr.trim();
    setNewMsg('');
    if (!name || !emr) { setNewMsg('Name and EMR number are required.'); return; }
    const data = {
      name, emr,
      diagnosis: newForm.diagnosis.trim(), ward: newForm.ward.trim(), age: newForm.age.trim(),
      hospNo: newForm.hospNo.trim(), admissionDate: newForm.admissionDate.trim(), allergies: newForm.allergies.trim(),
      createdAt: serverTimestamp(), createdBy: user ? user.uid : null
    };
    let ref;
    try {
      ref = await addDoc(collection(db, 'patients'), data);
    } catch (e) {
      setNewMsg('Save failed: ' + (e.code || e.message || 'unknown error'));
      return;
    }
    await loadAllPatients(true);
    setShowNewForm(false);
    setNewForm(EMPTY_FORM);
    setNewMsg('');
    selectPatient({ id: ref.id, ...data });
  }

  function openChart(chartName) {
    if (!selectedPatient) return;
    navigate('/charts/' + chartName + '?patient=' + selectedPatient.id);
  }

  function openOverview() {
    if (!selectedPatient) return;
    navigate('/charts/overview?patient=' + selectedPatient.id);
  }

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <>
      <Topbar brand="68 NARHY Ward Charts">
        <a className="whoami-link" onClick={(e) => { e.preventDefault(); navigate('/profile'); }} href="/profile">
          <span className="whoami-avatar" dangerouslySetInnerHTML={{ __html: profile ? avatarMarkup(profile, 32) : '' }} />
          <span className="whoami-name">{profile ? profile.name + ' (' + profile.role + ')' : ''}</span>
        </a>
        {profile?.role === 'admin' && (
          <a href="/admin" className="btn btn-purple" style={{ padding: '6px 12px' }} onClick={(e) => { e.preventDefault(); navigate('/admin'); }}>Admin</a>
        )}
        <a href="/my-patients" className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={(e) => { e.preventDefault(); navigate('/my-patients'); }}>My Patients</a>
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={handleLogout}>Log Out</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <label>Search Patient (EMR number or name)</label>
          <div className="search-row">
            <input
              ref={searchInputRef}
              type="text"
              placeholder="e.g. EMR12345 or John Doe"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
            />
            <button className="btn btn-primary" onClick={doSearch}>Search</button>
            <button className="btn btn-success" onClick={() => setShowNewForm(true)}>+ New Patient</button>
          </div>
          <div className="search-results">
            {searchResults === 'loading' && 'Searching…'}
            {Array.isArray(searchResults) && searchResults.length === 0 && (
              <div className="error-msg">No patient found. Use "+ New Patient" to register them.</div>
            )}
            {Array.isArray(searchResults) && searchResults.map(p => (
              <div key={p.id} className="search-result-item" onClick={() => selectPatient(p)}>
                <span><b>{p.name || 'Unnamed'}</b> — EMR: {p.emr || 'N/A'}</span>
                <span>{p.diagnosis || ''}</span>
              </div>
            ))}
          </div>
        </div>

        {showNewForm && (
          <div className="card-box">
            <h3 style={{ marginTop: 0 }}>Register New Patient</h3>
            <PatientForm form={newForm} setForm={setNewForm} />
            <button className="btn btn-primary" onClick={createPatient}>Save Patient</button>
            <button className="btn btn-secondary" onClick={() => setShowNewForm(false)}>Cancel</button>
            {newMsg && <div className="error-msg">{newMsg}</div>}
          </div>
        )}

        {selectedPatient && (
          <div className="card-box">
            <PatientBanner
              patient={selectedPatient}
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

            {showEditForm && (
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

function PatientForm({ form, setForm }) {
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
