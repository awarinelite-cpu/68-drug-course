import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../../firebase.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useGoBack } from "../../hooks/useGoBack.js";
import {
  WARDS, WARD_GROUPS, STAT_FIELDS, SHIFT_STAT_FIELDS, SHIFTS, PATIENT_FIELDS, PATIENT_STATUS_OPTIONS,
  DEMOGRAPHIC_FIELDS, DEMOGRAPHIC_CATEGORIES, DEMOGRAPHIC_AFFILIATIONS, occDelta, movementColorClass, PAROLE_WARD_KEY, wardShowsDel
} from "../../lib/nurses-report-common.js";
import { useTimeFormat, formatDateTime } from "../../lib/time-format.js";
import Topbar from "../../components/Topbar.jsx";
import { PatientPopupProvider, PNum } from "../../components/PatientListModal.jsx";
import ParoleTables, { hasAny as paroleHasAny } from "../../components/ParoleTables.jsx";
import { splitDiagnosisNote } from "../../lib/diagnosisNote.js";
import DiagnosisNoteEditor, { DiagnosisHeadline } from "../../components/DiagnosisNoteEditor.jsx";
import VitalsNoteText from "../../components/VitalsNoteText.jsx";
import VitalsRollEditor from "../../components/VitalsRollEditor.jsx";
import usePrintOrientation from "../../hooks/usePrintOrientation.js";

const movementFields = SHIFT_STAT_FIELDS;
const byKey = k => movementFields.find(f => f.key === k);
const SOLO_BEFORE = ['adm', 'disch', 'dama'].map(byKey);
const SOLO_AFTER = ['del', 'sc', 'vsc', 'absc', 'bid', 'death'].map(byKey);
const TRANSFER_PAIR = [byKey('transferIn'), byKey('transferOut')];
const EXT_PAIR = [byKey('ext'), byKey('extOut')];
const ORDERED_MOVEMENT = [...SOLO_BEFORE, ...TRANSFER_PAIR, ...EXT_PAIR, ...SOLO_AFTER];

// Maternity (Mothers + Cots) and Paed (Bed + Cot) are archived as two ward docs but read as ONE
// report, exactly like the Ward Nurse page: shared shift table, a MAT BED /
// MAT COT demographics table, and one combined patients section. The
// "All Wards" tables on an overall archive are never merged.
const MERGED_REPORT_GROUPS = WARD_GROUPS.filter(g => g.key === 'matward' || g.key === 'paedward');
const mergedGroupFor = (wardKey) => MERGED_REPORT_GROUPS.find(g => g.wardKeys.includes(wardKey));
const MAT_DEMO_ROW_LABEL = { matbed: 'MAT BED', matcot: 'MAT COT' };
const groupMembers = (g) => g.wardKeys.map(k => WARDS.find(x => x.key === k));

function fmtTimestamp(ts) {
  if (!ts || !ts.toDate) return '';
  return formatDateTime(ts.toDate());
}

function isNoteHeadingLine(line) {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase();
}
function NoteLines({ text, withDiagnosis, withVitals }) {
  let body = String(text);
  let head = null;
  if (withDiagnosis) {
    const parts = splitDiagnosisNote(body);
    if (parts.hasHeader) { head = <DiagnosisHeadline diagnosis={parts.diagnosis} />; body = parts.rest; }
  }
  const lines = body === '' ? [] : body.split('\n');
  const blocks = [];
  let paraLines = [];
  function flushPara() { if (paraLines.length) blocks.push({ type: 'p', text: paraLines.join('\n') }); paraLines = []; }
  lines.forEach(line => {
    if (isNoteHeadingLine(line)) { flushPara(); blocks.push({ type: 'h', text: line.trim() }); }
    else paraLines.push(line);
  });
  flushPara();
  return <>{head}{blocks.map((b, i) => b.type === 'h'
    ? <h4 className="patient-note-subheading" key={i}>{b.text}</h4>
    : <p className="patient-note-text" key={i}>{withVitals ? <VitalsNoteText text={b.text} /> : b.text}</p>)}</>;
}

function PatientBlockView({ p, n = 1, total = 1 }) {
  const summaryFields = PATIENT_FIELDS.filter(f => f.type !== 'textarea');
  const textFields = PATIENT_FIELDS.filter(f => f.type === 'textarea');
  return (
    <div className="patient-block">
      <div className="patient-block-head"><span>{'PATIENT ' + n}</span>{total > 1 && <span className="pbh-of">{'of ' + total}</span>}</div>
      {p.status && <div className="status-stamp">{p.status}</div>}
      {summaryFields.map(f => p[f.key] ? (
        <div className="patient-line" key={f.key}><h3>{f.label}: </h3>{p[f.key]}</div>
      ) : null)}
      {textFields.map(f => p[f.key] ? (
        <div key={f.key}>
          <h3 className="patient-note-label">{f.label}:</h3>
          <NoteLines text={p[f.key]} withDiagnosis={f.key === 'diagnosis'} withVitals={f.key === 'npAssessment'} />
        </div>
      ) : null)}
      {p.nightUpdate && (
        <div className="night-update-block">
          <h3 className="patient-note-label">{'Night Update' + (p.nightUpdateBy ? ' \u2014 ' + p.nightUpdateBy : '') + ':'}</h3>
          <p className="patient-note-text">{p.nightUpdate}</p>
        </div>
      )}
    </div>
  );
}

function computeWardCensus(w, data) {
  const shifts = data.shifts || {};
  const beds = typeof data.beds === 'number' ? data.beds : (w.beds || 0);
  const startOcc = typeof data.startOcc === 'number' ? data.startOcc : 0;
  let occ = startOcc;
  const perShiftOcc = {};
  SHIFTS.forEach(s => {
    occ += occDelta(shifts[s.key] || {});
    if (occ < 0) occ = 0;
    perShiftOcc[s.key] = occ;
  });
  const finalOcc = typeof data.occ === 'number' ? data.occ : occ;
  return { beds, perShiftOcc, finalOcc };
}

