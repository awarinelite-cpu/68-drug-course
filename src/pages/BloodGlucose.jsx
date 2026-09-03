import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { useBackLock } from "../hooks/useBackLock.js";
import { useChartBack } from "../hooks/useChartBack.js";
import { usePatientHeader } from "../hooks/usePatientHeader.js";
import Topbar from "../components/Topbar.jsx";
import PatientBanner from "../components/PatientBanner.jsx";

const STATUS_LABELS = { referred: 'Referred to another hospital', transferred: 'Transferred to another ward', discharged: 'Discharged' };

const CHART_DEFS = {
  '6point': {
    title: '6 Points Glycemic Chart',
    columns: [
      { label: 'Date', type: 'date' },
      { label: 'Time', type: 'time' },
      { label: 'FBS', type: 'text', glucose: true, glucoseType: 'fasting' },
      { label: '2hrs Post Prandial', type: 'text', glucose: true, glucoseType: 'post' },
      { label: 'Pre-Lunch', type: 'text', glucose: true, glucoseType: 'fasting' },
      { label: '2hrs Post Lunch', type: 'text', glucose: true, glucoseType: 'post' },
      { label: 'Pre-Dinner', type: 'text', glucose: true, glucoseType: 'fasting' },
      { label: '2hrs Post Dinner', type: 'text', glucose: true, glucoseType: 'post' },
      { label: 'Remark', type: 'text' }
    ]
  },
  '3point': {
    title: '3 Points Glycemic Chart',
    columns: [
      { label: 'Date', type: 'date' },
      { label: 'Time', type: 'time' },
      { label: 'FBS', type: 'text', glucose: true, glucoseType: 'fasting' },
      { label: 'RBS', type: 'text', glucose: true, glucoseType: 'random' },
      { label: 'RBS', type: 'text', glucose: true, glucoseType: 'random' },
      { label: 'Remark', type: 'text' }
    ]
  }
};

// How many columns each chart type had BEFORE the Time column was added
// (right after Date). A saved row this short predates that change — insert
// a blank Time cell at index 1 so its existing values land back under the
// same headers they were saved under, instead of shifting one column left.
const PRE_TIME_COLUMN_COUNT = { '6point': 8, '3point': 5 };
function migrateRow(type, row) {
  if (Array.isArray(row) && row.length === PRE_TIME_COLUMN_COUNT[type]) {
    return [row[0], '', ...row.slice(1)];
  }
  return row;
}

// 6-point glycemic chart normal ranges:
//   Fasting / pre-meal (before breakfast, lunch, dinner): 70-99 mg/dL
//   2 hrs post-prandial (after breakfast, lunch, dinner): under 140 mg/dL
// Anything outside these ranges is flagged red. Random (3-point RBS)
// readings fall back to a general hypo/hyperglycemia flag since no fixed
// target applies.
function isAbnormalGlucose(v, glucoseType) {
  const n = parseFloat(v);
  if (isNaN(n)) return false;
  if (glucoseType === 'fasting') return n < 70 || n > 99;
  if (glucoseType === 'post') return n < 70 || n >= 140;
  return n < 70 || n > 180;
}

function emptyRows() { return Array.from({ length: 10 }, () => []); }

// On mobile, tapping a date/time input always opens the OS's full picker
// sheet regardless of where on the field you tap. On desktop, clicking the
// field just places a text cursor — the native dropdown picker only opens
// if you click the small calendar/clock icon specifically, which is easy
// to miss in a narrow table cell. Forcing showPicker() on click makes
// desktop match the "tap anywhere to pick" behavior mobile already has.
function openPicker(el) {
  if (!el || typeof el.showPicker !== 'function') return;
  try { el.showPicker(); } catch (e) { /* not focused/supported here — typing still works */ }
}

