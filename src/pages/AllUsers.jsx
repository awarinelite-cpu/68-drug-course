import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { collection, getDocs, doc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app, db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { avatarMarkup } from "../lib/avatar.js";
import { formatNameWithTitle } from "../lib/roles.js";
import { weekId } from "../lib/nurses-report-common.js";
import Topbar from "../components/Topbar.jsx";

const deleteUserAccountFn = httpsCallable(getFunctions(app), 'deleteUserAccount');

function normalizeConfirmText(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export default function AllUsers() {
  const { user, profile } = useAuth();
  const goBack = useGoBack('/');
  const isAdmin = profile?.role === 'admin';
  const isSubadmin = profile?.role === 'subadmin';

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [overall, setOverall] = useState(null); // { uid, name } for the current week
  const [busyUid, setBusyUid] = useState(null);
  const [status, setStatus] = useState(null); // { text, error }

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [userDeletingId, setUserDeletingId] = useState(null);

  // Overall Nurse for the current report week — same document the Nurses
  // Report page and nav drawer read (nurseReportRoles/{weekId}), so anyone
  // appointed here takes over the role everywhere immediately.
  const wk = weekId();
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'nurseReportRoles', wk),
      (snap) => setOverall(snap.exists() ? (snap.data().overallNurse || null) : null),
      () => setOverall(null)
    );
    return unsub;
  }, [wk]);

  useEffect(() => { loadUsers(); }, []);

  async function loadUsers() {
    try {
      const snap = await getDocs(collection(db, 'users'));
      const list = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
      setUsers(list);
    } catch (e) {
      setStatus({ text: "Couldn't load users: " + (e.code || e.message || 'unknown error'), error: true });
    }
    setLoading(false);
  }

  async function appointOverall(u) {
    setBusyUid(u.id);
    setStatus(null);
    try {
      await setDoc(doc(db, 'nurseReportRoles', wk), {
        weekId: wk,
        overallNurse: { uid: u.id, name: u.name || 'Unknown', assignedAt: serverTimestamp() }
      }, { merge: true });
      setStatus({ text: (u.name || 'Nurse') + ' is now the Overall Nurse for this week.', error: false });
    } catch (e) {
      setStatus({ text: "Couldn't appoint: " + (e.code || e.message || 'unknown error'), error: true });
    }
    setBusyUid(null);
  }

  async function removeOverall(u) {
    setBusyUid(u.id);
    setStatus(null);
    try {
      await deleteDoc(doc(db, 'nurseReportRoles', wk));
      setStatus({ text: (u.name || 'Nurse') + ' is no longer the Overall Nurse.', error: false });
    } catch (e) {
      setStatus({ text: "Couldn't remove: " + (e.code || e.message || 'unknown error'), error: true });
    }
    setBusyUid(null);
  }

  async function setUserRole(u, newRole) {
    try {
      await updateDoc(doc(db, 'users', u.id), { role: newRole });
    } catch (e) {
      alert("Couldn't update role: " + (e.code || e.message || 'unknown error'));
    }
    loadUsers();
  }

  function openDeleteUserModal(u) {
    if (u.id === user.uid) { alert("You can't delete your own account."); return; }
    setDeleteTarget(u);
    setDeleteInput('');
    setDeleteError('');
  }
  function closeDeleteModal() { setDeleteTarget(null); }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const u = deleteTarget;
    const expected = (u.email || '').trim() || 'DELETE';
    if (normalizeConfirmText(deleteInput) !== normalizeConfirmText(expected)) {
      setDeleteError('That didn\u2019t match — nothing was deleted. Please re-type it exactly.');
      return;
    }
    setDeleteTarget(null);
    setUserDeletingId(u.id);
    try {
      await deleteUserAccountFn({ uid: u.id });
    } catch (e) {
      alert('Delete failed: ' + (e.message || e.code || 'unknown error'));
    }
    setUserDeletingId(null);
    loadUsers();
  }

  if (!profile) return null;
  // Admin and subadmin only (the Admin page itself isn't linked for anyone else).
  if (!isAdmin && !isSubadmin) return <Navigate to="/" replace />;

  const approvedUsers = users
    .filter(u => u.status !== 'pending')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const deletePromptLabel = deleteTarget
    ? ((deleteTarget.email || '').trim() ? ('Type the user\u2019s email to confirm: ' + deleteTarget.email) : 'No email on file — type DELETE to confirm')
    : '';

  return (
    <>
      <Topbar brand="68 NARHY Ward Charts — All Users">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Overall Nurse — This Week</h3>
          <p style={{ fontSize: 13, color: '#374151', margin: '0 0 6px' }}>
            {overall
              ? <>Current Overall Nurse: <b>{overall.name || 'Unknown'}</b></>
              : 'No Overall Nurse has been appointed yet this week.'}
          </p>
          <p style={{ fontSize: 12, color: '#666', margin: 0 }}>
            Use the Overall Nurse column below to appoint a nurse. Whoever you appoint takes over the Overall Nurse
            role for this week (locking/opening wards and saving to the archive). The appointment ends automatically
            when the week changes.
          </p>
          {status && <div className={status.error ? 'error-msg' : 'info-msg'}>{status.text}</div>}
        </div>

        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>All Users</h3>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
            {loading ? 'Loading users…' : approvedUsers.length + ' user(s)'}
          </div>
          <div className="table-wrap">
            <table className="entries">
              <thead><tr><th></th><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Overall Nurse</th>{isAdmin && <th></th>}</tr></thead>
              <tbody>
                {approvedUsers.map((u) => {
                  const isOverall = !!(overall && overall.uid === u.id);
                  const canBeOverall = u.role === 'nurse';
                  return (
                    <tr key={u.id}>
                      <td dangerouslySetInnerHTML={{ __html: avatarMarkup(u, 32) }} />
                      <td>{formatNameWithTitle(u.name, u.role)}</td><td>{u.email || ''}</td><td>{u.phone || ''}</td><td>{u.role || ''}</td>
                      <td>
                        {isOverall && (
                          <span style={{ fontSize: 10, fontWeight: 'bold', background: '#16a34a', color: '#fff', borderRadius: 999, padding: '2px 8px', marginRight: 6 }}>THIS WEEK</span>
                        )}
                        {canBeOverall && (isOverall ? (
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11 }}
                            disabled={busyUid === u.id} onClick={() => removeOverall(u)}>
                            {busyUid === u.id ? 'Removing…' : 'Remove'}
                          </button>
                        ) : (
                          <button className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 11 }}
                            disabled={busyUid === u.id} onClick={() => appointOverall(u)}>
                            {busyUid === u.id ? 'Appointing…' : 'Make Overall Nurse'}
                          </button>
                        ))}
                        {!canBeOverall && !isOverall && <span style={{ color: '#9ca3af' }}>—</span>}
                      </td>
                      {isAdmin && (
                        <td>
                          {u.id !== user.uid && (u.role === 'nurse' || u.role === 'subadmin') && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11, marginRight: 6 }}
                              onClick={() => setUserRole(u, u.role === 'subadmin' ? 'nurse' : 'subadmin')}>
                              {u.role === 'subadmin' ? 'Remove Subadmin' : 'Make Subadmin'}
                            </button>
                          )}
                          {u.id !== user.uid && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11, background: '#dc2626', color: '#fff', border: 'none' }}
                              disabled={userDeletingId === u.id} onClick={() => openDeleteUserModal(u)}>
                              {userDeletingId === u.id ? 'Deleting…' : 'Delete'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div className="card-box" style={{ maxWidth: 420, width: '100%', margin: 0 }}>
            <h3 style={{ marginTop: 0, color: '#dc2626' }}>Delete User</h3>
            <p style={{ fontSize: 14, color: '#374151' }}>
              This permanently removes {(deleteTarget.name || 'Unnamed') + ' (' + (deleteTarget.email || 'no email on file') + ')'}{'\u2019'}s account and sign-in access. This cannot be undone.
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
