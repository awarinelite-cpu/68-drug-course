import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../../firebase.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useGoBack } from "../../hooks/useGoBack.js";
import { WARDS, STAT_FIELDS, SHIFT_STAT_FIELDS, SHIFTS, PATIENT_FIELDS, PATIENT_STATUS_OPTIONS, DEMOGRAPHIC_FIELDS, occDelta, movementColorClass } from "../../lib/nurses-report-common.js";
import Topbar from "../../components/Topbar.jsx";

const movementFields = SHIFT_STAT_FIELDS;
const byKey = k => movementFields.find(f => f.key === k);
const SOLO_BEFORE = ['adm', 'disch', 'dama'].map(byKey);
const SOLO_AFTER = ['sc', 'vsc', 'absc', 'bid', 'death'].map(byKey);
const TRANSFER_PAIR = [byKey('transferIn'), byKey('transferOut')];
const EXT_PAIR = [byKey('ext'), byKey('extOut')];
const ORDERED_MOVEMENT = [...SOLO_BEFORE, ...TRANSFER_PAIR, ...EXT_PAIR, ...SOLO_AFTER];

function fmtTimestamp(ts) {
  if (!ts || !ts.toDate) return '';
  const d = ts.toDate();
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isNoteHeadingLine(line) {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase();
}
function NoteLines({ text }) {
  const lines = String(text).split('\n');
  const blocks = [];
  let paraLines = [];
  function flushPara() { if (paraLines.length) blocks.push({ type: 'p', text: paraLines.join('\n') }); paraLines = []; }
  lines.forEach(line => {
    if (isNoteHeadingLine(line)) { flushPara(); blocks.push({ type: 'h', text: line.trim() }); }
    else paraLines.push(line);
  });
  flushPara();
  return blocks.map((b, i) => b.type === 'h'
    ? <h4 className="patient-note-subheading" key={i}>{b.text}</h4>
    : <p className="patient-note-text" key={i}>{b.text}</p>);
}

function PatientBlockView({ p }) {
  const summaryFields = PATIENT_FIELDS.filter(f => f.type !== 'textarea');
  const textFields = PATIENT_FIELDS.filter(f => f.type === 'textarea');
  return (
    <div className="patient-block">
      {p.status && <div className="status-stamp">{p.status}</div>}
      {summaryFields.map(f => p[f.key] ? (
        <div className="patient-line" key={f.key}><h3>{f.label}: </h3>{p[f.key]}</div>
      ) : null)}
      {textFields.map(f => p[f.key] ? (
        <div key={f.key}>
          <h3 className="patient-note-label">{f.label}:</h3>
          <NoteLines text={p[f.key]} />
        </div>
      ) : null)}
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

function WardShiftTableView({ w, data }) {
  const { beds, perShiftOcc, finalOcc } = computeWardCensus(w, data);
  const shifts = data.shifts || {};
  const pmDuty = (shifts.pm || {}).nurseOnDuty;
  return (
    <table className="ward-shift">
      <thead>
        <tr>
          <th rowSpan={2}>Shift</th><th rowSpan={2}>Beds</th><th rowSpan={2}>Occ</th><th rowSpan={2}>Vac</th>
          {SOLO_BEFORE.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
          <th colSpan={2}>Int. Transfer</th><th colSpan={2}>Ext. Transfer</th>
          {SOLO_AFTER.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
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
              <td className="stat-beds">{beds}</td><td className="stat-occ">{perShiftOcc[s.key]}</td><td className="stat-vac">{beds - perShiftOcc[s.key]}</td>
              {ORDERED_MOVEMENT.map(f => <td key={f.key} className={movementColorClass(f.key)}>{typeof sData[f.key] === 'number' ? sData[f.key] : 0}</td>)}
              <td style={{ textAlign: 'left' }}>{sData.nurseOnDuty || '\u2014'}</td>
            </tr>
          );
        })}
        <tr className="total-row">
          <td className="shift-name">Total</td>
          <td className="stat-beds">{beds}</td><td className="stat-occ">{finalOcc}</td><td className="stat-vac">{beds - finalOcc}</td>
          {ORDERED_MOVEMENT.map(f => <td key={f.key} className={movementColorClass(f.key)}>{typeof data[f.key] === 'number' ? data[f.key] : 0}</td>)}
          <td style={{ textAlign: 'left' }}>{pmDuty || '\u2014'}</td>
        </tr>
      </tbody>
    </table>
  );
}

function WardShiftTableEdit({ w, data, onChange }) {
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
          {SOLO_AFTER.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
          <th rowSpan={2}>Nurses on Duty</th>
        </tr>
        <tr>{['In', 'Out', 'In', 'Out'].map((l, i) => <th key={i}>{l}</th>)}</tr>
      </thead>
      <tbody>
        {SHIFTS.map((s) => (
          <tr key={s.key}>
            <td className="shift-name">{s.label}</td>
            <td className="stat-beds">{s.key === 'am' ? <input type="number" inputMode="numeric" value={data.beds || 0} onChange={(e) => setBeds(e.target.value)} /> : beds}</td>
            <td className="stat-occ">{perShiftOcc[s.key]}</td>
            <td className="stat-vac">{beds - perShiftOcc[s.key]}</td>
            {ORDERED_MOVEMENT.map((f) => (
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

function DemographicsTableView({ data }) {
  const shifts = data.shifts || {};
  const totals = {};
  DEMOGRAPHIC_FIELDS.forEach(f => {
    let sum = 0;
    SHIFTS.forEach(s => { const v = (shifts[s.key] || {})[f.key]; sum += typeof v === 'number' ? v : 0; });
    totals[f.key] = sum;
  });
  return (
    <table className="shift">
      <thead>
        <tr><th>Shift</th>{DEMOGRAPHIC_FIELDS.map(f => <th key={f.key}>{f.label}</th>)}</tr>
      </thead>
      <tbody>
        {SHIFTS.map((s) => {
          const sData = shifts[s.key] || {};
          return (
            <tr key={s.key}>
              <td className="shift-name">{s.label}</td>
              {DEMOGRAPHIC_FIELDS.map(f => <td key={f.key}>{typeof sData[f.key] === 'number' ? sData[f.key] : 0}</td>)}
            </tr>
          );
        })}
        <tr className="total-row">
          <td className="shift-name">Total</td>
          {DEMOGRAPHIC_FIELDS.map(f => <td key={f.key}>{totals[f.key]}</td>)}
        </tr>
      </tbody>
    </table>
  );
}

function DemographicsTableEdit({ data, onChange }) {
  const shifts = data.shifts || {};
  function setField(shiftKey, fieldKey, raw) {
    const n = parseFloat(raw);
    onChange({ ...data, shifts: { ...shifts, [shiftKey]: { ...shifts[shiftKey], [fieldKey]: isNaN(n) ? 0 : n } } });
  }
  return (
    <table className="shift">
      <thead>
        <tr><th>Shift</th>{DEMOGRAPHIC_FIELDS.map(f => <th key={f.key}>{f.label}</th>)}</tr>
      </thead>
      <tbody>
        {SHIFTS.map((s) => (
          <tr key={s.key}>
            <td className="shift-name">{s.label}</td>
            {DEMOGRAPHIC_FIELDS.map((f) => (
              <td key={f.key}>
                <input type="number" inputMode="numeric" value={(shifts[s.key] || {})[f.key] || 0}
                  onChange={(e) => setField(s.key, f.key, e.target.value)} />
              </td>
            ))}
          </tr>
        ))}
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
              ? <textarea value={p[f.key] || ''} onChange={(e) => onChange({ ...p, [f.key]: e.target.value })} />
              : <input type="text" value={p[f.key] || ''} onChange={(e) => onChange({ ...p, [f.key]: e.target.value })} />}
          </div>
        ))}
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
      <h3 className="patient-note-label" style={{ marginTop: 14 }}>Patient Demographics</h3>
      <div className="table-wrap"><DemographicsTableView data={data} /></div>
      {patients.length === 0
        ? <div className="no-patients" style={{ marginTop: 10 }}>No patient write-ups submitted for this ward.</div>
        : patients.map((p, i) => <PatientBlockView p={p} key={p.id || i} />)}
      {data.nightUpdate && (
        <div className="night-update-block">
          <h3 className="patient-note-label">{'Night Update' + (data.nightUpdateBy ? ' — ' + data.nightUpdateBy : '') + ':'}</h3>
          <p className="patient-note-text">{data.nightUpdate}</p>
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
      <div className="table-wrap"><DemographicsTableEdit data={data} onChange={onChange} /></div>
      {patients.map((p, i) => (
        <PatientCardEdit key={p.id || i} p={p} onChange={(next) => updatePatient(i, next)} onRemove={() => removePatient(i)} />
      ))}
      <button type="button" className="add-patient-btn" onClick={addPatient}>+ Add Patient</button>
      <div className="patient-field" style={{ marginTop: 14 }}>
        <label>Night Update:</label>
        <textarea value={data.nightUpdate || ''} onChange={(e) => onChange({ ...data, nightUpdate: e.target.value })} />
      </div>
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
                return <td key={f.key} className={movementColorClass(f.key)}>{v}</td>;
              })}
              <td style={{ textAlign: 'left' }}>{data.nurseOnDuty || '\u2014'}</td>
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
                <input type="text" className="duty-input" value={data.nurseOnDuty || ''}
                  onChange={(e) => onChange(w.key, { ...data, nurseOnDuty: e.target.value })} />
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
  const totals = {};
  DEMOGRAPHIC_FIELDS.forEach(f => totals[f.key] = 0);
  return (
    <table className="report">
      <thead>
        <tr><th>Ward</th>{DEMOGRAPHIC_FIELDS.map(f => <th key={f.key}>{f.label}</th>)}</tr>
      </thead>
      <tbody>
        {wardsMeta.map((w) => {
          const data = wardsMap[w.key] || {};
          return (
            <tr key={w.key}>
              <td className="ward-name">{w.label}</td>
              {DEMOGRAPHIC_FIELDS.map((f) => {
                const v = typeof data[f.key] === 'number' ? data[f.key] : 0;
                totals[f.key] += v;
                return <td key={f.key}>{v}</td>;
              })}
            </tr>
          );
        })}
        <tr className="totals-row">
          <td className="ward-name">TOTAL</td>
          {DEMOGRAPHIC_FIELDS.map(f => <td key={f.key}>{totals[f.key]}</td>)}
        </tr>
      </tbody>
    </table>
  );
}

function DemoStatsTableEdit({ wardsMeta, wardsMap, onChange }) {
  const totals = {};
  DEMOGRAPHIC_FIELDS.forEach(f => totals[f.key] = 0);
  wardsMeta.forEach(w => DEMOGRAPHIC_FIELDS.forEach(f => {
    const data = wardsMap[w.key] || {};
    totals[f.key] += typeof data[f.key] === 'number' ? data[f.key] : 0;
  }));
  return (
    <table className="report">
      <thead>
        <tr><th>Ward</th>{DEMOGRAPHIC_FIELDS.map(f => <th key={f.key}>{f.label}</th>)}</tr>
      </thead>
      <tbody>
        {wardsMeta.map((w) => {
          const data = wardsMap[w.key] || {};
          return (
            <tr key={w.key}>
              <td className="ward-name">{w.label}</td>
              {DEMOGRAPHIC_FIELDS.map((f) => (
                <td key={f.key}>
                  <input type="number" inputMode="numeric" value={typeof data[f.key] === 'number' ? data[f.key] : 0}
                    onChange={(e) => { const n = parseFloat(e.target.value); onChange(w.key, { ...data, [f.key]: isNaN(n) ? 0 : n }); }} />
                </td>
              ))}
            </tr>
          );
        })}
        <tr className="totals-row">
          <td className="ward-name">TOTAL</td>
          {DEMOGRAPHIC_FIELDS.map(f => <td key={f.key}>{totals[f.key]}</td>)}
        </tr>
      </tbody>
    </table>
  );
}

export default function ArchiveView() {
  const { user, profile } = useAuth();
  const goBack = useGoBack('/nurses-report/role-select');
  const [searchParams] = useSearchParams();
  const archiveId = searchParams.get('id');

  const [archiveData, setArchiveData] = useState(null);
  const [deniedMsg, setDeniedMsg] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [wardsMap, setWardsMap] = useState({});
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
    setWardsMap(isOverallType ? (data.wards || {}) : { [data.wardKey]: data.data || {} });
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
  const wardsMeta = isOverallType ? WARDS : [{ key: archiveData.wardKey, label: archiveData.wardLabel, beds: (archiveData.data || {}).beds || 0 }];

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
    <>
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
            <div className="table-wrap">
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

        <div className="card-box">
          <h2>{'Ward Report' + (isOverallType ? 's' : '')}</h2>
          {wardsMeta.map((w) => {
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
    </>
  );
}
