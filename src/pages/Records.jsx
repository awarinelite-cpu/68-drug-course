import { useEffect, useState } from "react";
import { doc, serverTimestamp, collection, writeBatch } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { useNavigate } from "react-router-dom";
import { getDocSafe, getDocsSafe } from "../lib/firestoreOffline.js";
import { reportDateId } from "../lib/nurses-report-common.js";
import Topbar from "../components/Topbar.jsx";
import RecordsSheet, { RECORD_ROWS, buildSheetFromWards } from "../components/RecordsSheet.jsx";

function fmtSaved(ts) {
  try { return ts?.toDate ? ts.toDate().toLocaleString() : ""; } catch { return ""; }
}

export default function Records() {
  const { user, profile } = useAuth();
  const goBack = useGoBack("/");
  const navigate = useNavigate();
  const [date, setDate] = useState(reportDateId());
  const [rows, setRows] = useState({});
  const [remarks, setRemarks] = useState({});
  const [officers, setOfficers] = useState({});
  const [source, setSource] = useState("");
  const [savedInfo, setSavedInfo] = useState(null); // { at, by } of the archived copy for this date
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // { error, text }

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setMsg(null);
    (async () => {
      try {
        // Archived ward report wins once the day has been filed; otherwise the live ward docs.
        let wardsMap = {};
        let src = "";
        const arch = await getDocSafe(doc(db, "archives", "overall_" + date));
        if (arch.exists() && arch.data().wards) {
          wardsMap = arch.data().wards; src = "archived report";
        } else {
          const snap = await getDocsSafe(collection(db, "nurseReports", date, "wards"));
          snap.forEach((d) => { wardsMap[d.id] = d.data(); });
          src = Object.keys(wardsMap).length ? "live ward reports (not yet archived)" : "";
        }
        const built = buildSheetFromWards(wardsMap);
        let rem = {};
        const saved = await getDocSafe(doc(db, "recordSummaries", date));
        if (saved.exists()) rem = saved.data().remarks || {};
        const arc = await getDocSafe(doc(db, "recordArchives", date));
        if (!cancelled) {
          setRows(built.rows); setOfficers(built.officers); setRemarks(rem); setSource(src);
          setSavedInfo(arc.exists() ? { at: fmtSaved(arc.data().savedAt), by: arc.data().savedByName || "" } : null);
        }
      } catch (e) {
        if (!cancelled) { setRows({}); setRemarks({}); setOfficers({}); setSource(""); setSavedInfo(null); setMsg({ error: true, text: "Couldn't load this date: " + (e.code || e.message) }); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [date]);

  // Saves the whole table (every figure, the officer counts and the remarks)
  // as that date's permanent copy in the Records Archive. Saving the same
  // date again replaces its copy.
  async function saveToArchive() {
    setSaving(true); setMsg(null);
    const cleanRemarks = {};
    RECORD_ROWS.forEach((r) => { const t = (remarks[r.key] || "").trim(); if (t) cleanRemarks[r.key] = t; });
    const who = { savedBy: user?.uid || "", savedByName: profile?.name || "" };
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, "recordSummaries", date), { remarks: cleanRemarks, updatedAt: serverTimestamp(), updatedBy: who.savedBy, updatedByName: who.savedByName });
      batch.set(doc(db, "recordArchives", date), { date, rows, officers, remarks: cleanRemarks, source, savedAt: serverTimestamp(), ...who });
      await batch.commit();
      setSavedInfo({ at: new Date().toLocaleString(), by: who.savedByName });
      setMsg({ text: "Saved to the Records Archive." });
    } catch (e) {
      setMsg({ error: true, text: "Couldn't save: " + (e.code || e.message || "unknown error") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Topbar brand="Records">
        <button className="btn btn-secondary no-print" style={{ padding: "6px 12px" }} onClick={() => navigate("/records/archive")}>Archive</button>
        <button className="btn btn-secondary no-print" style={{ padding: "6px 12px" }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container" style={{ maxWidth: 1100 }}>
        <div className="card-box">
          <div className="field no-print" style={{ maxWidth: 220 }}>
            <label>Date</label>
            <input type="date" value={date} max={reportDateId()} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </div>

          {!loading && (
            <div className="field-hint no-print" style={{ marginTop: -6, marginBottom: 10 }}>
              {source ? "Figures are taken from the ward nurses' Patient Demographics (" + source + ")." : "No ward reports found for this date."}
              {savedInfo && <><br />Saved to the archive{savedInfo.at ? " on " + savedInfo.at : ""}{savedInfo.by ? " by " + savedInfo.by : ""}. Saving again replaces it.</>}
            </div>
          )}

          {loading ? <div className="loading-note">Loading…</div> : (
            <RecordsSheet date={date} rows={rows} officers={officers} remarks={remarks}
              onRemarkChange={(k, v) => setRemarks((m) => ({ ...m, [k]: v }))} />
          )}

          <div className="no-print" style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={saving || loading} onClick={saveToArchive}>
              {saving ? "Saving…" : savedInfo ? "Save Again to Archive" : "Save to Archive"}
            </button>
            <button className="btn btn-secondary" onClick={() => window.print()}>Print</button>
          </div>
          {msg && <div className={msg.error ? "error-msg" : "info-msg"}>{msg.text}</div>}
        </div>
      </div>
    </>
  );
}
