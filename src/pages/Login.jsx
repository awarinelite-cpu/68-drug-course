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
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState(null); // { type: 'error'|'info', text }
  const navigate = useNavigate();

  async function doLogin() {
    // Fall back to the actual DOM value in case the browser autofilled
    // the field without firing React's onChange (state would still be empty).
    // Sync state to it FIRST, before any state update triggers a re-render —
    // otherwise the very next render forces the controlled input back to
    // the (still empty) old state and visibly wipes what the user sees.
    const em = (email || emailRef.current?.value || '').trim();
    const pw = password || passwordRef.current?.value || '';
    if (em !== email) setEmail(em);
    if (pw !== password) setPassword(pw);
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
    const em = (email || emailRef.current?.value || '').trim();
    if (em !== email) setEmail(em);
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
            ref={emailRef} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" placeholder="Password" autoComplete="current-password"
            ref={passwordRef} value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }} />
        </div>
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={doLogin}>Log In</button>

        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); doReset(); }} style={{ fontSize: 13, color: '#2563eb' }}>Forgot password?</a>
        </div>
        {msg && <div className={msg.type === 'error' ? 'error-msg' : 'info-msg'}>{msg.text}</div>}
      </div>
      </div>
    </div>
  );
}
