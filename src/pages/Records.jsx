import { useEffect, useMemo, useState } from "react";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { getDocSafe } from "../lib/firestoreOffline.js";
import {
  DEMOGRAPHIC_CATEGORIES, DEMOGRAPHIC_AFFILIATIONS, DEMOGRAPHIC_SEXES, DEMOGRAPHIC_FIELDS, todayISO
} from "../lib/nurses-report-common.js";
import Topbar from "../components/Topbar.jsx";

// Rows of the paper "Summary Breakdown of Statistics" sheet, in paper order.
const RECORD_ROWS = [
  { key: "ae", label: "A&E" },
  { key: "fsw", label: "FSW" },
  { key: "fmw", label: "FMW" },
  { key: "msw1", label: "MSW 1" },
  { key: "msw2", label: "MSW 2" },
  { key: "mmw", label: "MMW" },
  { key: "orth", label: "ORTH" },
  { key: "pead", label: "PEAD" },
  { key: "gynae", label: "GYNAE" },
  { key: "offrs", label: "OFFR'S" },
  { key: "award", label: "A WARD" },
  { key: "maternity", label: "MATERNITY" }
];
const OFFICERS_ROW = "offrs";

function toNum(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; }

// Sum of a category's cells for one affiliation (both sexes) across given rows.
function sumCells(rows, rowKeys, cat, aff) {
  let t = 0;
  rowKeys.forEach((rk) => DEMOGRAPHIC_SEXES.forEach((sx) => { t += toNum(rows[rk]?.[`${cat}_${aff}${sx}`]); }));
  return t;
}