const PAROLE_COLS = [{ key: 'parole', label: 'Parole' }, { key: 'dParole', label: 'D/Parole' }];

function WardShiftTableView({ w, data }) {
  const showDel = wardShowsDel(w.key);
  const afterCols = showDel ? SOLO_AFTER : SOLO_AFTER.filter(f => f.key !== 'del');
  const moveCols = showDel ? ORDERED_MOVEMENT : ORDERED_MOVEMENT.filter(f => f.key !== 'del');
  const { beds, perShiftOcc, finalOcc } = computeWardCensus(w, data);
  const shifts = data.shifts || {};
  const pmDuty = (shifts.pm || {}).nurseOnDuty;
  const isParoleWard = w.key === PAROLE_WARD_KEY;
  const paroleCount = (k) => (typeof data[k] === 'number' ? data[k] : 0);
  return (
    <table className="ward-shift">
      <thead>
        <tr>
          <th rowSpan={2}>Shift</th><th rowSpan={2}>Beds</th><th rowSpan={2}>Occ</th><th rowSpan={2}>Vac</th>
          {SOLO_BEFORE.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
          <th colSpan={2}>Int. Transfer</th><th colSpan={2}>Ext. Transfer</th>
          {afterCols.map(f => (
            <Fragment key={f.key}>
              <th rowSpan={2}>{f.label}</th>
              {f.key === 'bid' && isParoleWard && PAROLE_COLS.map(c => <th key={c.key} rowSpan={2}>{c.label}</th>)}
            </Fragment>
          ))}
          <th rowSpan={2}>Nurses on Duty</th>
        </tr>
        <tr>{['In', 'Out', 'In', 'Out'].map((l, i) => <th key={i}>{l}</th>)}</tr>
      </thead>
      <tbody>
        {SHIFTS.map((s) => {
          const sData = shifts[s.key] || {};
          return (
            <tr key={s.key}>
              <td className="shift-name">{s.label}</td>
              <td className="stat-beds">{beds}</td><td className="stat-occ"><PNum n={perShiftOcc[s.key]} kind="stat" keys={[w.key]} field="occ" docs={{ [w.key]: data }} label={w.label + ' \u2014 Occ (' + s.label + ')'} /></td><td className="stat-vac">{beds - perShiftOcc[s.key]}</td>
              {moveCols.map(f => (
                <Fragment key={f.key}>
                  <td className={movementColorClass(f.key)}>{typeof sData[f.key] === 'number' ? sData[f.key] : 0}</td>
                  {f.key === 'bid' && isParoleWard && PAROLE_COLS.map(c => <td key={c.key}>{paroleCount(c.key)}</td>)}
                </Fragment>
              ))}
              <td style={{ textAlign: 'left' }}>{sData.nurseOnDuty || '\u2014'}</td>
            </tr>
          );
        })}
        <tr className="total-row">
          <td className="shift-name">Total</td>
          <td className="stat-beds">{beds}</td><td className="stat-occ"><PNum n={finalOcc} kind="stat" keys={[w.key]} field="occ" docs={{ [w.key]: data }} label={w.label + ' \u2014 Occ'} /></td><td className="stat-vac">{beds - finalOcc}</td>
          {moveCols.map(f => (
            <Fragment key={f.key}>
              <td className={movementColorClass(f.key)}><PNum n={typeof data[f.key] === 'number' ? data[f.key] : 0} kind="stat" keys={[w.key]} field={f.key} docs={{ [w.key]: data }} label={w.label + ' \u2014 ' + f.label} /></td>
              {f.key === 'bid' && isParoleWard && PAROLE_COLS.map(c => <td key={c.key}>{paroleCount(c.key)}</td>)}
            </Fragment>
          ))}
          <td style={{ textAlign: 'left' }}>{pmDuty || '\u2014'}</td>
        </tr>
      </tbody>
    </table>
  );
}

function WardShiftTableEdit({ w, data, onChange }) {
  const showDel = wardShowsDel(w.key);
  const afterCols = showDel ? SOLO_AFTER : SOLO_AFTER.filter(f => f.key !== 'del');
  const moveCols = showDel ? ORDERED_MOVEMENT : ORDERED_MOVEMENT.filter(f => f.key !== 'del');
  const { beds, perShiftOcc } = computeWardCensus(w, data);
  const shifts = data.shifts || {};
  function setBeds(raw) { const n = parseFloat(raw); onChange({ ...data, beds: isNaN(n) ? 0 : n }); }
  function setField(shiftKey, fieldKey, raw) {
    const n = parseFloat(raw);
    onChange({ ...data, shifts: { ...shifts, [shiftKey]: { ...shifts[shiftKey], [fieldKey]: isNaN(n) ? 0 : n } } });
  }
  function setDuty(shiftKey, value) {
    onChange({ ...data, shifts: { ...shifts, [shiftKey]: { ...shifts[shiftKey], nurseOnDuty: value } } });
  }
  return (
    <table className="ward-shift">
      <thead>
        <tr>
          <th rowSpan={2}>Shift</th><th rowSpan={2}>Beds</th><th rowSpan={2}>Occ</th><th rowSpan={2}>Vac</th>
          {SOLO_BEFORE.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
          <th colSpan={2}>Int. Transfer</th><th colSpan={2}>Ext. Transfer</th>
          {afterCols.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
          <th rowSpan={2}>Nurses on Duty</th>
        </tr>
        <tr>{['In', 'Out', 'In', 'Out'].map((l, i) => <th key={i}>{l}</th>)}</tr>
      </thead>
      <tbody>
        {SHIFTS.map((s) => (
          <tr key={s.key}>
            <td className="shift-name">{s.label}</td>
            <td className="stat-beds">{s.key === 'am' ? <input type="number" inputMode="numeric" value={data.beds || 0} onChange={(e) => setBeds(e.target.value)} /> : beds}</td>
            <td className="stat-occ"><PNum n={perShiftOcc[s.key]} kind="stat" keys={[w.key]} field="occ" docs={{ [w.key]: data }} label={w.label + ' \u2014 Occ (' + s.label + ')'} /></td>
            <td className="stat-vac">{beds - perShiftOcc[s.key]}</td>
            {moveCols.map((f) => (
              <td key={f.key} className={movementColorClass(f.key)}>
                <input type="number" inputMode="numeric" value={(shifts[s.key] || {})[f.key] || 0} onChange={(e) => setField(s.key, f.key, e.target.value)} />
              </td>
            ))}
            <td><input type="text" className="duty-input" value={(shifts[s.key] || {}).nurseOnDuty || ''} onChange={(e) => setDuty(s.key, e.target.value)} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Three-row grouped header matching the paper form — see the same
// helper in WardNurse.jsx.
function DemographicsHeaderRows({ leadCell, trailingCell }) {
  return (
    <>
      <tr>
        {leadCell}
        {DEMOGRAPHIC_CATEGORIES.map((cat) => <th key={cat.key} colSpan={4}>{cat.label}</th>)}
        {trailingCell}
      </tr>
      <tr>
        {DEMOGRAPHIC_CATEGORIES.flatMap((cat) =>
          DEMOGRAPHIC_AFFILIATIONS.map((aff) => <th key={cat.key + aff.key} colSpan={2}>{aff.label}</th>)
        )}
      </tr>
      <tr>
        {DEMOGRAPHIC_FIELDS.map((f) => <th key={f.key}>{f.sex}</th>)}
      </tr>
    </>
  );
}

// One daily total per ward, read directly off the archived doc — matches
// the paper "Summary Breakdown of Statistics" form's single row per ward
// (see the same shape in WardNurse.jsx's DemographicsTable).
function DemographicsTableView({ data, w }) {
  const fields = DEMOGRAPHIC_FIELDS;
  return (
    <table className="shift">
      <thead>
        <DemographicsHeaderRows trailingCell={<th rowSpan={3}>Rmks</th>} />
      </thead>
      <tbody>
        <tr>
          {fields.map(f => <td key={f.key}><PNum n={typeof data[f.key] === 'number' ? data[f.key] : 0} kind="demo" keys={[w.key]} field={f.key} docs={{ [w.key]: data }} label={w.label + ' \u2014 ' + f.label} /></td>)}
          <td>{data.demographicsRemarks || ''}</td>
        </tr>
      </tbody>
    </table>
  );
}

function DemographicsTableEdit({ data, onChange, w }) {
  const fields = DEMOGRAPHIC_FIELDS;
  function setField(fieldKey, raw) {
    const n = parseFloat(raw);
    onChange({ ...data, [fieldKey]: isNaN(n) ? 0 : n });
  }
  return (
    <table className="shift">
      <thead>
        <DemographicsHeaderRows trailingCell={<th rowSpan={3}>Rmks</th>} />
      </thead>
      <tbody>
        <tr>
          {fields.map((f) => (
            <td key={f.key}>
              <input type="number" inputMode="numeric" value={data[f.key] || 0}
                onChange={(e) => setField(f.key, e.target.value)} />
            </td>
          ))}
          <td>
            <input type="text" value={data.demographicsRemarks || ''}
              onChange={(e) => onChange({ ...data, demographicsRemarks: e.target.value })} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function PatientCardEdit({ p, onChange, onRemove }) {
  return (
    <div className="patient-card">
      <button type="button" className="remove-btn" onClick={onRemove}>Remove</button>
      <div className="patient-field">
        <label>Status:</label>
        <select className={"status-select" + (p.status ? ' set' : '')} value={p.status || ''} onChange={(e) => onChange({ ...p, status: e.target.value })}>
          <option value="">{'\u2014 Select status \u2014'}</option>
          {PATIENT_STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      </div>
      <div className="patient-grid">
        {PATIENT_FIELDS.map((f) => (
          <div className="patient-field" key={f.key} style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
            <label>{f.label}:</label>
            {f.type === 'textarea'
              ? (f.key === 'diagnosis'
                  ? <DiagnosisNoteEditor value={p.diagnosis || ''} onChange={(v) => onChange({ ...p, diagnosis: v })} />
                  : f.key === 'npAssessment'
                    ? <VitalsRollEditor value={p[f.key] || ''} onChange={(v) => onChange({ ...p, [f.key]: v })} />
                    : <textarea value={p[f.key] || ''} onChange={(e) => onChange({ ...p, [f.key]: e.target.value })} />)
              : <input type="text" value={p[f.key] || ''} onChange={(e) => onChange({ ...p, [f.key]: e.target.value })} />}
          </div>
        ))}
      </div>
      <div className="patient-field" style={{ marginTop: 10 }}>
        <label>Night Update:</label>
        <textarea value={p.nightUpdate || ''} onChange={(e) => onChange({ ...p, nightUpdate: e.target.value })} />
      </div>
    </div>
  );
}

function WardReportBlockView({ w, data }) {
  const patients = Array.isArray(data.patients) ? data.patients : [];
  return (
    <div className="ward-report-block">
      <h2 className="ward-report-heading">{w.label}</h2>
      <div className="table-wrap"><WardShiftTableView w={w} data={data} /></div>
      {w.key === PAROLE_WARD_KEY && (paroleHasAny(data.paroleList) || paroleHasAny(data.dParoleList)) && (
        <div style={{ marginTop: 12 }}>
          <ParoleTables paroleList={data.paroleList} dParoleList={data.dParoleList} />
        </div>
      )}
      <h3 className="patient-note-label" style={{ marginTop: 14 }}>Patient Demographics</h3>
      <div className="table-wrap"><DemographicsTableView data={data} w={w} /></div>
      {patients.length === 0
        ? <div className="no-patients" style={{ marginTop: 10 }}>No patient write-ups submitted for this ward.</div>
        : patients.map((p, i) => <PatientBlockView p={p} n={i + 1} total={patients.length} key={p.id || i} />)}
      {data.nightUpdate && (
        <div className="night-update-block">
          <h3 className="patient-note-label">{'Night Update' + (data.nightUpdateBy ? ' — ' + data.nightUpdateBy : '') + ':'}</h3>
          <p className="patient-note-text">{data.nightUpdate}</p>
        </div>
      )}
    </div>
  );
}

// One shared Shift Statistics table for a merged group (Morning: Mothers,
// Cots / Night: Mothers, Cots / one combined Total). In edit mode every cell
// writes back to its own member ward's data via onChange(wardKey, nextData).
function MergedShiftTable({ members, wardsMap, edit, onChange }) {
  const showDel = members.some(w => wardShowsDel(w.key));
  const afterCols = showDel ? SOLO_AFTER : SOLO_AFTER.filter(f => f.key !== 'del');
  const moveCols = showDel ? ORDERED_MOVEMENT : ORDERED_MOVEMENT.filter(f => f.key !== 'del');
  const rows = members.map((w) => {
    const data = wardsMap[w.key] || {};
    return { w, data, shifts: data.shifts || {}, ...computeWardCensus(w, data) };
  });
  const totalBeds = rows.reduce((n, r) => n + r.beds, 0);
  const totalOcc = rows.reduce((n, r) => n + r.finalOcc, 0);
  const totalMove = {};
  moveCols.forEach(f => { totalMove[f.key] = rows.reduce((n, r) => n + (typeof r.data[f.key] === 'number' ? r.data[f.key] : 0), 0); });
  const dutyNames = rows.map(r => (r.shifts.pm || {}).nurseOnDuty).filter(Boolean).join(', ');
  const colSpanAll = 4 + moveCols.length + 1;
  const num = (raw) => { const n = parseFloat(raw); return isNaN(n) ? 0 : n; };
  const setBeds = (r, raw) => onChange(r.w.key, { ...r.data, beds: num(raw) });
  const setField = (r, sk, fk, raw) => onChange(r.w.key, { ...r.data, shifts: { ...r.shifts, [sk]: { ...r.shifts[sk], [fk]: num(raw) } } });
  const setDuty = (r, sk, v) => onChange(r.w.key, { ...r.data, shifts: { ...r.shifts, [sk]: { ...r.shifts[sk], nurseOnDuty: v } } });

  return (
    <table className="ward-shift">
      <thead>
        <tr>
          <th rowSpan={2}>Shift</th><th rowSpan={2}>Beds</th><th rowSpan={2}>Occ</th><th rowSpan={2}>Vac</th>
          {SOLO_BEFORE.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
          <th colSpan={2}>Int. Transfer</th><th colSpan={2}>Ext. Transfer</th>
          {afterCols.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
          <th rowSpan={2}>Nurses on Duty</th>
        </tr>
        <tr>{['In', 'Out', 'In', 'Out'].map((l, i) => <th key={i}>{l}</th>)}</tr>
      </thead>
      <tbody>
        {SHIFTS.map((s) => (
          <Fragment key={s.key}>
            <tr className="shift-section-row"><td colSpan={colSpanAll}>{s.label === 'Am' ? 'Morning' : 'Night'}</td></tr>
            {rows.map((r) => {
              const sData = r.shifts[s.key] || {};
              return (
                <tr key={r.w.key}>
                  <td className="shift-name">{r.w.label}</td>
                  <td className="stat-beds">
                    {edit && s.key === 'am'
                      ? <input type="number" inputMode="numeric" value={r.data.beds || 0} onChange={(e) => setBeds(r, e.target.value)} />
                      : r.beds}
                  </td>
                  <td className="stat-occ"><PNum n={r.perShiftOcc[s.key]} kind="stat" keys={[r.w.key]} field="occ" docs={wardsMap} label={r.w.label + ' \u2014 Occ (' + s.label + ')'} /></td>
                  <td className="stat-vac">{r.beds - r.perShiftOcc[s.key]}</td>
                  {moveCols.map(f => (
                    <td key={f.key} className={movementColorClass(f.key)}>
                      {edit
                        ? <input type="number" inputMode="numeric" value={sData[f.key] || 0} onChange={(e) => setField(r, s.key, f.key, e.target.value)} />
                        : (typeof sData[f.key] === 'number' ? sData[f.key] : 0)}
                    </td>
                  ))}
                  <td style={{ textAlign: 'left' }}>
                    {edit
                      ? <input type="text" className="duty-input" value={sData.nurseOnDuty || ''} onChange={(e) => setDuty(r, s.key, e.target.value)} />
                      : (sData.nurseOnDuty || '\u2014')}
                  </td>
                </tr>
              );
            })}
          </Fragment>
        ))}
        {!edit && (
          <tr className="total-row">
            <td className="shift-name">Total</td>
            <td className="stat-beds">{totalBeds}</td><td className="stat-occ"><PNum n={totalOcc} kind="stat" keys={rows.map(r => r.w.key)} field="occ" docs={wardsMap} label={'Ward \u2014 Occ'} /></td><td className="stat-vac">{totalBeds - totalOcc}</td>
            {moveCols.map(f => <td key={f.key} className={movementColorClass(f.key)}><PNum n={totalMove[f.key]} kind="stat" keys={rows.map(r => r.w.key)} field={f.key} docs={wardsMap} label={'Ward \u2014 ' + f.label} /></td>)}
            <td style={{ textAlign: 'left' }}>{dutyNames || '\u2014'}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// One Patient Demographics table, one row per member ward (MAT BED / MAT COT).
function MergedDemographicsTable({ members, wardsMap, edit, onChange }) {
  const fields = DEMOGRAPHIC_FIELDS;
  return (
    <table className="shift">
      <thead>
        <DemographicsHeaderRows leadCell={<th rowSpan={3}>Ward</th>} trailingCell={<th rowSpan={3}>Rmks</th>} />
      </thead>
      <tbody>
        {members.map((w) => {
          const data = wardsMap[w.key] || {};
          return (
            <tr key={w.key}>
              <td className="shift-name">{MAT_DEMO_ROW_LABEL[w.key] || w.label}</td>
              {fields.map((f) => (
                <td key={f.key}>
                  {edit
                    ? <input type="number" inputMode="numeric" value={data[f.key] || 0}
                        onChange={(e) => { const n = parseFloat(e.target.value); onChange(w.key, { ...data, [f.key]: isNaN(n) ? 0 : n }); }} />
                    : <PNum n={typeof data[f.key] === 'number' ? data[f.key] : 0} kind="demo" keys={[w.key]} field={f.key} docs={wardsMap} label={(MAT_DEMO_ROW_LABEL[w.key] || w.label) + ' \u2014 ' + f.label} />}
                </td>
              ))}
              <td>
                {edit
                  ? <input type="text" value={data.demographicsRemarks || ''} onChange={(e) => onChange(w.key, { ...data, demographicsRemarks: e.target.value })} />
                  : (data.demographicsRemarks || '')}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Read-only merged report (Maternity): looks like the Ward Nurse page.
function MergedWardReportBlockView({ group, members, wardsMap }) {
  const patients = members.flatMap(w => (Array.isArray((wardsMap[w.key] || {}).patients) ? wardsMap[w.key].patients : []));
  const withNight = members.map(w => wardsMap[w.key] || {}).find(d => d.nightUpdate);
  return (
    <div className="ward-report-block">
      <h2 className="ward-report-heading">{group.label}</h2>
      <div className="table-wrap"><MergedShiftTable members={members} wardsMap={wardsMap} /></div>
      <h3 className="patient-note-label" style={{ marginTop: 14 }}>Patient Demographics</h3>
      <div className="table-wrap"><MergedDemographicsTable members={members} wardsMap={wardsMap} /></div>
      {patients.length === 0
        ? <div className="no-patients" style={{ marginTop: 10 }}>No patient write-ups submitted for this ward.</div>
        : patients.map((p, i) => <PatientBlockView p={p} n={i + 1} total={patients.length} key={p.id || i} />)}
      {withNight && (
        <div className="night-update-block">
          <h3 className="patient-note-label">{'Night Update' + (withNight.nightUpdateBy ? ' \u2014 ' + withNight.nightUpdateBy : '') + ':'}</h3>
          <p className="patient-note-text">{withNight.nightUpdate}</p>
        </div>
      )}
    </div>
  );
}

let patientCounter = 0;

function WardReportBlockEdit({ w, data, onChange }) {
  const patients = Array.isArray(data.patients) ? data.patients : [];
  function updatePatient(i, next) {
    const nextList = patients.map((p, idx) => idx === i ? next : p);
    onChange({ ...data, patients: nextList });
  }
  function removePatient(i) {
    onChange({ ...data, patients: patients.filter((_, idx) => idx !== i) });
  }
  function addPatient() {
    patientCounter += 1;
    onChange({ ...data, patients: [...patients, { id: 'a' + Date.now() + '_' + patientCounter, status: '' }] });
  }
  return (
    <div className="ward-report-block">
      <h2 className="ward-report-heading">{w.label}</h2>
      <div className="patient-field">
        <label>Previous Occ:</label>
        <input type="number" inputMode="numeric" value={data.startOcc || 0}
          onChange={(e) => { const n = parseFloat(e.target.value); onChange({ ...data, startOcc: isNaN(n) ? 0 : n }); }} />
      </div>
      <div className="table-wrap"><WardShiftTableEdit w={w} data={data} onChange={onChange} /></div>
      <h3 className="patient-note-label" style={{ marginTop: 14 }}>Patient Demographics</h3>
      <div className="table-wrap"><DemographicsTableEdit data={data} onChange={onChange} w={w} /></div>
      {patients.map((p, i) => (
        <PatientCardEdit key={p.id || i} p={p} onChange={(next) => updatePatient(i, next)} onRemove={() => removePatient(i)} />
      ))}
      <button type="button" className="add-patient-btn" onClick={addPatient}>+ Add Patient</button>
      {data.nightUpdate && (
        <div className="patient-field" style={{ marginTop: 14 }}>
          <label>Night Update (older report, whole ward):</label>
          <textarea value={data.nightUpdate || ''} onChange={(e) => onChange({ ...data, nightUpdate: e.target.value })} />
        </div>
      )}
    </div>
  );
}

// Editable merged report (admin/subadmin): same single layout, every cell
// still writes to its own member ward's archived data.
function MergedWardReportBlockEdit({ group, members, wardsMap, onChange }) {
  const lead = members[0];
  const num = (raw) => { const n = parseFloat(raw); return isNaN(n) ? 0 : n; };
  function updatePatient(wKey, i, next) {
    const d = wardsMap[wKey] || {}; const list = Array.isArray(d.patients) ? d.patients : [];
    onChange(wKey, { ...d, patients: list.map((p, idx) => idx === i ? next : p) });
  }
  function removePatient(wKey, i) {
    const d = wardsMap[wKey] || {}; const list = Array.isArray(d.patients) ? d.patients : [];
    onChange(wKey, { ...d, patients: list.filter((_, idx) => idx !== i) });
  }
  function addPatient() {
    patientCounter += 1;
    const d = wardsMap[lead.key] || {}; const list = Array.isArray(d.patients) ? d.patients : [];
    onChange(lead.key, { ...d, patients: [...list, { id: 'a' + Date.now() + '_' + patientCounter, status: '' }] });
  }
  return (
    <div className="ward-report-block">
      <h2 className="ward-report-heading">{group.label}</h2>
      {members.map((w) => (
        <div className="patient-field" key={w.key}>
          <label>{'Previous Occ (' + w.label + '):'}</label>
          <input type="number" inputMode="numeric" value={(wardsMap[w.key] || {}).startOcc || 0}
            onChange={(e) => onChange(w.key, { ...(wardsMap[w.key] || {}), startOcc: num(e.target.value) })} />
        </div>
      ))}
      <div className="table-wrap"><MergedShiftTable members={members} wardsMap={wardsMap} edit onChange={onChange} /></div>
      <h3 className="patient-note-label" style={{ marginTop: 14 }}>Patient Demographics</h3>
      <div className="table-wrap"><MergedDemographicsTable members={members} wardsMap={wardsMap} edit onChange={onChange} /></div>
      {members.flatMap((w) => (Array.isArray((wardsMap[w.key] || {}).patients) ? wardsMap[w.key].patients : []).map((p, i) => (
        <PatientCardEdit key={w.key + (p.id || i)} p={p} onChange={(next) => updatePatient(w.key, i, next)} onRemove={() => removePatient(w.key, i)} />
      )))}
      <button type="button" className="add-patient-btn" onClick={addPatient}>+ Add Patient</button>
      {members.map((w) => (wardsMap[w.key] || {}).nightUpdate ? (
        <div className="patient-field" style={{ marginTop: 14 }} key={'nu-' + w.key}>
          <label>Night Update (older report, whole ward):</label>
          <textarea value={wardsMap[w.key].nightUpdate || ''} onChange={(e) => onChange(w.key, { ...wardsMap[w.key], nightUpdate: e.target.value })} />
        </div>
      ) : null)}
    </div>
  );
}

function StatsTableView({ wardsMeta, wardsMap }) {
  const totals = {};
  STAT_FIELDS.forEach(f => totals[f.key] = 0);
  return (
    <table className="report">
      <thead>
        <tr>
          <th rowSpan={2}>Ward</th>
          {STAT_FIELDS.map((f) => {
            if (f.key === 'transferIn') return <th key={f.key} colSpan={2}>Int. Transfer</th>;
            if (f.key === 'transferOut') return null;
            if (f.key === 'ext') return <th key={f.key} colSpan={2}>Ext. Transfer</th>;
            if (f.key === 'extOut') return null;
            return <th key={f.key} rowSpan={2}>{f.label}</th>;
          })}
          <th rowSpan={2}>Nurses on Duty</th>
        </tr>
        <tr>{['In', 'Out', 'In', 'Out'].map((l, i) => <th key={i}>{l}</th>)}</tr>
      </thead>
      <tbody>
        {wardsMeta.map((w) => {
          const data = wardsMap[w.key] || {};
          return (
            <tr key={w.key}>
              <td className="ward-name">{w.label}</td>
              {STAT_FIELDS.map((f) => {
                const v = f.key === 'beds' ? (typeof data.beds === 'number' ? data.beds : w.beds) : (typeof data[f.key] === 'number' ? data[f.key] : 0);
                totals[f.key] += v;
                return <td key={f.key} className={movementColorClass(f.key)}><PNum n={v} kind="stat" keys={[w.key]} field={f.key} docs={wardsMap} label={w.label + ' \u2014 ' + f.label} /></td>;
              })}
              <td style={{ textAlign: 'left' }}>{data.submittedBy || '\u2014'}</td>
            </tr>
          );
        })}
        <tr className="totals-row">
          <td className="ward-name">TOTAL</td>
          {STAT_FIELDS.map((f) => <td key={f.key} className={movementColorClass(f.key)}><PNum n={totals[f.key]} kind="stat" keys={wardsMeta.map((x) => x.key)} field={f.key} docs={wardsMap} label={'All wards \u2014 ' + f.label} /></td>)}
          <td></td>
        </tr>
      </tbody>
    </table>
  );
}

function StatsTableEdit({ wardsMeta, wardsMap, onChange }) {
  const totals = {};
  STAT_FIELDS.forEach(f => totals[f.key] = 0);
  wardsMeta.forEach(w => STAT_FIELDS.forEach(f => {
    const data = wardsMap[w.key] || {};
    const v = f.key === 'beds' ? (typeof data.beds === 'number' ? data.beds : w.beds) : (typeof data[f.key] === 'number' ? data[f.key] : 0);
    totals[f.key] += v;
  }));
  return (
    <table className="report">
      <thead>
        <tr>
          <th rowSpan={2}>Ward</th>
          {STAT_FIELDS.map((f) => {
            if (f.key === 'transferIn') return <th key={f.key} colSpan={2}>Int. Transfer</th>;
            if (f.key === 'transferOut') return null;
            if (f.key === 'ext') return <th key={f.key} colSpan={2}>Ext. Transfer</th>;
            if (f.key === 'extOut') return null;
            return <th key={f.key} rowSpan={2}>{f.label}</th>;
          })}
          <th rowSpan={2}>Nurses on Duty</th>
        </tr>
        <tr>{['In', 'Out', 'In', 'Out'].map((l, i) => <th key={i}>{l}</th>)}</tr>
      </thead>
      <tbody>
        {wardsMeta.map((w) => {
          const data = wardsMap[w.key] || {};
          return (
            <tr key={w.key}>
              <td className="ward-name">{w.label}</td>
              {STAT_FIELDS.map((f) => {
                const v = f.key === 'beds' ? (typeof data.beds === 'number' ? data.beds : w.beds) : (typeof data[f.key] === 'number' ? data[f.key] : 0);
                return (
                  <td key={f.key} className={movementColorClass(f.key)}>
                    <input type="number" inputMode="numeric" value={v}
                      onChange={(e) => { const n = parseFloat(e.target.value); onChange(w.key, { ...data, [f.key]: isNaN(n) ? 0 : n }); }} />
                  </td>
                );
              })}
              <td>
                <input type="text" className="duty-input" value={data.submittedBy || ''}
                  onChange={(e) => onChange(w.key, { ...data, submittedBy: e.target.value })} />
              </td>
            </tr>
          );
        })}
        <tr className="totals-row">
          <td className="ward-name">TOTAL</td>
          {STAT_FIELDS.map((f) => <td key={f.key} className={movementColorClass(f.key)}>{totals[f.key]}</td>)}
          <td></td>
        </tr>
      </tbody>
    </table>
  );
}

function DemoStatsTableView({ wardsMeta, wardsMap }) {
  const fields = DEMOGRAPHIC_FIELDS;
  const totals = {};
  fields.forEach(f => totals[f.key] = 0);
  return (
    <table className="report">
      <thead>
        <tr>
          <th rowSpan={3}>Ward</th>
          {DEMOGRAPHIC_CATEGORIES.map((cat) => <th key={cat.key} colSpan={4}>{cat.label}</th>)}
          <th rowSpan={3}>Rmks</th>
        </tr>
        <tr>
          {DEMOGRAPHIC_CATEGORIES.flatMap((cat) =>
            DEMOGRAPHIC_AFFILIATIONS.map((aff) => <th key={cat.key + aff.key} colSpan={2}>{aff.label}</th>)
          )}
        </tr>
        <tr>{fields.map(f => <th key={f.key}>{f.sex}</th>)}</tr>
      </thead>
      <tbody>
        {wardsMeta.map((w) => {
          const data = wardsMap[w.key] || {};
          return (
            <tr key={w.key}>
              <td className="ward-name">{w.label}</td>
              {fields.map((f) => {
                const v = typeof data[f.key] === 'number' ? data[f.key] : 0;
                totals[f.key] += v;
                return <td key={f.key}><PNum n={v} kind="demo" keys={[w.key]} field={f.key} docs={wardsMap} label={w.label + ' \u2014 ' + f.label} /></td>;
              })}
              <td>{data.demographicsRemarks || ''}</td>
            </tr>
          );
        })}
        <tr className="totals-row">
          <td className="ward-name">TOTAL</td>
          {fields.map(f => <td key={f.key}><PNum n={totals[f.key]} kind="demo" keys={wardsMeta.map((x) => x.key)} field={f.key} docs={wardsMap} label={'All wards \u2014 ' + f.label} /></td>)}
          <td></td>
        </tr>
      </tbody>
    </table>
  );
}

function DemoStatsTableEdit({ wardsMeta, wardsMap, onChange }) {
  const fields = DEMOGRAPHIC_FIELDS;
  const totals = {};
  fields.forEach(f => totals[f.key] = 0);
  wardsMeta.forEach(w => fields.forEach(f => {
    const data = wardsMap[w.key] || {};
    totals[f.key] += typeof data[f.key] === 'number' ? data[f.key] : 0;
  }));
  return (
    <table className="report">
      <thead>
        <tr>
          <th rowSpan={3}>Ward</th>
          {DEMOGRAPHIC_CATEGORIES.map((cat) => <th key={cat.key} colSpan={4}>{cat.label}</th>)}
          <th rowSpan={3}>Rmks</th>
        </tr>
        <tr>
          {DEMOGRAPHIC_CATEGORIES.flatMap((cat) =>
            DEMOGRAPHIC_AFFILIATIONS.map((aff) => <th key={cat.key + aff.key} colSpan={2}>{aff.label}</th>)
          )}
        </tr>
        <tr>{fields.map(f => <th key={f.key}>{f.sex}</th>)}</tr>
      </thead>
      <tbody>
        {wardsMeta.map((w) => {
          const data = wardsMap[w.key] || {};
          return (
            <tr key={w.key}>
              <td className="ward-name">{w.label}</td>
              {fields.map((f) => (
                <td key={f.key}>
                  <input type="number" inputMode="numeric" value={typeof data[f.key] === 'number' ? data[f.key] : 0}
                    onChange={(e) => { const n = parseFloat(e.target.value); onChange(w.key, { ...data, [f.key]: isNaN(n) ? 0 : n }); }} />
                </td>
              ))}
              <td>
                <input type="text" value={data.demographicsRemarks || ''}
                  onChange={(e) => onChange(w.key, { ...data, demographicsRemarks: e.target.value })} />
              </td>
            </tr>
          );
        })}
        <tr className="totals-row">
          <td className="ward-name">TOTAL</td>
          {fields.map(f => <td key={f.key}>{totals[f.key]}</td>)}
          <td></td>
        </tr>
      </tbody>
    </table>
  );
}

export default function ArchiveView() {
  usePrintOrientation('landscape');
  useTimeFormat(); // re-render if admin changes the system time format elsewhere
  const { user, profile } = useAuth();
  const goBack = useGoBack('/nurses-report/role-select');
  const [searchParams] = useSearchParams();
  const archiveId = searchParams.get('id');

  const [archiveData, setArchiveData] = useState(null);
  const [deniedMsg, setDeniedMsg] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [wardsMap, setWardsMap] = useState({});
  // Archive doc ids of the other half of a merged ward (Maternity's Cots when
  // Mothers is opened, and vice versa), keyed by ward key.
  const [siblingIds, setSiblingIds] = useState({});
  const [saving, setSaving] = useState(false);
  const [editStatus, setEditStatus] = useState({ text: '', error: false });

  const canEdit = profile?.role === 'admin' || profile?.role === 'subadmin';

  async function load() {
    if (!archiveId) { setDeniedMsg('No report was specified.'); return; }
    let snap;
    try {
      snap = await getDoc(doc(db, 'archives', archiveId));
    } catch (e) {
      setDeniedMsg("Couldn't load this report: " + (e.code || e.message || 'unknown error'));
      return;
    }
    if (!snap.exists()) { setDeniedMsg('This archived report no longer exists.'); return; }
    const data = snap.data();
    setArchiveData(data);
    const isOverallType = data.type === 'overall';
    const map = isOverallType ? (data.wards || {}) : { [data.wardKey]: data.data || {} };
    const sibs = {};
    const mergedGroup = isOverallType ? null : mergedGroupFor(data.wardKey);
    if (mergedGroup) {
      // Pull in the other half archived for the same date so the report
      // reads as one MATERNITY / PAED WARD report.
      for (const k of mergedGroup.wardKeys.filter(x => x !== data.wardKey)) {
        const id = 'ward_' + k + '_' + data.dateId;
        try {
          const sSnap = await getDoc(doc(db, 'archives', id));
          if (sSnap.exists()) { map[k] = (sSnap.data() || {}).data || {}; sibs[k] = id; }
        } catch (e) { /* sibling not readable — show what we have */ }
      }
    }
    setSiblingIds(sibs);
    setWardsMap(map);
    setEditMode(false);
    setEditStatus({ text: '', error: false });
  }

  useEffect(() => { load(); }, [archiveId]);

  if (deniedMsg) {
    return (
      <>
        <Topbar brand="Archived Report">
          <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
        </Topbar>
        <div className="container">
          <div className="card-box" style={{ textAlign: 'center' }}>
            <h3 style={{ marginTop: 0 }}>Not Found</h3>
            <p style={{ fontSize: 13, color: '#555' }}>{deniedMsg}</p>
          </div>
        </div>
      </>
    );
  }

  if (!archiveData) return null;

  const isOverallType = archiveData.type === 'overall';
  const archiveGroup = isOverallType ? null : mergedGroupFor(archiveData.wardKey);
  const wardsMeta = isOverallType ? WARDS
    : archiveGroup ? groupMembers(archiveGroup)
    : [{ key: archiveData.wardKey, label: archiveData.wardLabel, beds: (archiveData.data || {}).beds || 0 }];
  // Ward Reports section: Maternity's two member wards collapse into one item.
  const reportItems = [];
  wardsMeta.forEach((w) => {
    const g = mergedGroupFor(w.key);
    if (g) {
      if (!reportItems.some(i => i.group === g)) reportItems.push({ group: g, members: groupMembers(g) });
    } else reportItems.push({ w });
  });

  function updateWard(key, next) {
    setWardsMap((m) => ({ ...m, [key]: next }));
  }

  async function saveChanges() {
    const payload = { lastEditedBy: profile.name || 'Unknown', lastEditedByUid: user.uid, lastEditedAt: serverTimestamp() };
    if (isOverallType) payload.wards = wardsMap;
    else payload.data = wardsMap[archiveData.wardKey];

    setSaving(true);
    try {
      await updateDoc(doc(db, 'archives', archiveId), payload);
      for (const [k, id] of Object.entries(siblingIds)) {
        await updateDoc(doc(db, 'archives', id), { data: wardsMap[k] || {}, lastEditedBy: payload.lastEditedBy, lastEditedByUid: payload.lastEditedByUid, lastEditedAt: payload.lastEditedAt });
      }
      setEditStatus({ text: 'Saved.', error: false });
      await load();
    } catch (e) {
      setEditStatus({ text: "Couldn't save: " + (e.code || e.message || 'unknown error'), error: true });
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit() {
    if (!confirm('Discard unsaved changes?')) return;
    load();
  }

  const meta = [];
  meta.push('Archived by ' + (archiveData.archivedBy || 'Unknown') + (archiveData.archivedAt ? ' on ' + fmtTimestamp(archiveData.archivedAt) : ''));
  if (archiveData.lastEditedAt) meta.push('Last edited by ' + (archiveData.lastEditedBy || 'Unknown') + ' on ' + fmtTimestamp(archiveData.lastEditedAt));

  return (
    <PatientPopupProvider>
      <Topbar brand="Archived Report">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
        <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={() => window.print()}>Print</button>
      </Topbar>
      <div className="container">
        <div className="card-box">
          <h1 className="period-label">
            {archiveData.fileName || archiveData.dateId}
            <span className={editMode ? 'editing-badge' : 'readonly-badge'}>{editMode ? 'Editing' : 'Read-only'}</span>
            {canEdit && (
              <button className="edit-toggle-btn" onClick={() => { if (editMode) { cancelEdit(); } else setEditMode(true); }}>
                {editMode ? '\u2716 Stop Editing' : '\u270F\uFE0F Edit'}
              </button>
            )}
          </h1>
          <div className="file-meta-row">{meta.join(' \u00B7 ')}</div>
        </div>

        {isOverallType && (
          <div className="card-box">
            <h2>All Wards — 24-Hour Statistics</h2>
            <div className="table-wrap fit-stats">
              {editMode
                ? <StatsTableEdit wardsMeta={wardsMeta} wardsMap={wardsMap} onChange={updateWard} />
                : <StatsTableView wardsMeta={wardsMeta} wardsMap={wardsMap} />}
            </div>
          </div>
        )}

        {isOverallType && (
          <div className="card-box">
            <h2>Patient Demographics</h2>
            <div className="table-wrap">
              {editMode
                ? <DemoStatsTableEdit wardsMeta={wardsMeta} wardsMap={wardsMap} onChange={updateWard} />
                : <DemoStatsTableView wardsMeta={wardsMeta} wardsMap={wardsMap} />}
            </div>
          </div>
        )}

        <div className="card-box archive-report-box">
          <h2>{'Ward Report' + (isOverallType ? 's' : '')}</h2>
          {reportItems.map((item) => {
            if (item.group) {
              return editMode
                ? <MergedWardReportBlockEdit key={item.group.key} group={item.group} members={item.members} wardsMap={wardsMap} onChange={updateWard} />
                : <MergedWardReportBlockView key={item.group.key} group={item.group} members={item.members} wardsMap={wardsMap} />;
            }
            const w = item.w;
            const data = wardsMap[w.key] || {};
            return editMode
              ? <WardReportBlockEdit key={w.key} w={w} data={data} onChange={(next) => updateWard(w.key, next)} />
              : <WardReportBlockView key={w.key} w={w} data={data} />;
          })}
        </div>

        {editMode && (
          <div className="card-box">
            <div className="edit-actions">
              <button className="btn btn-primary" style={{ flex: 1, padding: 12 }} disabled={saving} onClick={saveChanges}>Save Changes</button>
              <button className="btn btn-secondary" style={{ flex: 1, padding: 12 }} onClick={cancelEdit}>Cancel</button>
            </div>
            <div className="save-status" style={{ color: editStatus.error ? '#dc2626' : '#6b7280' }}>{editStatus.text}</div>
          </div>
        )}
      </div>
    </PatientPopupProvider>
  );
}
