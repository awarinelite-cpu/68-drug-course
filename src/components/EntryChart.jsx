import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  collection, addDoc, deleteDoc, doc, getDoc, setDoc, onSnapshot, query, orderBy, serverTimestamp
} from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useBackLock } from "../hooks/useBackLock.js";
import { useChartBack } from "../hooks/useChartBack.js";
import { usePatientHeader } from "../hooks/usePatientHeader.js";
import Topbar from "./Topbar.jsx";
import PatientBanner from "./PatientBanner.jsx";

const STATUS_LABELS = { referred: 'Referred to another hospital', transferred: 'Transferred to another ward', discharged: 'Discharged' };

// columns entries support:
//   { key, label, type }                 — normal entered field
//   { key, label, type: 'select', options: [...], placeholder?, otherOption?, otherPlaceholder? }
//                                         — dropdown; placeholder (if set) adds a blank first
//                                           option with that text, selected by default. When
//                                           otherOption is set and selected, an extra textarea
//                                           appears and its text is folded into the saved value
//                                           as "<otherOption>: <text>"
//   { ..., group, groupGate: true }      — groups columns together (e.g. all the "output" fields).
//                                           The one column with groupGate:true acts as an on/off
//                                           switch: if it's left on its placeholder (blank) when
//                                           Add Entry is pressed, every other column sharing that
//                                           `group` is cleared before saving, even if something
//                                           was typed into it. Grouped columns render together
//                                           inside their own visually distinct box in the entry
//                                           form. Set `groupColor`/`groupLabel` on any one column
//                                           in the group (typically the groupGate column).
//   { key, label, computed: true }       — value is filled in by deriveRows(), no input is rendered for it
//   { ..., formOnly: true }              — opposite of computed: rendered as a form input but
//                                           skipped in the table header/body (e.g. a single
//                                           datetime input that's split into separate Date/Time
//                                           display columns via deriveRows)
//   { ..., abnormal: (value, row) => bool, deficitShade?: true } — shades the cell for quick visual flagging
//   { ..., popup: true }                 — table cell shows a truncated one-line preview; tapping it
//                                           opens a small popup with the full text (same pattern as the
//                                           Diagnosis field on the Drug Course Chart)
//
// Optional top-level props:
//   deriveRows(ascRows, closeContext) — given entries sorted oldest→newest, return the same rows
//                         with any computed fields (e.g. a running balance) attached. May also
//                         insert extra rows shaped { isPeriodSummary: true, summaryText, deficit }
//                         at any point — these render as a single bold row spanning every column
//                         (maroon when deficit is true). `closeContext` is null for a live chart,
//                         or { closedAt: Date|null, closedAtDisplay: string|null } when viewing a
//                         closed admission — letting deriveRows force its final period closed at
//                         that moment rather than waiting for the period's normal boundary.
//   sortOrder: 'asc' | 'desc' (default) — display order after deriveRows runs.
//   summary: { label, archivedLabel, storeAt: [collName, docId], archivedKey, compute(rawRows, closeContext) }
//          — renders a small auto-updating, auto-saved totals card above the table.

function cellValue(row, col) {
  return (row[col.key] !== undefined && row[col.key] !== null && row[col.key] !== '') ? row[col.key] : '';
}

function cellClass(col, row) {
  if (typeof col.abnormal === 'function') {
    const raw = row[col.key];
    if (raw !== undefined && raw !== null && raw !== '' && col.abnormal(raw, row)) {
      return col.deficitShade ? 'flag-deficit' : 'flag-abnormal';
    }
  }
  return '';
}

// Sorts oldest→newest, runs deriveRows() to attach computed fields (e.g.
// balance) and possibly insert period-summary rows, then orders for display.
function withDerivedRows(rawRows, deriveRows, sortOrder, closeContext) {
  const asc = rawRows.slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const derived = typeof deriveRows === 'function' ? deriveRows(asc, closeContext) : asc;
  return sortOrder === 'asc' ? derived : derived.slice().sort((a, b) => (b.time || '').localeCompare(a.time || ''));
}

