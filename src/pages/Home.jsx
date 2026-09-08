import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useExitOnDoubleBack } from "../hooks/useExitOnDoubleBack.js";
import { avatarMarkup } from "../lib/avatar.js";
import Topbar from "../components/Topbar.jsx";
import PatientForm from "../components/PatientForm.jsx";
import NewPatientTransfersModal from "../components/NewPatientTransfersModal.jsx";
import { parseBulkText } from "../lib/drugChartHelpers.js";
import { parsePatientFields, extractDrugSection } from "../lib/patientParse.js";
import { generateCsvTemplate, parsePatientCsv } from "../lib/patientCsv.js";
import { pendingTransfersFor } from "../lib/wardTransfer.js";
import { wardHeadcount } from "../lib/wardCensus.js";
import { reportWardKeysForPatientWard, patientWardAndBedTypeForReportKey } from "../lib/wardNameMatch.js";
import { WARDS } from "../lib/nurses-report-common.js";

const EMPTY_FORM = { name: '', emr: '', diagnosis: '', ward: '', pedBedType: '', age: '', hospNo: '', admissionDate: '', allergies: '' };

// Wards are stored/compared in ALL CAPS (matches WARD_OPTIONS); this is
// purely for display so headings don't shout at the reader.
function titleCase(str) {
  return (str || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

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

  const [showTransfers, setShowTransfers] = useState(false);

  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkRows, setBulkRows] = useState(null); // null = no file parsed yet
  const [bulkMsg, setBulkMsg] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);

  const showExitToast = useExitOnDoubleBack();

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
      diagnosis, ward: newForm.ward.trim(),
      pedBedType: newForm.ward.trim() === 'PEDIATRIC/NICU WARD' ? (newForm.pedBedType || '') : '',
      age: newForm.age.trim(),
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

  // --- Bulk upload (CSV) --------------------------------------------------
  function downloadCsvTemplate() {
    const blob = new Blob([generateCsvTemplate()], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'patient-bulk-upload-template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleBulkFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file after a fix
    if (!file) return;
    setBulkFileName(file.name);
    setBulkMsg('');
    setBulkRows(null);
    const reader = new FileReader();
    reader.onload = () => {
      const { headerOk, rows } = parsePatientCsv(String(reader.result || ''));
      if (!headerOk) {
        setBulkMsg('Couldn\u2019t read that file \u2014 make sure it has "Name" and "EMR Number" columns (download the template below if unsure).');
        setBulkRows([]);
        return;
      }
      if (!rows.length) {
        setBulkMsg('No patient rows found in that file.');
        setBulkRows([]);
        return;
      }
      setBulkRows(rows);
      const errorCount = rows.filter(r => r.errors.length).length;
      setBulkMsg(
        rows.length + ' row(s) found' +
        (errorCount ? ', ' + errorCount + ' with errors \u2014 fix or they\u2019ll be skipped.' : ', all look good.')
      );
    };
    reader.onerror = () => setBulkMsg('Could not read that file.');
    reader.readAsText(file);
  }

  async function saveBulkPatients() {
    if (profile?.role !== 'admin') { setBulkMsg('Only an admin can bulk upload patients.'); return; }
    const validRows = (bulkRows || []).filter(r => r.errors.length === 0);
    if (!validRows.length) { setBulkMsg('No valid rows to upload.'); return; }
    setBulkSaving(true);
    const created = [];
    for (const r of validRows) {
      const data = {
        name: r.data.name, emr: r.data.emr, diagnosis: r.data.diagnosis,
        ward: r.data.ward, pedBedType: r.data.ward === 'PEDIATRIC/NICU WARD' ? r.data.pedBedType : '',
        age: r.data.age, hospNo: r.data.hospNo, admissionDate: r.data.admissionDate,
        allergies: r.data.allergies,
        createdAt: serverTimestamp(), createdBy: user ? user.uid : null
      };
      const ref = doc(collection(db, 'patients'));
      setDoc(ref, data).catch((e) => {
        console.warn('Bulk patient write queued locally; will retry once back online:', e);
      });
      created.push({ id: ref.id, ...data });
    }
    setAllPatients((prev) => prev ? [...prev, ...created] : created);
    setBulkSaving(false);
    setBulkMsg('Uploaded ' + created.length + ' patient(s).');
    setBulkRows(null);
    setBulkFileName('');
  }

  function clearBulkUpload() {
    setShowBulkUpload(false);
    setBulkRows(null);
    setBulkFileName('');
    setBulkMsg('');
  }

  const q = searchQuery.trim().toLowerCase();
  const myWard = profile?.ward || '';
  // Patients mid-transfer (pendingTransfer set) are held out of every
  // normal ward list — they only show up in the receiving ward's "New
  // Patient" queue below until a nurse there accepts or rejects them.
  // The search box is a general patient lookup, not a ward-scoped one: once
  // the nurse types something, we search across every ward. With no query,
  // we fall back to the normal "my ward" list.
  const visiblePatients = (allPatients || []).filter(p =>
    !p.pendingTransfer &&
    (q
      ? ((p.emr || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q))
      : (!myWard || p.ward === myWard))
  );
  // The count shown next to the heading. Where myWard has a matching
  // nurse-report ward (see reportWardKeysForPatientWard), it's that
  // ward's live Occ from today's Shift Statistics report — a split ward
  // like PEDIATRIC/NICU WARD sums both its report wards' Occ here, with
  // the per-ward breakdown rendered separately below. Wards with no
  // report equivalent (e.g. THEATER) fall back to the actual patient
  // headcount, same as before. Either way this is independent of any
  // active search filter above, and headcount is still what a matching
  // ward report's Previous Occ auto-fills from on shift handover.
  const reportWardKeys = reportWardKeysForPatientWard(myWard);
  const isSplitWard = reportWardKeys.length > 1;
  // Per report-ward-key count: the actual number of patients currently
  // registered on this ward in the app (not the shift report's Occ
  // figure), so the badge always matches the patient list right below
  // it. For a split ward (currently only PEDIATRIC/NICU WARD), each
  // key's headcount is further narrowed to patients whose pedBedType
  // matches that key's Bed/Cot side (see
  // patientWardAndBedTypeForReportKey) — patients with no pedBedType set
  // yet aren't counted on either side here, but still show up in the
  // "Bed/Cot not set" group in the list below.
  const wardBreakdown = reportWardKeys.map((k) => {
    const info = patientWardAndBedTypeForReportKey(k);
    const count = wardHeadcount(allPatients, myWard, info?.bedType);
    return { key: k, bedType: info?.bedType || null, count };
  });
  const wardPatientCount = reportWardKeys.length
    ? wardBreakdown.reduce((sum, x) => sum + x.count, 0)
    : wardHeadcount(allPatients, myWard);
  const incomingTransfers = pendingTransfersFor(allPatients, myWard);
  // Grouped view of the patient list for a split ward — Bed / Cot
  // sections plus an "unset" bucket, instead of one flat list, so the
  // list matches the per-key badges above it. Only makes sense for the
  // unfiltered "my ward" view; a cross-ward search stays a flat list.
  const pedGroups = isSplitWard && !q
    ? (() => {
        const groups = wardBreakdown.map((b) => ({
          ...b,
          label: (WARDS.find((w) => w.key === b.key) || {}).label || b.key,
          patients: visiblePatients.filter((p) => p.pedBedType === b.bedType)
        }));
        const assigned = new Set(groups.flatMap((g) => g.patients.map((p) => p.id)));
        const unassigned = visiblePatients.filter((p) => !assigned.has(p.id));
        return { groups, unassigned };
      })()
    : null;

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
        {myWard && (
          <a href="#" className="btn btn-secondary notif-bell-btn" style={{ padding: '6px 12px' }} onClick={(e) => { e.preventDefault(); setShowTransfers(true); }}>
            🔔 New Patient
            {incomingTransfers.length > 0 && <span className="notif-count-badge">{incomingTransfers.length}</span>}
          </a>
        )}
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
            <button className="btn btn-success" onClick={() => { setNewForm((f) => ({ ...f, ward: f.ward || myWard })); setShowNewForm(true); }}>+ New Patient</button>
            {profile?.role === 'admin' && (
              <button className="btn btn-secondary" onClick={() => setShowBulkUpload(true)}>📁 Bulk Upload</button>
            )}
          </div>
        </div>

        {showBulkUpload && profile?.role === 'admin' && (
          <div className="card-box">
            <h3 style={{ marginTop: 0 }}>Bulk Upload Patients (CSV)</h3>
            <p style={{ fontSize: 12, color: '#555' }}>
              Upload a CSV of patients and they\u2019ll be created and sorted into their wards automatically \u2014
              same fields as the New Patient form. Not sure of the format? Download the template first.
            </p>
            <div style={{ marginBottom: 10 }}>
              <button className="btn btn-secondary" onClick={downloadCsvTemplate}>⬇ Download CSV Template</button>
            </div>
            <div className="field">
              <label>Choose CSV file</label>
              <input type="file" accept=".csv,text/csv" onChange={handleBulkFile} />
            </div>
            {bulkFileName && <div style={{ fontSize: 12, color: '#555' }}>{bulkFileName}</div>}
            {bulkMsg && <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>{bulkMsg}</div>}

            {bulkRows && bulkRows.length > 0 && (
              <div style={{ marginTop: 10, overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Line</th>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Name</th>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>EMR</th>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Ward</th>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map((r) => (
                      <tr key={r.line} style={r.errors.length ? { background: '#fef2f2' } : undefined}>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>{r.line}</td>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>{r.data.name || '—'}</td>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>{r.data.emr || '—'}</td>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>{r.data.ward || '—'}</td>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12, color: r.errors.length ? '#b91c1c' : '#16a34a' }}>
                          {r.errors.length ? r.errors.join('; ') : 'OK'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                  Rows in red have errors and will be skipped. Fix them in your CSV and re-upload if needed.
                </div>
              </div>
            )}

            <div style={{ marginTop: 10 }}>
              <button
                className="btn btn-primary"
                disabled={bulkSaving || !bulkRows || !bulkRows.some(r => r.errors.length === 0)}
                onClick={saveBulkPatients}
              >
                {bulkSaving ? 'Uploading…' : 'Upload Patients'}
              </button>
              <button className="btn btn-secondary" onClick={clearBulkUpload}>Cancel</button>
            </div>
          </div>
        )}

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
          <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span>Patients on {myWard ? titleCase(myWard) : 'All Wards'} <span className="ward-count-badge">{wardPatientCount}</span></span>
            <a href="/profile" onClick={(e) => { e.preventDefault(); navigate('/profile'); }} style={{ fontSize: 12, fontWeight: 'normal' }}>
              {myWard ? 'Switch ward' : 'Set your ward'}
            </a>
          </h3>
          {isSplitWard && (
            <div className="ward-split-counts">
              {wardBreakdown.map(({ key: k, count }) => {
                const w = WARDS.find((x) => x.key === k);
                return (
                  <span className="ward-split-badge" key={k}>
                    {w ? w.label : k}<span className="ward-count-badge">{count}</span>
                  </span>
                );
              })}
            </div>
          )}
          <div className="search-results">
            {allPatients === null && 'Loading patients…'}
            {allPatients && visiblePatients.length === 0 && (
              <div className="error-msg">
                {q ? 'No patient matches that search.' :
                  (myWard ? 'No patients on ' + myWard + ' yet. Use "+ New Patient" to register one.' : 'No patients registered yet. Use "+ New Patient" to register one.')}
              </div>
            )}
            {allPatients && visiblePatients.length > 0 && pedGroups && (
              <>
                {pedGroups.groups.map((g) => (
                  <div key={g.key} style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 'bold', fontSize: 13, margin: '8px 0 4px' }}>{g.label} ({g.patients.length})</div>
                    {g.patients.length === 0 && <div style={{ fontSize: 12, color: '#888' }}>No patients yet.</div>}
                    {g.patients.map(p => (
                      <div key={p.id} className="search-result-item" onClick={() => openPatient(p)}>
                        <span><b>{p.name || 'Unnamed'}</b>{'. '}EMR: {p.emr || 'N/A'}</span>
                        <span>{p.diagnosis || ''}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {pedGroups.unassigned.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 'bold', fontSize: 13, margin: '8px 0 4px', color: '#b45309' }}>
                      Bed/Cot not set ({pedGroups.unassigned.length})
                    </div>
                    {pedGroups.unassigned.map(p => (
                      <div key={p.id} className="search-result-item" onClick={() => openPatient(p)}>
                        <span><b>{p.name || 'Unnamed'}</b>{'. '}EMR: {p.emr || 'N/A'}</span>
                        <span>{p.diagnosis || ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {allPatients && visiblePatients.length > 0 && !pedGroups && visiblePatients.map(p => (
              <div key={p.id} className="search-result-item" onClick={() => openPatient(p)}>
                <span><b>{p.name || 'Unnamed'}</b>{'. '}EMR: {p.emr || 'N/A'}{q && p.ward ? '. Ward: ' + p.ward : ''}</span>
                <span>{p.diagnosis || ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showTransfers && (
        <NewPatientTransfersModal
          ward={myWard}
          transfers={incomingTransfers}
          onClose={() => setShowTransfers(false)}
          onResolved={() => loadAllPatients(true)}
        />
      )}

      {showExitToast && (
        <div className="exit-toast no-print" role="status">Press back again to exit</div>
      )}
    </>
  );
}
