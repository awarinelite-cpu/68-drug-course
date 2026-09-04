import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, updateDoc, doc, getDoc, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { avatarMarkup } from "../lib/avatar.js";
import Topbar from "../components/Topbar.jsx";
import PatientBanner from "../components/PatientBanner.jsx";
import { parseBulkText } from "../lib/drugChartHelpers.js";
import { parsePatientFields, extractDrugSection } from "../lib/patientParse.js";

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

  const [showEmrPaste, setShowEmrPaste] = useState(false);
  const [emrPasteText, setEmrPasteText] = useState('');
  const [emrParseMsg, setEmrParseMsg] = useState('');
  const [pendingDrugs, setPendingDrugs] = useState([]);

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
    // Same offline-hang issue as createPatient: don't await these writes —
    // with offline persistence they queue locally and sync automatically,
    // but their Promises won't resolve until back online, which would leave
    // the Allocate button stuck disabled indefinitely while offline.
    if (allocatedToMe) {
      deleteDoc(ref).catch((e) => console.warn('Allocation removal queued locally; will retry once back online:', e));
      setAllocatedToMe(false);
    } else {
      setDoc(ref, {
        uid: user.uid,
        nurseName: profile?.name || '',
        patientId: selectedPatient.id,
        patientName: selectedPatient.name || 'Unnamed',
        patientEmr: selectedPatient.emr || '',
        patientWard: selectedPatient.ward || '',
        patientDiagnosis: selectedPatient.diagnosis || '',
        shift: currentShiftLabel(),
        allocatedAt: serverTimestamp()
      }).catch((e) => console.warn('Allocation queued locally; will retry once back online:', e));
      setAllocatedToMe(true);
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
    // Not awaited — same offline-hang reason as createPatient/toggleAllocation
    // above: it queues locally and syncs on reconnect either way.
    updateDoc(doc(db, 'patients', selectedPatient.id), updates).catch((e) => {
      console.warn('Patient edit queued locally; will retry once back online:', e);
    });
    const updated = { ...selectedPatient, ...updates };
    delete updated.updatedAt;
    setAllPatients((prev) => prev ? prev.map((p) => p.id === selectedPatient.id ? { ...p, ...updated } : p) : prev);
    setShowEditForm(false);
    selectPatient(updated);
  }

  // --- Paste from EMR (bulk fill on patient registration) -------------------
  function parseEmrPaste() {
    setEmrParseMsg('');
    if (!emrPasteText.trim()) { setEmrParseMsg('Paste the patient\u2019s EMR text first.'); return; }
    const fields = parsePatientFields(emrPasteText);
    setNewForm((f) => ({
      name: fields.name || f.name,
      emr: fields.emr || f.emr,
      diagnosis: fields.diagnosis || f.diagnosis,
      ward: fields.ward || f.ward,
      age: fields.age || f.age,
      hospNo: fields.hospNo || f.hospNo,
      admissionDate: fields.admissionDate || f.admissionDate,
      allergies: fields.allergies || f.allergies
    }));
    const drugBlock = extractDrugSection(emrPasteText);
    const drugs = drugBlock ? parseBulkText(drugBlock) : [];
    setPendingDrugs(drugs);
    const foundCount = Object.values(fields).filter(Boolean).length;
    setEmrParseMsg(
      (foundCount ? 'Filled ' + foundCount + ' patient field(s)' : 'Could not find patient details in that text') +
      (drugs.length ? ', and found ' + drugs.length + ' drug order(s) below.' : ' \u2014 no drug orders found.') +
      ' Please review everything before saving.'
    );
  }
  function updatePendingDrug(i, patch) { setPendingDrugs((rows) => rows.map((r, idx) => idx === i ? { ...r, ...patch } : r)); }
  function removePendingDrug(i) { setPendingDrugs((rows) => rows.filter((_, idx) => idx !== i)); }
  function clearEmrPaste() { setShowEmrPaste(false); setEmrPasteText(''); setEmrParseMsg(''); setPendingDrugs([]); }

  async function createPatient() {
    const name = newForm.name.trim();
    const emr = newForm.emr.trim();
    setNewMsg('');
    if (!name || !emr) { setNewMsg('Name and EMR number are required.'); return; }
    const diagnosis = newForm.diagnosis.trim();
    const data = {
      name, emr,
      diagnosis, ward: newForm.ward.trim(), age: newForm.age.trim(),
      hospNo: newForm.hospNo.trim(), admissionDate: newForm.admissionDate.trim(), allergies: newForm.allergies.trim(),
      createdAt: serverTimestamp(), createdBy: user ? user.uid : null
    };

    // Client-generated ID — doc() needs no network round trip, so the patient
    // is usable immediately even offline. We deliberately do NOT await
    // setDoc(): with offline persistence enabled, the write lands in the
    // local IndexedDB cache synchronously, but the returned Promise itself
    // only resolves once the device is back online and the backend
    // acknowledges the write (documented Firestore SDK behavior). Awaiting
    // it here is exactly what made "Save Patient" hang forever while
    // offline — it queues fine locally and syncs automatically on
    // reconnect, so there's nothing to wait for.
    const ref = doc(collection(db, 'patients'));
    setDoc(ref, data).catch((e) => {
      console.warn('Patient write queued locally; will retry once back online:', e);
    });

    if (pendingDrugs.length) {
      setDoc(doc(db, 'patients', ref.id, 'drugCourseChart', 'main'), {
        f_admission: '', f_discharge: '', f_diagnosis: diagnosis,
        drugs: pendingDrugs, rows: [], verbalOrders: [], careInstructions: [], auditLog: [],
        updatedAt: serverTimestamp()
      }).catch((e) => {
        console.warn('Drug list write queued locally; will retry once back online:', e);
      });
    }
    // Update the in-memory list directly instead of re-fetching the whole
    // patients collection — that fetch isn't needed (we already have the
    // new patient's data) and, like the writes above, is best avoided here
    // so this flow doesn't depend on a round trip at all while offline.
    setAllPatients((prev) => prev ? [...prev, { id: ref.id, ...data }] : [{ id: ref.id, ...data }]);
    setShowNewForm(false);
    setNewForm(EMPTY_FORM);
    clearEmrPaste();
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

            <button className="btn btn-secondary" style={{ marginBottom: 10 }} onClick={() => setShowEmrPaste((v) => !v)}>
              {showEmrPaste ? 'Hide Paste from EMR' : '📋 Paste from EMR'}
            </button>

            {showEmrPaste && (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginBottom: 14 }}>
                <label>Paste the patient's EMR page (header + notes) here</label>
                <textarea
                  rows={6}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
                  placeholder="Copy everything from the patient's EMR page and paste it here…"
                  value={emrPasteText}
                  onChange={(e) => setEmrPasteText(e.target.value)}
                />
                <div style={{ marginTop: 8 }}>
                  <button className="btn btn-primary" onClick={parseEmrPaste}>Parse</button>
                  <button className="btn btn-secondary" onClick={clearEmrPaste}>Clear</button>
                </div>
                {emrParseMsg && <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>{emrParseMsg}</div>}

                {pendingDrugs.length > 0 && (
                  <div style={{ marginTop: 10, overflowX: 'auto' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                      Drug orders found — review before saving:
                    </div>
                    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Drug Name</th>
                          <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Route</th>
                          <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Frequency</th>
                          <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Duration</th>
                          <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingDrugs.map((d, i) => (
                          <tr key={i}>
                            <td style={{ border: '1px solid #000', padding: 3 }}><input type="text" style={{ width: '100%', border: 'none', fontSize: 12 }} value={d.name} onChange={(e) => updatePendingDrug(i, { name: e.target.value })} /></td>
                            <td style={{ border: '1px solid #000', padding: 3 }}><input type="text" style={{ width: '100%', border: 'none', fontSize: 12 }} value={d.route} onChange={(e) => updatePendingDrug(i, { route: e.target.value })} /></td>
                            <td style={{ border: '1px solid #000', padding: 3 }}><input type="text" style={{ width: '100%', border: 'none', fontSize: 12 }} value={d.frequency} onChange={(e) => updatePendingDrug(i, { frequency: e.target.value })} /></td>
                            <td style={{ border: '1px solid #000', padding: 3 }}><input type="text" style={{ width: '100%', border: 'none', fontSize: 12 }} value={d.duration} onChange={(e) => updatePendingDrug(i, { duration: e.target.value })} /></td>
                            <td style={{ border: '1px solid #000', padding: 3, textAlign: 'center' }}><button className="remove-drug-btn" onClick={() => removePendingDrug(i)}>x</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                      These will be added to the patient's Drug Course Chart automatically once saved. Any custom frequency text can be picked from the dropdown there afterward.
                    </div>
                  </div>
                )}
              </div>
            )}

            <PatientForm form={newForm} setForm={setNewForm} />
            <button className="btn btn-primary" onClick={createPatient}>Save Patient</button>
            <button className="btn btn-secondary" onClick={() => { setShowNewForm(false); clearEmrPaste(); }}>Cancel</button>
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
