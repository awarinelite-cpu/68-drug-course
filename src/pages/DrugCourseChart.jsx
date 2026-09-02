import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  doc, getDoc, setDoc, updateDoc, addDoc, collection, getDocs, deleteDoc, serverTimestamp
} from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useBackLock } from "../hooks/useBackLock.js";
import { useChartBack } from "../hooks/useChartBack.js";
import { usePatientHeader } from "../hooks/usePatientHeader.js";
import Topbar from "../components/Topbar.jsx";
import {
  ROUTE_OPTIONS, FREQ_OPTIONS, ACTION_OPTIONS, STATUS_LABELS, WARD_OPTIONS, actionColor, defaultRow,
  dueLabelFor, withDrugCompletionChecked, computeRouteFromSno, parseBulkText,
  parseDoseSequence, administrationTimesFor, flaggedDrugRefs, flaggedDrugMessage, diffFields
} from "../lib/drugChartHelpers.js";

const FIELD_IDS = ['f_admission', 'f_discharge', 'f_diagnosis'];

function blankDrugs() { return Array(8).fill(null).map(() => ({ name: '', route: '', frequency: '', action: '', duration: '' })); }
function blankChartRows() { return Array(18).fill(null).map(() => defaultRow()); }

function rowsFromDoc(dataRows) {
  return (dataRows && dataRows.length)
    ? dataRows.map(r => Array.isArray(r)
      ? { date: r[0] || '', sno: r[1] || '', time: r[2] || '', dose: r[3] || 'AP', route: r[4] || '', nurse: r[5] || '', remark: r[6] || '' }
      : { ...r, dose: r.dose || 'AP' })
    : blankChartRows();
}

// --- Frequency <select> + "Other" custom-text control ---------------------
function FreqCell({ drug, onChange, openFreqModal }) {
  const isCustom = !!drug.frequency && !FREQ_OPTIONS.includes(drug.frequency);
  function handlePick(val) {
    if (val === 'Other') openFreqModal(isCustom ? drug.frequency : '', (text) => onChange(text));
    else onChange(val);
  }
  return (
    <>
      <select value={isCustom ? 'Other' : (drug.frequency || '')} onChange={(e) => handlePick(e.target.value)}>
        {FREQ_OPTIONS.map(opt => <option key={opt} value={opt}>{opt || '—'}</option>)}
      </select>
      {isCustom && (
        <div
          style={{ fontSize: 10, color: '#555', fontStyle: 'italic', marginTop: 2, wordBreak: 'break-word', textAlign: 'left', cursor: 'pointer' }}
          title="Click to edit this custom frequency"
          onClick={() => openFreqModal(drug.frequency, (text) => onChange(text))}
        >
          {drug.frequency}
        </div>
      )}
    </>
  );
}

// Small green/grey pills under the Frequency cell for a fixed dose-sequence
// drug (e.g. "0,12,24hr"), one per scheduled offset. A pill turns green
// with a tick as soon as that dose has been recorded on the chart below —
// 1st administration ticks the 1st offset, 2nd ticks the 2nd, etc.
function DoseSequenceBadges({ drug, index, chartRows }) {
  const seq = parseDoseSequence(drug.frequency);
  if (!seq) return null;
  const givenCount = administrationTimesFor(chartRows, index).length;
  return (
    <div className="dose-seq-badges">
      {seq.map((hr, idx) => {
        const given = idx < givenCount;
        return (
          <span key={idx} className={'dose-seq-pill ' + (given ? 'given' : 'pending')}
            title={given ? ('Dose given (' + hr + 'h mark)') : ('Not yet given (' + hr + 'h mark)')}>
            {hr}h{given ? ' \u2713' : ''}
          </span>
        );
      })}
    </div>
  );
}

