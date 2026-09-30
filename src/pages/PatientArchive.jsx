import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, query, where, limit } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import Topbar from "../components/Topbar.jsx";

const ARCHIVE_LIMIT = 1000;

function tsMillis(ts) {
  return ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0;
}

// Patients whose admission has been closed out (discharged / died / DAMA /
// absconded / referred out). closeOutDischargedPatient() clears their ward
// once the admission is archived, so "no ward" is what marks a patient as
// being in the archive. Tapping one opens Overview, where their archived
// admissions (with every chart) are listed.
export default function PatientArchive() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack("/");
  const [status, setStatus] = useState("loading"); // 'loading' | 'ready' | error string
  const [patients, setPatients] = useState([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        // Single equality filter (no orderBy) so no composite index is
        // needed; sorted client-side below.
        const snap = await getDocs(query(collection(db, "patients"), where("ward", "==", ""), limit(ARCHIVE_LIMIT)));
        if (cancelled) return;
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => {
          const diff = tsMillis(b.updatedAt) - tsMillis(a.updatedAt);
          return diff || (a.name || "").localeCompare(b.name || "");
        });
        setPatients(list);
        setStatus("ready");
      } catch (e) {
        if (!cancelled) setStatus("Couldn't load the archive: " + (e.code || e.message || "unknown error"));
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const filtered = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return patients;
    return patients.filter((p) => {
      const hay = ((p.name || "") + " " + (p.emr || "") + " " + (p.diagnosis || "")).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [patients, search]);

  function openPatient(id) {
    navigate("/charts/overview?patient=" + encodeURIComponent(id));
  }

  return (
    <>
      <Topbar brand="Archive">
        <button className="btn btn-secondary" style={{ padding: "6px 12px" }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h2 style={{ marginTop: 0 }}>Patient Archive</h2>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 10 }}>
            Patients who have left the ward (discharged, died, DAMA, absconded or referred). Tap a patient to see their archived admissions and charts.
          </div>

          <input
            type="search"
            className="archive-search"
            placeholder="Search by name, EMR number or diagnosis…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
          />

          {status === "loading" && <div className="loading-note">Loading…</div>}
          {status !== "loading" && status !== "ready" && <div className="loading-note">{status}</div>}

          {status === "ready" && (
            <div style={{ fontSize: 13, color: "#6b7280", margin: "8px 0" }}>
              {search.trim()
                ? filtered.length + " of " + patients.length + " archived patients"
                : patients.length + " archived " + (patients.length === 1 ? "patient" : "patients")}
              {patients.length >= ARCHIVE_LIMIT ? " (showing the most recent " + ARCHIVE_LIMIT + " — search to narrow down)" : ""}
            </div>
          )}

          {status === "ready" && filtered.length === 0 && (
            <div className="empty-note">{search.trim() ? "No archived patient matches your search." : "No patients in the archive yet."}</div>
          )}

          {status === "ready" && filtered.map((p) => (
            <div className="alloc-item" key={p.id} onClick={() => openPatient(p.id)}>
              <div className="alloc-main">
                <div className="alloc-name">{p.name || "Unnamed"}</div>
                <div className="alloc-meta">
                  EMR: {p.emr || "N/A"}
                  {p.age ? "  \u00b7  Age: " + p.age : ""}
                  {p.gender ? "  \u00b7  " + (p.gender === "M" ? "Male" : p.gender === "F" ? "Female" : p.gender) : ""}
                </div>
                {p.diagnosis && <div className="alloc-meta">{p.diagnosis}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
