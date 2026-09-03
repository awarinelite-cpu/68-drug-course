import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, query, where, deleteDoc, doc } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import Topbar from "../components/Topbar.jsx";

const SELECTED_PATIENT_KEY = 'selectedPatientId';

function fmtWhen(ts, shift) {
  if (!ts || typeof ts.toDate !== 'function') return shift || '';
  const d = ts.toDate();
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return dateStr + ', ' + timeStr + (shift ? ' \u00b7 ' + shift + ' shift' : '');
}

export default function MyPatients() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | error string
  const [allocations, setAllocations] = useState([]);

  useEffect(() => {
    if (!user) return;
    loadAllocations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function loadAllocations() {
    setStatus('loading');
    let docs = [];
    try {
      // A single equality filter (no orderBy alongside it) avoids needing a
      // composite Firestore index — sorted client-side instead, same as
      // the rest of the app does for small per-user/per-day result sets.
      const snap = await getDocs(query(collection(db, 'allocations'), where('uid', '==', user.uid)));
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
    } catch (e) {
      setStatus("Couldn't load: " + (e.code || e.message || 'unknown error'));
      return;
    }
    // Most recently allocated first — matches "what did I just pick up"
    // better than alphabetical for a start-of-shift review.
    docs.sort((a, b) => {
      const at = a.allocatedAt && a.allocatedAt.toMillis ? a.allocatedAt.toMillis() : 0;
      const bt = b.allocatedAt && b.allocatedAt.toMillis ? b.allocatedAt.toMillis() : 0;
      return bt - at;
    });
    setAllocations(docs);
    setStatus('ready');
  }

  function openPatient(patientId) {
    // Home's own restoreSelectedPatient() picks this up on load and opens
    // straight to that patient's profile — same mechanism used when
    // navigating back to Home from a chart page.
    sessionStorage.setItem(SELECTED_PATIENT_KEY, patientId);
    navigate('/');
  }

  async function removeAllocation(allocationId, ev) {
    ev.stopPropagation();
    try {
      await deleteDoc(doc(db, 'allocations', allocationId));
      setAllocations((prev) => prev.filter(a => a.id !== allocationId));
    } catch (e) {
      alert("Couldn't remove: " + (e.code || e.message || 'unknown error'));
    }
  }

  return (
    <>
      <Topbar brand="My Patients">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => navigate('/')}>Back</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h2 style={{ marginTop: 0 }}>My Allocated Patients</h2>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
            Patients you've allocated to yourself from the Search page. Tap a patient to open their chart, or remove them once you're done.
          </div>

          {status === 'loading' && <div className="loading-note">Loading…</div>}
          {typeof status === 'string' && status !== 'loading' && status !== 'ready' && (
            <div className="loading-note">{status}</div>
          )}

          {status === 'ready' && allocations.length === 0 && (
            <div className="empty-note">
              No patients allocated yet. Search for a patient and tap "Allocate to Me" on their profile.
            </div>
          )}

          {status === 'ready' && allocations.map((a) => (
            <div className="alloc-item" key={a.id} onClick={() => openPatient(a.patientId)}>
              <div className="alloc-main">
                <div className="alloc-name">{a.patientName || 'Unnamed'}</div>
                <div className="alloc-meta">
                  EMR: {a.patientEmr || 'N/A'}
                  {a.patientWard ? '  \u00b7  Ward: ' + a.patientWard : ''}
                  {a.patientDiagnosis ? '  \u00b7  ' + a.patientDiagnosis : ''}
                </div>
                <div className="alloc-when">Allocated {fmtWhen(a.allocatedAt, a.shift)}</div>
              </div>
              <button className="alloc-remove" title="Remove from my list" onClick={(ev) => removeAllocation(a.id, ev)}>Remove</button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