function FieldPopupModal({ label, value, onClose }) {
  return (
    <div className="field-popup-overlay no-print" style={{ display: 'flex' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="field-popup-box">
        <div className="field-popup-header"><h3>{label}</h3><button type="button" className="field-popup-close" aria-label="Close" onClick={onClose}>&times;</button></div>
        <div className="field-popup-body"><p className="field-popup-text">{value || '(Not entered)'}</p></div>
      </div>
    </div>
  );
}

// One entry-form field, including the select+"Other" textarea variant.
function FormField({ col, value, otherValue, onChange, onOtherChange }) {
  if (col.type === 'select') {
    const showOther = col.otherOption && value === col.otherOption;
    return (
      <div className="field" style={{ flex: '1 1 140px' }}>
        <label>{col.label}</label>
        <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
          {col.placeholder && <option value="">{col.placeholder}</option>}
          {(col.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
        </select>
        {col.otherOption && (
          <textarea rows={1} placeholder={col.otherPlaceholder || 'Please specify'}
            style={{ display: showOther ? 'block' : 'none', width: '100%', marginTop: 4, fontFamily: 'inherit' }}
            value={otherValue || ''} onChange={(e) => onOtherChange(e.target.value)} />
        )}
      </div>
    );
  }
  return (
    <div className="field" style={{ flex: '1 1 140px' }}>
      <label>{col.label}</label>
      <input type={col.type || 'text'} value={value || ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export default function EntryChart({ title, collectionName, columns, deriveRows, summary, entryNoun = 'Entry', sortOrder = 'desc' }) {
  const { profile } = useAuth();
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get('patient');
  const admissionId = searchParams.get('admission');
  const isArchived = !!admissionId;

  useBackLock('/');
  const goBack = useChartBack(patientId, admissionId);
  const { patient } = usePatientHeader(patientId);

  const displayColumns = columns.filter(c => !c.formOnly);
  const enterableColumns = columns.filter(c => !c.computed);

  const [entryValues, setEntryValues] = useState(() => {
    const initial = {};
    enterableColumns.forEach(c => {
      if (c.key === 'time') {
        const now = new Date();
        now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
        initial[c.key] = now.toISOString().slice(0, 16);
      } else initial[c.key] = '';
    });
    return initial;
  });
  const [entryOtherValues, setEntryOtherValues] = useState({});

  const [rawRows, setRawRows] = useState([]);
  const [loadedArchive, setLoadedArchive] = useState(false);
  const [archiveMeta, setArchiveMeta] = useState(null);
  const [archiveRows, setArchiveRows] = useState([]);
  const [summaryTotals, setSummaryTotals] = useState(null);
  const [popup, setPopup] = useState(null); // { label, value } | null
  const saveIntervalRef = useRef(null);

  const closeContext = isArchived && archiveMeta ? {
    closedAt: archiveMeta.archivedAt?.toDate ? archiveMeta.archivedAt.toDate() : null,
    closedAtDisplay: archiveMeta.archivedAtDisplay || null
  } : null;

  // Live subscription (non-archived only)
  useEffect(() => {
    if (isArchived || !patientId) return;
    const q = query(collection(db, 'patients', patientId, collectionName), orderBy('time', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      const rows = [];
      snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
      setRawRows(rows);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, isArchived, collectionName]);

  // Archived load
  useEffect(() => {
    if (!isArchived || !patientId) return;
    (async () => {
      const admSnap = await getDoc(doc(db, 'patients', patientId, 'admissions', admissionId));
      const admData = admSnap.exists() ? admSnap.data() : {};
      setArchiveMeta(admData);
      setArchiveRows(admData[collectionName] || []);
      setLoadedArchive(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isArchived, patientId, admissionId, collectionName]);

  async function saveSummary(rows) {
    if (!summary || !summary.storeAt || isArchived || !patientId) return;
    const totals = summary.compute(rows);
    const [collName, docId] = summary.storeAt;
    try {
      await setDoc(doc(db, 'patients', patientId, collName, docId), {
        ...totals, periodDate: new Date().toISOString().slice(0, 10), updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) { /* summary is a convenience record — a failed save here isn't fatal */ }
  }

  // Summary card: recompute live for an active chart (and re-save every
  // 15 min so the closed-period totals appear on schedule); for an archived
  // admission, prefer the totals preserved at archive time.
  useEffect(() => {
    if (!summary) return;
    if (isArchived) {
      if (!loadedArchive) return;
      const preserved = summary.archivedKey ? archiveMeta?.[summary.archivedKey] : null;
      setSummaryTotals(preserved || summary.compute(archiveRows, closeContext));
      return;
    }
    setSummaryTotals(summary.compute(rawRows));
    saveSummary(rawRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows, isArchived, loadedArchive]);

  useEffect(() => {
    if (!summary || isArchived) return;
    saveIntervalRef.current = setInterval(() => {
      setSummaryTotals(summary.compute(rawRows));
      saveSummary(rawRows);
    }, 15 * 60 * 1000);
    return () => clearInterval(saveIntervalRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows, isArchived]);

  // Reads an entry field's value — for a 'select' column with otherOption
  // selected, folds the paired textarea's text into the saved value as
  // "<otherOption>: <text>".
  function readInputValue(col) {
    const val = entryValues[col.key] || '';
    if (col.type === 'select' && col.otherOption && val === col.otherOption) {
      const otherText = (entryOtherValues[col.key] || '').trim();
      return otherText ? (col.otherOption + ': ' + otherText) : col.otherOption;
    }
    return val;
  }

  async function addEntry() {
    const data = {};
    enterableColumns.forEach(col => { data[col.key] = readInputValue(col); });

    // Group gating: a column marked groupGate acts as an on/off switch for
    // every other column sharing its `group`. If the gate's dropdown is
    // left on its placeholder (blank), every other field in that group is
    // cleared before saving — even if something was typed into it.
    const groupGateValue = {};
    columns.forEach(col => { if (col.groupGate) groupGateValue[col.group] = data[col.key]; });
    columns.forEach(col => {
      if (col.group && !col.groupGate && groupGateValue[col.group] === '') data[col.key] = '';
    });

    if (!data.time) { alert('Please set the time.'); return; }
    data.createdAt = serverTimestamp();
    data.enteredBy = profile.name;
    await addDoc(collection(db, 'patients', patientId, collectionName), data);

    setEntryValues((v) => {
      const next = { ...v };
      Object.keys(next).forEach((k) => { if (k !== 'time') next[k] = ''; });
      return next;
    });
    setEntryOtherValues({});
  }

  async function deleteEntry(id) {
    if (confirm('Delete this entry?')) await deleteDoc(doc(db, 'patients', patientId, collectionName, id));
  }

  // Groups entry-form fields into their `group` boxes (in column order), and
  // ungrouped fields render inline as before.
  function renderEntryForm() {
    const rendered = [];
    const groupedAlready = new Set();
    enterableColumns.forEach((col) => {
      if (col.group) {
        if (groupedAlready.has(col.group)) return;
        groupedAlready.add(col.group);
        const sameGroup = enterableColumns.filter(c => c.group === col.group);
        const styled = sameGroup.find(c => c.groupColor || c.groupLabel) || col;
        rendered.push(
          <div key={'group-' + col.group} style={{
            flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 10, padding: 10, borderRadius: 8,
            background: styled.groupColor || undefined
          }}>
            {styled.groupLabel && <div style={{ fontWeight: 600 }}>{styled.groupLabel}</div>}
            {sameGroup.map((c) => (
              <FormField key={c.key} col={c} value={entryValues[c.key]} otherValue={entryOtherValues[c.key]}
                onChange={(v) => setEntryValues((s) => ({ ...s, [c.key]: v }))}
                onOtherChange={(v) => setEntryOtherValues((s) => ({ ...s, [c.key]: v }))} />
            ))}
          </div>
        );
      } else {
        rendered.push(
          <FormField key={col.key} col={col} value={entryValues[col.key]} otherValue={entryOtherValues[col.key]}
            onChange={(v) => setEntryValues((s) => ({ ...s, [col.key]: v }))}
            onOtherChange={(v) => setEntryOtherValues((s) => ({ ...s, [col.key]: v }))} />
        );
      }
    });
    return rendered;
  }

  const displayRows = isArchived
    ? withDerivedRows(archiveRows, deriveRows, sortOrder, closeContext)
    : withDerivedRows(rawRows, deriveRows, sortOrder, null);

  return (
    <>
      <Topbar brand={title}>
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
        <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={() => window.print()}>Print</button>
      </Topbar>
      <div className="container">
        <PatientBanner patient={patient} />

        {isArchived && loadedArchive && (
          <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#78350f', fontWeight: 'bold', padding: '8px 12px', borderRadius: 6, marginTop: 10, fontSize: 13 }}>
            Archived chart — {(archiveMeta?.archiveReasonLabel || STATUS_LABELS[archiveMeta?.archiveReason] || 'Closed')}
            {archiveMeta?.archivedAtDisplay ? ' on ' + archiveMeta.archivedAtDisplay : ''}
          </div>
        )}

        {summary && summaryTotals && (
          <div className="card-box">
            <h3 style={{ marginTop: 0 }}>{isArchived && summary.archivedLabel ? summary.archivedLabel : summary.label}</h3>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 14 }}>
              <div><b>Total Intake:</b> {summaryTotals.intake} ml</div>
              <div><b>Total Output:</b> {summaryTotals.output} ml</div>
              <div className={summaryTotals.balance < 0 ? 'flag-deficit' : ''} style={{ padding: '2px 8px', borderRadius: 4 }}>
                <b>Balance:</b> {summaryTotals.balance} ml{summaryTotals.balance < 0 ? ' (deficit)' : ''}
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#777', marginTop: 6 }}>
              {isArchived ? 'Saved at the time this admission was closed.' : 'Recalculates automatically as entries are added, and saves every 24 hours.'}
            </div>
          </div>
        )}

        {!isArchived && (
          <div className="card-box no-print">
            <h3 style={{ marginTop: 0 }}>New {entryNoun === 'Reading' ? 'Reading' : 'Entry'}</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {renderEntryForm()}
            </div>
            <button className="btn btn-primary" onClick={addEntry}>Add {entryNoun}</button>
          </div>
        )}

        <div className="card-box">
          <h3 style={{ marginTop: 0 }}>{entryNoun === 'Reading' ? 'Readings' : 'Entries'}</h3>
          <div className="table-wrap">
          <table className="entries">
            <thead>
              <tr>
                {displayColumns.map((c) => <th key={c.key}>{c.label}</th>)}
                {!isArchived && <th className="no-print"></th>}
              </tr>
            </thead>
            <tbody>
              {isArchived && loadedArchive && displayRows.length === 0 && (
                <tr><td colSpan={displayColumns.length} style={{ color: '#777' }}>No entries recorded for this admission.</td></tr>
              )}
              {!isArchived && rawRows.length === 0 && (
                <tr><td colSpan={displayColumns.length + 1} style={{ color: '#777' }}>No entries yet.</td></tr>
              )}
              {displayRows.map((row, idx) => {
                if (row.isPeriodSummary) {
                  return (
                    <tr key={'summary-' + idx}>
                      <td colSpan={displayColumns.length + (isArchived ? 0 : 1)}
                        style={{ fontWeight: 'bold', padding: '8px 10px', background: '#f3f4f6', color: row.deficit ? 'maroon' : undefined }}>
                        {row.summaryText}
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={row.id || row.time + '-' + idx}>
                    {displayColumns.map((col) => {
                      const value = cellValue(row, col);
                      if (col.popup) {
                        return (
                          <td key={col.key} className={cellClass(col, row) + ' popup-cell'} title="Tap to view full text"
                            onClick={() => setPopup({ label: col.label, value })}>
                            {value}
                          </td>
                        );
                      }
                      return <td key={col.key} className={cellClass(col, row)}>{value}</td>;
                    })}
                    {!isArchived && (
                      <td className="no-print">
                        <button className="btn btn-danger" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => deleteEntry(row.id)}>Delete</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      </div>
      {popup && <FieldPopupModal label={popup.label} value={popup.value} onClose={() => setPopup(null)} />}
    </>
  );
}
