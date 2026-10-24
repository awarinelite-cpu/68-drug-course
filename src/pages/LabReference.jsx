import { useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useNav } from "../contexts/NavContext.jsx";
import { useBackHandler } from "../hooks/useBackHandler.js";
import Topbar from "../components/Topbar.jsx";
import { initLabReference } from "../lib/lab-reference.js";

export default function LabReference() {
  const navigate = useNavigate();
  const location = useLocation();
  const { openDrawer } = useNav();
  // Back returns to the page the side menu was opened from, with the menu open.
  useBackHandler(() => {
    navigate(location.state?.from || '/', { replace: true });
    openDrawer();
    return false;
  });
  const rootRef = useRef(null);

  useEffect(() => {
    if (rootRef.current) initLabReference(rootRef.current);
  }, []);

  return (
    <>
      <Topbar brand="Lab Reference">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => window.history.back()}>Back</button>
      </Topbar>
      <div className="container">
        <div className="card-box">
          <div ref={rootRef} />
        </div>
      </div>
    </>
  );
}
