import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, collection, onSnapshot, serverTimestamp, writeBatch
} from "firebase/firestore";
import { db } from "../../firebase.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import {
  WARDS, STAT_FIELDS, SHIFT_STAT_FIELDS, SHIFTS, PATIENT_FIELDS, reportDateId, reportPeriodLabel,
  wardReportPeriodLabel, weekId, occDelta, defaultWardDoc,
  loadWardNameOverrides, saveWardNameOverride,
  loadHeaderLabelOverrides, saveHeaderLabelOverride, headerLabel, GROUP_LABEL_IDS,
  CUSTOM_TEXT_COLUMNS, loadCustomColumns, addCustomColumn, renameCustomColumn, removeCustomColumn
} from "../../lib/nurses-report-common.js";
import Topbar from "../../components/Topbar.jsx";

const movementFields = SHIFT_STAT_FIELDS;
const byKey = k => movementFields.find(f => f.key === k);
const SOLO_BEFORE = ['adm', 'disch', 'dama'].map(byKey);
const SOLO_AFTER = ['sc', 'vsc', 'absc', 'bid', 'death'].map(byKey);
const TRANSFER_PAIR = [byKey('transferIn'), byKey('transferOut')];
const EXT_PAIR = [byKey('ext'), byKey('extOut')];
const ORDERED_MOVEMENT = [...SOLO_BEFORE, ...TRANSFER_PAIR, ...EXT_PAIR, ...SOLO_AFTER];

const wk = weekId();
const dateId = reportDateId();

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

function WardShiftTable({ w, data }) {
  const shifts = data.shifts || {};
  const beds = typeof data.beds === 'number' ? data.beds : (w.beds || 0);
  const startOcc = typeof data.startOcc === 'number' ? data.startOcc : 0;
  let runningOcc = startOcc;
  const perShiftOcc = {};
  SHIFTS.forEach(s => {
    runningOcc += occDelta(shifts[s.key] || {});
    if (runningOcc < 0) runningOcc = 0;
    perShiftOcc[s.key] = runningOcc;
  });
  const finalOcc = typeof data.occ === 'number' ? data.occ : runningOcc;
  const pmDuty = (shifts.pm || {}).nurseOnDuty;

  return (
    <table className="ward-shift">
      <thead>
        <tr>
          <th rowSpan={2}>Shift</th><th rowSpan={2}>Beds</th><th rowSpan={2}>Occ</th><th rowSpan={2}>Vac</th>
          {SOLO_BEFORE.map(f => <th key={f.key} rowSpan={2}>{f.label}</th>)}
          <th colSpan={2}>Int. Transfer</th>
          <th colSpan={2}>Ext. Transfer</th>
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
              <td>{beds}</td>
              <td>{perShiftOcc[s.key]}</td>
              <td>{beds - perShiftOcc[s.key]}</td>
              {ORDERED_MOVEMENT.map(f => <td key={f.key}>{typeof sData[f.key] === 'number' ? sData[f.key] : 0}</td>)}
              <td style={{ textAlign: 'left' }}>{sData.nurseOnDuty || '\u2014'}</td>
            </tr>
          );
        })}
        <tr className="total-row">
          <td className="shift-name">Total</td>
          <td>{beds}</td>
          <td>{finalOcc}</td>
          <td>{beds - finalOcc}</td>
          {ORDERED_MOVEMENT.map(f => <td key={f.key}>{typeof data[f.key] === 'number' ? data[f.key] : 0}</td>)}
          <td style={{ textAlign: 'left' }}>{pmDuty || '\u2014'}</td>
        </tr>
      </tbody>
    </table>
  );
}