export default function Records() {
  const { user, profile } = useAuth();
  const goBack = useGoBack("/");
  const [date, setDate] = useState(todayISO());
  const [rows, setRows] = useState({});
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // { error, text }

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setDirty(false); setMsg(null);
    (async () => {
      try {
        const snap = await getDocSafe(doc(db, "recordSummaries", date));
        if (!cancelled) setRows(snap.exists() ? (snap.data().rows || {}) : {});
      } catch (e) {
        if (!cancelled) { setRows({}); setMsg({ error: true, text: "Couldn't load this date: " + (e.code || e.message) }); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [date]);

  function setCell(rowKey, field, value) {
    setRows((r) => ({ ...r, [rowKey]: { ...(r[rowKey] || {}), [field]: value } }));
    setDirty(true);
  }

  async function save() {
    setSaving(true); setMsg(null);
    // Store numbers as numbers, drop blanks.
    const clean = {};
    RECORD_ROWS.forEach((r) => {
      const src = rows[r.key] || {};
      const out = {};
      DEMOGRAPHIC_FIELDS.forEach((f) => { const n = toNum(src[f.key]); if (n) out[f.key] = n; });
      if ((src.rmks || "").trim()) out.rmks = src.rmks.trim();
      if (Object.keys(out).length) clean[r.key] = out;
    });
    try {
      await setDoc(doc(db, "recordSummaries", date), {
        rows: clean, updatedAt: serverTimestamp(), updatedBy: user?.uid || "", updatedByName: profile?.name || ""
      });
      setDirty(false);
      setMsg({ text: "Saved." });
    } catch (e) {
      setMsg({ error: true, text: "Couldn't save: " + (e.code || e.message || "unknown error") });
    } finally {
      setSaving(false);
    }
  }

  const allKeys = useMemo(() => RECORD_ROWS.map((r) => r.key), []);
  const totalFor = (field) => allKeys.reduce((t, rk) => t + toNum(rows[rk]?.[field]), 0);

  // Footer lines: OFFRS from the OFFR'S row's military cells; SLDRS = all
  // military minus officers; CIVS = all civilian cells.
  const footer = DEMOGRAPHIC_CATEGORIES.reduce((acc, cat) => {
    const offrs = sumCells(rows, [OFFICERS_ROW], cat.key, "mil");
    const sldrs = sumCells(rows, allKeys, cat.key, "mil") - offrs;
    const civs = sumCells(rows, allKeys, cat.key, "civ");
    acc[cat.key] = { offrs, sldrs, civs };
    return acc;
  }, {});

  const cellInput = { width: 44, textAlign: "center", padding: "6px 2px", fontSize: 15, boxSizing: "border-box" };
  const th = { whiteSpace: "nowrap", fontSize: 13 };

  return (
    <>
      <Topbar brand="Records">
        <button className="btn btn-secondary no-print" style={{ padding: "6px 12px" }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container" style={{ maxWidth: 1100 }}>
        <div className="card-box">
          <h3 style={{ marginTop: 0, textAlign: "center" }}>
            SUMMARY BREAKDOWN OF STATISTICS AS AT {date.split("-").reverse().join("/")}
          </h3>

          <div className="field no-print" style={{ maxWidth: 220 }}>
            <label>Date</label>
            <input type="date" value={date} max={todayISO()} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </div>

          {loading ? <div className="loading-note">Loading…</div> : (
            <div className="table-wrap">
              <table className="entries" style={{ marginTop: 0 }}>
                <thead>
                  <tr>
                    <th rowSpan={3} style={th}>Ward</th>
                    {DEMOGRAPHIC_CATEGORIES.map((c) => <th key={c.key} colSpan={4} style={th}>{c.label}</th>)}
                    <th rowSpan={3} style={th}>Rmks</th>
                  </tr>
                  <tr>
                    {DEMOGRAPHIC_CATEGORIES.map((c) => DEMOGRAPHIC_AFFILIATIONS.map((a) => (
                      <th key={c.key + a.key} colSpan={2} style={th}>{a.label}</th>
                    )))}
                  </tr>
                  <tr>
                    {DEMOGRAPHIC_CATEGORIES.map((c) => DEMOGRAPHIC_AFFILIATIONS.map((a) => DEMOGRAPHIC_SEXES.map((sx) => (
                      <th key={c.key + a.key + sx} style={th}>{sx}</th>
                    ))))}
                  </tr>
                </thead>
                <tbody>
                  {RECORD_ROWS.map((r) => (
                    <tr key={r.key}>
                      <td style={{ textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>{r.label}</td>
                      {DEMOGRAPHIC_FIELDS.map((f) => (
                        <td key={f.key} style={{ padding: 2 }}>
                          <input type="number" inputMode="numeric" min="0" style={cellInput}
                            value={rows[r.key]?.[f.key] ?? ""}
                            onChange={(e) => setCell(r.key, f.key, e.target.value)} />
                        </td>
                      ))}
                      <td style={{ padding: 2 }}>
                        <input type="text" style={{ ...cellInput, width: 110, textAlign: "left", padding: "6px" }}
                          value={rows[r.key]?.rmks ?? ""} onChange={(e) => setCell(r.key, "rmks", e.target.value)} />
                      </td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700, background: "var(--background)" }}>
                    <td style={{ textAlign: "left" }}>G/TOTAL</td>
                    {DEMOGRAPHIC_FIELDS.map((f) => <td key={f.key}>{totalFor(f.key)}</td>)}
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {!loading && (
            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table className="entries" style={{ marginTop: 0, maxWidth: 520 }}>
                <thead>
                  <tr><th></th>{DEMOGRAPHIC_CATEGORIES.map((c) => <th key={c.key} style={th}>{c.key === "adm" ? "ADM" : c.label.toUpperCase()}</th>)}</tr>
                </thead>
                <tbody>
                  {[["OFFRS", "offrs"], ["SLDRS", "sldrs"], ["CIVS", "civs"]].map(([label, k]) => (
                    <tr key={k}>
                      <td style={{ textAlign: "left", fontWeight: 600 }}>{label}</td>
                      {DEMOGRAPHIC_CATEGORIES.map((c) => <td key={c.key}>{footer[c.key][k]}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="field-hint">OFFRS comes from the OFFR'S row (military); SLDRS is all other military; CIVS is all civilian.</div>
            </div>
          )}

          <div className="no-print" style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={saving || loading || !dirty} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-secondary" onClick={() => window.print()}>Print</button>
          </div>
          {dirty && !saving && <div className="field-hint no-print">Unsaved changes.</div>}
          {msg && <div className={msg.error ? "error-msg" : "info-msg"}>{msg.text}</div>}
        </div>
      </div>
    </>
  );
}
