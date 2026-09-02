import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, updateDoc } from "firebase/firestore";
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "firebase/auth";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { avatarMarkup } from "../lib/avatar.js";
import { pushIsEnabled, enablePushForThisDevice, disablePushForThisDevice } from "../lib/push.js";
import Topbar from "../components/Topbar.jsx";

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out — check your internet connection and try again.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export default function Profile() {
  const { user, profile, logout, updateLocalProfile } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/');

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [department, setDepartment] = useState('');
  const [gender, setGender] = useState('');
  const [pfMsg, setPfMsg] = useState(null);

  const [curpw, setCurpw] = useState('');
  const [newpw, setNewpw] = useState('');
  const [newpw2, setNewpw2] = useState('');
  const [pwMsg, setPwMsg] = useState(null);

  const [pushState, setPushState] = useState('loading'); // 'loading' | 'unsupported' | 'blocked' | 'on' | 'off'
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState(null);

  useEffect(() => {
    if (profile) {
      setName(profile.name || '');
      setPhone(profile.phone || '');
      setDepartment(profile.department || '');
      setGender(profile.gender || '');
    }
  }, [profile]);

  useEffect(() => { refreshPushState(); }, []);

  function refreshPushState() {
    if (!('Notification' in window)) { setPushState('unsupported'); return; }
    if (Notification.permission === 'denied') { setPushState('blocked'); return; }
    setPushState(pushIsEnabled() ? 'on' : 'off');
  }

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  async function saveProfile() {
    setPfMsg(null);
    const trimmedName = name.trim();
    if (!trimmedName) { setPfMsg({ type: 'error', text: 'Name cannot be empty.' }); return; }
    const updates = { name: trimmedName, phone: phone.trim(), department: department.trim(), gender };
    try {
      await updateDoc(doc(db, 'users', user.uid), updates);
    } catch (e) {
      setPfMsg({ type: 'error', text: 'Save failed: ' + (e.code || e.message || 'unknown error') });
      return;
    }
    updateLocalProfile(updates);
    setPfMsg({ type: 'info', text: 'Profile updated.' });
  }

  async function togglePush() {
    setPushBusy(true);
    setPushMsg({ type: 'info', text: 'Working…' });
    try {
      if (pushIsEnabled()) {
        setPushMsg({ type: 'info', text: 'Turning off…' });
        await withTimeout(disablePushForThisDevice(user.uid), 60000);
        setPushMsg({ type: 'info', text: 'Dose alerts are now off for this phone.' });
      } else {
        await withTimeout(
          enablePushForThisDevice(user.uid, (label) => setPushMsg({ type: 'info', text: label })),
          60000
        );
        setPushMsg({ type: 'info', text: 'Dose alerts are on for this phone.' });
      }
    } catch (e) {
      setPushMsg({ type: 'error', text: e.message || 'Could not update alert settings.' });
    }
    setPushBusy(false);
    refreshPushState();
  }

  async function changePassword() {
    setPwMsg(null);
    if (!curpw || newpw.length < 6) {
      setPwMsg({ type: 'error', text: 'Enter your current password and a new one with at least 6 characters.' });
      return;
    }
    if (newpw !== newpw2) { setPwMsg({ type: 'error', text: 'New passwords do not match.' }); return; }
    try {
      const cred = EmailAuthProvider.credential(user.email, curpw);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, newpw);
    } catch (e) {
      setPwMsg({ type: 'error', text: e.code === 'auth/wrong-password' ? 'Current password is incorrect.' : (e.message || 'Failed to update password.') });
      return;
    }
    setCurpw(''); setNewpw(''); setNewpw2('');
    setPwMsg({ type: 'info', text: 'Password updated.' });
  }

  if (!profile) return null;

  const pushLabel = {
    loading: 'Loading…',
    unsupported: 'Not supported on this browser',
    blocked: 'Blocked — enable in browser settings',
    on: 'Alerts On — Tap to Turn Off',
    off: 'Turn On Dose Alerts'
  }[pushState];
  const pushDisabled = pushBusy || pushState === 'unsupported' || pushState === 'blocked';
  const pushClass = (pushState === 'on') ? 'push-on' : ((pushState === 'off' || pushState === 'blocked') ? 'push-off' : '');

  return (
    <>
      <Topbar brand="My Profile">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={handleLogout}>Log Out</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
            <div className="avatar" dangerouslySetInnerHTML={{ __html: avatarMarkup({ name, gender }, 56) }} />
            <div>
              <div style={{ fontSize: 18, fontWeight: 'bold' }}>{profile.name || 'Unnamed'}</div>
              <span style={{
                display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 11,
                fontWeight: 'bold', textTransform: 'uppercase', background: '#eff6ff', color: '#1d4ed8', marginTop: 4
              }}>{profile.role || ''}</span>
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '20px 0' }} />

          <div className="field"><label>Full Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Phone Number</label><input type="text" placeholder="e.g. 080XXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="field"><label>Department / Ward</label><input type="text" placeholder="e.g. Officers Ward" value={department} onChange={(e) => setDepartment(e.target.value)} /></div>
          <div className="field">
            <label>Gender</label>
            <select value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="">Select gender…</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>

          <div className="field">
            <label>Email</label>
            <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 6, background: '#f9fafb', fontSize: 14, color: '#374151' }}>
              {profile.email || user.email || ''}
            </div>
          </div>
          <div className="field">
            <label>Role</label>
            <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 6, background: '#f9fafb', fontSize: 14, color: '#374151' }}>
              {profile.role || ''}
            </div>
          </div>

          <button className="btn btn-primary" onClick={saveProfile}>Save Changes</button>
          {pfMsg && <div className={pfMsg.type === 'error' ? 'error-msg' : 'info-msg'} style={{ marginTop: 10 }}>{pfMsg.text}</div>}
        </div>

        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Dose Due Alerts</h3>
          <button id="pushToggleBtn" className={"btn btn-primary " + pushClass} disabled={pushDisabled} onClick={togglePush}>{pushLabel}</button>
          {pushMsg && <div className={pushMsg.type === 'error' ? 'error-msg' : 'info-msg'} style={{ marginTop: 10 }}>{pushMsg.text}</div>}
        </div>

        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Change Password</h3>
          <div className="field"><label>Current Password</label><input type="password" value={curpw} onChange={(e) => setCurpw(e.target.value)} /></div>
          <div className="field"><label>New Password</label><input type="password" placeholder="At least 6 characters" value={newpw} onChange={(e) => setNewpw(e.target.value)} /></div>
          <div className="field"><label>Confirm New Password</label><input type="password" value={newpw2} onChange={(e) => setNewpw2(e.target.value)} /></div>
          <button className="btn btn-purple" onClick={changePassword}>Update Password</button>
          {pwMsg && <div className={pwMsg.type === 'error' ? 'error-msg' : 'info-msg'} style={{ marginTop: 10 }}>{pwMsg.text}</div>}
        </div>
      </div>
    </>
  );
}
