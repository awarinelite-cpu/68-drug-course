import { useEffect, useState } from "react";
import { doc } from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { db } from "../firebase.js";
import { getDocSafe } from "../lib/firestoreOffline.js";

// Returns { patient, loading }. Redirects to "/" if the patient doesn't exist
// (mirrors chart-common.js's alert() + redirect behavior, minus the blocking alert).
export function usePatientHeader(patientId) {
  const [patient, setPatient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    if (!patientId) { navigate("/"); return; }
    setLoading(true);
    setError(null);
    getDocSafe(doc(db, "patients", patientId)).then((snap) => {
      if (cancelled) return;
      if (!snap.exists()) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setPatient({ id: snap.id, ...snap.data() });
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError("Couldn't load patient: " + (e.code || e.message || 'unknown error'));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [patientId, navigate]);

  useEffect(() => {
    if (notFound) navigate("/");
  }, [notFound, navigate]);

  return { patient, loading, error };
}
