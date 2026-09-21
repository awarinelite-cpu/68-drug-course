import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, getDocs, collection, query, where, orderBy, limit, setDoc, serverTimestamp } from "firebase/firestore";
import { getDocSafe, getDocsSafe } from "../../lib/firestoreOffline.js";
import { db } from "../../firebase.js";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { useGoBack } from "../../hooks/useGoBack.js";
import {
  WARDS, SHIFT_STAT_FIELDS, SHIFTS, PATIENT_FIELDS, PATIENT_STATUS_OPTIONS,
  PATIENT_STATUS_ARCHIVE_REASON,
  DEMOGRAPHIC_FIELDS, DEMOGRAPHIC_CATEGORIES, DEMOGRAPHIC_AFFILIATIONS, movementColorClass,
  reportDateId, occDelta, blankShift, defaultWardDoc, wardSelectorOptions,
  isWardDocUntouched
} from "../../lib/nurses-report-common.js";
import { patientWardAndBedTypeForReportKey } from "../../lib/wardNameMatch.js";
import { wardHeadcount } from "../../lib/wardCensus.js";
import { applyPatientStatus, closeOutDischargedPatient, activeAdmissionTag, clearAdmissionTag, ADMISSION_TAG_LABEL, ADMISSION_TAG_STATUS_STAMP } from "../../lib/patientAdmissionStatus.js";
import Topbar from "../../components/Topbar.jsx";
import { splitDiagnosisNote, withPatientDiagnosis } from "../../lib/diagnosisNote.js";
import DiagnosisNoteEditor, { DiagnosisHeadline } from "../../components/DiagnosisNoteEditor.jsx";
import wardSelectBg from "../../assets/ward-select-bg.svg";

// Row-label overrides for MergedDemographicsTable only — Maternity's
// Shift Statistics table and every other display still use WARDS'
// shared "MOTHERS"/"COTS" labels (matching the paper Minute Book); the
// Patient Demographics table alone shows "MAT BED"/"MAT COT" so it reads
// the same way as PAED WARD's "PAED BED"/"PAED COT" rows.
const DEMOGRAPHICS_ROW_LABEL = { matbed: 'MAT BED', matcot: 'MAT COT' };

const movementFields = SHIFT_STAT_FIELDS;
const byKey = k => movementFields.find(f => f.key === k);
const SOLO_BEFORE = ['adm', 'disch', 'dama'].map(byKey);
const SOLO_AFTER = ['sc', 'vsc', 'absc', 'bid', 'death'].map(byKey);
const TRANSFER_PAIR = [byKey('transferIn'), byKey('transferOut')];
const EXT_PAIR = [byKey('ext'), byKey('extOut')];
const ORDERED_MOVEMENT = [...SOLO_BEFORE, ...TRANSFER_PAIR, ...EXT_PAIR, ...SOLO_AFTER];

const dateId = reportDateId();

function prevDateId(id) {
  const [y, m, d] = id.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

function computeCensus(wardDoc) {
  const beds = typeof wardDoc.beds === 'number' ? wardDoc.beds : 0;
  const start = typeof wardDoc.startOcc === 'number' ? wardDoc.startOcc : 0;
  let occ = start;
  const perShiftOcc = {};
  SHIFTS.forEach(s => {
    occ += occDelta(wardDoc.shifts[s.key] || {});
    if (occ < 0) occ = 0;
    perShiftOcc[s.key] = occ;
  });
  return { beds, occ, vac: beds - occ, perShiftOcc };
}

// Typing "VITAL SIGNS:" (or "Vitals:", any case, with or without the extra
// space) as the last line of a patient's Diagnosis/Notes triggers an
// auto-pull of that patient's most recent reading from the Vital Signs
// Chart (see updateDiagnosisField below). Tolerant of spacing/case so
// "Vital signs:", "VITALS:", "Vital  Signs :" etc. all match.
const VITALS_TRIGGER_RE = /^(vital\s*signs|vitals)\s*:\s*$/i;

// A patient write-up card is "linked" to a real patient record either via
// the Select Patient dropdown (sourcePatientId) or, more loosely, via a
// successful EMR lookup (emrPatientId, set below) — either is enough to
// know whose Vital Signs Chart to read from. Only sourcePatientId is ever
// used for the discharge/referral archiving side effect in submitReport().
function linkedPatientIdFor(p) {
  return (p && (p.sourcePatientId || p.emrPatientId)) || '';
}

// Matches the Vitals Chart's own field keys (temp/pulse/resp/bp/spo2) and
// mirrors how a nurse writes it on paper: "T-36.8⁰c P-98b/m R-20c/m BP-
// 123/80mmHg SPO2- 99%." Missing values render as an em dash rather than
// being silently dropped, so it's obvious a reading is incomplete.
function formatVitalsLine(v) {
  const val = (x) => (x === undefined || x === null || x === '') ? '\u2014' : x;
  return `T-${val(v.temp)}\u2070c P-${val(v.pulse)}b/m R-${val(v.resp)}c/m BP- ${val(v.bp)}mmHg SPO2- ${val(v.spo2)}%.`;
}

async function fetchLatestVitals(patientId) {
  const q = query(collection(db, 'patients', patientId, 'vitals'), orderBy('time', 'desc'), limit(1));
  const snap = await getDocsSafe(q);
  if (snap.empty) return null;
  return snap.docs[0].data();
}

// The patient's current drugs from their Drug Course Chart, one per line as
// "1. Name – Route – Frequency – Duration" (blank parts left out). Only drugs
// that are Ongoing count as "current" — Completed / Discontinued / Withheld /
// Other, and Inactive follow-on orders that haven't started yet, are left
// off, and so are unnamed placeholder rows.
function formatPlanDrugs(drugs) {
  const active = (Array.isArray(drugs) ? drugs : []).filter((d) => d && (d.name || '').trim() && (!d.action || d.action === 'Ongoing'));
  return active.map((d, i) => (i + 1) + '. ' + [d.name, d.route, d.frequency, d.duration].map((x) => (x || '').toString().trim()).filter(Boolean).join(' \u2013 ')).join('\n');
}

async function fetchCurrentDrugPlan(patientId) {
  const snap = await getDocSafe(doc(db, 'patients', patientId, 'drugCourseChart', 'main'));
  if (!snap || !snap.exists()) return '';
  return formatPlanDrugs(snap.data().drugs);
}

const VITALS_CHIPS = [
  { key: 'temp', label: 'T', suffix: '\u2070c' },
  { key: 'pulse', label: 'P', suffix: 'b/m' },
  { key: 'resp', label: 'R', suffix: 'c/m' },
  { key: 'bp', label: 'BP', suffix: 'mmHg' },
  { key: 'spo2', label: 'SPO2', suffix: '%' }
];

// The row of tappable vitals shown under Diagnosis/Notes once a "VITAL
// SIGNS:" trigger has pulled a reading in (see updateDiagnosisField).
// Tapping one turns it into a small inline input; committing it (blur or
// Enter) regenerates the note's vitals line in place via onChange.
function VitalsChipRow({ snapshot, onChange }) {
  const [editingKey, setEditingKey] = useState(null);
  const [draft, setDraft] = useState('');

  function startEdit(key) {
    setEditingKey(key);
    setDraft(snapshot[key] || '');
  }
  function commit(key) {
    onChange(key, draft.trim());
    setEditingKey(null);
  }

  return (
    <div className="vitals-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
      {VITALS_CHIPS.map((c) => editingKey === c.key ? (
        <span key={c.key} className="vitals-chip vitals-chip-editing"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#eef2ff', border: '1px solid #6366f1', borderRadius: 999, padding: '3px 8px', fontSize: 13 }}>
          {c.label}-
          <input autoFocus type="text" value={draft} style={{ width: 54, border: 'none', background: 'transparent', font: 'inherit', outline: 'none' }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(c.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(c.key); }
              if (e.key === 'Escape') setEditingKey(null);
            }} />
          {c.suffix}
        </span>
      ) : (
        <button key={c.key} type="button" className="vitals-chip" title="Tap to edit"
          style={{ background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 999, padding: '3px 10px', fontSize: 13, color: '#3730a3', cursor: 'pointer' }}
          onClick={() => startEdit(c.key)}>
          {c.label}-{snapshot[c.key] || '\u2014'}{c.suffix}
        </button>
      ))}
    </div>
  );
}

function computeMovementTotals(wardDoc) {
  const totals = {};
  movementFields.forEach(f => {
    let sum = 0;
    SHIFTS.forEach(s => { const v = wardDoc.shifts[s.key][f.key]; sum += typeof v === 'number' ? v : 0; });
    totals[f.key] = sum;
  });
  return totals;
}

// A nurse's free-text write-up often has its own section headers inside it
// (LEFT UPPER LIMB FRACTURE / NURSING DIAGNOSIS / etc, by convention typed
// in ALL CAPS on their own line). Detect those and render as bold
// sub-headings within the note, splitting the surrounding text into
// justified paragraphs around them — still one continuous note.
function isNoteHeadingLine(line) {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase();
}
function NoteLines({ text, withDiagnosis }) {
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
    : <p className="patient-note-text" key={i}>{b.text}</p>)}</>;
}

function PatientBlockView({ p }) {
  const summaryFields = PATIENT_FIELDS.filter(f => f.type !== 'textarea');
  const textFields = PATIENT_FIELDS.filter(f => f.type === 'textarea');
  return (
    <div className="patient-block">
      {p.status && <div className="status-stamp">{p.status}</div>}
      {p.location && <div className="status-stamp">{p.location}</div>}
      {summaryFields.map(f => p[f.key] ? (
        <div className="patient-line" key={f.key}><h3>{f.label}: </h3>{p[f.key]}</div>
      ) : null)}
      {textFields.map(f => p[f.key] ? (
        <div key={f.key}>
          <h3 className="patient-note-label">{f.label}:</h3>
          <NoteLines text={p[f.key]} withDiagnosis={f.key === 'diagnosis'} />
        </div>
      ) : null)}
    </div>
  );
}

