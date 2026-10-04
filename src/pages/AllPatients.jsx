import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, doc, deleteDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import Topbar from "../components/Topbar.jsx";
import { releaseEmrIndex } from "../lib/patientUnique.js";

// Every chart type and archived-admission record a patient can accumulate.
// Firestore doesn't cascade-delete subcollections when the parent doc is
// removed, so each one has to be cleared out explicitly first.
const PATIENT_SUBCOLLECTIONS = ['admissions', 'bloodGlucose', 'drugCourseChart', 'intakeOutput', 'intakeOutputSummary', 'seizure', 'vitals'];

// Trims, collapses whitespace and lowercases before comparing typed
// confirmation text (mobile keyboards can inject stray spaces / capitals).
function normalizeConfirmText(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export default function AllPatients() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/admin');
  const isAdmin = profile?.role === 'admin';

  const [allPatients, setAllPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [patientFilter, setPatientFilter] = useState('');
  const [patientStatus, setPatientStatus] = useState('');

  const [selectedPatientIds, setSelectedPatientIds] = useState(() => new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteInput, setBulkDeleteInput] = useState('');
  const [bulkDeleteError, setBulkDeleteError] = useState('');
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null); // patient record
  const [deleteInput, setDeleteInput] = useState('');
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => { loadPatients(); }, []);

  async function loadPatients() {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'patients'));
      const list = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setAllPatients(list);
    } catch (e) {
      setPatientStatus("Couldn't load patients: " + (e.code || e.message || 'unknown error'));
    }
    setLoading(false);
  }

  const filteredPatients = (() => {
    const q = patientFilter.trim().toLowerCase();
    return !q ? allPatients : allPatients.filter(p =>
      (p.name || '').toLowerCase().includes(q) || (p.emr || '').toLowerCase().includes(q) || (p.ward || '').toLowerCase().includes(q) || (p.diagnosis || '').toLowerCase().includes(q)
    );
  })();

  function openPatient(p) { navigate('/charts/overview?patient=' + p.id); }

  function openDeletePatientModal(p) {
    setDeleteTarget(p);
    setDeleteInput('');
    setDeleteError('');
  }
  function closeDeleteModal() { setDeleteTarget(null); }

  async function deletePatientRecords(p) {
    async function deleteAllInSubcollection(sub) {
      const snap = await getDocs(collection(db, 'patients', p.id, sub));
      await Promise.all(snap.docs.map(d => deleteDoc(doc(db, 'patients', p.id, sub, d.id))));
    }
    await Promise.all(PATIENT_SUBCOLLECTIONS.map(deleteAllInSubcollection));
    await releaseEmrIndex(p.id, p.emr);
    await deleteDoc(doc(db, 'patients', p.id));
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const p = deleteTarget;
    const expected = (p.emr || '').trim() || 'DELETE';
    if (normalizeConfirmText(deleteInput) !== normalizeConfirmText(expected)) {
      setDeleteError('That didn\u2019t match — nothing was deleted. Please re-type it exactly.');
      return;
    }
    setDeleteTarget(null);
    setPatientStatus('Deleting ' + (p.name || 'patient') + '…');
    try {
      await deletePatientRecords(p);
    } catch (e) {
      alert('Delete failed: ' + (e.code || e.message || 'unknown error'));
      setPatientStatus('');
      return;
    }
    setAllPatients((list) => list.filter(x => x.id !== p.id));
    setSelectedPatientIds((prev) => { const n = new Set(prev); n.delete(p.id); return n; });
    setPatientStatus('');
  }

  const allFilteredSelected = filteredPatients.length > 0 && filteredPatients.every(p => selectedPatientIds.has(p.id));
  const selectedPatients = allPatients.filter(p => selectedPatientIds.has(p.id));

  function togglePatientSelected(id) {
    setSelectedPatientIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleSelectAllFiltered() {
    setSelectedPatientIds((prev) => {
      const n = new Set(prev);
      if (allFilteredSelected) filteredPatients.forEach(p => n.delete(p.id));
      else filteredPatients.forEach(p => n.add(p.id));
      return n;
    });
  }

  function openBulkDeleteModal() {
    if (!selectedPatients.length) return;
    setBulkDeleteInput('');
    setBulkDeleteError('');
    setBulkDeleteOpen(true);
  }
  function closeBulkDeleteModal() { if (!bulkDeleting) setBulkDeleteOpen(false); }

  async function confirmBulkDelete() {
    if (bulkDeleting) return;
    if (normalizeConfirmText(bulkDeleteInput) !== 'delete') {
      setBulkDeleteError('That didn\u2019t match — nothing was deleted. Please type DELETE exactly.');
      return;
    }
    const targets = selectedPatients;
    setBulkDeleting(true);
    setBulkDeleteError('');
    const deletedIds = [];
    const failed = [];
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      setPatientStatus('Deleting patient ' + (i + 1) + ' of ' + targets.length + '…');
      try {
        await deletePatientRecords(p);
        deletedIds.push(p.id);
      } catch (e) {
        failed.push((p.name || 'Unnamed') + ' (' + (e.code || e.message || 'unknown error') + ')');
      }
    }
    const gone = new Set(deletedIds);
    setAllPatients((list) => list.filter(x => !gone.has(x.id)));
    setSelectedPatientIds((prev) => { const n = new Set(prev); deletedIds.forEach(id => n.delete(id)); return n; });
    setPatientStatus(failed.length
      ? 'Deleted ' + deletedIds.length + ' patient(s); ' + failed.length + ' failed: ' + failed.join(', ')
      : 'Deleted ' + deletedIds.length + ' patient(s).');
    setBulkDeleting(false);
    setBulkDeleteOpen(false);
  }

  if (!profile) return null;

  const deleteLabel = deleteTarget ? (deleteTarget.name || 'Unnamed') + ' (EMR: ' + (deleteTarget.emr || 'N/A') + ')' : '';
  const deletePromptLabel = deleteTarget
    ? ((deleteTarget.emr || '').trim() ? ('Type the patient\u2019s EMR number to confirm: ' + deleteTarget.emr) : 'No EMR on file — type DELETE to confirm')
    : '';

  return (
    <>
      <Topbar brand="68 NARHY Ward Charts — All Patients">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>All Patients</h3>
          <div className="search-row">
            <input type="text" placeholder="Search by name, EMR, ward, or diagnosis" value={patientFilter} onChange={(e) => setPatientFilter(e.target.value)} />
          </div>
          <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
            {patientStatus || (loading ? 'Loading patients…' : (filteredPatients.length + ' of ' + allPatients.length + ' patient(s)' + (patientFilter.trim() ? ' matching "' + patientFilter.trim() + '"' : '')))}
          </div>
          {isAdmin && selectedPatients.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn" style={{ background: '#dc2626', color: '#fff' }} disabled={bulkDeleting} onClick={openBulkDeleteModal}>
                Delete selected ({selectedPatients.length})
              </button>
              <button className="btn btn-secondary" disabled={bulkDeleting} onClick={() => setSelectedPatientIds(new Set())}>Clear selection</button>
            </div>
          )}
          <div className="table-wrap">
            <table className="entries">
              <thead><tr>
                {isAdmin && (
                  <th style={{ width: 36 }}>
                    <input type="checkbox" style={{ width: 'auto' }} aria-label="Select all patients shown"
                      title={allFilteredSelected ? 'Unselect all shown' : 'Select all shown'}
                      checked={allFilteredSelected} disabled={!filteredPatients.length || bulkDeleting} onChange={toggleSelectAllFiltered} />
                  </th>
                )}
                <th>Name</th><th>EMR</th><th>Ward</th><th>Diagnosis</th><th>Admission Date</th>{isAdmin && <th></th>}
              </tr></thead>
              <tbody>
                {!filteredPatients.length && <tr><td colSpan={isAdmin ? 7 : 5} style={{ color: '#666' }}>{loading ? 'Loading…' : 'No patients found.'}</td></tr>}
                {filteredPatients.map((p) => (
                  <tr key={p.id}>
                    {isAdmin && (
                      <td>
                        <input type="checkbox" style={{ width: 'auto' }} aria-label={'Select ' + (p.name || 'patient')}
                          checked={selectedPatientIds.has(p.id)} disabled={bulkDeleting} onChange={() => togglePatientSelected(p.id)} />
                      </td>
                    )}
                    <td style={{ textAlign: 'left', cursor: 'pointer' }} title={'Open ' + (p.name || 'this patient') + '\u2019s overview'} onClick={() => openPatient(p)}>{p.name || 'Unnamed'}</td>
                    <td style={{ cursor: 'pointer' }} onClick={() => openPatient(p)}>{p.emr || '-'}</td>
                    <td style={{ cursor: 'pointer' }} onClick={() => openPatient(p)}>{p.ward || '-'}</td>
                    <td style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => openPatient(p)}>{p.diagnosis || 'Not specified'}</td>
                    <td style={{ cursor: 'pointer' }} onClick={() => openPatient(p)}>{p.admissionDate || '-'}</td>
                    {isAdmin && (
                      <td>
                        <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11, background: '#dc2626', color: '#fff', border: 'none' }}
                          onClick={(e) => { e.stopPropagation(); openDeletePatientModal(p); }}>Delete</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {bulkDeleteOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div className="card-box" style={{ maxWidth: 420, width: '100%', margin: 0 }}>
            <h3 style={{ marginTop: 0, color: '#dc2626' }}>Delete {selectedPatients.length} Patient{selectedPatients.length === 1 ? '' : 's'}</h3>
            <p style={{ fontSize: 14, color: '#374151' }}>
              This permanently deletes {selectedPatients.length === allPatients.length ? 'ALL ' : ''}{selectedPatients.length} selected patient{selectedPatients.length === 1 ? '' : 's'} and every
              chart, drug list, and closed-admission record for them. This cannot be undone. Consider downloading a
              full backup (bottom of the Admin page) first.
            </p>
            <div className="field">
              <label>Type DELETE to confirm</label>
              <input type="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck="false"
                value={bulkDeleteInput} onChange={(e) => setBulkDeleteInput(e.target.value)} disabled={bulkDeleting}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmBulkDelete(); } else if (e.key === 'Escape') closeBulkDeleteModal(); }}
                autoFocus />
            </div>
            {bulkDeleteError && <div className="error-msg">{bulkDeleteError}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} disabled={bulkDeleting} onClick={closeBulkDeleteModal}>Cancel</button>
              <button className="btn" style={{ flex: 1, background: '#dc2626', color: '#fff' }} disabled={bulkDeleting} onClick={confirmBulkDelete}>
                {bulkDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div className="card-box" style={{ maxWidth: 420, width: '100%', margin: 0 }}>
            <h3 style={{ marginTop: 0, color: '#dc2626' }}>Delete Patient</h3>
            <p style={{ fontSize: 14, color: '#374151' }}>
              This permanently deletes {deleteLabel} and every chart, drug list, and closed-admission record for this patient. This cannot be undone.
            </p>
            <div className="field">
              <label>{deletePromptLabel}</label>
              <input type="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck="false"
                value={deleteInput} onChange={(e) => setDeleteInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmDelete(); } else if (e.key === 'Escape') closeDeleteModal(); }}
                autoFocus />
            </div>
            {deleteError && <div className="error-msg">{deleteError}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={closeDeleteModal}>Cancel</button>
              <button className="btn" style={{ flex: 1, background: '#dc2626', color: '#fff' }} onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