export default function DrugCourseChart() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get('patient');
  const admissionId = searchParams.get('admission');
  const isArchived = !!admissionId;

  useBackLock('/');
  const goBack = useChartBack(patientId, admissionId);
  const { patient } = usePatientHeader(patientId);
  const currentNurseName = profile?.name || '';

  const [loaded, setLoaded] = useState(false);
  const [fields, setFields] = useState({ f_admission: '', f_discharge: '', f_diagnosis: '' });
  const [drugs, setDrugs] = useState([]);
  const [drugsEditMode, setDrugsEditMode] = useState(false);
  const [editingDrugRows, setEditingDrugRows] = useState({});
  const [chartRows, setChartRows] = useState([]);
  const [chartEditMode, setChartEditMode] = useState(false);
  const [editingChartRows, setEditingChartRows] = useState({});
  const [verbalOrders, setVerbalOrders] = useState([]);
  const [careInstructions, setCareInstructions] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [archiveMeta, setArchiveMeta] = useState(null);
  const [saveStatus, setSaveStatus] = useState('—');
  const [now, setNow] = useState(new Date());

  const chartRefPath = useRef(null);
  const saveTimerRef = useRef(null);
  const lastAppliedUpdatedAtRef = useRef(null); // Firestore Timestamp of the version currently shown on screen
  const drugRowSnapshots = useRef({}); // index -> the drug row as it was when its edit opened, for audit diffing
  const chartRowSnapshots = useRef({}); // index -> the chart row as it was when its edit opened, for audit diffing
  // Latest values for the debounced/interval/beforeunload/polling code to
  // read from, avoiding stale closures without re-subscribing on every keystroke.
  const latestRef = useRef({ fields, drugs, chartRows, verbalOrders, careInstructions, auditLog });
  latestRef.current = { fields, drugs, chartRows, verbalOrders, careInstructions, auditLog };

  const [verbalModalOpen, setVerbalModalOpen] = useState(false);
  const [editingVerbalIndex, setEditingVerbalIndex] = useState(-1);
  const [verbalInput, setVerbalInput] = useState('');
  const [verbalEditText, setVerbalEditText] = useState('');

  const [careModalOpen, setCareModalOpen] = useState(false);
  const [editingCareIndex, setEditingCareIndex] = useState(-1);
  const [careInput, setCareInput] = useState('');
  const [careEditText, setCareEditText] = useState('');

  const [auditModalOpen, setAuditModalOpen] = useState(false);

  const [diagModalOpen, setDiagModalOpen] = useState(false);
  const [diagEditing, setDiagEditing] = useState(false);
  const [diagEditText, setDiagEditText] = useState('');

  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkStep, setBulkStep] = useState(1);
  const [bulkText, setBulkText] = useState('');
  const [bulkParseMsg, setBulkParseMsg] = useState('');
  const [bulkParsed, setBulkParsed] = useState([]);

  const [freqModalOpen, setFreqModalOpen] = useState(false);
  const [freqModalText, setFreqModalText] = useState('');
  const freqApplyRef = useRef(null);

  const [statusAction, setStatusAction] = useState('');
  const [transferWard, setTransferWard] = useState('');
  const [statusMsg, setStatusMsg] = useState({ color: '', text: '' });
  const [statusApplying, setStatusApplying] = useState(false);

  function logAudit(text) {
    const entry = { at: new Date().toISOString(), nurse: currentNurseName, text };
    setAuditLog((log) => [...log, entry]);
    latestRef.current.auditLog = [...latestRef.current.auditLog, entry];
  }

  // --- Load ---------------------------------------------------------------
  useEffect(() => {
    if (!patientId) return;
    (async () => {
      let data = null;
      let admissionMetaData = null;
      if (isArchived) {
        const admSnap = await getDoc(doc(db, 'patients', patientId, 'admissions', admissionId));
        if (admSnap.exists()) {
          admissionMetaData = admSnap.data();
          data = admissionMetaData.drugCourseChart || null;
        }
      } else {
        chartRefPath.current = doc(db, 'patients', patientId, 'drugCourseChart', 'main');
        const snap = await getDoc(chartRefPath.current);
        if (snap.exists()) { data = snap.data(); lastAppliedUpdatedAtRef.current = data.updatedAt || null; }
      }

      if (data) {
        const nextFields = { f_admission: '', f_discharge: '', f_diagnosis: '' };
        FIELD_IDS.forEach(id => { if (data[id]) nextFields[id] = data[id]; });
        setFields((prev) => ({ ...prev, ...nextFields }));

        const nextDrugs = (data.drugs && data.drugs.length) ? data.drugs : blankDrugs();
        setDrugs(nextDrugs);

        let nextRows = rowsFromDoc(data.rows);
        nextRows = nextRows.map(row => (row.sno && !row.route) ? { ...row, route: computeRouteFromSno(row.sno, nextDrugs) } : row);
        setChartRows(nextRows);
        setVerbalOrders(data.verbalOrders || []);
        setCareInstructions(data.careInstructions || []);
        setAuditLog(data.auditLog || []);
        if (isArchived && admissionMetaData) setArchiveMeta(admissionMetaData);
      } else {
        setDrugs(blankDrugs());
        setChartRows(blankChartRows());
        setVerbalOrders([]);
        setCareInstructions([]);
        setAuditLog([]);
      }

      setSaveStatus(isArchived ? 'Viewing archived chart (read-only)' : 'Changes save automatically');
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, admissionId, isArchived]);

  // Date of Admission defaults to the date set when the patient was
  // registered, but a chart's own saved value (loaded above) wins.
  useEffect(() => {
    if (loaded && patient?.admissionDate) {
      setFields((prev) => (prev.f_admission ? prev : { ...prev, f_admission: patient.admissionDate }));
    }
  }, [loaded, patient]);

  // --- Due-label ticker + periodic completion re-check ---------------------
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!loaded || isArchived) return;
    setDrugs((d) => {
      const next = withDrugCompletionChecked(d, latestRef.current.chartRows);
      if (next !== d) scheduleSave();
      return next;
    });
    const recheck = setInterval(() => {
      setDrugs((d) => {
        const n = withDrugCompletionChecked(d, latestRef.current.chartRows);
        if (n !== d) scheduleSave();
        return n;
      });
    }, 60 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setDrugs((d) => withDrugCompletionChecked(d, latestRef.current.chartRows));
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(recheck); document.removeEventListener('visibilitychange', onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // --- Cross-device sync polling ---
  // Reads this doc every 30s and pulls in newer data, as long as nobody is
  // mid-edit on this device (so we never clobber unsaved typing) and no
  // field on the page is actively focused.
  useEffect(() => {
    if (isArchived) return;
    const poll = setInterval(async () => {
      if (!chartRefPath.current || chartEditMode || drugsEditMode) return;
      const active = document.activeElement;
      if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
      try {
        const snap = await getDoc(chartRefPath.current);
        if (!snap.exists()) return;
        const data = snap.data();
        const remoteMs = data.updatedAt?.toMillis ? data.updatedAt.toMillis() : 0;
        const localMs = lastAppliedUpdatedAtRef.current?.toMillis ? lastAppliedUpdatedAtRef.current.toMillis() : 0;
        if (remoteMs > localMs) {
          lastAppliedUpdatedAtRef.current = data.updatedAt;
          const nextFields = { f_admission: '', f_discharge: '', f_diagnosis: '' };
          FIELD_IDS.forEach(id => { if (data[id] !== undefined) nextFields[id] = data[id]; });
          setFields((prev) => ({ ...prev, ...nextFields }));
          const nextDrugs = (data.drugs && data.drugs.length) ? data.drugs : latestRef.current.drugs;
          let nextRows = rowsFromDoc(data.rows);
          nextRows = nextRows.map(row => (row.sno && !row.route) ? { ...row, route: computeRouteFromSno(row.sno, nextDrugs) } : row);
          setDrugs(nextDrugs);
          setChartRows(nextRows);
          setVerbalOrders(data.verbalOrders || []);
          setCareInstructions(data.careInstructions || []);
          setAuditLog(data.auditLog || []);
        }
      } catch (e) { /* silent — just try again on the next cycle */ }
    }, 30000);
    return () => clearInterval(poll);
  }, [isArchived, chartEditMode, drugsEditMode]);

  // --- Save -----------------------------------------------------------------
  async function saveChart() {
    if (isArchived || !chartRefPath.current) return;
    const { fields: f, drugs: d, chartRows: c, verbalOrders: v, careInstructions: ci, auditLog: al } = latestRef.current;
    const data = { ...f, rows: c, drugs: d, verbalOrders: v, careInstructions: ci, auditLog: al, updatedAt: serverTimestamp() };
    try {
      await setDoc(chartRefPath.current, data, { merge: true });
      setSaveStatus('Saved ' + new Date().toLocaleTimeString());
    } catch (e) {
      setSaveStatus('Save failed: ' + (e.code || e.message));
    }
  }

  function scheduleSave() {
    if (isArchived) return;
    setSaveStatus('Saving…');
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(saveChart, 600);
  }

  // Safety net: flush pending changes periodically and on tab hide/close.
  useEffect(() => {
    if (isArchived) return;
    const iv = setInterval(() => { if (chartEditMode || drugsEditMode) saveChart(); }, 15000);
    const onVis = () => { if (document.visibilityState === 'hidden' && (chartEditMode || drugsEditMode)) saveChart(); };
    const onUnload = () => { if (chartEditMode || drugsEditMode) saveChart(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('beforeunload', onUnload);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('beforeunload', onUnload); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartEditMode, drugsEditMode, isArchived]);

  function updateField(id, value) {
    setFields((f) => ({ ...f, [id]: value }));
    scheduleSave();
  }

  // --- Diagnosis modal (readonly + truncated on the banner; tap to view/edit) ---
  function openDiagnosisModal(startInEdit) {
    setDiagEditText(fields.f_diagnosis || '');
    setDiagEditing(!!startInEdit && !isArchived);
    setDiagModalOpen(true);
  }
  function saveDiagnosisEdit() {
    updateField('f_diagnosis', diagEditText);
    setDiagModalOpen(false);
  }

  // --- Drugs table ------------------------------------------------------
  function enterDrugsEditMode() { setDrugsEditMode(true); setEditingDrugRows({}); }
  function exitDrugsEditMode() { setDrugsEditMode(false); setEditingDrugRows({}); scheduleSave(); }
  function unlockDrugRow(i) {
    drugRowSnapshots.current[i] = { ...drugs[i] };
    setEditingDrugRows((e) => ({ ...e, [i]: true }));
  }
  function lockDrugRow(i) {
    const before = drugRowSnapshots.current[i] || {};
    const after = drugs[i] || {};
    const wasBlank = !before.name && !before.route && !before.frequency && !before.action && !before.duration;
    const changes = diffFields(before, after, { name: 'Name', route: 'Route', frequency: 'Frequency', action: 'Action', duration: 'Duration' });
    if (changes.length) {
      const prefix = wasBlank ? ('Drug added (#' + (i + 1) + '): ') : ('Drug #' + (i + 1) + ' edited: ');
      logAudit(prefix + changes.join(', '));
    }
    delete drugRowSnapshots.current[i];
    setEditingDrugRows((e) => { const n = { ...e }; delete n[i]; return n; });
  }

  function addDrug() {
    const blank = { name: '', route: '', frequency: '', action: '', duration: '', createdAt: new Date().toISOString() };
    const next = [...drugs, blank];
    setDrugs(next);
    drugRowSnapshots.current[next.length - 1] = { ...blank };
    setEditingDrugRows((e) => ({ ...e, [next.length - 1]: true }));
    scheduleSave();
  }

  function updateDrug(i, patch) {
    setDrugs((d) => d.map((row, idx) => idx === i ? { ...row, ...patch } : row));
    scheduleSave();
  }

  function removeDrug(i) {
    if (!confirm('Remove this drug from the list?')) return;
    logAudit('Drug removed (#' + (i + 1) + '): ' + (drugs[i]?.name || '(unnamed)'));
    delete drugRowSnapshots.current[i];
    setDrugs((d) => d.filter((_, idx) => idx !== i));
    setEditingDrugRows((e) => { const n = { ...e }; delete n[i]; return n; });
    scheduleSave();
  }

  function openFreqModal(currentText, onApply) {
    setFreqModalText(currentText || '');
    freqApplyRef.current = onApply;
    setFreqModalOpen(true);
  }
  function cancelFreqModal() { setFreqModalOpen(false); freqApplyRef.current = null; }
  function applyFreqModal() {
    const text = freqModalText.trim();
    setFreqModalOpen(false);
    const apply = freqApplyRef.current;
    freqApplyRef.current = null;
    if (apply) apply(text);
  }

  // --- Chart table --------------------------------------------------------
  function enterChartEditMode() { setChartEditMode(true); setEditingChartRows({}); }
  function exitChartEditMode() { setChartEditMode(false); setEditingChartRows({}); scheduleSave(); }
  function unlockChartRow(i) {
    chartRowSnapshots.current[i] = { ...chartRows[i] };
    setEditingChartRows((e) => ({ ...e, [i]: true }));
  }
  function lockChartRow(i) {
    const row = chartRows[i];
    const blocked = flaggedDrugRefs(row?.sno, drugs);
    if (blocked.length) {
      alert(flaggedDrugMessage(blocked) + '\n\nPlease correct the Drug S/N before continuing.');
      return;
    }
    const before = chartRowSnapshots.current[i] || {};
    const wasBlank = !before.sno && !before.date && !before.time;
    const changes = diffFields(before, row || {}, { date: 'Date', sno: 'Drug S/N', time: 'Time', dose: 'Dose', route: 'Route', remark: 'Remark' });
    if (changes.length) {
      const prefix = wasBlank ? ('Dose recorded (row ' + (i + 1) + '): ') : ('Chart entry edited (row ' + (i + 1) + '): ');
      logAudit(prefix + changes.join(', '));
    }
    delete chartRowSnapshots.current[i];
    setEditingChartRows((e) => { const n = { ...e }; delete n[i]; return n; });
  }

  function touchRowNurse(row) {
    return (!row.nurse && currentNurseName) ? { ...row, nurse: currentNurseName } : row;
  }

  function updateChartRow(i, patch) {
    setChartRows((rows) => rows.map((row, idx) => {
      if (idx !== i) return row;
      return touchRowNurse({ ...row, ...patch });
    }));
    scheduleSave();
  }

  // Drug S/N field: on blur, block and revert if it now references a flagged drug.
  function handleSnoBlur(i) {
    const row = chartRows[i];
    const blocked = flaggedDrugRefs(row?.sno, drugs);
    if (!blocked.length) return;
    alert(flaggedDrugMessage(blocked));
    const snapshot = chartRowSnapshots.current[i] || {};
    const revertedSno = snapshot.sno || '';
    setChartRows((rows) => rows.map((r, idx) => idx === i ? { ...r, sno: revertedSno, route: computeRouteFromSno(revertedSno, drugs) } : r));
    scheduleSave();
  }

  function addChartRow(count) {
    const additions = Array.from({ length: count }, () => defaultRow());
    setChartRows((rows) => {
      const next = [...rows, ...additions];
      const startIdx = rows.length;
      setEditingChartRows((e) => {
        const n = { ...e };
        for (let i = 0; i < count; i++) { n[startIdx + i] = true; chartRowSnapshots.current[startIdx + i] = { ...defaultRow() }; }
        return n;
      });
      return next;
    });
    scheduleSave();
  }

  function removeChartRow() {
    setChartRows((rows) => {
      if (!rows.length) return rows;
      const last = rows[rows.length - 1];
      if (last && (last.sno || last.date || last.time)) {
        logAudit('Chart row removed (row ' + rows.length + '): Drug S/N="' + (last.sno || '') + '", Date=' + (last.date || '—') + ', Time=' + (last.time || '—'));
      }
      delete chartRowSnapshots.current[rows.length - 1];
      setEditingChartRows((e) => { const n = { ...e }; delete n[rows.length - 1]; return n; });
      return rows.slice(0, -1);
    });
    scheduleSave();
  }

  // --- Verbal orders --------------------------------------------------------
  function openVerbalModal() { setEditingVerbalIndex(-1); setVerbalModalOpen(true); }
  function closeVerbalModal() { setEditingVerbalIndex(-1); setVerbalModalOpen(false); }

  async function submitVerbalOrder() {
    const text = verbalInput.trim();
    if (!text) return;
    const entry = { text, nurse: currentNurseName, at: new Date().toISOString() };
    setVerbalOrders((v) => [...v, entry]);
    latestRef.current.verbalOrders = [...latestRef.current.verbalOrders, entry];
    logAudit('Verbal order added: ' + text.slice(0, 80));
    setVerbalInput('');
    await saveChart(); // emergency/verbal orders are important enough to save right away
  }

  async function saveVerbalEdit(i) {
    const trimmed = verbalEditText.trim();
    if (!trimmed) return;
    setVerbalOrders((v) => v.map((o, idx) => idx === i ? { ...o, text: trimmed, editedAt: new Date().toISOString() } : o));
    logAudit('Verbal order edited: ' + trimmed.slice(0, 80));
    setEditingVerbalIndex(-1);
    await saveChart();
  }

  async function deleteVerbalOrder(i) {
    if (!confirm('Delete this verbal order? This cannot be undone.')) return;
    logAudit('Verbal order deleted: ' + (verbalOrders[i]?.text || '').slice(0, 80));
    setVerbalOrders((v) => v.filter((_, idx) => idx !== i));
    if (editingVerbalIndex === i) setEditingVerbalIndex(-1);
    await saveChart();
  }

  // --- Care instructions --------------------------------------------------
  function openCareModal() { setEditingCareIndex(-1); setCareModalOpen(true); }
  function closeCareModal() { setEditingCareIndex(-1); setCareModalOpen(false); }

  async function submitCareInstruction() {
    // A nurse may paste/type several lines at once (one instruction per
    // line) — split those into separate bullets rather than one blob.
    const lines = careInput.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const entries = lines.map(text => ({ text, nurse: currentNurseName, at: new Date().toISOString() }));
    setCareInstructions((c) => [...c, ...entries]);
    latestRef.current.careInstructions = [...latestRef.current.careInstructions, ...entries];
    lines.forEach(text => logAudit('Care instruction added: ' + text.slice(0, 80)));
    setCareInput('');
    await saveChart();
  }

  async function saveCareEdit(i) {
    const trimmed = careEditText.trim();
    if (!trimmed) return;
    setCareInstructions((c) => c.map((o, idx) => idx === i ? { ...o, text: trimmed, editedAt: new Date().toISOString() } : o));
    logAudit('Care instruction edited: ' + trimmed.slice(0, 80));
    setEditingCareIndex(-1);
    await saveChart();
  }

  async function deleteCareInstruction(i) {
    if (!confirm('Delete this care instruction? This cannot be undone.')) return;
    logAudit('Care instruction deleted: ' + (careInstructions[i]?.text || '').slice(0, 80));
    setCareInstructions((c) => c.filter((_, idx) => idx !== i));
    if (editingCareIndex === i) setEditingCareIndex(-1);
    await saveChart();
  }

  // --- Bulk upload ------------------------------------------------------
  function openBulkModal() { setBulkText(''); setBulkParseMsg(''); setBulkParsed([]); setBulkStep(1); setBulkModalOpen(true); }
  function closeBulkModal() { setBulkModalOpen(false); }
  function parseBulk() {
    const parsed = parseBulkText(bulkText);
    if (!parsed.length) { setBulkParseMsg('Paste at least one drug line first.'); return; }
    setBulkParsed(parsed);
    setBulkStep(2);
  }
  function updateBulkRow(i, patch) { setBulkParsed((rows) => rows.map((r, idx) => idx === i ? { ...r, ...patch } : r)); }
  function removeBulkRow(i) { setBulkParsed((rows) => rows.filter((_, idx) => idx !== i)); }
  function confirmBulkImport() {
    if (!bulkParsed.length) { closeBulkModal(); return; }
    setDrugs((current) => {
      const next = current.map(d => ({ ...d }));
      bulkParsed.forEach((d) => {
        const emptySlotIdx = next.findIndex(x => !x.name && !x.route && !x.frequency && !x.duration);
        if (emptySlotIdx !== -1) next[emptySlotIdx] = d;
        else next.push(d);
      });
      return next;
    });
    closeBulkModal();
    if (!drugsEditMode) setDrugsEditMode(true);
    scheduleSave();
  }

  // --- Patient status change: referred / transferred / discharged --------
  async function applyStatusAction() {
    if (isArchived) return;
    const reason = statusAction;
    if (!reason) { setStatusMsg({ color: '#dc2626', text: 'Please select an action first.' }); return; }
    let label = STATUS_LABELS[reason];
    let wardChosen = '';
    if (reason === 'transferred') {
      wardChosen = transferWard;
      if (!wardChosen) { setStatusMsg({ color: '#dc2626', text: 'Please select which ward the patient is being transferred to.' }); return; }
      label = 'Transferred to ' + wardChosen;
    }

    // Discharge Date is locked (readonly) so it can only ever be set here,
    // automatically, the moment the patient is actually discharged — never
    // typed in manually.
    let dischargeDate = fields.f_discharge;
    if (reason === 'discharged' && !dischargeDate) {
      dischargeDate = new Date().toISOString().slice(0, 10);
      setFields((f) => ({ ...f, f_discharge: dischargeDate }));
      latestRef.current.fields = { ...latestRef.current.fields, f_discharge: dischargeDate };
    }

    if (!confirm('Confirm: ' + label + '?\n\nAll care records for this admission (drug chart, vitals, glycemic chart, intake & output, seizure chart) will be saved together to Overview, and fresh charts will open for this patient.')) return;

    logAudit('Patient status set: ' + label);
    setStatusApplying(true);
    setStatusMsg({ color: '#555', text: 'Saving all charts for this admission…' });
    await saveChart(); // flush latest drug-chart edits first

    async function fetchEntries(collName) {
      const snap = await getDocs(collection(db, 'patients', patientId, collName));
      const arr = [];
      snap.forEach(d => arr.push(d.data()));
      return arr;
    }
    async function clearEntries(collName) {
      const snap = await getDocs(collection(db, 'patients', patientId, collName));
      await Promise.all(snap.docs.map(d => deleteDoc(doc(db, 'patients', patientId, collName, d.id))));
    }

    // Each chart type (6-point / 3-point) keeps its own saved rows — both
    // must be archived, not just whichever was on screen last, or switching
    // chart type before discharge would lose data.
    let bgData = { chartType: '6point', rows6: [], rows3: [] };
    try {
      const bgSnap = await getDoc(doc(db, 'patients', patientId, 'bloodGlucose', 'main'));
      if (bgSnap.exists()) {
        const d = bgSnap.data();
        bgData = { chartType: d.chartType || '6point', rows6: d.rows6 || [], rows3: d.rows3 || [] };
      }
    } catch (e) { /* fine to archive with blank glycemic data if this fails */ }

    let vitalsArr = [], ioArr = [], seizureArr = [];
    let ioSummary = { intake: 0, output: 0, balance: 0 };
    try {
      [vitalsArr, ioArr, seizureArr] = await Promise.all([fetchEntries('vitals'), fetchEntries('intakeOutput'), fetchEntries('seizure')]);
    } catch (e) { /* fine to archive with whatever we could gather */ }
    try {
      const ioSumSnap = await getDoc(doc(db, 'patients', patientId, 'intakeOutputSummary', 'current'));
      if (ioSumSnap.exists()) {
        const d = ioSumSnap.data();
        ioSummary = { intake: d.intake || 0, output: d.output || 0, balance: d.balance || 0 };
      }
    } catch (e) { /* fine to archive without the summary snapshot — derivable from intakeOutput entries */ }

    const { fields: f, drugs: d, chartRows: c, verbalOrders: v, careInstructions: ci, auditLog: al } = latestRef.current;
    const drugChartData = { ...f, f_discharge: dischargeDate, rows: c, drugs: d, verbalOrders: v, careInstructions: ci, auditLog: al };

    const admissionDoc = {
      diagnosis: f.f_diagnosis,
      archiveReason: reason,
      archiveReasonLabel: label,
      transferWard: wardChosen || null,
      archivedAt: serverTimestamp(),
      archivedAtDisplay: new Date().toLocaleString(),
      drugCourseChart: drugChartData,
      bloodGlucose: bgData,
      vitals: vitalsArr,
      intakeOutput: ioArr,
      intakeOutputSummary: ioSummary,
      seizure: seizureArr
    };

    try {
      await addDoc(collection(db, 'patients', patientId, 'admissions'), admissionDoc);
    } catch (e) {
      setStatusMsg({ color: '#dc2626', text: 'Could not save to Overview: ' + (e.code || e.message) });
      setStatusApplying(false);
      return;
    }

    if (reason === 'transferred' && wardChosen) {
      try {
        await updateDoc(doc(db, 'patients', patientId), { ward: wardChosen, updatedAt: serverTimestamp() });
      } catch (e) { /* not fatal — the admission itself is already saved */ }
    }

    const blankDrugChart = {
      f_admission: '', f_discharge: '', f_diagnosis: '',
      rows: blankChartRows(), drugs: blankDrugs(),
      verbalOrders: [], careInstructions: [], auditLog: [],
      updatedAt: serverTimestamp()
    };

    try {
      await Promise.all([
        setDoc(chartRefPath.current, blankDrugChart), // full overwrite (no merge) so old data doesn't linger
        setDoc(doc(db, 'patients', patientId, 'bloodGlucose', 'main'), { chartType: '6point', rows6: [], rows3: [], updatedAt: serverTimestamp() }),
        setDoc(doc(db, 'patients', patientId, 'intakeOutputSummary', 'current'), { intake: 0, output: 0, balance: 0, periodDate: new Date().toISOString().slice(0, 10), updatedAt: serverTimestamp() }),
        clearEntries('vitals'), clearEntries('intakeOutput'), clearEntries('seizure')
      ]);
    } catch (e) {
      setStatusMsg({ color: '#dc2626', text: 'Archived, but could not fully reset the new charts: ' + (e.code || e.message) });
      setStatusApplying(false);
      return;
    }

    setStatusMsg({ color: '#16a34a', text: 'Saved to Overview. Redirecting…' });
    setTimeout(() => navigate('/'), 900);
  }

  return (
    <>
      <Topbar brand="Drug Course Chart">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
        <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={() => window.print()}>Print</button>
      </Topbar>

      <div className="container no-print">
        <div className="patient-banner">
          <div>
            <div className="pname">{patient ? (patient.name || 'Unnamed') : 'Loading…'}</div>
            <div className="pmeta">{patient ? 'EMR: ' + (patient.emr || 'N/A') : ''}</div>
          </div>
        </div>
        {isArchived && archiveMeta && (
          <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#78350f', fontWeight: 'bold', padding: '8px 12px', borderRadius: 6, marginTop: 10, fontSize: 13 }}>
            Archived chart — {(archiveMeta.archiveReasonLabel || STATUS_LABELS[archiveMeta.archiveReason] || 'Closed')}
            {archiveMeta.archivedAtDisplay ? ' on ' + archiveMeta.archivedAtDisplay : ''}
          </div>
        )}
        <div style={{ fontSize: 12, color: '#555', marginTop: 8, textAlign: 'right' }}>{saveStatus}</div>
      </div>

      <div className="sheet">
        <div className="header"><h1>68 Nigerian Army Reference Hospital Yaba</h1></div>
        <div className="header-sub"><h2>Drugs Course Chart</h2></div>

        <div className="info-grid">
          <div className="info-row"><label>NAME:</label><span className="val">{patient?.name || ''}</span></div>
          <div className="info-row"><label>EMR:</label><span className="val">{patient?.emr || ''}</span></div>
          <div className="info-row"><label>WARD:</label><span className="val">{patient?.ward || ''}</span></div>
          <div className="info-row"><label>Hospital No:</label><span className="val">{patient?.hospNo || ''}</span></div>
          <div className="info-row"><label>AGE:</label><span className="val">{patient?.age || ''}</span></div>
          <div className="info-row"><label>Date of Admission:</label>
            <input type="date" readOnly={isArchived} value={fields.f_admission} onChange={(e) => updateField('f_admission', e.target.value)} />
          </div>
          <div className="info-row"><label>Diagnosis:</label>
            <input type="text" placeholder="Enter diagnosis for this chart" readOnly value={fields.f_diagnosis} onClick={() => openDiagnosisModal()} />
          </div>
          <div className="info-row"><label>Discharge Date:</label>
            <input type="date" readOnly value={fields.f_discharge}
              title="Auto-filled when the patient is discharged — cannot be entered manually"
              style={{ background: '#f3f4f6', cursor: 'not-allowed', pointerEvents: 'none' }} />
          </div>
        </div>

        <div className="no-print" style={{ margin: '-4px 0 14px' }}>
          <button className="btn btn-secondary" onClick={openCareModal}>
            {careInstructions.length ? '\uD83D\uDCAC Care Instructions (' + careInstructions.length + ')' : '+ Care Instructions'}
          </button>
          <button className="btn btn-secondary" onClick={() => setAuditModalOpen(true)}>
            {'\uD83D\uDD53 Audit Log' + (auditLog.length ? ' (' + auditLog.length + ')' : '')}
          </button>
        </div>

        <div className="drugs-block">
          <h3>Drugs</h3>
          <div className="table-wrap">
            <table className="drugs-table">
              <thead>
                <tr>
                  {drugsEditMode && <th className="col-rowedit no-print"></th>}
                  <th style={{ width: 34 }}>No.</th><th>Drug Name</th><th>Route</th><th>Frequency</th><th>Action</th><th>Duration</th>
                  <th className="no-print">Due</th>
                  {drugsEditMode && <th className="no-print" style={{ width: 34 }}></th>}
                </tr>
              </thead>
              <tbody>
                {drugs.map((d, i) => {
                  const editing = drugsEditMode && editingDrugRows[i];
                  const showPencil = drugsEditMode && !editing;
                  const due = dueLabelFor(d, i, chartRows, now);

                  if (editing) {
                    return (
                      <tr key={i}>
                        <td className="col-rowedit no-print"><button className="row-lock-btn" title="Done editing this row" onClick={() => lockDrugRow(i)}>✓</button></td>
                        <td>{i + 1}</td>
                        <td><input type="text" value={d.name || ''} onChange={(e) => updateDrug(i, { name: e.target.value })} /></td>
                        <td>
                          <select value={d.route || ''} onChange={(e) => updateDrug(i, { route: e.target.value })}>
                            {ROUTE_OPTIONS.map(opt => <option key={opt} value={opt}>{opt || '—'}</option>)}
                          </select>
                        </td>
                        <td><FreqCell drug={d} onChange={(text) => updateDrug(i, { frequency: text })} openFreqModal={openFreqModal} /></td>
                        <td>
                          <select value={d.action || ''} onChange={(e) => updateDrug(i, { action: e.target.value })}
                            style={d.action ? { background: actionColor(d.action), color: '#fff', fontWeight: 'bold' } : {}}>
                            {ACTION_OPTIONS.map(opt => <option key={opt} value={opt}>{opt || '—'}</option>)}
                          </select>
                        </td>
                        <td>
                          <input type="text" placeholder="e.g. 3/7 or 5 days" value={d.duration || ''} onChange={(e) => {
                            const val = e.target.value;
                            const patch = { duration: val };
                            if (val && !d.startDate) patch.startDate = new Date().toISOString().slice(0, 10);
                            updateDrug(i, patch);
                          }} />
                        </td>
                        <td className="no-print" style={due.overdue ? { color: '#dc2626', fontWeight: 'bold' } : {}}>{due.text}</td>
                        <td className="no-print"><button className="remove-drug-btn" onClick={() => removeDrug(i)}>x</button></td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={i}>
                      {showPencil && <td className="col-rowedit no-print"><button className="row-edit-btn" title="Edit this row" onClick={() => unlockDrugRow(i)}>🖊️</button></td>}
                      <td>{i + 1}</td>
                      <td>{d.name || '—'}</td>
                      <td>{d.route || '—'}</td>
                      <td>
                        {d.frequency || '—'}
                        <DoseSequenceBadges drug={d} index={i} chartRows={chartRows} />
                      </td>
                      <td>{d.action ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, color: '#fff', fontSize: 11, fontWeight: 'bold', background: actionColor(d.action) }}>{d.action}</span> : '—'}</td>
                      <td>{d.duration || '—'}</td>
                      <td className="no-print" style={due.overdue ? { color: '#dc2626', fontWeight: 'bold' } : {}}>{due.text}</td>
                      {showPencil && <td className="no-print"></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!isArchived && (
            <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {!drugsEditMode
                ? <button className="btn btn-purple" onClick={enterDrugsEditMode}>Edit</button>
                : <button className="btn btn-success" onClick={exitDrugsEditMode}>Save</button>
              }
              <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: 12 }} onClick={openVerbalModal}>
                {verbalOrders.length ? '\uD83D\uDCAC Verbal Order (' + verbalOrders.length + ')' : '+ Verbal Order'}
              </button>
              {drugsEditMode && <>
                <button className="btn btn-secondary" onClick={addDrug}>+ Add Drug</button>
                <button className="btn btn-secondary" onClick={openBulkModal}>+ Bulk Upload</button>
              </>}
            </div>
          )}
        </div>

        <div className="table-wrap">
          <table className="chart">
            <thead>
              <tr>
                {chartEditMode && <th className="col-rowedit no-print"></th>}
                <th className="col-date">Date</th><th className="col-sno">Drug S/N</th><th className="col-time">Time</th>
                <th className="col-dose">Dose</th><th className="col-route">Route</th><th className="col-nurse">Nurses Name</th><th className="col-remark">Remark</th>
              </tr>
            </thead>
            <tbody>
              {chartRows.map((row, i) => {
                const editing = chartEditMode && editingChartRows[i];
                const showPencil = chartEditMode && !editing;

                if (editing) {
                  return (
                    <tr key={i}>
                      <td className="col-rowedit no-print"><button className="row-lock-btn" title="Done editing this row" onClick={() => lockChartRow(i)}>✓</button></td>
                      <td className="col-date"><input type="date" value={row.date || ''} onChange={(e) => updateChartRow(i, { date: e.target.value })} /></td>
                      <td className="col-sno"><input type="text" list="drugSnoList" placeholder="e.g. 1 - Paracetamol" value={row.sno || ''}
                        onChange={(e) => { const sno = e.target.value; updateChartRow(i, { sno, route: computeRouteFromSno(sno, drugs) }); }}
                        onBlur={() => handleSnoBlur(i)} /></td>
                      <td className="col-time"><input type="time" value={row.time || ''} onChange={(e) => updateChartRow(i, { time: e.target.value })} /></td>
                      <td className="col-dose"><input type="text" value={row.dose || 'AP'} onChange={(e) => updateChartRow(i, { dose: e.target.value })} /></td>
                      <td className="col-route"><input type="text" value={row.route || ''} onChange={(e) => updateChartRow(i, { route: e.target.value })} /></td>
                      <td className="col-nurse"><input type="text" readOnly value={row.nurse || ''} /></td>
                      <td className="col-remark"><input type="text" value={row.remark || ''} onChange={(e) => updateChartRow(i, { remark: e.target.value })} /></td>
                    </tr>
                  );
                }
                return (
                  <tr key={i}>
                    {showPencil && <td className="col-rowedit no-print"><button className="row-edit-btn" title="Edit this row" onClick={() => unlockChartRow(i)}>🖊️</button></td>}
                    <td className="col-date view-cell">{row.date || '\u00A0'}</td>
                    <td className="col-sno view-cell">{row.sno || '\u00A0'}</td>
                    <td className="col-time view-cell">{row.time || '\u00A0'}</td>
                    <td className="col-dose view-cell">{row.dose || 'AP'}</td>
                    <td className="col-route view-cell">{row.route || '\u00A0'}</td>
                    <td className="col-nurse view-cell">{row.nurse || '\u00A0'}</td>
                    <td className="col-remark view-cell">{row.remark || '\u00A0'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <datalist id="drugSnoList">
          {drugs.map((d, i) => <option key={i} value={(i + 1) + (d.name ? ' - ' + d.name : '')} />)}
        </datalist>

        {!isArchived && (
          <div className="no-print" style={{ marginTop: 10 }}>
            {!chartEditMode
              ? <button className="btn btn-purple" onClick={enterChartEditMode}>Edit</button>
              : <>
                <button className="btn btn-success" onClick={exitChartEditMode}>Save</button>
                <button className="btn btn-success" onClick={() => addChartRow(1)}>+ Add Row</button>
                <button className="btn btn-secondary" onClick={removeChartRow}>− Remove Row</button>
              </>
            }
          </div>
        )}

        {!isArchived && (
          <div className="no-print" style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
            <label style={{ fontWeight: 'bold', fontSize: 13, display: 'block', marginBottom: 6 }}>Patient Status</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select style={{ width: 'auto', minWidth: 220 }} value={statusAction} onChange={(e) => { setStatusAction(e.target.value); if (e.target.value !== 'transferred') setTransferWard(''); }}>
                <option value="">Select action…</option>
                <option value="referred">Referred to another hospital</option>
                <option value="transferred">Transferred to another ward</option>
                <option value="discharged">Discharged</option>
              </select>
              {statusAction === 'transferred' && (
                <select style={{ width: 'auto', minWidth: 220 }} value={transferWard} onChange={(e) => setTransferWard(e.target.value)}>
                  <option value="">Select ward…</option>
                  {WARD_OPTIONS.map(w => <option key={w} value={w}>{w}</option>)}
                </select>
              )}
              <button className="btn btn-primary" style={{ padding: '8px 14px', fontSize: 13 }} disabled={statusApplying} onClick={applyStatusAction}>Apply</button>
            </div>
            {statusMsg.text && <div style={{ fontSize: 12, marginTop: 8, color: statusMsg.color }}>{statusMsg.text}</div>}
          </div>
        )}
      </div>

      {verbalModalOpen && (
        <div className="modal-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) closeVerbalModal(); }}>
          <div className="modal-box">
            <div className="modal-header"><h3>Verbal / Emergency Orders</h3><button className="modal-close" onClick={closeVerbalModal}>&times;</button></div>
            <div className="modal-body">
              {!verbalOrders.length && <p style={{ color: '#777', fontSize: 13, margin: 0 }}>No verbal orders recorded yet.</p>}
              {verbalOrders.map((o, i) => (
                <div className="verbal-bubble" key={i}>
                  {!isArchived && editingVerbalIndex === i ? (
                    <>
                      <textarea rows={2} style={{ marginBottom: 6 }} value={verbalEditText} onChange={(e) => setVerbalEditText(e.target.value)} />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-success" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => saveVerbalEdit(i)}>Save</button>
                        <button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setEditingVerbalIndex(-1)}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="verbal-meta">{(o.nurse || 'Unknown') + ' · ' + (o.at ? new Date(o.at).toLocaleString() : '') + (o.editedAt ? ' (edited)' : '')}</div>
                      <div className="verbal-text">{o.text}</div>
                      {!isArchived && <>
                        <button className="btn btn-secondary" style={{ padding: '3px 9px', fontSize: 11, marginTop: 6 }} onClick={() => { setEditingVerbalIndex(i); setVerbalEditText(o.text); }}>Edit</button>
                        <button className="btn btn-danger" style={{ padding: '3px 9px', fontSize: 11, marginTop: 6, marginLeft: 6 }} onClick={() => deleteVerbalOrder(i)}>Delete</button>
                      </>}
                    </>
                  )}
                </div>
              ))}
            </div>
            {!isArchived && (
              <div className="modal-footer">
                <textarea rows={2} placeholder="e.g. Dr. Adeyemi verbally ordered IV Furosemide 40mg STAT — not yet on the drug list" value={verbalInput} onChange={(e) => setVerbalInput(e.target.value)} />
                <button className="btn btn-primary" onClick={submitVerbalOrder}>Save</button>
              </div>
            )}
          </div>
        </div>
      )}

      {careModalOpen && (
        <div className="modal-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) closeCareModal(); }}>
          <div className="modal-box">
            <div className="modal-header"><h3>\uD83D\uDCAC Care Instructions (Vitals / Standing Orders)</h3><button className="modal-close" onClick={closeCareModal}>&times;</button></div>
            <div className="modal-body">
              {!careInstructions.length && <p style={{ color: '#777', fontSize: 13, margin: 0 }}>No care instructions recorded yet.</p>}
              {careInstructions.map((o, i) => (
                <div className="care-bullet" key={i}>
                  {!isArchived && editingCareIndex === i ? (
                    <>
                      <textarea rows={2} style={{ marginBottom: 6 }} value={careEditText} onChange={(e) => setCareEditText(e.target.value)} />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-success" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => saveCareEdit(i)}>Save</button>
                        <button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setEditingCareIndex(-1)}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="care-bullet-row">
                        <span className="care-dot">•</span>
                        <div className="care-text">{o.text}</div>
                      </div>
                      <div className="care-meta">{(o.nurse || 'Unknown') + ' · ' + (o.at ? new Date(o.at).toLocaleString() : '') + (o.editedAt ? ' (edited)' : '')}</div>
                      {!isArchived && <>
                        <button className="btn btn-secondary" style={{ padding: '3px 9px', fontSize: 11, marginTop: 6 }} onClick={() => { setEditingCareIndex(i); setCareEditText(o.text); }}>Edit</button>
                        <button className="btn btn-danger" style={{ padding: '3px 9px', fontSize: 11, marginTop: 6, marginLeft: 6 }} onClick={() => deleteCareInstruction(i)}>Delete</button>
                      </>}
                    </>
                  )}
                </div>
              ))}
            </div>
            {!isArchived && (
              <div className="modal-footer">
                <textarea rows={2} placeholder={"e.g. Nurse bed 30° head up\nGive IV Labetalol if BP >200mmHg"} value={careInput} onChange={(e) => setCareInput(e.target.value)} />
                <button className="btn btn-primary" onClick={submitCareInstruction}>Add</button>
              </div>
            )}
          </div>
        </div>
      )}

      {auditModalOpen && (
        <div className="modal-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) setAuditModalOpen(false); }}>
          <div className="modal-box">
            <div className="modal-header"><h3>\uD83D\uDD53 Audit Log</h3><button className="modal-close" onClick={() => setAuditModalOpen(false)}>&times;</button></div>
            <div className="modal-body">
              {!auditLog.length && <p style={{ color: '#777', fontSize: 13, margin: 0 }}>No changes logged yet.</p>}
              {auditLog.slice().reverse().map((entry, i) => (
                <div className="audit-entry" key={i}>
                  <div className="audit-meta">{(entry.nurse || 'Unknown') + ' · ' + (entry.at ? new Date(entry.at).toLocaleString() : '')}</div>
                  <div className="audit-text">{entry.text}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {diagModalOpen && (
        <div className="modal-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) setDiagModalOpen(false); }}>
          <div className="modal-box diag-modal-box">
            <div className="modal-header">
              <h3>Diagnosis</h3>
              <div className="diag-header-actions">
                {!isArchived && !diagEditing && (
                  <button className="diag-edit-btn" title="Edit diagnosis" aria-label="Edit diagnosis" onClick={() => { setDiagEditText(fields.f_diagnosis || ''); setDiagEditing(true); }}>✏️</button>
                )}
                <button className="diag-edit-btn" title="Close" aria-label="Close" onClick={() => setDiagModalOpen(false)}>&times;</button>
              </div>
            </div>
            <div className="diag-modal-body">
              {diagEditing ? (
                <textarea className="diag-edit-textarea" rows={3} placeholder="Enter diagnosis for this chart" value={diagEditText} onChange={(e) => setDiagEditText(e.target.value)} autoFocus />
              ) : (
                <p className="diag-full-text">{fields.f_diagnosis || '(No diagnosis entered)'}</p>
              )}
            </div>
            {diagEditing && (
              <div className="diag-modal-footer modal-footer">
                <button className="btn btn-secondary" onClick={() => { setDiagEditText(fields.f_diagnosis || ''); setDiagEditing(false); }}>Cancel</button>
                <button className="btn btn-primary" onClick={saveDiagnosisEdit}>Save</button>
              </div>
            )}
          </div>
        </div>
      )}

      {bulkModalOpen && (
        <div className="modal-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) closeBulkModal(); }}>
          <div className="modal-box" style={{ maxWidth: 640 }}>
            <div className="modal-header"><h3>Bulk Upload Drugs</h3><button className="modal-close" onClick={closeBulkModal}>&times;</button></div>
            <div className="modal-body">
              {bulkStep === 1 ? (
                <div>
                  <textarea rows={10} style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box', padding: 8 }}
                    placeholder={"Tabs Omeprazole 20mg bd x2/52\nIV Ceftriaxone 1g 12hrly\nTab Doxycycline 100mg bd"}
                    value={bulkText} onChange={(e) => setBulkText(e.target.value)} />
                  {bulkParseMsg && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{bulkParseMsg}</div>}
                </div>
              ) : (
                <div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#f2f2f2' }}>
                          <th style={{ border: '1px solid #000', padding: 4 }}>Drug Name</th>
                          <th style={{ border: '1px solid #000', padding: 4 }}>Route</th>
                          <th style={{ border: '1px solid #000', padding: 4 }}>Frequency</th>
                          <th style={{ border: '1px solid #000', padding: 4 }}>Duration</th>
                          <th style={{ border: '1px solid #000', padding: 4 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {bulkParsed.map((d, i) => (
                          <tr key={i}>
                            <td style={{ border: '1px solid #000', padding: 3 }}><input type="text" style={{ width: '100%', border: 'none', fontSize: 12 }} value={d.name} onChange={(e) => updateBulkRow(i, { name: e.target.value })} /></td>
                            <td style={{ border: '1px solid #000', padding: 3 }}>
                              <select style={{ fontSize: 12 }} value={d.route || ''} onChange={(e) => updateBulkRow(i, { route: e.target.value })}>
                                {ROUTE_OPTIONS.map(opt => <option key={opt} value={opt}>{opt || '—'}</option>)}
                              </select>
                            </td>
                            <td style={{ border: '1px solid #000', padding: 3 }}>
                              <FreqCell drug={d} onChange={(text) => updateBulkRow(i, { frequency: text })} openFreqModal={openFreqModal} />
                            </td>
                            <td style={{ border: '1px solid #000', padding: 3 }}><input type="text" style={{ width: '100%', border: 'none', fontSize: 12 }} value={d.duration} onChange={(e) => updateBulkRow(i, { duration: e.target.value })} /></td>
                            <td style={{ border: '1px solid #000', padding: 3, textAlign: 'center' }}><button className="remove-drug-btn" onClick={() => removeBulkRow(i)}>x</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
            {bulkStep === 1 ? (
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={closeBulkModal}>Cancel</button>
                <button className="btn btn-primary" onClick={parseBulk}>Parse</button>
              </div>
            ) : (
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setBulkStep(1)}>Back</button>
                <button className="btn btn-success" onClick={confirmBulkImport}>Add to List</button>
              </div>
            )}
          </div>
        </div>
      )}

      {freqModalOpen && (
        <div className="modal-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) cancelFreqModal(); }}>
          <div className="modal-box" style={{ maxWidth: 560 }}>
            <div className="modal-header"><h3>Custom Frequency</h3><button className="modal-close" onClick={cancelFreqModal}>&times;</button></div>
            <div className="modal-body">
              <textarea rows={4} style={{ width: '100%', fontSize: 14, padding: 8, boxSizing: 'border-box', resize: 'vertical' }}
                placeholder="e.g. STAT, then 40mg 12hrly" value={freqModalText} onChange={(e) => setFreqModalText(e.target.value)} autoFocus />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={cancelFreqModal}>Cancel</button>
              <button className="btn btn-primary" onClick={applyFreqModal}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
