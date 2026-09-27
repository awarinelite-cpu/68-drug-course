import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { WARD_OPTIONS } from "../lib/drugChartHelpers.js";
import Topbar from "../components/Topbar.jsx";

// A rotating palette for the ward cards — purely decorative (not tied to any
// status meaning like the app's semantic btn-danger/btn-success colors), so
// it just cycles through however many wards WARD_OPTIONS has.
const CARD_COLORS = [
  { bg: '#3070C7', shadow: '#1e4c8f' }, // blue
  { bg: '#16A34A', shadow: '#0f7a37' }, // green
  { bg: '#7C3AED', shadow: '#5b21b6' }, // purple
  { bg: '#D97706', shadow: '#a15c04' }, // amber
  { bg: '#0891B2', shadow: '#0e6478' }, // cyan
  { bg: '#DB2777', shadow: '#a3195c' }, // pink
];

export default function SelectWard() {
  const { user, profile, updateLocalProfile } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/');

  const [busyWard, setBusyWard] = useState(null); // which card is mid-save, or null
  const [errMsg, setErrMsg] = useState(null);

  async function chooseWard(newWard) {
    if (busyWard) return;
    setBusyWard(newWard || '__clear__');
    setErrMsg(null);
    try {
      await updateDoc(doc(db, 'users', user.uid), { ward: newWard });
      updateLocalProfile({ ward: newWard });
      // Job done — straight back to the ward home page, now showing this ward.
      navigate('/');
    } catch (e) {
      setErrMsg('Could not switch ward: ' + (e.code || e.message || 'unknown error'));
      setBusyWard(null);
    }
  }

  return (
    <>
      <Topbar brand="Select Your Ward">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>Tap your ward</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: -6 }}>
            You'll only see patients from this ward on Home. You can come back and change it any time.
          </p>

          <div className="ward-pick-grid">
            <button
              className={
                'ward-pick-card' + (!profile?.ward ? ' ward-pick-card--current' : '')
              }
              style={{ '--card-bg': 'var(--text-secondary)', '--card-shadow': 'rgba(0,0,0,.4)' }}
              disabled={!!busyWard}
              onClick={() => chooseWard('')}
            >
              {busyWard === '__clear__' ? 'Setting…' : 'All Wards (clear)'}
            </button>

            {WARD_OPTIONS.map((w, i) => {
              const c = CARD_COLORS[i % CARD_COLORS.length];
              return (
                <button
                  key={w}
                  className={'ward-pick-card' + (profile?.ward === w ? ' ward-pick-card--current' : '')}
                  style={{ '--card-bg': c.bg, '--card-shadow': c.shadow }}
                  disabled={!!busyWard}
                  onClick={() => chooseWard(w)}
                >
                  {busyWard === w ? 'Setting…' : w}
                </button>
              );
            })}
          </div>

          {errMsg && <div className="error-msg" style={{ marginTop: 14 }}>{errMsg}</div>}
        </div>
      </div>
    </>
  );
}
