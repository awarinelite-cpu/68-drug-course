import { useEffect, useRef } from "react";
import { useGoBack } from "../hooks/useGoBack.js";
import Topbar from "../components/Topbar.jsx";
import { initLabReference } from "../lib/lab-reference.js";

export default function LabReference() {
  const goBack = useGoBack('/');
  const rootRef = useRef(null);

  useEffect(() => {
    if (rootRef.current) initLabReference(rootRef.current);
  }, []);

  return (
    <>
      <Topbar brand="Lab Reference">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>
      <div className="container">
        <div className="card-box">
          <div ref={rootRef} />
        </div>
      </div>
    </>
  );
}
