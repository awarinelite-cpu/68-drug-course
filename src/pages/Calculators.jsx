import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { useNavigate, useLocation } from "react-router-dom";
import { useNav } from "../contexts/NavContext.jsx";
import { useBackHandler } from "../hooks/useBackHandler.js";
import Topbar from "../components/Topbar.jsx";
import { initCalculators, isCalculatorHub, showCalculatorHub } from "../lib/calculators.js";

export default function Calculators() {
  const navigate = useNavigate();
  const location = useLocation();
  const { openDrawer } = useNav();
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get('patient');
  // Back: inside a calculator -> calculator home; already on the calculator
  // home -> back to the page the side menu was opened from, with the menu open.
  useBackHandler(() => {
    if (!isCalculatorHub()) { showCalculatorHub(); return true; }
    navigate(location.state?.from || '/', { replace: true });
    openDrawer();
    return false;
  });
  const [patient, setPatient] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    // Reference tool, independent of any single patient — still show a
    // banner for orientation if we arrived here with one selected, but
    // never require one.
    if (!patientId) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'patients', patientId));
        if (snap.exists()) setPatient(snap.data());
      } catch (e) { /* non-critical — calculators still work without patient context */ }
    })();
  }, [patientId]);

  useEffect(() => {
    if (rootRef.current) initCalculators(rootRef.current);
  }, []);

  return (
    <>
      <Topbar brand="Clinical Calculators">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => window.history.back()}>Back</button>
      </Topbar>
      <div className="container">
        {patient && (
          <div className="patient-banner">
            <div>
              <div className="pname">{patient.name || ''}</div>
              <div className="pmeta">EMR: {patient.emr || '—'}{patient.diagnosis ? ' | Diagnosis: ' + patient.diagnosis : ''}</div>
            </div>
          </div>
        )}
        <div className="card-box">
          <div ref={rootRef} />
        </div>
      </div>
    </>
  );
}
