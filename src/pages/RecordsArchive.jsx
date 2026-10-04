import { useEffect, useState } from "react";
import { collection, orderBy, query, limit, doc, deleteDoc } from "firebase/firestore";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useNavigate } from "react-router-dom";
import { db } from "../firebase.js";
import { useGoBack } from "../hooks/useGoBack.js";
import { getDocsSafe } from "../lib/firestoreOffline.js";
import Topbar from "../components/Topbar.jsx";
import RecordsSheet from "../components/RecordsSheet.jsx";
import usePrintOrientation from "../hooks/usePrintOrientation.js";

function fmtSaved(ts) {
  try { return ts?.toDate ? ts.toDate().toLocaleString() : ""; } catch { return ""; }
}

// Past Summary Breakdown of Statistics tables saved from the Records page,
// newest first. Read-only.
export default function RecordsArchive() {
  usePrintOrientation('landscape');
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const goBack = useGoBack("/records");
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocsSafe(query(collection(db, "recordArchives"), orderBy("date", "desc"), limit(400)));
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        if (!cancelled) setItems(list);
      } catch (e) {
        if (!cancelled) setError("Couldn't load the archive: " + (e.code || e.message));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const open = items.find((i) => i.id === openId);

  async function removeItem(i) {
    if (!window.confirm("Delete the saved table for " + i.date.split("-").reverse().join("/") + "? This cannot be undone.")) return;
    try {
      await deleteDoc(doc(db, "recordArchives", i.id));
      setItems((prev) => prev.filter((x) => x.id !== i.id));
      setOpenId("");
    } catch (e) {
      setError("Couldn't delete: " + (e.code || e.message));
    }
  }

  return (
    <>
      <Topbar brand="Records Archive">
        <button className="btn btn-secondary no-print" style={{ padding: "6px 12px" }} onClick={() => navigate("/records")}>Records</button>
        <button className="btn btn-secondary no-print" style={{ padding: "6px 12px" }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container" style={{ maxWidth: "98%" }}>
        {open ? (
          <div className="card-box">
            <div className="no-print" style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <button className="btn btn-secondary" onClick={() => setOpenId("")}>All saved tables</button>
              <button className="btn btn-secondary" onClick={() => window.print()}>Print</button>
              {isAdmin && <button className="btn btn-secondary" style={{ color: "#c0392b" }} onClick={() => removeItem(open)}>Delete</button>}
            </div>
            <RecordsSheet date={open.date} rows={open.rows || {}} officers={open.officers || {}} remarks={open.remarks || {}} />
            <div className="field-hint">
              Saved{fmtSaved(open.savedAt) ? " " + fmtSaved(open.savedAt) : ""}{open.savedByName ? " by " + open.savedByName : ""}.
            </div>
          </div>
        ) : (
          <div className="card-box">
            <h3 style={{ marginTop: 0 }}>Saved tables</h3>
            {loading && <div className="loading-note">Loading…</div>}
            {error && <div className="error-msg">{error}</div>}
            {!loading && !error && !items.length && <div className="field-hint">Nothing saved yet. Open the Records page and tap Save to Archive.</div>}
            {items.map((i) => (
              <div key={i.id} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button className="btn btn-secondary" style={{ flex: 1, textAlign: "left" }} onClick={() => setOpenId(i.id)}>
                  <strong>{i.date.split("-").reverse().join("/")}</strong>
                  <span style={{ opacity: 0.7, fontSize: 13 }}>{fmtSaved(i.savedAt) ? "  ·  saved " + fmtSaved(i.savedAt) : ""}{i.savedByName ? " by " + i.savedByName : ""}</span>
                </button>
                {isAdmin && <button className="btn btn-secondary" style={{ color: "#c0392b" }} onClick={() => removeItem(i)}>Delete</button>}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
