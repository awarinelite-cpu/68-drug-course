import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";

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
  const { status, error, profile } = useAuth();
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

  if (adminOnly && profile?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return children;
}
