import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "../firebase.js";
import wardBg from "../assets/login-ward-bg.jpg";

function friendlyError(e) {
  const code = e.code || '';
  if (code.includes('user-not-found') || code.includes('invalid-credential') || code.includes('wrong-password')) return 'Incorrect email or password.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Please try again later.';
  if (code.includes('invalid-email')) return 'Enter a valid email address.';
  return 'Something went wrong. Please try again.';
}

export default function Login() {
  // Deliberately UNCONTROLLED: these two inputs are not bound to React
  // state via `value`. Browser autofill / password managers set the DOM
  // value directly without always firing a React-visible change event, and
  // a controlled input gets forced back to its (still-empty) state on the
  // very next render for ANY reason — clicking Login, but also anything
  // else in the tree re-rendering (auth listener, offline banner, etc).
  // That's what was wiping the fields before the user even touched the
  // button. Reading straight from the DOM via refs at submit time sidesteps
  // the whole class of bug: the input is always the source of truth.
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const [msg, setMsg] = useState(null); // { type: 'error'|'info', text }
  const navigate = useNavigate();

  // No Enter-to-submit on the password field anymore, and the button only
  // reacts to e.isTrusted clicks (a real tap/click, never a script- or
  // autofill-simulated one). Login now only ever fires from an explicit,
  // genuine press of this button.
  async function doLogin() {
    const em = (emailRef.current?.value || '').trim();
    const pw = passwordRef.current?.value || '';
    setMsg(null);
    if (!em || !pw) { setMsg({ type: 'error', text: 'Enter your email and password.' }); return; }
    try {
      await signInWithEmailAndPassword(auth, em, pw);
      navigate('/');
    } catch (e) {
      setMsg({ type: 'error', text: friendlyError(e) });
    }
  }

  async function doReset() {
    const em = (emailRef.current?.value || '').trim();
    if (!em) { setMsg({ type: 'error', text: 'Enter your email above first, then click "Forgot password?".' }); return; }
    try {
      await sendPasswordResetEmail(auth, em);
      setMsg({ type: 'info', text: 'Password reset link sent to ' + em + '. Check your inbox (and spam folder).' });
    } catch (e) {
      setMsg({ type: 'error', text: friendlyError(e) });
    }
  }

  return (
    <div className="login-page" style={{ backgroundImage: `url(${wardBg})` }}>
      <div className="container" style={{ maxWidth: 420, marginTop: 60 }}>
      <div className="card-box login-card">
        <h2 style={{ textAlign: 'center', marginTop: 0 }}>68 NARHY Ward Charts</h2>

        <div className="field">
          <label>Email</label>
          <input type="email" placeholder="name@example.com" autoComplete="username"
            ref={emailRef} defaultValue="" />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" placeholder="Password" autoComplete="current-password"
            ref={passwordRef} defaultValue="" />
        </div>
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={(e) => { if (e.isTrusted) doLogin(); }}>Log In</button>

        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); doReset(); }} style={{ fontSize: 13, color: '#2563eb' }}>Forgot password?</a>
        </div>
        {msg && <div className={msg.type === 'error' ? 'error-msg' : 'info-msg'}>{msg.text}</div>}
      </div>
      </div>
    </div>
  );
}
