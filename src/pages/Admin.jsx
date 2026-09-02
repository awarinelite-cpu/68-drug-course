import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { collection, getDocs, doc, setDoc, updateDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app, db, firebaseConfig } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { downloadFullBackup } from "../lib/export.js";
import { avatarMarkup } from "../lib/avatar.js";
import {
  SOUND_OPTIONS, APPEARANCE_OPTIONS, REPEAT_OPTIONS, ALL_FREQUENCIES, GLUCOSE_INTERVAL_OPTIONS,
  loadAlarmSettings, saveAlarmSettings as persistAlarmSettings
} from "../lib/alarm-settings.js";
import Topbar from "../components/Topbar.jsx";

// Every chart type and archived-admission record a patient can accumulate.
// Firestore doesn't cascade-delete subcollections when the parent doc is
// removed, so each one has to be cleared out explicitly first, or the data
// would keep sitting there orphaned (invisible in the app, but still using
// storage and still technically recoverable — not acceptable for a real delete).
const PATIENT_SUBCOLLECTIONS = ['admissions', 'bloodGlucose', 'drugCourseChart', 'intakeOutput', 'intakeOutputSummary', 'seizure', 'vitals'];

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
  const [msg, setMsg] = useState(null);

  const [allPatients, setAllPatients] = useState([]);
  const [patientFilter, setPatientFilter] = useState('');
  const [patientStatus, setPatientStatus] = useState('');

  // Delete modal is shared between patients and users — deleteTarget.type
  // says which one confirmDelete() below should act on.
  const [deleteTarget, setDeleteTarget] = useState(null); // { type: 'patient'|'user', record }
  const [deleteInput, setDeleteInput] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [userDeletingId, setUserDeletingId] = useState(null);

  const [alarm, setAlarm] = useState(null); // null while loading
  const [freqChecked, setFreqChecked] = useState({});
  const [alarmSaving, setAlarmSaving] = useState(false);
  const [alarmMsg, setAlarmMsg] = useState(null);

  const [backupRunning, setBackupRunning] = useState(false);
  const [backupStatus, setBackupStatus] = useState('');

  useEffect(() => {
    loadUsers();
    loadPatients();
    (async () => {
      const settings = await loadAlarmSettings(db);
      setAlarm(settings);
      const checked = {};
      ALL_FREQUENCIES.forEach(f => { checked[f] = settings.frequencies.includes(f); });
      setFreqChecked(checked);
    })();
  }, []);

  async function loadUsers() {
    const snap = await getDocs(collection(db, 'users'));
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    setUsers(list);
  }

  async function loadPatients() {
    const snap = await getDocs(collection(db, 'patients'));
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    setAllPatients(list);
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
        name: trimmedName, email: trimmedEmail, gender, role: 'nurse', createdAt: serverTimestamp()
      });
      await signOut(secondaryAuth);
      await deleteApp(secondaryApp);

      setMsg({ type: 'info', text: 'Nurse account created for ' + trimmedEmail + '.' });
      setName(''); setEmail(''); setPassword(''); setGender('');
      loadUsers();
    } catch (e) {
      setMsg({ type: 'error', text: e.message || 'Failed to create account.' });
    }
  }

  const filteredPatients = (() => {
    const q = patientFilter.trim().toLowerCase();
    return !q ? allPatients : allPatients.filter(p =>
      (p.name || '').toLowerCase().includes(q) || (p.emr || '').toLowerCase().includes(q) || (p.ward || '').toLowerCase().includes(q)
    );
  })();

  function openPatient(p) { navigate('/charts/overview?patient=' + p.id); }

  function openDeletePatientModal(p) {
    setDeleteTarget({ type: 'patient', record: p });
    setDeleteInput('');
    setDeleteError('');
  }

  function openDeleteUserModal(u) {
    if (u.id === user.uid) { alert("You can't delete your own account."); return; }
    setDeleteTarget({ type: 'user', record: u });
    setDeleteInput('');
    setDeleteError('');
  }

  function closeDeleteModal() { setDeleteTarget(null); }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { type, record } = deleteTarget;
    const expected = type === 'patient' ? ((record.emr || '').trim() || 'DELETE') : ((record.email || '').trim() || 'DELETE');
    if (normalizeConfirmText(deleteInput) !== normalizeConfirmText(expected)) {
      setDeleteError('That didn\u2019t match — nothing was deleted. Please re-type it exactly.');
      return;
    }
    setDeleteTarget(null);
    if (type === 'patient') await runDeletePatient(record);
    else await runDeleteUser(record);
  }

  async function runDeletePatient(p) {
    setPatientStatus('Deleting ' + (p.name || 'patient') + '…');
    async function deleteAllInSubcollection(sub) {
      const snap = await getDocs(collection(db, 'patients', p.id, sub));
      await Promise.all(snap.docs.map(d => deleteDoc(doc(db, 'patients', p.id, sub, d.id))));
    }
    try {
      await Promise.all(PATIENT_SUBCOLLECTIONS.map(deleteAllInSubcollection));
      await deleteDoc(doc(db, 'patients', p.id));
    } catch (e) {
      alert('Delete failed: ' + (e.code || e.message || 'unknown error'));
      setPatientStatus('');
      return;
    }
    setAllPatients((list) => list.filter(x => x.id !== p.id));
    setPatientStatus('');
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

  async function setUserRole(u, newRole) {
    try {
      await updateDoc(doc(db, 'users', u.id), { role: newRole });
    } catch (e) {
      alert("Couldn't update role: " + (e.code || e.message || 'unknown error'));
    }
    loadUsers();
  }

  function toggleFreq(f) { setFreqChecked((c) => ({ ...c, [f]: !c[f] })); }

  async function saveAlarmSettings() {
    const selectedFrequencies = ALL_FREQUENCIES.filter(f => freqChecked[f]);
    if (!selectedFrequencies.length) {
      setAlarmMsg({ type: 'error', text: 'Select at least one frequency, or nurses will never get an alert.' });
      return;
    }
    setAlarmSaving(true);
    setAlarmMsg(null);
    try {
      const saved = await persistAlarmSettings(db, { ...alarm, frequencies: selectedFrequencies });
      setAlarm(saved);
      setAlarmMsg({ type: 'info', text: 'Alarm settings saved.' });
    } catch (e) {
      setAlarmMsg({ type: 'error', text: e.message || 'Failed to save alarm settings.' });
    } finally {
      setAlarmSaving(false);
    }
  }

  if (!profile) return null;

  const deleteLabel = deleteTarget?.type === 'patient'
    ? (deleteTarget.record.name || 'Unnamed') + ' (EMR: ' + (deleteTarget.record.emr || 'N/A') + ')'
    : deleteTarget ? (deleteTarget.record.name || 'Unnamed') + ' (' + (deleteTarget.record.email || 'no email on file') + ')' : '';
  const deletePromptLabel = deleteTarget?.type === 'patient'
    ? ((deleteTarget.record.emr || '').trim() ? ('Type the patient\u2019s EMR number to confirm: ' + deleteTarget.record.emr) : 'No EMR on file — type DELETE to confirm')
    : deleteTarget ? ((deleteTarget.record.email || '').trim() ? ('Type the user\u2019s email to confirm: ' + deleteTarget.record.email) : 'No email on file — type DELETE to confirm') : '';

  return (
    <>
      <Topbar brand="68 NARHY Ward Charts — Admin">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back Home</button>
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={handleLogout}>Log Out</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Create Nurse Account</h3>
          <div className="field"><label>Full Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label>Temporary Password</label><input type="text" placeholder="At least 6 characters" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <div className="field">
            <label>Gender</label>
            <select value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="">Select gender…</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={createNurse}>Create Account</button>
          {msg && <div className={msg.type === 'error' ? 'error-msg' : 'info-msg'}>{msg.text}</div>}
          <p style={{ fontSize: 12, color: '#666', marginTop: 10 }}>
            Share this email and temporary password with the nurse directly. They can change it anytime using
            "Forgot password?" on the login page, which sends a reset link to their own email.
          </p>
        </div>

        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>All Patients</h3>
          <div className="search-row">
            <input type="text" placeholder="Filter by name, EMR, or ward" value={patientFilter} onChange={(e) => setPatientFilter(e.target.value)} />
          </div>
          <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
            {patientStatus || (filteredPatients.length + ' of ' + allPatients.length + ' patient(s)' + (patientFilter.trim() ? ' matching "' + patientFilter.trim() + '"' : ''))}
          </div>
          <div className="table-wrap">
            <table className="entries">
              <thead><tr><th>Name</th><th>EMR</th><th>Ward</th><th>Diagnosis</th><th>Admission Date</th><th></th></tr></thead>
              <tbody>
                {!filteredPatients.length && <tr><td colSpan={6} style={{ color: '#666' }}>No patients found.</td></tr>}
                {filteredPatients.map((p) => (
                  <tr key={p.id}>
                    <td style={{ textAlign: 'left', cursor: 'pointer' }} title={'Open ' + (p.name || 'this patient') + '\u2019s overview'} onClick={() => openPatient(p)}>{p.name || 'Unnamed'}</td>
                    <td style={{ cursor: 'pointer' }} onClick={() => openPatient(p)}>{p.emr || '-'}</td>
                    <td style={{ cursor: 'pointer' }} onClick={() => openPatient(p)}>{p.ward || '-'}</td>
                    <td style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => openPatient(p)}>{p.diagnosis || 'Not specified'}</td>
                    <td style={{ cursor: 'pointer' }} onClick={() => openPatient(p)}>{p.admissionDate || '-'}</td>
                    <td>
                      <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11, background: '#dc2626', color: '#fff', border: 'none' }}
                        onClick={(e) => { e.stopPropagation(); openDeletePatientModal(p); }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>All Users</h3>
          <div className="table-wrap">
            <table className="entries">
              <thead><tr><th></th><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td dangerouslySetInnerHTML={{ __html: avatarMarkup(u, 32) }} />
                    <td>{u.name || ''}</td><td>{u.email || ''}</td><td>{u.role || ''}</td>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Drug-Due Alarm Settings</h3>
          <p style={{ fontSize: 12, color: '#666', marginTop: -6 }}>
            Controls the alert nurses get when a drug dose is due — see "Alerts" on the Profile page for how a nurse
            opts a device in. Changes here apply to every nurse's device; already-open tabs pick them up live, no
            reload needed.
          </p>
          {alarm && (
            <>
              <div className="field">
                <label>Alarm Sound</label>
                <select value={alarm.sound} onChange={(e) => setAlarm({ ...alarm, sound: e.target.value })}>
                  {SOUND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Alarm Type (how it appears)</label>
                <select value={alarm.appearance} onChange={(e) => setAlarm({ ...alarm, appearance: e.target.value })}>
                  {APPEARANCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Repeat Behavior</label>
                <select value={alarm.repeat} onChange={(e) => setAlarm({ ...alarm, repeat: e.target.value })}>
                  {REPEAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>
                  <input type="checkbox" style={{ width: 'auto', marginRight: 6, verticalAlign: 'middle' }}
                    checked={alarm.quietHours.enabled} onChange={(e) => setAlarm({ ...alarm, quietHours: { ...alarm.quietHours, enabled: e.target.checked } })} />
                  Quiet Hours (mute alerts overnight)
                </label>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>Quiet From</label>
                  <input type="time" value={alarm.quietHours.start} onChange={(e) => setAlarm({ ...alarm, quietHours: { ...alarm.quietHours, start: e.target.value } })} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>Quiet Until</label>
                  <input type="time" value={alarm.quietHours.end} onChange={(e) => setAlarm({ ...alarm, quietHours: { ...alarm.quietHours, end: e.target.value } })} />
                </div>
              </div>
              <div className="field">
                <label>Alarm Schedule — Which Frequencies Alert</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 4 }}>
                  {ALL_FREQUENCIES.map(f => (
                    <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 'normal', fontSize: 13 }}>
                      <input type="checkbox" style={{ width: 'auto' }} checked={!!freqChecked[f]} onChange={() => toggleFreq(f)} />{f}
                    </label>
                  ))}
                </div>
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '18px 0' }} />

              <div className="field">
                <label>
                  <input type="checkbox" style={{ width: 'auto', marginRight: 6, verticalAlign: 'middle' }}
                    checked={alarm.glucose.enabled} onChange={(e) => setAlarm({ ...alarm, glucose: { ...alarm.glucose, enabled: e.target.checked } })} />
                  Glycemic Check Reminders
                </label>
                <p style={{ fontSize: 12, color: '#666', margin: '2px 0 0' }}>
                  Reminds nurses when a patient's blood glucose reading is overdue, timed from their last recorded
                  reading (see the Time column on the Glycemic Chart) — same alarm sound/appearance/quiet-hours above.
                </p>
              </div>
              <div className="field">
                <label>Remind Every</label>
                <select value={String(alarm.glucose.intervalHours)} onChange={(e) => setAlarm({ ...alarm, glucose: { ...alarm.glucose, intervalHours: Number(e.target.value) } })}>
                  {GLUCOSE_INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>

              <button className="btn btn-primary" disabled={alarmSaving} onClick={saveAlarmSettings}>Save Alarm Settings</button>
              {alarmMsg && <div className={alarmMsg.type === 'error' ? 'error-msg' : 'info-msg'}>{alarmMsg.text}</div>}
            </>
          )}
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
        </div>
      </div>

      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div className="card-box" style={{ maxWidth: 420, width: '100%', margin: 0 }}>
            <h3 style={{ marginTop: 0, color: '#dc2626' }}>{deleteTarget.type === 'patient' ? 'Delete Patient' : 'Delete User'}</h3>
            <p style={{ fontSize: 14, color: '#374151' }}>
              {deleteTarget.type === 'patient'
                ? 'This permanently deletes ' + deleteLabel + ' and every chart, drug list, and closed-admission record for this patient. This cannot be undone.'
                : 'This permanently removes ' + deleteLabel + '\u2019s account and sign-in access. This cannot be undone.'}
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
