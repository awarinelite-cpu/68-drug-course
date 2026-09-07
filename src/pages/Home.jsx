import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { avatarMarkup } from "../lib/avatar.js";
import Topbar from "../components/Topbar.jsx";
import PatientForm from "../components/PatientForm.jsx";
import { parseBulkText } from "../lib/drugChartHelpers.js";
import { parsePatientFields, extractDrugSection } from "../lib/patientParse.js";

const EMPTY_FORM = { name: '', emr: '', diagnosis: '', ward: '', age: '', hospNo: '', admissionDate: '', allergies: '' };

export default function Home() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const searchInputRef = useRef(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [allPatients, setAllPatients] = useState(null); // null = still loading

  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY_FORM);
  const [newMsg, setNewMsg] = useState('');

  const [showEmrPaste, setShowEmrPaste] = useState(false);
  const [emrPasteText, setEmrPasteText] = useState('');
  const [emrParseMsg, setEmrParseMsg] = useState('');
  const [pendingDrugs, setPendingDrugs] = useState([]);

  useEffect(() => {
    if (window.location.hash === '#search' && searchInputRef.current) {
      searchInputRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      searchInputRef.current.focus();
    }
    loadAllPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAllPatients(force) {
    if (allPatients && !force) return allPatients;
    const snap = await getDocs(collection(db, 'patients'));
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    setAllPatients(list);
    return list;
  }

  function openPatient(p) {
    navigate('/patient?patient=' + p.id);
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
    openPatient({ id: ref.id });
  }

  const q = searchQuery.trim().toLowerCase();
  const visiblePatients = (allPatients || []).filter(p =>
    !q || (p.emr || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)
  );

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
      </Topbar>

      <div className="container">
        <div className="card-box">
          <label>Search Patient (EMR number or name)</label>
          <div className="search-row">
            <input
              id="searchInput"
              ref={searchInputRef}
              type="text"
              placeholder="e.g. EMR12345 or John Doe"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button className="btn btn-primary" onClick={() => searchInputRef.current && searchInputRef.current.focus()}>Search</button>
            <button className="btn btn-success" onClick={() => setShowNewForm(true)}>+ New Patient</button>
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

        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Patients on This Ward</h3>
          <div className="search-results">
            {allPatients === null && 'Loading patients…'}
            {allPatients && visiblePatients.length === 0 && (
              <div className="error-msg">
                {q ? 'No patient matches that search.' : 'No patients on this ward yet. Use "+ New Patient" to register one.'}
              </div>
            )}
            {allPatients && visiblePatients.map(p => (
              <div key={p.id} className="search-result-item" onClick={() => openPatient(p)}>
                <span><b>{p.name || 'Unnamed'}</b> — EMR: {p.emr || 'N/A'}</span>
                <span>{p.diagnosis || ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
