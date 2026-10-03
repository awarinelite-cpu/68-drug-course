import { useMemo } from "react";
import {
  DEMOGRAPHIC_CATEGORIES, DEMOGRAPHIC_AFFILIATIONS, DEMOGRAPHIC_SEXES, DEMOGRAPHIC_FIELDS, OFFICER_FIELDS
} from "../lib/nurses-report-common.js";

// Rows of the paper "Summary Breakdown of Statistics" sheet, in paper order,
// each fed from the ward report(s) it corresponds to. The figures come from
// the Patient Demographics ward nurses enter on their own Ward Report page.
export const RECORD_ROWS = [
  { key: "ae", label: "A&E", wards: ["ae"] },
  { key: "fsw", label: "FSW", wards: ["fsw2", "fswext"] },
  { key: "fmw", label: "FMW", wards: ["fmw1"] },
  { key: "msw1", label: "MSW 1", wards: ["msw"] },
  { key: "msw2", label: "MSW 2", wards: ["esw"] },
  { key: "mmw", label: "MMW", wards: ["mmw"] },
  { key: "orth", label: "ORTH", wards: ["ortho"] },
  { key: "pead", label: "PEAD", wards: ["paedbed", "paedcot"] },
  { key: "gynae", label: "GYNAE", wards: ["gynae"] },
  { key: "offrs", label: "OFFR'S", wards: ["officers"] },
  { key: "award", label: "A WARD", wards: ["award"] },
  { key: "maternity", label: "MATERNITY", wards: ["matbed", "matcot"] }
];

export function toNum(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; }

// Turns { wardKey: wardDoc } into the sheet's rows ({ rowKey: { fieldKey: n } })
// and the all-ward officer counts ({ adm, disch, dead, bid }).
export function buildSheetFromWards(wardsMap) {
  const rows = {};
  RECORD_ROWS.forEach((r) => {
    const row = {};
    DEMOGRAPHIC_FIELDS.forEach((f) => {
      row[f.key] = r.wards.reduce((t, wk) => t + toNum(wardsMap[wk]?.[f.key]), 0);
    });
    rows[r.key] = row;
  });
  const officers = {};
  OFFICER_FIELDS.forEach((f) => {
    officers[f.category] = RECORD_ROWS.reduce((t, r) => t + r.wards.reduce((u, wk) => u + toNum(wardsMap[wk]?.[f.key]), 0), 0);
  });
  return { rows, officers };
}

function sumCells(rows, rowKeys, cat, aff) {
  let t = 0;
  rowKeys.forEach((rk) => DEMOGRAPHIC_SEXES.forEach((sx) => { t += toNum(rows[rk]?.[`${cat}_${aff}${sx}`]); }));
  return t;
}

const th = { whiteSpace: "nowrap", fontSize: 13 };
const remarkInput = { width: 110, textAlign: "left", padding: "6px", fontSize: 15, boxSizing: "border-box" };

// The sheet itself. Pass onRemarkChange to make the Rmks column editable;
// leave it out for a read-only view (the archive).
export default function RecordsSheet({ date, rows, officers, remarks, onRemarkChange }) {
  const allKeys = useMemo(() => RECORD_ROWS.map((r) => r.key), []);
  const totalFor = (field) => allKeys.reduce((t, rk) => t + toNum(rows[rk]?.[field]), 0);
  const footer = DEMOGRAPHIC_CATEGORIES.reduce((acc, cat) => {
    const offrs = toNum(officers?.[cat.key]);
    const sldrs = Math.max(0, sumCells(rows, allKeys, cat.key, "mil") - offrs);
    const civs = sumCells(rows, allKeys, cat.key, "civ");
    acc[cat.key] = { offrs, sldrs, civs };
    return acc;
  }, {});

  return (
    <>
      <h3 style={{ marginTop: 0, textAlign: "center" }}>
        SUMMARY BREAKDOWN OF STATISTICS AS AT {date.split("-").reverse().join("/")}
      </h3>
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
                {DEMOGRAPHIC_FIELDS.map((f) => <td key={f.key}>{toNum(rows[r.key]?.[f.key]) || ""}</td>)}
                <td style={{ padding: onRemarkChange ? 2 : undefined, textAlign: "left" }}>
                  {onRemarkChange
                    ? <input type="text" style={remarkInput} value={remarks[r.key] ?? ""} onChange={(e) => onRemarkChange(r.key, e.target.value)} />
                    : (remarks[r.key] || "")}
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
        <div className="field-hint">OFFRS = officers in every ward (Army Number N/…); SLDRS = all other military; CIVS = all civilians.</div>
      </div>
    </>
  );
}
