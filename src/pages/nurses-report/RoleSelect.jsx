import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../../firebase.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useGoBack } from "../../hooks/useGoBack.js";
import { weekId } from "../../lib/nurses-report-common.js";
import Topbar from "../../components/Topbar.jsx";

export default function RoleSelect() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/');

  const wk = weekId();
  const roleRef = doc(db, 'nurseReportRoles', wk);

  const [status, setStatus] = useState({ text: 'Checking…', className: 'status' });

  async function refreshStatus() {
    let snap;
    try {
      snap = await getDoc(roleRef);
    } catch (e) {
      setStatus({ text: "Couldn't check current status.", className: 'status' });
      return null;
    }
    const data = snap.exists() ? snap.data() : null;
    const overall = data && data.overallNurse;
    if (!overall) {
      setStatus({ text: 'Unassigned this week — tap to take the role.', className: 'status status-open' });
    } else if (user && overall.uid === user.uid) {
      setStatus({ text: "You're the Overall Nurse this week.", className: 'status status-you' });
    } else {
      setStatus({ text: (overall.name || 'Another nurse') + ' is the Overall Nurse this week.', className: 'status status-taken' });
    }
    return overall;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }

  useEffect(() => { if (user) refreshStatus(); }, [user]);

  async function assumeOverall() {
    if (!user) return;
    const overall = await refreshStatus();
    if (overall && overall.uid !== user.uid) {
      const ok = confirm((overall.name || 'Another nurse') + ' is currently the Overall Nurse for this week. Take over this role?');
      if (!ok) return;
    }
    try {
      await setDoc(roleRef, {
        weekId: wk,
        overallNurse: { uid: user.uid, name: profile.name || 'Unknown', assignedAt: serverTimestamp() }
      }, { merge: true });
    } catch (e) {
      alert("Couldn't assign the role: " + (e.code || e.message || 'unknown error'));
      return;
    }
    navigate('/nurses-report/overall-nurse');
  }

  return (
    <>
      <Topbar brand="Nurses Report">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>
      <div className="container">
        <p style={{ fontSize: 13, color: '#555' }}>Choose your role for this shift. The Overall Nurse role runs for the whole week.</p>
        <div className="role-grid">
          <button className="role-card" onClick={assumeOverall}>
            <span className="icon">🗂️</span>
            <span className="title">ASSUME OVERALL</span>
            <span className="desc">Become the Overall Nurse for this week — monitor and manage every ward's 24-hour report.</span>
            <div className={status.className}>{status.text}</div>
          </button>
          <button className="role-card" onClick={() => navigate('/nurses-report/ward-nurse')}>
            <span className="icon">🏥</span>
            <span className="title">WARD NURSE</span>
            <span className="desc">Submit and manage your own ward's 24-hour report.</span>
          </button>
          <button className="role-card" onClick={() => navigate('/nurses-report/analytics')}>
            <span className="icon">📈</span>
            <span className="title">ANALYTICS</span>
            <span className="desc">Charts and trends across every ward — Today, This Week, This Month, or This Year.</span>
          </button>
        </div>
      </div>
    </>
  );
}
