import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, doc, deleteDoc, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import Topbar from "../components/Topbar.jsx";

// Admin tool: finds patient records that share the same EMR number (the cause
// of the "Duplicate EMR" warning in the ward-report patient picker), shows
// what each one holds, and lets the admin keep one and fold the others into it.

const PATIENT_SUBCOLLECTIONS = ['admissions', 'bloodGlucose', 'drugCourseChart', 'intakeOutput', 'intakeOutputSummary', 'seizure', 'vitals'];
const SUB_LABELS = { admissions: 'admissions', bloodGlucose: 'glucose', drugCourseChart: 'drug chart', intakeOutput: 'I/O', intakeOutputSummary: 'I/O summary', seizure: 'seizure', vitals: 'vitals' };
// Descriptive fields copied onto the kept record only when it has them empty.
const FILL_FIELDS = ['phone', 'address', 'nextKinName', 'diagnosis', 'age', 'gender', 'admissionDate', 'allergies', 'insurance', 'hospNo', 'armyNumber'];

const normEmr = (e) => String(e || '').trim().toLowerCase();
const norm = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();

function tsText(v) {
  if (!v) return '';
  const ms = typeof v.toMillis === 'function' ? v.toMillis() : (typeof v.seconds === 'number' ? v.seconds * 1000 : (typeof v === 'number' ? v : 0));
  return ms ? new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

export default function DuplicatePatients() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/admin');
  const isAdmin = profile?.role === 'admin';

  const [groups, setGroups] = useState([]);   // [{ emr, records: [{...patient, counts}] }]
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [target, setTarget] = useState(null); // { group, keep }
  const [confirmText, setConfirmText] = useState('');
  const [confirmErr, setConfirmErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (isAdmin) load(); else setLoading(false); }, [isAdmin]);

  async function load() {
    setLoading(true);
    setMsg('');
    try {
      const snap = await getDocs(collection(db, 'patients'));
      const byEmr = {};
      snap.forEach((d) => {
        const data = d.data();
        const k = normEmr(data.emr);
        if (!k) return;
        (byEmr[k] = byEmr[k] || []).push({ id: d.id, ...data });
      });
      const dupGroups = Object.entries(byEmr).filter(([, recs]) => recs.length > 1);
      // What each record holds, so the admin can tell the live one from the empty one.
      const out = [];
      for (const [emr, recs] of dupGroups) {
        const withCounts = await Promise.all(recs.map(async (r) => {
          const counts = {};
          await Promise.all(PATIENT_SUBCOLLECTIONS.map(async (sub) => {
            try { counts[sub] = (await getDocs(collection(db, 'patients', r.id, sub))).size; } catch (e) { counts[sub] = 0; }
          }));
          return { ...r, counts };
        }));
        withCounts.sort((a, b) => totalDocs(b) - totalDocs(a));
        out.push({ emr, records: withCounts });
      }
      out.sort((a, b) => (a.records[0].name || '').localeCompare(b.records[0].name || ''));
      setGroups(out);
    } catch (e) {
      setMsg("Couldn't load patients: " + (e.code || e.message || 'unknown error'));
    }
    setLoading(false);
  }

  function totalDocs(r) { return Object.values(r.counts || {}).reduce((a, b) => a + b, 0); }

  function openKeep(group, keep) {
    setTarget({ group, keep });
    setConfirmText('');
    setConfirmErr('');
  }

  async function confirmKeep() {
    if (!target || busy) return;
    const { group, keep } = target;
    const expected = (keep.emr || '').trim();
    if (norm(confirmText) !== norm(expected)) {
      setConfirmErr('That didn\u2019t match — nothing was changed. Type the EMR number exactly.');
      return;
    }
    setBusy(true);
    setConfirmErr('');
    try {
      const others = group.records.filter((r) => r.id !== keep.id);
      for (const o of others) {
        // 1) Copy chart/admission documents the kept record doesn't already have.
        for (const sub of PATIENT_SUBCOLLECTIONS) {
          const [srcSnap, dstSnap] = await Promise.all([
            getDocs(collection(db, 'patients', o.id, sub)),
            getDocs(collection(db, 'patients', keep.id, sub))
          ]);
          const have = new Set(dstSnap.docs.map((d) => d.id));
          for (const d of srcSnap.docs) {
            if (!have.has(d.id)) await setDoc(doc(db, 'patients', keep.id, sub, d.id), d.data());
          }
        }
        // 2) Fill descriptive fields the kept record is missing.
        const patch = {};
        FILL_FIELDS.forEach((f) => {
          const kv = keep[f];
          const ov = o[f];
          if ((kv === undefined || kv === null || kv === '') && ov !== undefined && ov !== null && ov !== '') patch[f] = ov;
        });
        if (Object.keys(patch).length) await updateDoc(doc(db, 'patients', keep.id), patch);
        // 3) Remove the duplicate (its subcollections first — Firestore doesn't cascade).
        for (const sub of PATIENT_SUBCOLLECTIONS) {
          const snap = await getDocs(collection(db, 'patients', o.id, sub));
          await Promise.all(snap.docs.map((d) => deleteDoc(doc(db, 'patients', o.id, sub, d.id))));
        }
        await deleteDoc(doc(db, 'patients', o.id));
      }
      setTarget(null);
      setMsg('Done — kept ' + (keep.name || 'record') + ' (' + keep.emr + ') and removed ' + others.length + ' duplicate record(s).');
      await load();
    } catch (e) {
      setConfirmErr('Failed part-way: ' + (e.code || e.message || 'unknown error') + '. Nothing already copied was lost; reload and try again.');
    }
    setBusy(false);
  }

  function summary(r) {
    const parts = PATIENT_SUBCOLLECTIONS.filter((s) => r.counts[s]).map((s) => r.counts[s] + ' ' + SUB_LABELS[s]);
    return parts.length ? parts.join(' · ') : 'No charts or entries';
  }

  return (
    <>
      <Topbar brand="68 NARHY Ward Charts — Duplicate Patients">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Duplicate patients (same EMR)</h3>
          {!isAdmin && <div className="error-msg">Admins only.</div>}
          {isAdmin && (
            <>
              <p style={{ fontSize: 13, color: '#555', marginTop: 0 }}>
                Each group below is one EMR number with more than one patient record. Look at what each record holds, then tap
                <b> Keep this one</b> on the correct record — any charts on the others are copied into it first, then the extras are removed.
                Ward statistics counters are not changed by this.
              </p>
              <div style={{ fontSize: 13, color: '#555' }}>
                {loading ? 'Checking all patients…' : (groups.length ? groups.length + ' EMR number(s) with duplicate records' : 'No duplicate EMR records found.')}
              </div>
              {msg && <div className="info-msg" style={{ marginTop: 8 }}>{msg}</div>}
              <button className="btn btn-secondary" style={{ marginTop: 8 }} disabled={loading || busy} onClick={load}>Re-check</button>
            </>
          )}
        </div>

        {isAdmin && groups.map((g) => (
          <div className="card-box" key={g.emr}>
            <h3 style={{ marginTop: 0 }}>EMR {g.records[0].emr} <span style={{ fontWeight: 400, fontSize: 14 }}>— {g.records.length} records</span></h3>
            {g.records.map((r, i) => (
              <div key={r.id} style={{ border: '2px solid #94a3b8', borderRadius: 12, padding: 12, marginTop: 10 }}>
                <div style={{ fontWeight: 800, fontSize: 17 }}>{r.name || 'Unnamed'}{i === 0 && totalDocs(r) > 0 ? ' · most data' : ''}</div>
                <div style={{ fontSize: 14, marginTop: 4 }}>
                  Ward: <b>{r.ward || '—'}</b>{r.dischargeStatus ? ' · ' + r.dischargeStatus : ''} · Age: {r.age || '—'} · Admitted: {r.admissionDate || '—'}
                </div>
                <div style={{ fontSize: 14, marginTop: 2 }}>Diagnosis: {r.diagnosis || '—'}</div>
                <div style={{ fontSize: 14, marginTop: 2 }}>Holds: <b>{summary(r)}</b></div>
                {tsText(r.createdAt) && <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>Created {tsText(r.createdAt)}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary" onClick={() => navigate('/charts/overview?patient=' + r.id)}>Open</button>
                  <button className="btn btn-primary" disabled={busy} onClick={() => openKeep(g, r)}>Keep this one</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {target && (
        <div className="modal-overlay" onClick={() => { if (!busy) setTarget(null); }}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Keep this record?</h3></div>
            <div style={{ padding: 16 }}>
              <p style={{ marginTop: 0 }}>
                Keep <b>{target.keep.name || 'this record'}</b> ({target.keep.ward || 'no ward'}) and remove the other
                {' '}{target.group.records.length - 1} record(s) for EMR {target.keep.emr}. Their charts are copied into this one first.
                This can't be undone.
              </p>
              <label>Type the EMR number ({target.keep.emr}) to confirm</label>
              <input type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} disabled={busy} />
              {confirmErr && <div className="error-msg" style={{ marginTop: 8 }}>{confirmErr}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button className="btn btn-primary" disabled={busy} onClick={confirmKeep}>{busy ? 'Working…' : 'Keep & remove others'}</button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => setTarget(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
