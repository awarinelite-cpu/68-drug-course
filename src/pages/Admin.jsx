import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { collection, getDocs, doc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app, db, firebaseConfig } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { downloadFullBackup } from "../lib/export.js";
import { rebuildSearchIndex } from "../lib/patientDirectory.js";
import { avatarMarkup } from "../lib/avatar.js";
import { ROLE_OPTIONS } from "../lib/roles.js";
import StaffRegistrationCard from "../components/StaffRegistrationCard.jsx";
import Topbar from "../components/Topbar.jsx";

// Normalizes typed confirmation text before comparing: trims edge whitespace,
// collapses internal whitespace, and lowercases. Mobile keyboards (especially
// in a PWA/WebView) can silently inject a trailing space via autocomplete/
// suggestion-bar taps or auto-capitalize the first character, which made the
// old exact-match check fail even when the admin typed the right EMR.
function normalizeConfirmText(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const functionsInstance = getFunctions(app);
const deleteUserAccountFn = httpsCallable(functionsInstance, 'deleteUserAccount');

export default function Admin() {
  const { user, profile, logout } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/');

  const [users, setUsers] = useState([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [gender, setGender] = useState('');
  const [phone, setPhone] = useState('');
  const [newAccountRole, setNewAccountRole] = useState('nurse');
  const [msg, setMsg] = useState(null);

  // Pending self-registration applications (see RequestAccount.jsx /
  // StaffRegistrationCard.jsx) — role an admin approves them under
  // defaults to whatever the applicant requested, but is editable before
  // approving, in case they picked the wrong one.
  const [pendingRoleChoice, setPendingRoleChoice] = useState({}); // { [uid]: role }
  const [approvingId, setApprovingId] = useState(null);
  const [approveMsg, setApproveMsg] = useState(null);

  // Delete modal — used to reject a pending application.
  const [deleteTarget, setDeleteTarget] = useState(null); // { type: 'user', record }
  const [deleteInput, setDeleteInput] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [userDeletingId, setUserDeletingId] = useState(null);

  const [backupRunning, setBackupRunning] = useState(false);
  const [backupStatus, setBackupStatus] = useState('');

  const [reindexRunning, setReindexRunning] = useState(false);
  const [reindexStatus, setReindexStatus] = useState('');

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    const snap = await getDocs(collection(db, 'users'));
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    setUsers(list);
  }

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  async function runBackup() {
    setBackupRunning(true);
    try {
      const result = await downloadFullBackup(profile.name, (done, total) => {
        setBackupStatus('Backing up patient ' + done + ' of ' + total + '…');
      });
      setBackupStatus('Done — ' + result.count + ' patient record(s) saved to your downloads.');
    } catch (e) {
      setBackupStatus('Backup failed: ' + (e.message || e.code || 'unknown error'));
    } finally {
      setBackupRunning(false);
    }
  }

  // One-time backfill for the Home page's search box (see
  // patientDirectory.js) — any patient record created before this feature
  // shipped is missing the nameLower/emrLower fields the search's indexed
  // "starts with" queries rely on, so those older records won't turn up
  // in a search until this has run once. Safe to run again later (it
  // only touches records still missing the fields, e.g. after restoring
  // an old backup), and doesn't affect the ordinary myWard patient list,
  // which never needed these fields.
  async function runReindex() {
    setReindexRunning(true);
    setReindexStatus('Scanning patient records…');
    try {
      const updated = await rebuildSearchIndex();
      setReindexStatus(updated
        ? 'Done — ' + updated + ' older patient record(s) are now searchable by name/EMR.'
        : 'Done — every patient record was already up to date.');
    } catch (e) {
      setReindexStatus('Reindex failed: ' + (e.message || e.code || 'unknown error'));
    } finally {
      setReindexRunning(false);
    }
  }

  async function createNurse() {
    setMsg(null);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail || password.length < 6) {
      setMsg({ type: 'error', text: 'Fill in all fields; password needs at least 6 characters.' });
      return;
    }
    try {
      const secondaryApp = initializeApp(firebaseConfig, 'Secondary-' + Date.now());
      const secondaryAuth = getAuth(secondaryApp);
      const cred = await createUserWithEmailAndPassword(secondaryAuth, trimmedEmail, password);
      await setDoc(doc(db, 'users', cred.user.uid), {
        name: trimmedName, email: trimmedEmail, phone: phone.trim(), gender, role: newAccountRole, createdAt: serverTimestamp()
      });
      await signOut(secondaryAuth);
      await deleteApp(secondaryApp);

      setMsg({ type: 'info', text: ROLE_OPTIONS.find(r => r.value === newAccountRole)?.label + ' account created for ' + trimmedEmail + '.' });
      setName(''); setEmail(''); setPassword(''); setPhone(''); setGender(''); setNewAccountRole('nurse');
      loadUsers();
    } catch (e) {
      setMsg({ type: 'error', text: e.message || 'Failed to create account.' });
    }
  }

  const pendingUsers = users.filter(u => u.status === 'pending');

  function openDeleteUserModal(u) {
    if (u.id === user.uid) { alert("You can't delete your own account."); return; }
    setDeleteTarget({ type: 'user', record: u });
    setDeleteInput('');
    setDeleteError('');
  }

  function closeDeleteModal() { setDeleteTarget(null); }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { record } = deleteTarget;
    const expected = (record.email || '').trim() || 'DELETE';
    if (normalizeConfirmText(deleteInput) !== normalizeConfirmText(expected)) {
      setDeleteError('That didn\u2019t match — nothing was deleted. Please re-type it exactly.');
      return;
    }
    setDeleteTarget(null);
    await runDeleteUser(record);
  }

  async function runDeleteUser(u) {
    setUserDeletingId(u.id);
    try {
      await deleteUserAccountFn({ uid: u.id });
    } catch (e) {
      alert('Delete failed: ' + (e.message || e.code || 'unknown error'));
      setUserDeletingId(null);
      loadUsers();
      return;
    }
    setUserDeletingId(null);
    loadUsers();
  }

  async function approveApplication(u) {
    const chosenRole = pendingRoleChoice[u.id] || u.role || 'nurse';
    setApprovingId(u.id);
    setApproveMsg(null);
    try {
      await updateDoc(doc(db, 'users', u.id), { status: 'approved', role: chosenRole });
      setApproveMsg({ type: 'info', text: (u.name || u.email || 'Applicant') + '\u2019s account has been approved.' });
    } catch (e) {
      setApproveMsg({ type: 'error', text: "Couldn't approve: " + (e.code || e.message || 'unknown error') });
    }
    setApprovingId(null);
    loadUsers();
  }

  if (!profile) return null;

  const deleteLabel = deleteTarget ? (deleteTarget.record.name || 'Unnamed') + ' (' + (deleteTarget.record.email || 'no email on file') + ')' : '';
  const deletePromptLabel = deleteTarget
    ? ((deleteTarget.record.email || '').trim() ? ('Type the user\u2019s email to confirm: ' + deleteTarget.record.email) : 'No email on file — type DELETE to confirm')
    : '';

  return (
    <>
      <Topbar brand="68 NARHY Ward Charts — Admin">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back Home</button>
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={handleLogout}>Log Out</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Create Account</h3>
          <div className="field"><label>Full Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label>Phone Number</label><input type="tel" placeholder="e.g. 080XXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="field"><label>Temporary Password</label><input type="text" placeholder="At least 6 characters" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <div className="field">
            <label>Gender</label>
            <select value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="">Select gender…</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>
          <div className="field">
            <label>Role</label>
            <select value={newAccountRole} onChange={(e) => setNewAccountRole(e.target.value)}>
              {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" onClick={createNurse}>Create Account</button>
          {msg && <div className={msg.type === 'error' ? 'error-msg' : 'info-msg'}>{msg.text}</div>}
          <p style={{ fontSize: 12, color: '#666', marginTop: 10 }}>
            Share this email and temporary password with them directly. They can change it anytime using
            "Forgot password?" on the login page, which sends a reset link to their own email.
          </p>
        </div>

        <StaffRegistrationCard />

        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Pending Account Applications</h3>
          <p style={{ fontSize: 12, color: '#666', marginTop: -6 }}>
            Self-registered via the QR code above. Approving assigns them the role picked below (defaults
            to what they applied for) and lets them log in right away with the password they set; rejecting
            deletes the application entirely — nothing is created until you approve.
          </p>
          {!pendingUsers.length && <div style={{ fontSize: 13, color: '#666' }}>No pending applications.</div>}
          {pendingUsers.length > 0 && (
            <div className="table-wrap">
              <table className="entries">
                <thead><tr><th></th><th>Name</th><th>Email</th><th>Phone</th><th>Applying As</th><th></th></tr></thead>
                <tbody>
                  {pendingUsers.map((u) => (
                    <tr key={u.id}>
                      <td dangerouslySetInnerHTML={{ __html: avatarMarkup(u, 32) }} />
                      <td>{u.name || 'Unnamed'}</td><td>{u.email || ''}</td><td>{u.phone || ''}</td>
                      <td>
                        <select value={pendingRoleChoice[u.id] || u.role || 'nurse'}
                          onChange={(e) => setPendingRoleChoice((m) => ({ ...m, [u.id]: e.target.value }))}
                          disabled={approvingId === u.id}>
                          {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      </td>
                      <td>
                        <button className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 11, marginRight: 6 }}
                          disabled={approvingId === u.id} onClick={() => approveApplication(u)}>
                          {approvingId === u.id ? 'Approving…' : 'Approve'}
                        </button>
                        <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11, background: '#dc2626', color: '#fff', border: 'none' }}
                          disabled={approvingId === u.id || userDeletingId === u.id} onClick={() => openDeleteUserModal(u)}>
                          {userDeletingId === u.id ? 'Rejecting…' : 'Reject'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {approveMsg && <div className={approveMsg.type === 'error' ? 'error-msg' : 'info-msg'}>{approveMsg.text}</div>}
        </div>

        <div className="card-box">
          <button className="btn btn-primary" style={{ width: '100%', fontSize: 16, fontWeight: 'bold', padding: '12px 16px' }}
            onClick={() => navigate('/admin/patients')}>
            All Patients &rarr;
          </button>
          <p style={{ fontSize: 12, color: '#666', margin: '8px 0 0' }}>Browse, filter and manage every patient record.</p>
        </div>

        <div className="card-box">
          <button className="btn btn-primary" style={{ width: '100%', fontSize: 16, fontWeight: 'bold', padding: '12px 16px' }}
            onClick={() => navigate('/admin/users')}>
            All Users &rarr;
          </button>
          <p style={{ fontSize: 12, color: '#666', margin: '8px 0 0' }}>Manage accounts and appoint this week's Overall Nurse.</p>
        </div>

        <div className="card-box">
          <button className="btn btn-primary" style={{ width: '100%', fontSize: 16, fontWeight: 'bold', padding: '12px 16px' }}
            onClick={() => navigate('/admin/ward-beds')}>
            Ward Bed Numbers &rarr;
          </button>
          <p style={{ fontSize: 12, color: '#666', margin: '8px 0 0' }}>Edit each ward's bed count used in the ward statistics tables.</p>
        </div>

        <div className="card-box">
          <button className="btn btn-primary" style={{ width: '100%', fontSize: 16, fontWeight: 'bold', padding: '12px 16px' }}
            onClick={() => navigate('/admin/alarm-settings')}>
            Drug-Due Alarm Settings &rarr;
          </button>
          <p style={{ fontSize: 12, color: '#666', margin: '8px 0 0' }}>Alarm sound, type, quiet hours, overdue reminders and glycemic check reminders.</p>
        </div>

        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Backup All Patients</h3>
          <p style={{ fontSize: 12, color: '#666', marginTop: -6 }}>
            Downloads every patient's full record (active + closed admissions) as one JSON file, independent of
            Firestore — for legal/audit purposes or disaster recovery. This runs on demand rather than a fixed
            schedule — save the file somewhere safe (e.g. Google Drive) and run it on whatever cadence you want,
            e.g. weekly.
          </p>
          <button className="btn btn-primary" disabled={backupRunning} onClick={runBackup}>Download Full Backup (JSON)</button>
          <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>{backupStatus}</div>
          <button className="btn btn-secondary" style={{ marginTop: 12 }} disabled={reindexRunning} onClick={runReindex}>
            {reindexRunning ? 'Rebuilding search index…' : 'Rebuild Patient Search Index'}
          </button>
          <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>
            {reindexStatus || 'Run this once after updating, so older patient records show up in the Home page search box.'}
          </div>
        </div>
      </div>

      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div className="card-box" style={{ maxWidth: 420, width: '100%', margin: 0 }}>
            <h3 style={{ marginTop: 0, color: '#dc2626' }}>Delete User</h3>
            <p style={{ fontSize: 14, color: '#374151' }}>
              {'This permanently removes ' + deleteLabel + '\u2019s account and sign-in access. This cannot be undone.'}
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