function ShiftTable({ wardDoc, census, movementTotals, editable, onBeds, onField, onDuty }) {
  return (
    <table className="shift">
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
        {SHIFTS.map((s) => (
          <tr key={s.key}>
            <td className="shift-name">{s.label}</td>
            <td className={"stat-beds" + (s.key === 'am' ? '' : ' mirrored')}>
              {s.key === 'am'
                ? <input type="number" inputMode="numeric" disabled={!editable} value={wardDoc.beds} onChange={(e) => onBeds(e.target.value)} />
                : census.beds}
            </td>
            <td className="computed stat-occ">{census.perShiftOcc[s.key]}</td>
            <td className="computed stat-vac">{census.beds - census.perShiftOcc[s.key]}</td>
            {ORDERED_MOVEMENT.map((f) => (
              <td key={f.key} className={movementColorClass(f.key)}>
                <input type="number" inputMode="numeric" disabled={!editable}
                  value={wardDoc.shifts[s.key][f.key]} onChange={(e) => onField(s.key, f.key, e.target.value)} />
              </td>
            ))}
            <td>
              <input type="text" className="duty-input" placeholder="Nurse name(s)" disabled={!editable}
                value={wardDoc.shifts[s.key].nurseOnDuty} onChange={(e) => onDuty(s.key, e.target.value)} />
            </td>
          </tr>
        ))}
        <tr className="total-row">
          <td className="shift-name">Total</td>
          <td className="stat-beds">{census.beds}</td>
          <td className="stat-occ">{census.occ}</td>
          <td className="stat-vac">{census.vac}</td>
          {ORDERED_MOVEMENT.map((f) => <td key={f.key} className={movementColorClass(f.key)}>{movementTotals[f.key]}</td>)}
          <td style={{ textAlign: 'left' }}>{wardDoc.shifts.pm.nurseOnDuty || '\u2014'}</td>
        </tr>
      </tbody>
    </table>
  );
}

// Three-row grouped header matching the paper form: category
// (Admission/Disch/Dead/BID) spanning 4 columns each, Military/Civilian
// spanning 2 each within that, then the M/F leaf columns — reused as-is
// by every demographics table below (Ward Nurse, merged-ward, Overall
// Nurse compiled view, Archive).
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