export default function BloodGlucose() {
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get('patient');
  const admissionId = searchParams.get('admission');
  const isArchived = !!admissionId;

  useBackLock('/');
  const goBack = useChartBack(patientId, admissionId);
  const { patient } = usePatientHeader(patientId);

  const [currentType, setCurrentType] = useState('6point');
  // Each chart type keeps its own rows. Switching the toggle only changes
  // which one is on screen — it never deletes the other type's data.
  const [rowsCache, setRowsCache] = useState({ '6point': [], '3point': [] });
  const [saveStatus, setSaveStatus] = useState('—');
  const [archiveMeta, setArchiveMeta] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const saveTimerRef = useRef(null);
  const chartRefPath = useRef(null);
  const rowsCacheRef = useRef(rowsCache);
  rowsCacheRef.current = rowsCache;
  const currentTypeRef = useRef(currentType);
  currentTypeRef.current = currentType;

  useEffect(() => {
    if (!patientId) return;
    (async () => {
      let data = null;
      if (isArchived) {
        const admSnap = await getDoc(doc(db, 'patients', patientId, 'admissions', admissionId));
        if (admSnap.exists()) {
          const admData = admSnap.data();
          setArchiveMeta(admData);
          data = admData.bloodGlucose || null;
        }
      } else {
        chartRefPath.current = doc(db, 'patients', patientId, 'bloodGlucose', 'main');
        const snap = await getDoc(chartRefPath.current);
        if (snap.exists()) data = snap.data();
      }

      // Rows are stored as { cells: [...] } (Firestore rejects bare nested
      // arrays) — unwrap back to a plain array for the table.
      const unwrap = (arr) => (arr || []).map(r => r.cells || r);
      const type = (data && data.chartType === '3point') ? '3point' : '6point';
      let nextCache = { '6point': [], '3point': [] };
      if (data && (data.rows6 || data.rows3)) {
        nextCache['6point'] = unwrap(data.rows6).map(r => migrateRow('6point', r));
        nextCache['3point'] = unwrap(data.rows3).map(r => migrateRow('3point', r));
      } else if (data && data.rows && data.rows.length) {
        nextCache[type] = unwrap(data.rows).map(r => migrateRow(type, r));
      }
      if (!isArchived) {
        if (!nextCache['6point'].length) nextCache['6point'] = emptyRows();
        if (!nextCache['3point'].length && type === '3point') nextCache['3point'] = emptyRows();
      }

      setCurrentType(type);
      setRowsCache(nextCache);
      setSaveStatus(isArchived ? 'Viewing archived chart (read-only)' : 'Changes save automatically — tap Save to confirm');
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, admissionId, isArchived]);

  function scheduleSave() {
    if (isArchived) return;
    setSaveStatus('Saving…');
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(saveChart, 600);
  }

  async function saveChart() {
    if (isArchived || !chartRefPath.current) return;
    const toDocRows = (arr) => arr.map(cells => ({ cells }));
    try {
      await setDoc(chartRefPath.current, {
        chartType: currentTypeRef.current,
        rows6: toDocRows(rowsCacheRef.current['6point']),
        rows3: toDocRows(rowsCacheRef.current['3point']),
        updatedAt: serverTimestamp()
      }, { merge: true });
      setSaveStatus('Saved ' + new Date().toLocaleTimeString());
    } catch (e) {
      setSaveStatus('Save failed: ' + (e.code || e.message));
    }
  }

  function manualSave() {
    clearTimeout(saveTimerRef.current);
    setSaveStatus('Saving…');
    saveChart();
  }

  function switchType(type) {
    if (type === currentType) return;
    setRowsCache((cache) => {
      const cached = cache[type];
      const next = { ...cache };
      if (!cached || !cached.length) next[type] = emptyRows();
      return next;
    });
    setCurrentType(type);
    // Viewing a type doesn't trigger a write — only a real edit or manual Save does.
  }

  function updateCell(rowIdx, colIdx, value) {
    setRowsCache((cache) => {
      const rows = cache[currentType].map((r, i) => {
        if (i !== rowIdx) return r;
        const copy = r.slice();
        copy[colIdx] = value;
        return copy;
      });
      return { ...cache, [currentType]: rows };
    });
    scheduleSave();
  }

  function addRow() {
    setRowsCache((cache) => ({ ...cache, [currentType]: [...cache[currentType], []] }));
    scheduleSave();
  }

  function removeRow() {
    setRowsCache((cache) => {
      const rows = cache[currentType];
      if (!rows.length) return cache;
      return { ...cache, [currentType]: rows.slice(0, -1) };
    });
    scheduleSave();
  }

  const cols = CHART_DEFS[currentType].columns;
  const rows = rowsCache[currentType] || [];

  return (
    <>
      <Topbar brand="Blood Glucose Chart">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
        <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={() => window.print()}>Print</button>
      </Topbar>

      <div className="container no-print">
        <PatientBanner patient={patient} />
        {isArchived && loaded && (
          <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#78350f', fontWeight: 'bold', padding: '8px 12px', borderRadius: 6, marginTop: 10, fontSize: 13 }}>
            Archived chart — {(archiveMeta?.archiveReasonLabel || STATUS_LABELS[archiveMeta?.archiveReason] || 'Closed')}
            {archiveMeta?.archivedAtDisplay ? ' on ' + archiveMeta.archivedAtDisplay : ''}
          </div>
        )}
        <div style={{ fontSize: 12, color: '#555', marginTop: 8, textAlign: 'right' }}>{saveStatus}</div>
      </div>

      <div className="sheet">
        <div className="sheet-title">{CHART_DEFS[currentType].title}</div>
        <div className="unit-note">All glucose readings in mg/dL</div>
        <div className="unit-note">Normal: Fasting/Pre-meal 70–99 &nbsp;•&nbsp; 2hrs Post-meal &lt;140 &nbsp;•&nbsp; readings outside these ranges are flagged red</div>

        {!isArchived && (
          <div className="toggle-row no-print">
            <button className={"toggle-btn" + (currentType === '6point' ? " active" : "")} onClick={() => switchType('6point')}>6-Point</button>
            <button className={"toggle-btn" + (currentType === '3point' ? " active" : "")} onClick={() => switchType('3point')}>3-Point</button>
          </div>
        )}

        <div className="table-wrap">
          <table className="chart">
            <thead>
              <tr>{cols.map((c, i) => <th key={i}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {cols.map((col, cIdx) => {
                    const val = row[cIdx] || '';
                    const abnormal = col.glucose && isAbnormalGlucose(val, col.glucoseType);
                    return (
                      <td key={cIdx} className={abnormal ? 'flag-abnormal' : ''}>
                        <input
                          type={col.type}
                          value={val}
                          readOnly={isArchived}
                          onChange={(e) => updateCell(rIdx, cIdx, e.target.value)}
                          onClick={(col.type === 'date' || col.type === 'time') ? (e) => openPicker(e.currentTarget) : undefined}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!isArchived && (
          <div className="no-print" style={{ marginTop: 10 }}>
            <button className="btn btn-success" onClick={addRow}>+ Add Row</button>
            <button className="btn btn-secondary" onClick={removeRow}>− Remove Row</button>
            <button className="btn btn-primary" onClick={manualSave}>Save</button>
          </div>
        )}
        {!isArchived && (
          <div className="no-print" style={{ fontSize: 13, color: '#555', marginTop: 10, textAlign: 'center', fontWeight: 'bold' }}>{saveStatus}</div>
        )}
      </div>
    </>
  );
}
