import { useState } from "react";
import { Link } from "react-router-dom";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { getFirestore, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { firebaseConfig } from "../firebase.js";
import { ROLE_OPTIONS } from "../lib/roles.js";
import wardBg from "../assets/login-ward-bg.jpg";

function friendlyError(e) {
  const code = e.code || '';
  if (code.includes('email-already-in-use')) return 'An account already exists for that email — try logging in, or use "Forgot password?" on the login page.';
  if (code.includes('invalid-email')) return 'Enter a valid email address.';
  if (code.includes('weak-password')) return 'Password must be at least 6 characters.';
  return e.message || 'Something went wrong. Please try again.';
}

// Self-service registration, reached by scanning the QR code an admin can
// print from Admin > Staff Registration. Anyone with the link can apply,
// but the account created here is inert: it lands in Firestore with
// status: 'pending' (see firestore.rules) and can't read or write anything
// else in the app until an admin approves it on the Admin page. This
// mirrors Admin.jsx's createNurse() — a throwaway secondary Firebase app
// creates the Auth account and its Firestore profile, then signs itself
// out, so submitting an application never logs the applicant's device into
// the main app.
export default function RequestAccount() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState('');
  const [role, setRole] = useState('nurse');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [msg, setMsg] = useState(null); // { type: 'error'|'info', text }
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function submit() {
    setMsg(null);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail || !gender) {
      setMsg({ type: 'error', text: 'Fill in your name, email, and gender.' });
      return;
    }
    if (password.length < 6) {
      setMsg({ type: 'error', text: 'Password must be at least 6 characters.' });
      return;
    }
    if (password !== confirmPassword) {
      setMsg({ type: 'error', text: 'Passwords don\u2019t match.' });
      return;
    }
    setSubmitting(true);
    let secondaryApp;
    try {
      // Nobody is signed into the app's main Firebase instance here — this
      // is the public, logged-out registration page. So unlike Admin.jsx's
      // createNurse() (where the *admin* is already signed in and does the
      // Firestore write as themselves), the profile write below has to go
      // through a Firestore instance tied to this same secondary app, so
      // it's authenticated as the applicant she just created — matching
      // the self-registration branch of the users/{uid} create rule
      // (request.auth.uid == uid, email == request.auth.token.email).
      // Writing it via the main `db` instead would be unauthenticated and
      // rejected outright.
      secondaryApp = initializeApp(firebaseConfig, 'Registration-' + Date.now());
      const secondaryAuth = getAuth(secondaryApp);
      const secondaryDb = getFirestore(secondaryApp);
      const cred = await createUserWithEmailAndPassword(secondaryAuth, trimmedEmail, password);
      await setDoc(doc(secondaryDb, 'users', cred.user.uid), {
        name: trimmedName, email: trimmedEmail, phone: phone.trim(), gender, role,
        status: 'pending', createdAt: serverTimestamp()
      });
      await signOut(secondaryAuth);
      setSubmitted(true);
    } catch (e) {
      setMsg({ type: 'error', text: friendlyError(e) });
    } finally {
      if (secondaryApp) { try { await deleteApp(secondaryApp); } catch { /* already torn down */ } }
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="login-page" style={{ backgroundImage: `url(${wardBg})` }}>
        <div className="container" style={{ maxWidth: 420, marginTop: 60 }}>
          <div className="card-box login-card">
            <h2 style={{ textAlign: 'center', marginTop: 0 }}>Application Submitted</h2>
            <p style={{ textAlign: 'center', color: '#374151' }}>
              Thanks, {name.trim()}. Your application is waiting for an admin to review and approve it.
              You'll be able to log in with the email and password you just set as soon as that happens —
              no need to re-apply.
            </p>
            <Link to="/login" className="btn btn-primary" style={{ width: '100%', display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Back to Login
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page" style={{ backgroundImage: `url(${wardBg})` }}>
      <div className="container" style={{ maxWidth: 420, marginTop: 60 }}>
        <div className="card-box login-card">
          <h2 style={{ textAlign: 'center', marginTop: 0 }}>Request Staff Account</h2>
          <p style={{ fontSize: 13, color: '#666', textAlign: 'center', marginTop: -6 }}>
            68 NARHY Ward Charts — for nurses and doctors joining the ward. An admin reviews every
            application before it's approved.
          </p>

          <div className="field"><label>Full Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} /></div>
          <div className="field"><label>Email</label><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} disabled={submitting} /></div>
          <div className="field"><label>Phone Number</label><input type="tel" placeholder="e.g. 080XXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={submitting} /></div>
          <div className="field">
            <label>Gender</label>
            <select value={gender} onChange={(e) => setGender(e.target.value)} disabled={submitting}>
              <option value="">Select gender…</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>
          <div className="field">
            <label>I am a…</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} disabled={submitting}>
              {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Choose a Password</label><input type="password" autoComplete="new-password" placeholder="At least 6 characters" value={password} onChange={(e) => setPassword(e.target.value)} disabled={submitting} /></div>
          <div className="field"><label>Confirm Password</label><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} disabled={submitting} /></div>

          <button className="btn btn-primary" style={{ width: '100%' }} disabled={submitting} onClick={submit}>
            {submitting ? 'Submitting…' : 'Submit Application'}
          </button>
          {msg && <div className={msg.type === 'error' ? 'error-msg' : 'info-msg'}>{msg.text}</div>}

          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <Link to="/login" style={{ fontSize: 13, color: '#2563eb' }}>Already have an account? Log in</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
