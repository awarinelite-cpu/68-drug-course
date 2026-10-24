import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { useGoBack } from "../hooks/useGoBack.js";
import { useBackLock } from "../hooks/useBackLock.js";
import Topbar from "../components/Topbar.jsx";
import { initCalculators } from "../lib/calculators.js";

export default function Calculators() {
  const goBack = useGoBack('/');
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get('patient');
  // Same Back behaviour as the other pages: always land on a known route
  // (the open patient if there is one, else Home), however this page was reached.
  useBackLock(patientId ? '/patient?patient=' + encodeURIComponent(patientId) : '/');
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
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
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