function PatientBlock({ p }) {
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

export default function OverallNurse() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();

  const [access, setAccess] = useState('checking'); // 'checking' | 'denied' | 'granted'
  const [deniedMsg, setDeniedMsg] = useState('');
  const [whoLabel, setWhoLabel] = useState('');
  const [wardData, setWardData] = useState({});
  const [saveStatus, setSaveStatus] = useState({ text: '', error: false });
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState({ text: '', error: false });
  // WARDS/STAT_FIELDS/CUSTOM_TEXT_COLUMNS are mutated in place by the
  // override loaders below (same module-level arrays every importer
  // shares), so this counter is bumped after loading/saving overrides
  // purely to force a re-render — it isn't read anywhere itself.
  const [, setOverridesTick] = useState(0);

  const isAdmin = profile?.role === 'admin';
  const isSubadmin = profile?.role === 'subadmin';

  const roleRef = doc(db, 'nurseReportRoles', wk);
  const wardsCol = collection(db, 'nurseReports', dateId, 'wards');

  useEffect(() => {
    if (!user || !profile) return;
    let unsub;
    (async () => {
      let roleSnap;
      try {
        roleSnap = await getDoc(roleRef);
      } catch (e) {
        setDeniedMsg("Couldn't check the current Overall Nurse: " + (e.code || e.message || 'unknown error'));
        setAccess('denied');
        return;
      }
      const overall = roleSnap.exists() ? roleSnap.data().overallNurse : null;
      const isOverall = overall && overall.uid === user.uid;

      if (!isAdmin && !isSubadmin && !isOverall) {
        setDeniedMsg(overall
          ? (overall.name || 'Another nurse') + ' is the Overall Nurse for this week. Ask them to hand off the role, or claim it yourself if it\u2019s free next week.'
          : 'No one has assumed the Overall Nurse role this week yet.');
        setAccess('denied');
        return;
      }

      setWhoLabel('Overall Nurse this week: ' + (overall ? overall.name : profile.name) + ((isAdmin || isSubadmin) && !isOverall ? ' (viewing as ' + profile.role + ')' : ''));
      setAccess('granted');

      await Promise.all([loadWardNameOverrides(db), loadHeaderLabelOverrides(db), loadCustomColumns(db)]);
      setOverridesTick((t) => t + 1);

      await ensureSeeded();
      unsub = onSnapshot(wardsCol, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'removed') return;
          setWardData((prev) => ({ ...prev, [change.doc.id]: change.doc.data() }));
        });
      }, (err) => {
        setSaveStatus({ text: 'Live sync error: ' + (err.code || err.message || 'unknown error'), error: true });
      });
    })();
    return () => { if (unsub) unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, profile]);

  async function ensureSeeded() {
    let snap;
    try {
      snap = await getDocs(wardsCol);
    } catch (e) {
      setSaveStatus({ text: "Couldn't load ward data: " + (e.code || e.message || 'unknown error'), error: true });
      return;
    }
    const existing = new Set(snap.docs.map(d => d.id));
    const missing = WARDS.filter(w => !existing.has(w.key));
    if (!missing.length) return;
    const batch = writeBatch(db);
    missing.forEach(w => {
      const data = { label: w.label, beds: w.beds, nurseOnDuty: '', locked: false };
      STAT_FIELDS.forEach(f => { if (f.key !== 'beds') data[f.key] = 0; });
      batch.set(doc(wardsCol, w.key), data);
    });
    try {
      await batch.commit();
    } catch (e) {
      setSaveStatus({ text: "Couldn't seed ward list: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  async function saveField(wardKey, field, value) {
    try {
      await updateDoc(doc(wardsCol, wardKey), { [field]: value, updatedAt: serverTimestamp(), updatedBy: profile.name || 'Unknown' });
      setSaveStatus({ text: 'Saved.', error: false });
    } catch (e) {
      setSaveStatus({ text: "Couldn't save: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  async function toggleLock(wardKey) {
    const locked = !!(wardData[wardKey] && wardData[wardKey].locked);
    try {
      await updateDoc(doc(wardsCol, wardKey), { locked: !locked });
    } catch (e) {
      setSaveStatus({ text: "Couldn't change access: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  // Renames a ward everywhere it's shown on this page and persists the
  // change so every other page/device picks it up too. Only shown to
  // admin/subadmin via the "Click to rename" affordance below.
  async function renameWard(w) {
    const newLabel = window.prompt('Rename ward "' + w.label + '" to:', w.label);
    if (newLabel === null) return;
    const trimmed = newLabel.trim();
    if (!trimmed || trimmed === w.label) return;
    try {
      await saveWardNameOverride(db, w.key, trimmed);
      setOverridesTick((t) => t + 1);
      setSaveStatus({ text: 'Ward renamed to "' + w.label + '".', error: false });
    } catch (e) {
      setSaveStatus({ text: "Couldn't rename ward: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  async function renameBuiltInColumn(f) {
    const newLabel = window.prompt('Rename column "' + f.label + '" to:', f.label);
    if (newLabel === null) return;
    const trimmed = newLabel.trim();
    if (!trimmed || trimmed === f.label) return;
    try {
      await saveHeaderLabelOverride(db, f.key, trimmed, f.defaultLabel);
      setOverridesTick((t) => t + 1);
      setSaveStatus({ text: 'Column renamed.', error: false });
    } catch (e) {
      setSaveStatus({ text: "Couldn't rename column: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  async function renameGroupHeader(groupId, currentLabel, defaultLabel) {
    const newLabel = window.prompt('Rename column "' + currentLabel + '" to:', currentLabel);
    if (newLabel === null) return;
    const trimmed = newLabel.trim();
    if (!trimmed || trimmed === currentLabel) return;
    try {
      await saveHeaderLabelOverride(db, groupId, trimmed, defaultLabel);
      setOverridesTick((t) => t + 1);
      setSaveStatus({ text: 'Column renamed.', error: false });
    } catch (e) {
      setSaveStatus({ text: "Couldn't rename column: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  async function renameCustomColumnPrompt(c) {
    const newLabel = window.prompt('Rename column "' + c.label + '" to (clear the text and OK to delete it):', c.label);
    if (newLabel === null) return;
    const trimmed = newLabel.trim();
    if (trimmed === c.label) return;
    if (!trimmed) {
      if (!window.confirm('Delete column "' + c.label + '"? This does not erase any data already entered under it, just removes the column from the tables.')) return;
      try {
        await removeCustomColumn(db, c.key);
        setOverridesTick((t) => t + 1);
        setSaveStatus({ text: 'Column deleted.', error: false });
      } catch (e) {
        setSaveStatus({ text: "Couldn't delete column: " + (e.code || e.message || 'unknown error'), error: true });
      }
      return;
    }
    try {
      await renameCustomColumn(db, c.key, trimmed);
      setOverridesTick((t) => t + 1);
      setSaveStatus({ text: 'Column renamed.', error: false });
    } catch (e) {
      setSaveStatus({ text: "Couldn't rename column: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  async function addColumnPrompt() {
    const label = window.prompt('New column name:');
    if (label === null) return;
    const trimmed = label.trim();
    if (!trimmed) return;
    try {
      await addCustomColumn(db, trimmed);
      setOverridesTick((t) => t + 1);
      setSaveStatus({ text: 'Column added.', error: false });
    } catch (e) {
      setSaveStatus({ text: "Couldn't add column: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  function updateCustomColumnField(wardKey, colKey, value) {
    setWardData((prev) => ({ ...prev, [wardKey]: { ...prev[wardKey], [colKey]: value } }));
    saveField(wardKey, colKey, value);
  }

  function updateStatField(wardKey, fieldKey, raw) {
    const num = parseFloat(raw);
    const val = isNaN(num) ? 0 : num;
    setWardData((prev) => ({ ...prev, [wardKey]: { ...prev[wardKey], [fieldKey]: val } }));
    saveField(wardKey, fieldKey, val);
  }
  function updateDutyField(wardKey, value) {
    setWardData((prev) => ({ ...prev, [wardKey]: { ...prev[wardKey], nurseOnDuty: value } }));
    saveField(wardKey, 'nurseOnDuty', value);
  }

  const totals = {};
  STAT_FIELDS.forEach(f => {
    let sum = 0;
    WARDS.forEach(w => { const v = wardData[w.key] ? wardData[w.key][f.key] : undefined; sum += typeof v === 'number' ? v : 0; });
    totals[f.key] = sum;
  });

  const submittedWards = WARDS.filter(w => wardData[w.key] && wardData[w.key].submitted);

  // Files the current 24-hour period to the permanent Ward Charts Archive:
  // one "overall_<dateId>" doc plus one "ward_<wardKey>_<dateId>" doc per
  // ward, all as a single batch. Matches firestore.rules, which only lets
  // the Overall Nurse *create* an archive entry — only admin/subadmin may
  // update an already-archived one.
  async function saveToArchive() {
    const overallRef = doc(db, 'archives', 'overall_' + dateId);
    let existingSnap;
    try {
      existingSnap = await getDoc(overallRef);
    } catch (e) {
      setArchiveStatus({ text: "Couldn't check the archive: " + (e.code || e.message || 'unknown error'), error: true });
      return;
    }
    const alreadyArchived = existingSnap.exists();
    if (alreadyArchived && !isAdmin && !isSubadmin) {
      setArchiveStatus({ text: 'This period is already archived. Only an admin or subadmin can update an archived report.', error: true });
      return;
    }
    const verb = alreadyArchived ? 'update the archived copy of' : 'save';
    if (!confirm('This will ' + verb + ' this 24-hour report (overall + all ' + WARDS.length + ' ward reports) to the permanent archive. Continue?')) return;

    setArchiveBusy(true);
    const who = profile.name || 'Unknown';
    const batch = writeBatch(db);

    const wardsSnapshot = {};
    WARDS.forEach(w => { wardsSnapshot[w.key] = wardData[w.key] || {}; });
    const overallPayload = {
      type: 'overall', dateId, weekId: wk,
      fileName: reportPeriodLabel(dateId),
      wards: wardsSnapshot,
      archivedBy: who, archivedByUid: user.uid, archivedAt: serverTimestamp()
    };
    if (alreadyArchived) {
      overallPayload.lastEditedBy = who;
      overallPayload.lastEditedByUid = user.uid;
      overallPayload.lastEditedAt = serverTimestamp();
      batch.update(overallRef, overallPayload);
    } else {
      batch.set(overallRef, overallPayload);
    }

    WARDS.forEach(w => {
      const ref = doc(db, 'archives', 'ward_' + w.key + '_' + dateId);
      const payload = {
        type: 'ward', wardKey: w.key, wardLabel: w.label, dateId, weekId: wk,
        fileName: wardReportPeriodLabel(dateId),
        data: wardData[w.key] || {},
        archivedBy: who, archivedByUid: user.uid, archivedAt: serverTimestamp()
      };
      if (alreadyArchived) {
        payload.lastEditedBy = who;
        payload.lastEditedByUid = user.uid;
        payload.lastEditedAt = serverTimestamp();
        batch.update(ref, payload);
      } else {
        batch.set(ref, payload);
      }
    });

    try {
      await batch.commit();
    } catch (e) {
      setArchiveStatus({ text: "Couldn't save to archive: " + (e.code || e.message || 'unknown error'), error: true });
      setArchiveBusy(false);
      return;
    }

    setArchiveStatus({ text: 'Archived. Resetting reports for the next period...', error: false });
    try {
      await resetWardReports();
    } catch (e) {
      setArchiveStatus({ text: 'Archived, but resetting the live reports failed: ' + (e.code || e.message || 'unknown error') + '. Reload and try Save to Archive again to reset them.', error: true });
      setArchiveBusy(false);
      return;
    }

    navigate('/nurses-report/archive-list?type=overall');
  }

  // Puts each ward's live doc back to its empty-state shape for the next
  // 24-hour period. Each ward's just-archived closing Occ is carried
  // forward as the new period's opening census.
  async function resetWardReports() {
    const batch = writeBatch(db);
    WARDS.forEach(w => {
      const closingOcc = wardData[w.key] && typeof wardData[w.key].occ === 'number' ? wardData[w.key].occ : 0;
      batch.set(doc(wardsCol, w.key), defaultWardDoc(w, closingOcc));
    });
    await batch.commit();
  }

  if (access === 'checking') return null;

  if (access === 'denied') {
    return (
      <>
        <Topbar brand="Overall Nurse">
          <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => navigate('/nurses-report/role-select')}>Back</button>
        </Topbar>
        <div className="container">
          <div className="card-box" style={{ textAlign: 'center' }}>
            <h3 style={{ marginTop: 0 }}>Not the Overall Nurse</h3>
            <p style={{ fontSize: 13, color: '#555' }}>{deniedMsg}</p>
            <button className="btn btn-primary" style={{ padding: '8px 14px' }} onClick={() => navigate('/nurses-report/role-select')}>Go to Role Selection</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar brand="Overall Nurse">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => navigate('/nurses-report/role-select')}>Back</button>
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => navigate('/nurses-report/archive-list?type=overall')}>{'\uD83D\uDCC1 Archive'}</button>
        <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={() => window.print()}>Print</button>
      </Topbar>
      <div className="container">
        <div className="card-box">
          <h1 className="period-label">{reportPeriodLabel(dateId)}</h1>
          <div className="who-label">{whoLabel}</div>
        </div>

        <div className="card-box">
          <h2>All Wards — 24-Hour Statistics</h2>
          <div className="table-wrap">
            <table className="report">
              <thead>
                <tr>
                  <th rowSpan={2}>Ward</th>
                  {STAT_FIELDS.map((f) => {
                    if (f.key === 'transferIn') {
                      const label = headerLabel(GROUP_LABEL_IDS.intTransfer, 'Int. Transfer');
                      return <th key={f.key} colSpan={2}
                        className={isAdmin ? 'renamable-col' : undefined}
                        title={isAdmin ? 'Click to rename this column' : undefined}
                        onClick={isAdmin ? () => renameGroupHeader(GROUP_LABEL_IDS.intTransfer, label, 'Int. Transfer') : undefined}>
                        {label}
                      </th>;
                    }
                    if (f.key === 'transferOut') return null;
                    if (f.key === 'ext') {
                      const label = headerLabel(GROUP_LABEL_IDS.extTransfer, 'Ext. Transfer');
                      return <th key={f.key} colSpan={2}
                        className={isAdmin ? 'renamable-col' : undefined}
                        title={isAdmin ? 'Click to rename this column' : undefined}
                        onClick={isAdmin ? () => renameGroupHeader(GROUP_LABEL_IDS.extTransfer, label, 'Ext. Transfer') : undefined}>
                        {label}
                      </th>;
                    }
                    if (f.key === 'extOut') return null;
                    return <th key={f.key} rowSpan={2}
                      className={isAdmin ? 'renamable-col' : undefined}
                      title={isAdmin ? 'Click to rename this column' : undefined}
                      onClick={isAdmin ? () => renameBuiltInColumn(f) : undefined}>
                      {f.label}
                    </th>;
                  })}
                  {CUSTOM_TEXT_COLUMNS.map((c) => (
                    <th key={c.key} rowSpan={2}
                      className={isAdmin ? 'renamable-col' : undefined}
                      title={isAdmin ? 'Click to rename this column' : undefined}
                      onClick={isAdmin ? () => renameCustomColumnPrompt(c) : undefined}>
                      {c.label}
                    </th>
                  ))}
                  <th rowSpan={2}>Nurses on Duty</th>
                  <th rowSpan={2}>Access</th>
                  {isAdmin && (
                    <th rowSpan={2}>
                      <button type="button" className="btn btn-secondary"
                        style={{ padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
                        onClick={addColumnPrompt}>+ Column</button>
                    </th>
                  )}
                </tr>
                <tr>{['In', 'Out', 'In', 'Out'].map((l, i) => <th key={i}>{l}</th>)}</tr>
              </thead>
              <tbody>
                {WARDS.map((w) => {
                  const data = wardData[w.key] || {};
                  const locked = !!data.locked;
                  return (
                    <tr key={w.key}>
                      <td className={"ward-name" + (isAdmin ? ' renamable-col' : '')}
                        title={isAdmin ? 'Click to rename this ward' : undefined}
                        onClick={isAdmin ? () => renameWard(w) : undefined}>{w.label}</td>
                      {STAT_FIELDS.map((f) => (
                        <td key={f.key}>
                          <input type="number" inputMode="numeric"
                            defaultValue={typeof data[f.key] === 'number' ? data[f.key] : (f.key === 'beds' ? w.beds : 0)}
                            key={w.key + '-' + f.key + '-' + (typeof data[f.key] === 'number' ? data[f.key] : 'x')}
                            onChange={(e) => updateStatField(w.key, f.key, e.target.value)} />
                        </td>
                      ))}
                      {CUSTOM_TEXT_COLUMNS.map((c) => (
                        <td key={c.key}>
                          <input type="text" defaultValue={data[c.key] || ''}
                            key={w.key + '-' + c.key + '-' + (data[c.key] || '')}
                            onChange={(e) => updateCustomColumnField(w.key, c.key, e.target.value)} />
                        </td>
                      ))}
                      <td>
                        <input type="text" className="duty-input" placeholder="Nurse name"
                          defaultValue={data.nurseOnDuty || ''} key={w.key + '-duty-' + (data.nurseOnDuty || '')}
                          onChange={(e) => updateDutyField(w.key, e.target.value)} />
                      </td>
                      <td>
                        <button className={"lock-btn " + (locked ? 'locked' : 'open')} onClick={() => toggleLock(w.key)}>
                          {locked ? '\uD83D\uDD12 Locked' : '\uD83D\uDD13 Open'}
                        </button>
                      </td>
                      {isAdmin && <td></td>}
                    </tr>
                  );
                })}
                <tr className="totals-row">
                  <td className="ward-name">TOTAL</td>
                  {STAT_FIELDS.map((f) => <td key={f.key}>{totals[f.key]}</td>)}
                  {CUSTOM_TEXT_COLUMNS.map((c) => <td key={c.key}></td>)}
                  <td></td><td></td>
                  {isAdmin && <td></td>}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="save-status" style={{ color: saveStatus.error ? '#dc2626' : '#6b7280' }}>{saveStatus.text}</div>
        </div>

        <div className="card-box">
          <h2>Ward Reports</h2>
          {submittedWards.length === 0 && <div className="ward-report-empty">No ward reports submitted yet.</div>}
          {submittedWards.map((w) => {
            const data = wardData[w.key];
            const patients = Array.isArray(data.patients) ? data.patients : [];
            return (
              <div className="ward-report-block" key={w.key}>
                <h2 className="ward-report-heading">{w.label}</h2>
                <div className="table-wrap"><WardShiftTable w={w} data={data} /></div>
                {patients.length === 0
                  ? <div className="no-patients" style={{ marginTop: 10 }}>No patient write-ups submitted for this ward.</div>
                  : patients.map((p, i) => <PatientBlock p={p} key={p.id || i} />)}
                {data.nightUpdate && (
                  <div className="night-update-block">
                    <h3 className="patient-note-label">{'Night Update' + (data.nightUpdateBy ? ' — ' + data.nightUpdateBy : '') + ':'}</h3>
                    <p className="patient-note-text">{data.nightUpdate}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="card-box">
          <h2>Finalize This Report</h2>
          <p style={{ fontSize: 12, color: '#555', marginTop: -4 }}>
            Once every ward report above looks right, save this 24-hour period to the permanent Ward Charts Archive.
            This files the overall report and all {WARDS.length} ward reports as read-only records. After saving,
            only an admin or subadmin can make corrections to it.
          </p>
          <button className="btn btn-primary" style={{ padding: '10px 16px' }} disabled={archiveBusy} onClick={saveToArchive}>{'\uD83D\uDCBE Save to Archive'}</button>
          <div className="save-status" style={{ color: archiveStatus.error ? '#dc2626' : '#6b7280' }}>{archiveStatus.text}</div>
        </div>
      </div>
    </>
  );
}