// One daily total per ward, entered directly — matches the paper
// "Summary Breakdown of Statistics" form's single row per ward, rather
// than a per-shift entry table.
function DemographicsTable({ wardDoc, editable, onField, onRemarks }) {
  return (
    <table className="shift">
      <thead>
        <DemographicsHeaderRows trailingCell={<th rowSpan={3}>Rmks</th>} />
      </thead>
      <tbody>
        <tr>
          {DEMOGRAPHIC_FIELDS.map((f) => (
            <td key={f.key}>
              <input type="number" inputMode="numeric" disabled={!editable}
                value={wardDoc[f.key]} onChange={(e) => onField(f.key, e.target.value)} />
            </td>
          ))}
          <td>
            <input type="text" disabled={!editable}
              value={wardDoc.demographicsRemarks || ''} onChange={(e) => onRemarks(e.target.value)} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// Maternity's Patient Demographics now reuses MergedDemographicsTable
// below (see WARD_GROUPS' matward entry: demographicsVariant 'merged'),
// same as PAED WARD — one row for MAT BED, one row for MAT COT, instead
// of a single combined row with a separate newborn COT Male/Female
// count. Removed the bespoke childMale/childFemale-based table this used
// to be.

// All of one ward's report state/logic — loading, editing, saving,
// submitting — with no rendering. Extracted out of WardReportPanel so
// MergedWardReportPanel below can run two of these (one per member
// ward) and feed both into a single shared Shift Statistics table,
// while everything else about each ward (Previous Occ, Demographics,
// Patients, Save/Submit) still saves to that ward's own Firestore doc
// completely independently, same as before this split existed.
function useWardReport(wardKey, isAdmin, profile, user) {
  const [wardDoc, setWardDoc] = useState(null);
  const [adminEditOverride, setAdminEditOverride] = useState(false);
  const [nightUpdateOpen, setNightUpdateOpen] = useState(false);
  const [topStatus, setTopStatus] = useState({ text: 'Loading…', error: false });
  const [saveStatus, setSaveStatus] = useState({ text: '', error: false });
  // Per-patient status for the EMR auto-fill lookup (see
  // lookupPatientByEmr below) — keyed by patient id, e.g.
  // { text: 'Filled from patient record.', error: false }. Purely for
  // showing the nurse a small note under the EMR field; never persisted.
  const [emrLookup, setEmrLookup] = useState({});
  // Patients (from the master `patients` collection) currently on this
  // report ward — powers the "Select Patient" dropdown on each write-up
  // card, so a nurse can pick a patient instead of retyping their
  // details. Refetched whenever the selected ward changes; empty when
  // this report ward has no matching patient-chart ward (see
  // patientWardAndBedTypeForReportKey) or the fetch fails, in which case
  // the dropdown simply doesn't show and the nurse falls back to typing
  // details in manually (or via the EMR lookup on blur).
  const [wardPatientOptions, setWardPatientOptions] = useState([]);
  const patientCounter = useRef(0);
  const w = WARDS.find(x => x.key === wardKey);
  // Movement figures (Adm/Disch/Dama/Transfer In-Out/Ext In-Out/Absc/
  // Death/S-C/VS-C/BID) can now also change in the background while this
  // report is open — see shiftStatsSync.js, fired the instant a patient
  // is registered, discharged, transferred, or readmitted from anywhere
  // in the app. Save/Submit below re-reads the live doc and takes those
  // background figures as-is for anything the nurse hasn't personally
  // edited in this session; only fields actually typed into here (this
  // set) override the live figure with what's on screen. Keyed
  // 'shiftKey.fieldKey'.
  const touchedShiftFieldsRef = useRef(new Set());
  // Same idea, for the top-level Patient Demographics fields (adm/disch/
  // dead/bid x mil/civ x M/F — see DEMOGRAPHIC_FIELDS). Those aren't
  // nested under `shifts`, so they need their own touched-set and their
  // own reconciliation (reconcileDemographicsBeforeSave below) — without
  // this, an automatic bump from a discharge/admission/death/BID that
  // lands while this report is open gets silently overwritten back to
  // whatever was on screen when the page loaded, the same bug the shift
  // reconciliation above already exists to prevent for Shift Statistics.
  const touchedDemographicFieldsRef = useRef(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = patientWardAndBedTypeForReportKey(wardKey);
      if (!info) { setWardPatientOptions([]); return; }
      try {
        const q = query(collection(db, 'patients'), where('ward', '==', info.wardLabel));
        const snap = await getDocsSafe(q);
        const list = [];
        snap.forEach((d) => {
          const data = d.data();
          if (data.pendingTransfer) return;
          if (info.bedType && (data.pedBedType || '') !== info.bedType) return;
          // dischargeStatus ('DISCHARGE' / 'TRANS OUT') is set by
          // applyPatientStatus (patientAdmissionStatus.js) the moment a
          // patient is discharged/referred — via this report's own status
          // dropdown, via Patient.jsx, or straight off the Drug Course
          // Chart. The patient stays on this list (still keyed by `ward`)
          // so the nurse can tap their name and write a closing note; see
          // WardPatientPicker below for how it's shown, and submitReport
          // for how they finally drop off once that note is submitted.
          // admissionTag ('AE_TRANSFER' / 'NEW_PATIENT' / '') mirrors
          // dischargeStatus but on the arrival side — see
          // ADMISSION_TAG_LABEL/activeAdmissionTag in
          // patientAdmissionStatus.js and WardPatientPicker below for how
          // it's shown (blue, vs dischargeStatus's red).
          list.push({ id: d.id, name: data.name || '', emr: data.emr || '', age: data.age || '', admissionDate: data.admissionDate || '', diagnosis: data.diagnosis || '', gender: data.gender || '', dischargeStatus: data.dischargeStatus || '', admissionTag: activeAdmissionTag(data) });
        });
        list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        if (!cancelled) setWardPatientOptions(list);
      } catch (e) {
        if (!cancelled) setWardPatientOptions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [wardKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAdminEditOverride(false); // default to read-only even for admin; they tap ✏️ per ward
      setWardDoc(null);
      setTopStatus({ text: 'Loading…', error: false });
      const ref = doc(db, 'nurseReports', dateId, 'wards', wardKey);
      let snap;
      try {
        snap = await getDocSafe(ref);
      } catch (e) {
        if (!cancelled) setTopStatus({ text: "Couldn't load this ward's report: " + (e.code || e.message || 'unknown error'), error: true });
        return;
      }
      let next = snap.exists() ? Object.assign(defaultWardDoc(w), snap.data()) : defaultWardDoc(w);
      next.shifts = next.shifts || {};
      SHIFTS.forEach(s => { next.shifts[s.key] = Object.assign(blankShift(), next.shifts[s.key] || {}); });
      next.patients = Array.isArray(next.patients) ? next.patients : [];
      next.patients.forEach(p => { if (!p.id) p.id = 'p' + Math.random().toString(36).slice(2); if (typeof p.status !== 'string') p.status = ''; });
      next.nightUpdate = typeof next.nightUpdate === 'string' ? next.nightUpdate : '';
      next.nightUpdateBy = next.nightUpdateBy || '';

      // On taking over — the first time this ward's report for today is
      // opened, OR any later time it's opened while still untouched (no
      // shift figures entered yet, e.g. because a patient was registered
      // on the ward after someone merely opened this page without
      // entering anything) — Previous Occ should equal what the nurse
      // actually meets on the patient list, not a number carried forward
      // or stuck at a stale zero. Re-seeding an untouched doc loses
      // nothing, since there's no real shift data on it yet. Only
      // possible for wards whose name matches a patient-chart ward (see
      // wardNameMatch.js); everything else keeps the old carry-forward
      // behavior.
      if (!snap.exists() || isWardDocUntouched(next)) {
        const patientWardInfo = patientWardAndBedTypeForReportKey(wardKey);
        let filledFromPatients = false;
        if (patientWardInfo) {
          try {
            const patientsSnap = await getDocs(collection(db, 'patients'));
            const patients = [];
            patientsSnap.forEach(d => patients.push(d.data()));
            const headcount = wardHeadcount(patients, patientWardInfo.wardLabel, patientWardInfo.bedType);
            next = { ...next, startOcc: headcount, occ: headcount, vac: (next.beds || 0) - headcount };
            filledFromPatients = true;
          } catch (e) { /* fall through to the old carry-forward below */ }
        }
        if (!filledFromPatients && !snap.exists()) {
          try {
            const prevRef = doc(db, 'nurseReports', prevDateId(dateId), 'wards', wardKey);
            const prevSnap = await getDocSafe(prevRef);
            if (prevSnap.exists() && typeof prevSnap.data().occ === 'number') next = { ...next, startOcc: prevSnap.data().occ };
          } catch (e) { /* non-fatal — leave startOcc at 0, nurse can correct it */ }
        }
      } else {
        // The report already has shift movements typed into it today, so
        // its running Occ (startOcc + every shift's ADM/DISC/etc.) is the
        // real record of what a nurse reported and must stay intact. But
        // that running total only ever moves when someone types a number
        // in — if a patient's chart is instead deleted outright (a
        // duplicate entry, a mistaken registration) with no matching "-1"
        // typed anywhere, Occ silently drifts above the real patient
        // count and stays wrong until a nurse notices and hand-fixes it.
        // Reconcile on every open: compare the running total to the live
        // patient count and, if they've drifted apart, absorb the
        // difference into startOcc rather than occ/vac directly, so every
        // shift's own recorded numbers are preserved and only the
        // baseline they build on is corrected.
        const patientWardInfo = patientWardAndBedTypeForReportKey(wardKey);
        if (patientWardInfo) {
          try {
            const patientsSnap = await getDocs(collection(db, 'patients'));
            const patients = [];
            patientsSnap.forEach(d => patients.push(d.data()));
            const headcount = wardHeadcount(patients, patientWardInfo.wardLabel, patientWardInfo.bedType);
            const runningOcc = computeCensus(next).occ;
            if (headcount !== runningOcc) {
              const correctedStartOcc = (typeof next.startOcc === 'number' ? next.startOcc : 0) + (headcount - runningOcc);
              next = { ...next, startOcc: correctedStartOcc };
              // Persist right away — not just for this viewer's session —
              // so any other screen reading this ward's stored report
              // (e.g. the ward home-page summary) also sees the corrected
              // number instead of the stale one until someone happens to
              // save.
              if (snap.exists()) {
                setDoc(doc(db, 'nurseReports', dateId, 'wards', wardKey), { startOcc: correctedStartOcc, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
              }
            }
          } catch (e) { /* best-effort — leave the running total as-is */ }
        }
      }

      if (cancelled) return;
      setTopStatus({ text: '', error: false });
      setNightUpdateOpen(!!next.nightUpdate);
      setWardDoc(next);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wardKey]);

  function updateWardDoc(patch) { setWardDoc((d) => ({ ...d, ...patch })); }
  function updateShiftField(shiftKey, fieldKey, raw) {
    const num = parseFloat(raw);
    touchedShiftFieldsRef.current.add(shiftKey + '.' + fieldKey);
    setWardDoc((d) => ({ ...d, shifts: { ...d.shifts, [shiftKey]: { ...d.shifts[shiftKey], [fieldKey]: isNaN(num) ? 0 : num } } }));
  }

  // Re-reads the live report doc and builds the `shifts` object Save/
  // Submit should actually persist: the live/background figure for
  // every field, except any field the nurse has personally edited in
  // this session (touchedShiftFieldsRef), which keeps whatever's on
  // screen. Falls back to the given local doc's own shifts untouched if
  // the re-read fails (e.g. offline) — same as before this reconciliation
  // existed.
  async function reconcileShiftsBeforeSave(localDoc) {
    let liveShifts = null;
    try {
      const snap = await getDocSafe(doc(db, 'nurseReports', dateId, 'wards', wardKey));
      if (snap.exists()) liveShifts = snap.data().shifts || null;
    } catch (e) { /* offline or otherwise unreachable — just save local as-is */ }
    if (!liveShifts) return localDoc.shifts;
    const merged = {};
    SHIFTS.forEach((s) => {
      merged[s.key] = { ...(liveShifts[s.key] || {}), ...(localDoc.shifts[s.key] || {}) };
      movementFields.forEach((f) => {
        const key = s.key + '.' + f.key;
        if (!touchedShiftFieldsRef.current.has(key)) {
          const liveVal = (liveShifts[s.key] || {})[f.key];
          if (typeof liveVal === 'number') merged[s.key][f.key] = liveVal;
        }
      });
    });
    return merged;
  }
  // Mirrors reconcileShiftsBeforeSave above, for the top-level
  // Demographics fields instead of the nested shifts object — see
  // touchedDemographicFieldsRef for why this is needed.
  async function reconcileDemographicsBeforeSave(localDoc) {
    let live = null;
    try {
      const snap = await getDocSafe(doc(db, 'nurseReports', dateId, 'wards', wardKey));
      if (snap.exists()) live = snap.data();
    } catch (e) { /* offline or otherwise unreachable — just save local as-is */ }
    if (!live) return {};
    const patch = {};
    DEMOGRAPHIC_FIELDS.forEach((f) => {
      if (touchedDemographicFieldsRef.current.has(f.key)) return;
      const liveVal = live[f.key];
      if (typeof liveVal === 'number' && liveVal !== localDoc[f.key]) patch[f.key] = liveVal;
    });
    return patch;
  }
  function updateDuty(shiftKey, value) {
    setWardDoc((d) => ({ ...d, shifts: { ...d.shifts, [shiftKey]: { ...d.shifts[shiftKey], nurseOnDuty: value } } }));
  }
  function updateBeds(raw) { const n = parseFloat(raw); updateWardDoc({ beds: isNaN(n) ? 0 : n }); }
  function updateStartOcc(raw) { const n = parseFloat(raw); updateWardDoc({ startOcc: isNaN(n) ? 0 : n }); }

  function addPatient() {
    patientCounter.current += 1;
    const id = 'p' + Date.now() + '_' + patientCounter.current;
    const blank = { id, status: '' };
    PATIENT_FIELDS.forEach(f => { blank[f.key] = ''; });
    setWardDoc((d) => ({ ...d, patients: [...d.patients, blank] }));
  }
  function removePatient(id) { setWardDoc((d) => ({ ...d, patients: d.patients.filter(p => p.id !== id) })); }
  function updatePatientField(id, key, value) { setWardDoc((d) => ({ ...d, patients: d.patients.map(p => p.id === id ? { ...p, [key]: value } : p) })); }
  function updatePatientStatus(id, value) { setWardDoc((d) => ({ ...d, patients: d.patients.map(p => p.id === id ? { ...p, status: value } : p) })); }

  // Diagnosis/Notes edits go through here instead of updatePatientField so
  // a trailing "VITAL SIGNS:" / "Vitals:" line (see VITALS_TRIGGER_RE) can
  // auto-pull that patient's latest Vitals Chart reading right underneath
  // it — same trigger text a nurse would already write by hand, just
  // filled in instead of left blank. Does nothing (silently) if this
  // write-up isn't linked to a real patient record yet, or if that
  // patient has no vitals recorded.
  async function updateDiagnosisField(id, value) {
    updatePatientField(id, 'diagnosis', value);

    const lines = value.split('\n');
    const triggerLine = lines[lines.length - 1];
    if (!VITALS_TRIGGER_RE.test(triggerLine.trim())) return;

    const p = wardDoc.patients.find((x) => x.id === id);
    const patientId = linkedPatientIdFor(p);
    if (!patientId) return;

    try {
      const latest = await fetchLatestVitals(patientId);
      if (!latest) return;
      const snapshot = { temp: latest.temp || '', pulse: latest.pulse || '', resp: latest.resp || '', bp: latest.bp || '', spo2: latest.spo2 || '' };
      const vitalsLine = formatVitalsLine(snapshot);
      setWardDoc((d) => ({
        ...d,
        patients: d.patients.map((x) => {
          if (x.id !== id) return x;
          // The lookup is async — if the note moved on (more typed, the
          // trigger edited away) while it was in flight, don't insert
          // a reading that no longer matches where the cursor is.
          if (!x.diagnosis || !x.diagnosis.endsWith(triggerLine)) return x;
          return { ...x, diagnosis: x.diagnosis + '\n' + vitalsLine, vitalsSnapshot: snapshot, vitalsLine };
        })
      }));
    } catch (e) {
      // Non-fatal — the nurse can still type vitals in by hand.
    }
  }

  // Fired when the nurse clicks one of the auto-filled vitals chips under
  // the Diagnosis/Notes box and edits it — regenerates just that reading's
  // line and swaps it into the note text in place (see vitalsLine, the
  // exact substring last inserted, so the replace targets the right spot
  // even though the rest of the note may have grown around it since).
  function updateVitalsSnapshotField(id, field, value) {
    setWardDoc((d) => ({
      ...d,
      patients: d.patients.map((p) => {
        if (p.id !== id || !p.vitalsSnapshot) return p;
        const nextSnapshot = { ...p.vitalsSnapshot, [field]: value };
        const nextLine = formatVitalsLine(nextSnapshot);
        const nextDiagnosis = p.vitalsLine && p.diagnosis ? p.diagnosis.replace(p.vitalsLine, nextLine) : p.diagnosis;
        return { ...p, vitalsSnapshot: nextSnapshot, vitalsLine: nextLine, diagnosis: nextDiagnosis };
      })
    }));
  }

  // Fills the "Vital Signs Roll" box (stored as npAssessment) with the
  // linked patient's most recent Vital Signs Chart reading, in the same
  // T/P/R/BP/SPO2 line format used elsewhere in this file. Blank-only,
  // like every other auto-fill here, so it never overwrites anything the
  // nurse typed or edited — and since the result is plain text in a
  // normal textarea, she can still change any of it. Silent no-op if the
  // patient has no vitals recorded or the lookup fails.
  async function fillVitalsRoll(id, patientId) {
    if (!patientId) return;
    try {
      const latest = await fetchLatestVitals(patientId);
      if (!latest) return;
      const line = formatVitalsLine({ temp: latest.temp || '', pulse: latest.pulse || '', resp: latest.resp || '', bp: latest.bp || '', spo2: latest.spo2 || '' });
      setWardDoc((d) => ({
        ...d,
        patients: d.patients.map((p) => (p.id === id && !p.npAssessment) ? { ...p, npAssessment: line } : p)
      }));
    } catch (e) {
      // Non-fatal — the nurse can still type vitals in by hand.
    }
  }

  // Fills the "Plan" box (npPlan) with the linked patient's current drugs
  // from their Drug Course Chart. Blank-only, like fillVitalsRoll, so it
  // never overwrites anything the nurse typed or edited. Silent no-op if the
  // patient has no active drugs or the lookup fails.
  async function fillPlan(id, patientId) {
    if (!patientId) return;
    try {
      const text = await fetchCurrentDrugPlan(patientId);
      if (!text) return;
      setWardDoc((d) => ({
        ...d,
        patients: d.patients.map((p) => (p.id === id && !p.npPlan) ? { ...p, npPlan: text } : p)
      }));
    } catch (e) {
      // Non-fatal — the nurse can still type the plan in by hand.
    }
  }

  // Re-pulls the Plan from the Drug Course Chart on demand (orders change
  // during the shift). Replaces whatever is in the box, so it asks first if
  // there's already text there.
  async function refreshPlan(id) {
    const p = wardDoc.patients.find((x) => x.id === id);
    const patientId = linkedPatientIdFor(p);
    if (!patientId) return;
    if (p.npPlan && !window.confirm('Replace the current Plan with the latest drugs from the Drug Course Chart?')) return;
    try {
      const text = await fetchCurrentDrugPlan(patientId);
      if (!text) { window.alert('No active drugs found on this patient\u2019s Drug Course Chart.'); return; }
      updatePatientField(id, 'npPlan', text);
    } catch (e) {
      window.alert('Couldn\u2019t load the Drug Course Chart: ' + (e.code || e.message || 'unknown error'));
    }
  }

  // Looks the typed EMR number up against the existing 'patients'
  // collection (the same master record used by the drug-course-chart
  // side of the app) and, if found, fills in Age/Name/Sex/DOA — but only
  // the fields that are still blank, so it never clobbers anything the
  // nurse already typed. Sex isn't tracked on the patient master record,
  // so that field is left for the nurse either way. Fires on blur of the
  // EMR input rather than every keystroke.
  async function lookupPatientByEmr(id, rawEmr) {
    const emr = (rawEmr || '').trim();
    if (!emr) { setEmrLookup((s) => ({ ...s, [id]: null })); return; }
    setEmrLookup((s) => ({ ...s, [id]: { text: 'Looking up patient…', error: false } }));
    try {
      const q = query(collection(db, 'patients'), where('emr', '==', emr), limit(1));
      const snap = await getDocsSafe(q);
      if (snap.empty) {
        setEmrLookup((s) => ({ ...s, [id]: { text: 'No patient found with that EMR number — fill in details manually.', error: false } }));
        return;
      }
      const record = snap.docs[0].data();
      const foundId = snap.docs[0].id;
      setWardDoc((d) => ({
        ...d,
        patients: d.patients.map((p) => {
          if (p.id !== id) return p;
          const next = { ...p, emrPatientId: foundId };
          if (!next.name && record.name) next.name = record.name;
          if (!next.age && record.age) next.age = record.age;
          if (!next.doa && record.admissionDate) next.doa = record.admissionDate;
          if (record.diagnosis) next.diagnosis = withPatientDiagnosis(next.diagnosis, record.diagnosis);
          if (!next.sex && record.gender) next.sex = record.gender === 'M' ? 'Male' : record.gender === 'F' ? 'Female' : record.gender;
          return next;
        })
      }));
      setEmrLookup((s) => ({ ...s, [id]: { text: 'Filled in from the patient record.', error: false } }));
      fillVitalsRoll(id, foundId);
      fillPlan(id, foundId);
    } catch (e) {
      setEmrLookup((s) => ({ ...s, [id]: { text: "Couldn't look up patient: " + (e.code || e.message || 'unknown error'), error: true } }));
    }
  }

  // Fills a write-up card straight from the "Select Patient" dropdown —
  // same blank-fields-only fill as lookupPatientByEmr above, but keyed
  // off a chosen wardPatientOptions entry instead of a typed EMR number.
  // Also remembers which real patient record this card came from
  // (`sourcePatientId`), which submitReport() below needs to actually
  // discharge/refer that patient when the card's status calls for it.
  // Clearing the dropdown back to blank clears that link too.
  function selectPatientFromWard(id, sourcePatientId) {
    if (!sourcePatientId) { setWardDoc((d) => ({ ...d, patients: d.patients.map((p) => p.id === id ? { ...p, sourcePatientId: '' } : p) })); return; }
    const record = wardPatientOptions.find((p) => p.id === sourcePatientId);
    if (!record) return;
    setWardDoc((d) => ({
      ...d,
      patients: d.patients.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p, sourcePatientId };
        if (!next.emr && record.emr) next.emr = record.emr;
        if (!next.name && record.name) next.name = record.name;
        if (!next.age && record.age) next.age = record.age;
        // Sex is a free-text field on the write-up (unlike the patient
        // record's own M/F select) — spell it out the way a nurse would
        // type it by hand, matching every other write-up already on file.
        if (!next.sex && record.gender) next.sex = record.gender === 'M' ? 'Male' : record.gender === 'F' ? 'Female' : record.gender;
        if (!next.doa && record.admissionDate) next.doa = record.admissionDate;
        // The patient's diagnosis goes on the bold "Diagnosis:" line at the
        // top of the Notes box (blank-only, existing notes are kept below it).
        if (record.diagnosis) next.diagnosis = withPatientDiagnosis(next.diagnosis, record.diagnosis);
        // Picking someone already tagged DISCHARGE/TRANS OUT (see
        // WardPatientPicker) means this write-up is their closing note —
        // pre-fill Status to match so submitReport recognizes it and the
        // nurse doesn't have to set it by hand, but never override
        // something the nurse already picked themselves.
        if (!next.status && record.dischargeStatus) next.status = record.dischargeStatus;
        // Same idea for a patient tagged TRANS IN FROM A&E / NEW PATIENT
        // (see admissionTag on wardPatientOptions) — pre-fill Status to
        // the matching write-up stamp, again only if the nurse hasn't
        // already set something themselves.
        if (!next.status && record.admissionTag) next.status = ADMISSION_TAG_STATUS_STAMP[record.admissionTag] || '';
        return next;
      })
    }));
    setEmrLookup((s) => ({ ...s, [id]: { text: 'Filled in from ' + (record.name || 'the patient') + '\u2019s record.', error: false } }));
    fillVitalsRoll(id, sourcePatientId);
    fillPlan(id, sourcePatientId);
  }

  function openNightUpdate() {
    if (!editable) return;
    const opening = !nightUpdateOpen;
    setNightUpdateOpen(opening);
    if (!opening) return;
    if (!wardDoc.shifts.pm.nurseOnDuty && profile?.name) updateDuty('pm', profile.name);
  }

  const census = useMemo(() => wardDoc ? computeCensus(wardDoc) : null, [wardDoc]);
  const movementTotals = useMemo(() => wardDoc ? computeMovementTotals(wardDoc) : null, [wardDoc]);

  const editable = wardDoc ? ((isAdmin && adminEditOverride) || !wardDoc.locked) : false;

  async function saveReport() {
    if (!wardDoc || !editable) return;
    let doc_ = wardDoc;
    if (!doc_.shifts.am.nurseOnDuty && profile?.name) {
      doc_ = { ...doc_, shifts: { ...doc_.shifts, am: { ...doc_.shifts.am, nurseOnDuty: profile.name } } };
      setWardDoc(doc_);
    }
    const ref = doc(db, 'nurseReports', dateId, 'wards', wardKey);
    // Take the live/background movement figures for anything the nurse
    // hasn't personally edited this session — see shiftStatsSync.js and
    // reconcileShiftsBeforeSave above — so a patient status change
    // elsewhere while this report is open doesn't get overwritten by a
    // stale on-screen count.
    const reconciledShifts = await reconcileShiftsBeforeSave(doc_);
    doc_ = { ...doc_, shifts: reconciledShifts, ...(await reconcileDemographicsBeforeSave(doc_)) };
    setWardDoc(doc_);
    const reconciledCensus = computeCensus(doc_);
    const reconciledTotals = computeMovementTotals(doc_);
    const finalDoc = { ...doc_, occ: reconciledCensus.occ, vac: reconciledCensus.vac, ...reconciledTotals };
    try {
      await setDoc(ref, { ...finalDoc, updatedAt: serverTimestamp(), updatedBy: profile.name || 'Unknown' }, { merge: true });
      setSaveStatus({ text: 'Saved.', error: false });
    } catch (e) {
      setSaveStatus({ text: "Couldn't save: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  async function submitReport() {
    if (!wardDoc || !editable) return;
    const hasNightUpdate = !!(wardDoc.nightUpdate && wardDoc.nightUpdate.trim());
    let doc_ = wardDoc;
    if (hasNightUpdate && !doc_.shifts.pm.nurseOnDuty && profile?.name) {
      doc_ = { ...doc_, shifts: { ...doc_.shifts, pm: { ...doc_.shifts.pm, nurseOnDuty: profile.name } } };
    }

    // A write-up linked to a real patient record (picked via "Select
    // Patient") whose status is DISCHARGE or TRANS OUT (TRANS OUT doubles
    // as "referred to another hospital") finalizes that patient on
    // submit. Two cases, handled the same way from here on:
    //  - Freshly set here (wardPatientOptions didn't already show them
    //    tagged DISCHARGE/TRANS OUT): archive their current admission for
    //    real — the same archive-and-reset flow as the Drug Course
    //    Chart's own Patient Status control (applyPatientStatus), just
    //    triggered from here instead.
    //  - Already tagged (the nurse picked them off the roster where they
    //    showed the small red DISCHARGE/TRANS OUT tag — see
    //    WardPatientPicker below — because they were discharged/referred
    //    straight off the Drug Course Chart, or off Patient.jsx, earlier):
    //    already archived, so this write-up is just their closing note —
    //    skip re-archiving.
    // Either way, once submitted this closes them out
    // (closeOutDischargedPatient) so they finally drop off this and every
    // other ward-scoped patient list. Skips anything already finalized
    // this way (so re-submitting doesn't double-archive or re-run the
    // close-out) or with no linked record.
    const alreadyTaggedIds = new Set(wardPatientOptions.filter((p) => p.dischargeStatus).map((p) => p.id));
    const toFinalize = doc_.patients.filter((p) => p.sourcePatientId && !p.archivedFromReport && PATIENT_STATUS_ARCHIVE_REASON[p.status]);
    if (toFinalize.length && !navigator.onLine) {
      setSaveStatus({ text: "Some patients here are marked Discharge/Trans Out — closing them out needs an internet connection. Please try again once online, or clear their status to submit without closing them out.", error: true });
      return;
    }

    // A patient not already tagged (wardPatientOptions had no
    // dischargeStatus for them) is about to be discharged/referred for
    // real, right now, purely because this write-up's own Status field
    // says so — this is the "second route" into a discharge: a nurse who
    // knows the patient is leaving marks it here even though nobody set
    // that from the Drug Course Chart (e.g. the nurse who actually
    // discharged them forgot to). Confirm before doing anything
    // irreversible, same as Drug Course Chart's own Patient Status
    // control and Patient.jsx's do for this exact archive.
    const freshDischarges = toFinalize.filter((p) => !alreadyTaggedIds.has(p.sourcePatientId));
    if (freshDischarges.length) {
      const names = freshDischarges.map((p) => (p.name || p.emr || 'Unnamed') + ' \u2014 ' + p.status).join('\n');
      if (!window.confirm('Submitting this report will discharge/refer the following patient(s) and archive their current chart:\n\n' + names + '\n\nContinue?')) {
        setSaveStatus({ text: "Submission cancelled — clear or change the Status field on the patient(s) listed above if that wasn't intended.", error: true });
        return;
      }
    }

    const archiveErrors = [];
    if (toFinalize.length) {
      const results = await Promise.all(toFinalize.map(async (p) => {
        const name = p.name || p.emr || 'A patient';
        if (!alreadyTaggedIds.has(p.sourcePatientId)) {
          const r = await applyPatientStatus({
            patientId: p.sourcePatientId, reason: PATIENT_STATUS_ARCHIVE_REASON[p.status],
            transferWard: '', fromWard: w?.label || '', transferredByName: profile?.name || 'Unknown'
          });
          if (!r.ok) return { id: p.id, ok: false, message: r.message, name };
        }
        const closed = await closeOutDischargedPatient(p.sourcePatientId);
        if (!closed.ok) return { id: p.id, ok: false, message: closed.message, name };
        return { id: p.id, ok: true, name };
      }));
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      results.forEach((r) => { if (!r.ok) archiveErrors.push(r.name + ': ' + r.message); });
      doc_ = { ...doc_, patients: doc_.patients.map((p) => okIds.has(p.id) ? { ...p, archivedFromReport: true } : p) };
    }

    // Take the live/background movement figures for anything the nurse
    // hasn't personally edited this session (see reconcileShiftsBeforeSave
    // above) — this also naturally picks up the exit bumps applyPatientStatus
    // just made for toFinalize above, since those already landed in
    // Firestore by this point.
    const reconciledShifts = await reconcileShiftsBeforeSave(doc_);
    doc_ = { ...doc_, shifts: reconciledShifts, ...(await reconcileDemographicsBeforeSave(doc_)) };
    const reconciledCensus = computeCensus(doc_);
    const reconciledTotals = computeMovementTotals(doc_);
    const finalDoc = { ...doc_, occ: reconciledCensus.occ, vac: reconciledCensus.vac, ...reconciledTotals };
    const ref = doc(db, 'nurseReports', dateId, 'wards', wardKey);
    const payload = {
      ...finalDoc, submitted: true, locked: true,
      submittedBy: profile.name || 'Unknown', submittedByUid: user?.uid || null, submittedAt: serverTimestamp(),
      updatedAt: serverTimestamp(), updatedBy: profile.name || 'Unknown'
    };
    if (hasNightUpdate) {
      payload.nightUpdateBy = doc_.nightUpdateBy || profile.name || 'Unknown';
      payload.nightUpdatedAt = doc_.nightUpdatedAt || serverTimestamp();
    }
    try {
      await setDoc(ref, payload, { merge: true });
      setSaveStatus(archiveErrors.length
        ? { text: 'Report submitted, but could not archive: ' + archiveErrors.join('; '), error: true }
        : { text: 'Report submitted.', error: false });
      setWardDoc((d) => ({ ...d, ...doc_, submitted: true, locked: true, nightUpdateBy: payload.nightUpdateBy || d.nightUpdateBy }));

      // A patient tagged AE_TRANSFER/NEW_PATIENT (see wardPatientOptions
      // above) whose name was picked for one of this report's write-ups
      // has now had a report written on them — clear their blue tag. Not
      // gated on navigator.onLine like the discharge archiving above:
      // nothing else depends on this succeeding, so it's fine to just
      // fire it and let Firestore's offline queue catch up later.
      const admissionTaggedIds = new Set(wardPatientOptions.filter((p) => p.admissionTag).map((p) => p.id));
      doc_.patients.forEach((p) => {
        if (p.sourcePatientId && admissionTaggedIds.has(p.sourcePatientId)) {
          clearAdmissionTag(p.sourcePatientId).catch(() => {});
        }
      });
    } catch (e) {
      setSaveStatus({ text: "Couldn't submit: " + (e.code || e.message || 'unknown error'), error: true });
    }
  }

  const pillClass = !wardDoc ? '' : wardDoc.locked ? 'locked' : wardDoc.submitted ? 'submitted' : 'draft';
  const pillText = !wardDoc ? '' : wardDoc.locked ? 'Locked' : wardDoc.submitted ? 'Submitted' : 'Draft';

  return {
    w, wardDoc, adminEditOverride, setAdminEditOverride, nightUpdateOpen, topStatus, saveStatus, emrLookup,
    wardPatientOptions,
    census, movementTotals, editable,
    updateWardDoc, updateShiftField, updateDuty, updateBeds, updateStartOcc,
    addPatient, removePatient, updatePatientField, updateDiagnosisField, updateVitalsSnapshotField,
    updatePatientStatus, lookupPatientByEmr, selectPatientFromWard, refreshPlan,
    openNightUpdate, saveReport, submitReport, pillClass, pillText,
    touchedDemographicFieldsRef
  };
}

// Everything about one ward's report except the Shift Statistics table
// itself: header/status/archive, locked notice, Previous Occ, [the
// Shift Statistics table, when includeShiftTable], Patient Demographics,
// Patients, Night Update, Save/Submit. `includeShiftTable` is false for
// a mergedTable group's members (MergedWardReportPanel renders one
// shared table above instead) and true everywhere else. Likewise
// `includePreviousOcc` is false for a mergedTable group's members —
// MergedWardReportPanel renders both members' Previous Occ inline atop
// the shared table instead of as a separate card down here.
// `includeHeader` is false for a mergedTable group's non-lead member
// (Cots) — MergedWardReportPanel doesn't render this component for that
// member at all. `onSave`/`onSubmit`, when passed, replace the default
// per-ward save/submit handlers — MergedWardReportPanel uses these so
// the one Save/Submit bar shown (Mothers') saves both member wards'
// data together, since Cots' own numeric figures (entered in the shared
// table above) would otherwise have no button of their own to save.
// "Select Patient" picker for a write-up card — a button that opens a
// modal listing this ward's patients (wardPatientOptions), rather than a
// plain <select>. A native <select>'s <option> can only ever be a single
// line of plain text, so it can't carry the small red DISCHARGE/TRANS OUT
// tag a patient needs once they've been discharged or referred out (see
// dischargeStatus on wardPatientOptions, set by applyPatientStatus in
// patientAdmissionStatus.js) — they stay on this list, tag and all, until
// a closing report is submitted for them (see submitReport above), so the
// nurse can still find and tap them to write that closing note.
//
// usedIds (optional) — patient ids already picked in one of this report's
// OTHER write-up cards (see WardPanelRest below). Faded out and
// unclickable here so a nurse building a second write-up can see at a
// glance who she's already written on and can't pick them again by
// mistake — except the option matching this picker's own current value,
// which stays fully selectable/highlighted since it's this card's pick.
// `columns`, when provided (currently just the merged PAED WARD "Check a
// patient's status" lookup — see MergedWardReportPanel), splits the list
// into side-by-side sub-ward tables instead of one flat list, e.g. PAED
// BED on the left and PAED COT on the right, since a nurse scanning for a
// patient usually already knows which sub-ward they're in and a single
// merged list makes that slower to find. Each entry is
// { label, options }; `options` here is still the full combined list,
// used for the button's own selected-label lookup and for the
// duplicate-EMR check across both sub-wards.
function WardPatientPicker({ value, options, onSelect, usedIds, columns }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value);
  const label = selected ? ((selected.name || 'Unnamed') + (selected.emr ? ' (' + selected.emr + ')' : '')) : '\u2014 Select from ward \u2014';

  // Two separate patient records can end up sharing the same EMR number
  // (e.g. a name typed/reordered differently on re-entry - "Ernest Ukolio"
  // vs "Ukolio Enerst", both 139680) — without a flag, both look like
  // valid options and a nurse can't tell they're the same real patient,
  // so she might pick either one, or the same person twice across two
  // write-up cards, without realizing it. Flags every option whose EMR
  // matches another option's, so she can check with the Overall Nurse/
  // Admin instead of guessing which record is the live one.
  const duplicateEmrIds = useMemo(() => {
    const counts = {};
    options.forEach((o) => {
      const k = (o.emr || '').trim().toLowerCase();
      if (k) counts[k] = (counts[k] || 0) + 1;
    });
    const ids = new Set();
    options.forEach((o) => {
      const k = (o.emr || '').trim().toLowerCase();
      if (k && counts[k] > 1) ids.add(o.id);
    });
    return ids;
  }, [options]);

  function pick(id) { onSelect(id); setOpen(false); }

  function OptionRow(o) {
    const isUsedElsewhere = !!usedIds && usedIds.has(o.id) && o.id !== value;
    return (
      <div className={"ward-patient-picker-row" + (isUsedElsewhere ? ' is-used' : '')}
        key={o.id} onClick={() => { if (!isUsedElsewhere) pick(o.id); }}>
        <div>
          <span className={"ward-patient-picker-name" + (o.id === value ? ' is-selected' : '')}>
            {(o.name || 'Unnamed') + (o.emr ? ' (' + o.emr + ')' : '')}{!columns && o.location ? ' \u2014 ' + o.location : ''}
          </span>
          {isUsedElsewhere && (
            <div className="ward-patient-picker-tag used">{'Already selected in another write-up'}</div>
          )}
          {duplicateEmrIds.has(o.id) && (
            <div className="ward-patient-picker-tag duplicate">{'\u26A0\uFE0F Duplicate EMR \u2014 check with Overall Nurse'}</div>
          )}
          {o.dischargeStatus ? (
            <div className="ward-patient-picker-tag">{o.dischargeStatus === 'TRANS OUT' ? 'TRANS OUT' : o.dischargeStatus === 'DEATH' ? 'Death' : o.dischargeStatus === 'DAMA' ? 'DAMA' : o.dischargeStatus === 'ABSC' ? 'Absconded' : 'Discharged'}</div>
          ) : o.admissionTag ? (
            <div className="ward-patient-picker-tag admission">{ADMISSION_TAG_LABEL[o.admissionTag] || o.admissionTag}</div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <button type="button" className={"ward-patient-picker-btn" + (value ? ' set' : '')} onClick={() => setOpen(true)}>
        <span className="ward-patient-picker-btn-text">{label}</span>
        <span className="sno-picker-caret">{'\u25BE'}</span>
      </button>
      {open && (
        <div className="modal-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="modal-box">
            <div className="modal-header"><h3>Select Patient <span className="ward-count-badge">{options.length}</span></h3><button className="modal-close" onClick={() => setOpen(false)}>&times;</button></div>
            <div className="modal-body ward-patient-picker-body">
              <div className="ward-patient-picker-row" onClick={() => pick('')}>
                <span className={"ward-patient-picker-name" + (!value ? ' is-selected' : '')}>{'\u2014 Select from ward \u2014'}</span>
              </div>
              {columns ? (
                <div className="ward-patient-picker-columns">
                  {columns.map((col) => (
                    <div className="ward-patient-picker-column" key={col.label}>
                      <div className="ward-patient-picker-column-header">{col.label}</div>
                      {col.options.length === 0
                        ? <div className="ward-patient-picker-empty">No patients</div>
                        : col.options.map((o) => OptionRow(o))}
                    </div>
                  ))}
                </div>
              ) : options.map((o) => OptionRow(o))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function WardPanelRest({ h, showLabel, isAdmin, navigate, includeShiftTable = true, includePreviousOcc = true, includeHeader = true, includeDemographics = true, onSave, onSubmit, locationOptions }) {
  const {
    w, wardDoc, topStatus, saveStatus, editable, adminEditOverride, setAdminEditOverride,
    census, movementTotals, emrLookup, wardPatientOptions,
    updateWardDoc, updateShiftField, updateDuty, updateBeds, updateStartOcc,
    addPatient, removePatient, updatePatientField, updateDiagnosisField, updateVitalsSnapshotField,
    updatePatientStatus, lookupPatientByEmr, selectPatientFromWard, refreshPlan,
    nightUpdateOpen, openNightUpdate, saveReport, submitReport, pillClass, pillText
  } = h;

  // Quick lookup only, not tied to any write-up — lets the nurse glance at
  // a patient's roster tag (Discharge/Trans Out/Death/admission tag) right
  // next to Previous Occ while tallying the Shift Statistics table above,
  // instead of scrolling all the way down to the Patients section to find
  // that same tag on a linked write-up.
  // Which shift the nurse filling in this report is currently working —
  // a UI-only gate (not saved to Firestore): a morning-shift nurse only
  // ever sees Save, so she can hand the report off for the night nurse to
  // finish; the night-shift nurse sees both Save and Submit Report, since
  // she's the one who closes the day's report out.
  const [shiftMode, setShiftMode] = useState('');
  // A nurse must pick her shift before she can add a patient write-up.
  // Tapping Add Patient with no shift chosen doesn't add anything: it flags
  // the Select Shift field and scrolls it into view instead.
  const [shiftWarn, setShiftWarn] = useState(false);
  const shiftSelectRef = useRef(null);
  function handleAddPatient() {
    if (!shiftMode) {
      setShiftWarn(true);
      const el = shiftSelectRef.current;
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
      return;
    }
    addPatient();
  }

  const [quickLookupId, setQuickLookupId] = useState('');
  const quickLookupRecord = wardPatientOptions.find((o) => o.id === quickLookupId);
  let quickLookupTag = null;
  if (quickLookupRecord) {
    quickLookupTag = quickLookupRecord.dischargeStatus
      ? (quickLookupRecord.dischargeStatus === 'TRANS OUT' ? 'TRANS OUT' : quickLookupRecord.dischargeStatus === 'DEATH' ? 'Death' : quickLookupRecord.dischargeStatus === 'DAMA' ? 'DAMA' : quickLookupRecord.dischargeStatus === 'ABSC' ? 'Absconded' : 'Discharged')
      : quickLookupRecord.admissionTag
        ? (ADMISSION_TAG_LABEL[quickLookupRecord.admissionTag] || quickLookupRecord.admissionTag)
        : 'Active \u2014 no status tag';
  }

  return (
    <>
      {includeHeader && topStatus.text && (
        <div className="save-status" style={{ color: topStatus.error ? '#dc2626' : '#6b7280', margin: '4px 0 0' }}>{topStatus.text}</div>
      )}

      {wardDoc && (
        <>
          {wardDoc.locked && (
            <div className="locked-notice">
              {isAdmin ? "This ward's report is locked." : "This ward's report is locked. Ask the Overall Nurse to grant access before editing."}
              {isAdmin && !adminEditOverride && <button className="admin-edit-btn" onClick={() => setAdminEditOverride(true)}>{'\u270F\uFE0F'}</button>}
            </div>
          )}

          {includePreviousOcc && (
            <div className="card-box">
              <div className="patient-field" style={{ marginTop: 0 }}>
                {wardPatientOptions && wardPatientOptions.length > 0 && (
                  <label>Check a patient's status:</label>
                )}
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  {wardPatientOptions && wardPatientOptions.length > 0 && (
                    <div style={{ flex: '1 1 180px', minWidth: 180 }}>
                      <WardPatientPicker value={quickLookupId} options={wardPatientOptions} onSelect={setQuickLookupId} />
                      {quickLookupTag && (
                        <div style={{ fontSize: 12, marginTop: 4, fontWeight: 'bold', color: quickLookupRecord.dischargeStatus ? '#dc2626' : quickLookupRecord.admissionTag ? '#2563eb' : '#6b7280' }}>
                          {quickLookupTag}
                        </div>
                      )}
                    </div>
                  )}
                  {includeHeader && w && (
                    <button className="btn btn-secondary" style={{ padding: '6px 12px' }} type="button"
                      onClick={() => navigate('/nurses-report/archive-list?type=ward&ward=' + encodeURIComponent(w.key) + '&label=' + encodeURIComponent(w.label))}>
                      {'\uD83D\uDCC1 Archive'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {includeShiftTable && (
            <div className="card-box">
              <h2>Shift Statistics</h2>
              <div className="table-wrap">
                <ShiftTable wardDoc={wardDoc} census={census} movementTotals={movementTotals} editable={editable}
                  onBeds={updateBeds} onField={updateShiftField} onDuty={updateDuty} />
              </div>
            </div>
          )}

          {includeDemographics && (
            <div className="card-box">
              <h2>Patient Demographics</h2>
              <div className="table-wrap">
                <DemographicsTable wardDoc={wardDoc} editable={editable}
                  onField={(key, raw) => { touchedDemographicFieldsRef.current.add(key); const n = parseFloat(raw); updateWardDoc({ [key]: isNaN(n) ? 0 : n }); }}
                  onRemarks={(v) => updateWardDoc({ demographicsRemarks: v })} />
              </div>
            </div>
          )}

          <div className="card-box">
            {editable && (
              <div className="patient-field" style={{ marginTop: 0 }}>
                <label>Select Shift:</label>
                <select ref={shiftSelectRef} className={"status-select" + (shiftMode ? ' set' : '')}
                  style={shiftWarn && !shiftMode ? { borderColor: '#dc2626', boxShadow: '0 0 0 3px rgba(220,38,38,.15)' } : undefined}
                  value={shiftMode} onChange={(e) => { setShiftMode(e.target.value); if (e.target.value) setShiftWarn(false); }}>
                  <option value="">{'\u2014 Select shift \u2014'}</option>
                  <option value="morning">Morning Shift</option>
                  <option value="night">Night Shift</option>
                </select>
                {shiftWarn && !shiftMode && (
                  <div className="save-status" style={{ color: '#dc2626', marginTop: 4 }}>Select your shift (Morning or Night) before adding a patient.</div>
                )}
              </div>
            )}
            <h2>Patients</h2>
            <p style={{ fontSize: 12, color: '#6b7280', marginTop: -6, marginBottom: 12 }}>Click add patient to write report</p>
            {editable ? (
              <>
                {wardDoc.patients.map((p, i) => (
                  <div className="patient-card" key={p.id}>
                    <button type="button" className="remove-btn" onClick={() => removePatient(p.id)}>Remove</button>
                    {wardPatientOptions && wardPatientOptions.length > 0 && (
                      <div className="patient-field">
                        <label>Select Patient:</label>
                        <WardPatientPicker value={p.sourcePatientId || ''} options={wardPatientOptions} onSelect={(id) => selectPatientFromWard(p.id, id)}
                          usedIds={new Set(wardDoc.patients.filter((other) => other.id !== p.id && other.sourcePatientId).map((other) => other.sourcePatientId))} />
                      </div>
                    )}
                    {locationOptions && (
                      <div className="patient-field">
                        <label>Located:</label>
                        <select className={"status-select" + (p.location ? ' set' : '')} value={p.location || ''} onChange={(e) => updatePatientField(p.id, 'location', e.target.value)}>
                          <option value="">{'\u2014 Select \u2014'}</option>
                          {locationOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                      </div>
                    )}
                    <div className="patient-field">
                      <label>Status:</label>
                      <select className={"status-select" + (p.status ? ' set' : '')} value={p.status || ''} onChange={(e) => updatePatientStatus(p.id, e.target.value)}>
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
                                ? <DiagnosisNoteEditor value={p.diagnosis || ''} onChange={(v) => updateDiagnosisField(p.id, v)} />
                                : <textarea className={f.big ? 'big' : ''} value={p[f.key] || ''}
                                    onChange={(e) => updatePatientField(p.id, f.key, e.target.value)} />)
                            : <input type="text" value={p[f.key] || ''} onChange={(e) => updatePatientField(p.id, f.key, e.target.value)}
                                onBlur={f.key === 'emr' ? (e) => lookupPatientByEmr(p.id, e.target.value) : undefined} />}
                          {f.key === 'diagnosis' && p.vitalsSnapshot && (
                            <VitalsChipRow snapshot={p.vitalsSnapshot} onChange={(field, value) => updateVitalsSnapshotField(p.id, field, value)} />
                          )}
                          {f.key === 'npPlan' && linkedPatientIdFor(p) && (
                            <button className="btn btn-secondary" type="button" style={{ marginTop: 6, padding: '6px 10px', fontSize: 14 }}
                              onClick={() => refreshPlan(p.id)}>{'\u21BB Refresh from Drug Course Chart'}</button>
                          )}
                          {f.key === 'emr' && emrLookup[p.id] && (
                            <div className="emr-lookup-note" style={{ color: emrLookup[p.id].error ? '#dc2626' : '#6b7280' }}>
                              {emrLookup[p.id].text}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {editable && i === wardDoc.patients.length - 1 && (
                      <>
                        <h2 className="night-update-heading">Night Update</h2>
                        <button className="btn btn-secondary" type="button" onClick={openNightUpdate}>{'\uD83C\uDF19 Night Update'}</button>
                        {nightUpdateOpen && (
                          <div className="patient-field" style={{ marginTop: 10 }}>
                            <label className="patient-note-label" style={{ marginTop: 0 }}>Night update:</label>
                            <textarea id="nightUpdateInput" placeholder="Type the night update here…" style={{ minHeight: 140 }}
                              value={wardDoc.nightUpdate} onChange={(e) => updateWardDoc({ nightUpdate: e.target.value })} />
                          </div>
                        )}
                        <div className="night-update-meta">{wardDoc.nightUpdateBy ? 'Added by ' + wardDoc.nightUpdateBy : ''}</div>
                      </>
                    )}
                  </div>
                ))}
              </>
            ) : wardDoc.patients.length === 0 ? (
              <div className="no-patients">No patient write-ups on this report.</div>
            ) : (
              wardDoc.patients.map((p, i) => (
                <Fragment key={p.id}>
                  <PatientBlockView p={p} />
                  {i === wardDoc.patients.length - 1 && wardDoc.nightUpdate && (
                    <div className="night-update-block">
                      <h3 className="patient-note-label">{'Night Update' + (wardDoc.nightUpdateBy ? ' — ' + wardDoc.nightUpdateBy : '') + ':'}</h3>
                      <p className="patient-note-text">{wardDoc.nightUpdate}</p>
                    </div>
                  )}
                </Fragment>
              ))
            )}

            {editable && <button className={"add-patient-btn" + (shiftMode ? '' : ' is-disabled')} type="button" aria-disabled={!shiftMode} onClick={handleAddPatient} style={{ marginTop: 12 }}>+ Add Patient</button>}
          </div>

          <div className="card-box">
            {editable && (
              <div className="submit-bar">
                <button className="btn btn-secondary" style={{ flex: 1, padding: 12 }} onClick={onSave || saveReport}>Save</button>
                {shiftMode === 'night' && (
                  <button className="btn btn-primary" style={{ flex: 1, padding: 12 }} onClick={onSubmit || submitReport}>Submit Report</button>
                )}
              </div>
            )}
            <div className="save-status" style={{ color: saveStatus.error ? '#dc2626' : '#6b7280' }}>{saveStatus.text}</div>
          </div>
        </>
      )}
    </>
  );
}

// One ward's full report — Previous Occ, Shift Statistics, Patient
// Demographics, Patients, Night Update, Save/Submit. Used once per
// selected ward, and twice side-by-side when the nurse picks a grouped
// option that isn't a mergedTable group (e.g. PAED WARD) — each
// instance loads and saves its own Firestore doc under its own
// wardKey, completely independently.
function WardReportPanel({ wardKey, showLabel, isAdmin, profile, user, navigate }) {
  const h = useWardReport(wardKey, isAdmin, profile, user);
  return <WardPanelRest h={h} showLabel={showLabel} isAdmin={isAdmin} navigate={navigate} includeShiftTable />;
}

// One shared, editable Shift Statistics table for a mergedTable group
// (currently just MATERNITY WARD) — matches the paper Minute Book
// exactly: a Morning section with a Mothers row then a Cots row, a
// Night section the same way, and one combined Total row. `panels` is
// one entry per member ward, each still writing to its own wardDoc/
// Firestore record via its own handlers — this table only combines how
// they're displayed and totalled, never the underlying data.
function MergedShiftTable({ panels }) {
  const totalBeds = panels.reduce((s, p) => s + p.census.beds, 0);
  const totalOcc = panels.reduce((s, p) => s + p.census.occ, 0);
  const totalVac = panels.reduce((s, p) => s + p.census.vac, 0);
  const totalMovement = {};
  ORDERED_MOVEMENT.forEach((f) => {
    totalMovement[f.key] = panels.reduce((s, p) => s + (typeof p.movementTotals[f.key] === 'number' ? p.movementTotals[f.key] : 0), 0);
  });
  const dutyNames = panels.map((p) => p.wardDoc.shifts.pm.nurseOnDuty).filter(Boolean).join(', ');
  const colSpanAll = 4 + ORDERED_MOVEMENT.length + 1;

  return (
    <table className="shift">
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
        {SHIFTS.map((s) => (
          <Fragment key={s.key}>
            <tr className="shift-section-row"><td colSpan={colSpanAll}>{s.label === 'Am' ? 'Morning' : 'Night'}</td></tr>
            {panels.map((p) => (
              <tr key={p.w.key}>
                <td className="shift-name">{p.w.label}</td>
                <td className={"stat-beds" + (s.key === 'am' ? '' : ' mirrored')}>
                  {s.key === 'am'
                    ? <input type="number" inputMode="numeric" disabled={!p.editable} value={p.wardDoc.beds} onChange={(e) => p.updateBeds(e.target.value)} />
                    : p.census.beds}
                </td>
                <td className="computed stat-occ">{p.census.perShiftOcc[s.key]}</td>
                <td className="computed stat-vac">{p.census.beds - p.census.perShiftOcc[s.key]}</td>
                {ORDERED_MOVEMENT.map((f) => (
                  <td key={f.key} className={movementColorClass(f.key)}>
                    <input type="number" inputMode="numeric" disabled={!p.editable}
                      value={p.wardDoc.shifts[s.key][f.key]} onChange={(e) => p.updateShiftField(s.key, f.key, e.target.value)} />
                  </td>
                ))}
                <td>
                  <input type="text" className="duty-input" placeholder="Nurse name(s)" disabled={!p.editable}
                    value={p.wardDoc.shifts[s.key].nurseOnDuty} onChange={(e) => p.updateDuty(s.key, e.target.value)} />
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
        <tr className="total-row">
          <td className="shift-name">Total</td>
          <td className="stat-beds">{totalBeds}</td>
          <td className="stat-occ">{totalOcc}</td>
          <td className="stat-vac">{totalVac}</td>
          {ORDERED_MOVEMENT.map((f) => <td key={f.key} className={movementColorClass(f.key)}>{totalMovement[f.key]}</td>)}
          <td style={{ textAlign: 'left' }}>{dutyNames || '\u2014'}</td>
        </tr>
      </tbody>
    </table>
  );
}

// One shared Patient Demographics table for a mergedTable group with
// demographicsVariant: 'merged' (currently just PAED WARD) — one row per
// member ward (Bed, Cot), same one-daily-total-per-ward shape as the
// standalone DemographicsTable above, kept as separate rows (not combined
// into one) since Bed and Cot each keep their own figures, same as every
// other ward. `panels` is one entry per member ward, each still writing
// to its own wardDoc/Firestore record via its own onField/onRemarks
// handler.
function MergedDemographicsTable({ panels }) {
  const fields = DEMOGRAPHIC_FIELDS;
  const getVal = (p, key) => (typeof p.wardDoc[key] === 'number' ? p.wardDoc[key] : 0);

  return (
    <table className="shift">
      <thead>
        <DemographicsHeaderRows leadCell={<th rowSpan={3}>Ward</th>} trailingCell={<th rowSpan={3}>Rmks</th>} />
      </thead>
      <tbody>
        {panels.map((p) => (
          <tr key={p.w.key}>
            <td className="shift-name">{p.w.label}</td>
            {fields.map((f) => (
              <td key={f.key}>
                <input type="number" inputMode="numeric" disabled={!p.editable}
                  value={getVal(p, f.key)} onChange={(e) => p.onField(f.key, e.target.value)} />
              </td>
            ))}
            <td>
              <input type="text" disabled={!p.editable}
                value={p.wardDoc.demographicsRemarks || ''} onChange={(e) => p.onRemarks(e.target.value)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// A mergedTable group's full report (Maternity, Paed): one shared
// editable Shift Statistics table for both member wards with both
// members' Previous Occ inline just above it, and one Archive button
// covering the whole group — all still writing to the two members' own
// separate Firestore docs underneath. Its Save/Submit buttons always
// save BOTH member wards' data together (via onSave/onSubmit below),
// since the second member's own numeric figures — entered directly in
// the shared table above — would otherwise have no button of their own
// to save. What happens below the table depends on
// group.demographicsVariant:
//   - 'maternity': only the first member (Mothers) gets a Demographics/
//     Patients/Night Update section — nurses don't write reports for
//     Maternity's Cots (newborns have no patient record).
//   - 'merged': both members' demographic figures combine into one
//     shared table (MergedDemographicsTable), and Patients/Night Update
//     is one shared section too — every write-up saves under the first
//     member's doc, tagged with a "Located" dropdown (from
//     group.patientLocationOptions) so nurses can still mark which
//     member ward each patient is actually in.
// Assumes exactly two member wards, true for every mergedTable group
// defined today; a third member would need a third useWardReport call
// added here explicitly (hooks can't be called from a loop).
function MergedWardReportPanel({ group, isAdmin, profile, user, navigate }) {
  const hA = useWardReport(group.wardKeys[0], isAdmin, profile, user);
  const hB = useWardReport(group.wardKeys[1], isAdmin, profile, user);
  const hooks = [hA, hB];
  const bothLoaded = hooks.every((h) => h.wardDoc);
  const mergedDemographics = group.demographicsVariant === 'merged';

  // Same idea as WardPanelRest's own Previous Occ card, but merges BOTH
  // member wards' patients — unlike the "Select Patient" list further
  // down (which stays hA-only, since every write-up saves under hA's
  // doc), this is read-only lookup, so there's no reason to hide Cot
  // patients from it. For Maternity, hB (Cots) never has real patient
  // records (newborns aren't charted — see wardNameMatch.js), so this is
  // effectively just hA's list there; for Paed, Bed and Cot are both real
  // wards with their own patients, tagged here by member label so a nurse
  // can tell which is which.
  const [quickLookupId, setQuickLookupId] = useState('');
  const quickLookupOptions = [
    ...(hA.wardPatientOptions || []).map((o) => ({ ...o, location: hA.w?.label })),
    ...(hB.wardPatientOptions || []).map((o) => ({ ...o, location: hB.w?.label }))
  ].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  // Two-column split by member ward for every merged group (both PAED and
  // Maternity), not just wherever patientLocationOptions is set — that flag
  // only controls the "Located" dropdown on write-up cards, which is a
  // separate concern from how this read-only lookup is laid out. For
  // Maternity, the right (COTS) column will just always read "No
  // patients", since newborns aren't charted (see wardNameMatch.js) — that
  // empty state is accurate, not a bug.
  const quickLookupColumns = [
    { label: hA.w?.label, options: quickLookupOptions.filter((o) => o.location === hA.w?.label) },
    { label: hB.w?.label, options: quickLookupOptions.filter((o) => o.location === hB.w?.label) }
  ];
  const quickLookupRecord = quickLookupOptions.find((o) => o.id === quickLookupId);
  let quickLookupTag = null;
  if (quickLookupRecord) {
    quickLookupTag = quickLookupRecord.dischargeStatus
      ? (quickLookupRecord.dischargeStatus === 'TRANS OUT' ? 'TRANS OUT' : quickLookupRecord.dischargeStatus === 'DEATH' ? 'Death' : quickLookupRecord.dischargeStatus === 'DAMA' ? 'DAMA' : quickLookupRecord.dischargeStatus === 'ABSC' ? 'Absconded' : 'Discharged')
      : quickLookupRecord.admissionTag
        ? (ADMISSION_TAG_LABEL[quickLookupRecord.admissionTag] || quickLookupRecord.admissionTag)
        : 'Active \u2014 no status tag';
  }

  async function saveBoth() { await Promise.all([hA.saveReport(), hB.saveReport()]); }
  async function submitBoth() { await Promise.all([hA.submitReport(), hB.submitReport()]); }

  return (
    <>
      {bothLoaded && (
        <div className="card-box">
          <h2 style={{ margin: 0 }}>{group.label} — Shift Statistics</h2>
          <div className="patient-field" style={{ marginTop: 12, marginBottom: 12 }}>
            {quickLookupOptions.length > 0 && (
              <label>Check a patient's status:</label>
            )}
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              {quickLookupOptions.length > 0 && (
                <div style={{ flex: '1 1 180px', minWidth: 180 }}>
                  <WardPatientPicker value={quickLookupId} options={quickLookupOptions} columns={quickLookupColumns} onSelect={setQuickLookupId} />
                  {quickLookupTag && (
                    <div style={{ fontSize: 12, marginTop: 4, fontWeight: 'bold', color: quickLookupRecord.dischargeStatus ? '#dc2626' : quickLookupRecord.admissionTag ? '#2563eb' : '#6b7280' }}>
                      {quickLookupTag}{quickLookupRecord.location ? ' \u2014 ' + quickLookupRecord.location : ''}
                    </div>
                  )}
                </div>
              )}
              <button className="btn btn-secondary" style={{ padding: '6px 12px' }} type="button"
                onClick={() => navigate('/nurses-report/archive-list?type=ward&ward=' + encodeURIComponent(hA.w.key) + '&label=' + encodeURIComponent(group.label))}>
                {'\uD83D\uDCC1 Archive'}
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <MergedShiftTable panels={hooks.map((h) => ({
              w: h.w, wardDoc: h.wardDoc, census: h.census, movementTotals: h.movementTotals,
              editable: h.editable, updateBeds: h.updateBeds, updateShiftField: h.updateShiftField, updateDuty: h.updateDuty
            }))} />
          </div>
        </div>
      )}
      {bothLoaded && mergedDemographics && (
        <div className="card-box">
          <h2>Patient Demographics</h2>
          <div className="table-wrap">
            <MergedDemographicsTable panels={hooks.map((h) => ({
              w: { ...h.w, label: DEMOGRAPHICS_ROW_LABEL[h.w.key] || h.w.label },
              wardDoc: h.wardDoc, editable: h.editable,
              onField: (key, raw) => { h.touchedDemographicFieldsRef.current.add(key); const n = parseFloat(raw); h.updateWardDoc({ [key]: isNaN(n) ? 0 : n }); },
              onRemarks: (v) => h.updateWardDoc({ demographicsRemarks: v })
            }))} />
          </div>
        </div>
      )}
      <WardPanelRest h={hA} showLabel={false} isAdmin={isAdmin} navigate={navigate}
        includeShiftTable={false} includePreviousOcc={false} includeHeader={false}
        includeDemographics={!mergedDemographics}
        locationOptions={group.patientLocationOptions}
        onSave={saveBoth} onSubmit={submitBoth} />
    </>
  );
}

export default function WardNurse() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const goBack = useGoBack('/nurses-report/role-select');

  const wardOptions = useMemo(() => wardSelectorOptions(), []);
  const [groupKey, setGroupKey] = useState('');
  const activeOption = wardOptions.find(o => o.key === groupKey) || null;
  const isAdmin = profile?.role === 'admin';

  return (
    <>
      <Topbar brand="Ward Nurse">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>
      <div className="ward-select-page" style={{ backgroundImage: `url(${wardSelectBg})` }} />
      <div className="container">
        <div className="card-box">
          <div className="ward-select-row">
            <select value={groupKey} onChange={(e) => setGroupKey(e.target.value)}>
              <option value="">-- Select your ward --</option>
              {wardOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {activeOption && (
          activeOption.mergedTable
            ? <MergedWardReportPanel group={activeOption} isAdmin={isAdmin} profile={profile} user={user} navigate={navigate} />
            : activeOption.wardKeys.map(key => (
                <WardReportPanel key={key} wardKey={key} showLabel={activeOption.wardKeys.length > 1}
                  isAdmin={isAdmin} profile={profile} user={user} navigate={navigate} />
              ))
        )}
      </div>
    </>
  );
}
