import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";

// Shown instead of the app for a self-registered account (see
// RequestAccount.jsx) that hasn't been approved yet. firestore.rules
// backs this up independently — isKnownUser() already refuses a pending
// account read/write access to every other collection — this screen is
// just the friendly front door for that same block, with a way to sign
// out and check back later instead of a wall of permission-denied errors.
function PendingApproval({ onLogout }) {
  return (
    <div className="container" style={{ maxWidth: 480, marginTop: 60 }}>
      <div className="card-box">
        <h3 style={{ marginTop: 0 }}>Application Pending</h3>
        <p style={{ color: '#374151' }}>
          Your account application has been submitted and is waiting for an admin to review and approve
          it. You'll be able to use the app as soon as that happens — check back later, or log back in
          then.
        </p>
        <button className="btn btn-secondary" onClick={onLogout}>Log Out</button>
      </div>
    </div>
  );
}

// A cold-started window — e.g. tapping a drug-due notification, which opens
// a fresh window/tab straight at a deep chart URL instead of "/" — has to
// wait for Firebase Auth to rehydrate its persisted session from IndexedDB
// before onAuthStateChanged fires even once. That's normally near-instant,
// but on the ward's wifi (or a slow first cold-start of the service worker)
// it can stall. Previously this state rendered nothing at all, so a stall
// looked exactly like a broken blank page with no way to tell the two apart
// or recover. Now it shows a visible loading note, and if auth is still
// stuck after STUCK_MS, offers a manual reload instead of stalling forever.
const STUCK_MS = 8000;

export default function RequireAuth({ children, adminOnly }) {
  const { status, error, profile, logout } = useAuth();
  const location = useLocation();
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (status !== "loading") { setStuck(false); return; }
    const timer = setTimeout(() => setStuck(true), STUCK_MS);
    return () => clearTimeout(timer);
  }, [status]);

  if (status === "loading") {
    return (
      <div className="container" style={{ maxWidth: 480, marginTop: 60 }}>
        <div className="card-box">
          <div className="loading-note">Loading…</div>
          {stuck && (
            <>
              <div className="loading-note" style={{ marginTop: 8 }}>
                Still working on it — this is taking longer than usual.
              </div>
              <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => window.location.reload()}>
                Reload
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (status === "signed-out") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (status === "error") {
    return (
      <div className="container" style={{ maxWidth: 480, marginTop: 60 }}>
        <div className="card-box">
          <div className="error-msg">{error}</div>
        </div>
      </div>
    );
  }

  if (profile?.status === "pending") {
    return <PendingApproval onLogout={logout} />;
  }

  if (adminOnly && profile?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return children;
}
