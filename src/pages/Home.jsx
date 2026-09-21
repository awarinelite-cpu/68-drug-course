import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDoc, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useExitOnDoubleBack } from "../hooks/useExitOnDoubleBack.js";
import { avatarMarkup } from "../lib/avatar.js";
import Topbar from "../components/Topbar.jsx";
import PatientForm from "../components/PatientForm.jsx";
import NewPatientTransfersModal from "../components/NewPatientTransfersModal.jsx";
import { parsePatientFields } from "../lib/patientParse.js";
import { generateCsvTemplate, parsePatientCsv } from "../lib/patientCsv.js";
import { wardHeadcount } from "../lib/wardCensus.js";
import { reportWardKeysForPatientWard, patientWardAndBedTypeForReportKey } from "../lib/wardNameMatch.js";
import { WARDS } from "../lib/nurses-report-common.js";
import { loadWardPatients, loadIncomingTransfers, searchPatients, findPatientByEmrExact, nameSearchTokens } from "../lib/patientDirectory.js";
import { activeAdmissionTag, ADMISSION_TAG_LABEL, clearAdmissionTag, readmitLatestAdmission, READMIT_ELIGIBLE_TAGS, hasActiveAdmissionData } from "../lib/patientAdmissionStatus.js";
import { bumpShiftStatForPatientWard, bumpDemographicStatForPatientWard } from "../lib/shiftStatsSync.js";
import { WARD_OPTIONS } from "../lib/drugChartHelpers.js";
import { classifyAffiliation } from "../lib/patientAffiliation.js";

function normEmr(emr) { return (emr || '').trim().toLowerCase(); }

// Ward-list status badge for patients tagged DISCHARGE/TRANS OUT/DEATH/
// DAMA/ABSC by applyPatientStatus (see patientAdmissionStatus.js) but
// still on the ward roster, awaiting the ward nurse's closing report
// before closeOutDischargedPatient clears their ward field and drops
// them off this list. Reuses the same badge-* classes Overview.jsx/
// Admission.jsx already use for archived-admission status pills. For
// tags in READMIT_ELIGIBLE_TAGS (everything except DEATH — a transfer
// to another ward never sets dischargeStatus in the first place, see
// applyPatientStatus), also offers an inline Readmit action so a nurse
// doesn't have to open Overview and hunt for the archived admission.
const DISCHARGE_BADGE_CLASS = { 'DISCHARGE': 'badge-discharged', 'TRANS OUT': 'badge-referred', 'DEATH': 'badge-died', 'DAMA': 'badge-dama', 'ABSC': 'badge-absconded' };
function PendingDischargeBadge({ patient, busy, message, onReadmit }) {
  const status = patient.dischargeStatus;
  if (!status) return null;
  return (
    <>
      <br />
      <span className={"oi-badge " + (DISCHARGE_BADGE_CLASS[status] || 'badge-discharged')} style={{ fontSize: 12, padding: '2px 8px', marginTop: 2 }}>
        {status} — awaiting ward report
      </span>
      {READMIT_ELIGIBLE_TAGS.includes(status) && (
        <button
          className="oi-badge"
          style={{ fontSize: 12, padding: '2px 8px', marginTop: 2, marginLeft: 4, border: 'none', cursor: 'pointer', background: '#2563eb', color: '#fff' }}
          disabled={busy}
          onClick={(e) => { e.stopPropagation(); onReadmit(patient); }}
        >
          {busy ? 'Working…' : '\u21BA Readmit'}
        </button>
      )}
      {message && (
        <>
          <br />
          <span style={{ fontSize: 11, color: message.color }}>{message.text}</span>
        </>
      )}
    </>
  );
}

// Ward-list badge for a patient's recent-admission tag (NEW PATIENT / TRANS
// IN from A&E / TRANSFER REJECTED) — see activeAdmissionTag/ADMISSION_TAG_LABEL
// in patientAdmissionStatus.js. Shown the same way PendingDischargeBadge shows
// an exit status, so a nurse glancing at the ward list can see both a
// patient's arrival and their departure at a glance. TRANSFER_REJECTED gets
// its own badge-emergency-blink animation (hard red/amber flash, see
// styles.css) on top of its base color, so it stands out from the other,
// static admission tags — appends which ward rejected it, from
// transferRejectedByWard, when known. It's also the only one of these tags
// a nurse can tap to dismiss directly (stopping propagation so the tap
// doesn't also open the patient's chart) — the other two (NEW PATIENT /
// TRANS IN) are left tied to their existing write-up-linked clearing, since
// that's what confirms the arrival was actually acted on; a rejected
// transfer has no equivalent follow-up action to wait for, so requiring
// one before it can go away would just leave it blinking for no reason.
const ADMISSION_TAG_BADGE_CLASS = { AE_TRANSFER: 'badge-active', WARD_TRANSFER: 'badge-active', NEW_PATIENT: 'badge-active', TRANSFER_REJECTED: 'badge-transferred', READMITTED: 'badge-active' };
function AdmissionTagBadge({ patient }) {
  const tag = activeAdmissionTag(patient);
  if (!tag) return null;
  const label = tag === 'TRANSFER_REJECTED' && patient.transferRejectedByWard
    ? `TRANSFER REJECTED by ${patient.transferRejectedByWard}`
    : tag === 'WARD_TRANSFER' && patient.transferFromWard
      ? `TRANS IN from ${patient.transferFromWard}`
      : (ADMISSION_TAG_LABEL[tag] || tag);
  const dismissible = tag === 'TRANSFER_REJECTED';
  const blinkClass = dismissible ? ' badge-emergency-blink' : '';
  return (
    <>
      <br />
      <span
        className={"oi-badge " + (ADMISSION_TAG_BADGE_CLASS[tag] || 'badge-active') + blinkClass}
        style={{ fontSize: 12, padding: '2px 8px', marginTop: 2, cursor: dismissible ? 'pointer' : undefined }}
        title={dismissible ? 'Tap to dismiss' : undefined}
        onClick={dismissible ? (e) => { e.stopPropagation(); clearAdmissionTag(patient.id); } : undefined}
      >
        {label}
      </span>
    </>
  );
}

// Small tag shown just under a patient's diagnosis in the ward list so a
// nurse who doesn't yet know a patient by name can find them by bed number.
// hospNo is the same field edited as "Hospital Bed No" on PatientForm.
function BedTag({ patient }) {
  const bed = (patient.hospNo || '').trim();
  return (
    <span className={"patient-bed-tag" + (bed ? '' : ' patient-bed-tag-missing')}>
      Bed: {bed || 'not set'}
    </span>
  );
}

const EMPTY_FORM = { name: '', emr: '', diagnosis: '', ward: '', pedBedType: '', age: '', hospNo: '', admissionDate: '', allergies: '', insurance: '', gender: '', armyNumber: '' };

// Wards are stored/compared in ALL CAPS (matches WARD_OPTIONS); this is
// purely for display so headings don't shout at the reader.
function titleCase(str) {
  return (str || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function Home() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const searchInputRef = useRef(null);

  const [searchQuery, setSearchQuery] = useState('');
  // Just this ward's patients (see patientDirectory.js) — replaces what
  // used to be every patient in the hospital. null = still loading.
  const [myWardPatients, setMyWardPatients] = useState(null);
  const [incomingTransfers, setIncomingTransfers] = useState([]);
  // Cross-ward name/EMR search results — null when the search box is
  // empty (the patient list below falls back to myWardPatients then).
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  // EMR -> matched existing patient, resolved once per parsed bulk-upload
  // file (see handleBulkFile) instead of re-querying per row on every
  // render or during the actual save.
  const [bulkEmrMatches, setBulkEmrMatches] = useState(new Map());

  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY_FORM);
  const [newMsg, setNewMsg] = useState('');

  const [showEmrPaste, setShowEmrPaste] = useState(false);
  const [emrPasteText, setEmrPasteText] = useState('');
  const [emrParseMsg, setEmrParseMsg] = useState('');

  const [showTransfers, setShowTransfers] = useState(false);

  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkRows, setBulkRows] = useState(null); // null = no file parsed yet
  const [bulkMsg, setBulkMsg] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);

  const showExitToast = useExitOnDoubleBack();

  useEffect(() => {
    if (window.location.hash === '#search' && searchInputRef.current) {
      searchInputRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      searchInputRef.current.focus();
    }
    loadWardData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ward-to-ward transfers, new admissions, etc. are written by other
  // devices, so a plain load-on-mount only shows what existed when this
  // page opened. Poll quietly in the background so an incoming transfer
  // (or any other change) shows up within 30s without a manual reload.
  // Paused while the tab/app is backgrounded so it doesn't burn reads for
  // a screen nobody's looking at, and skipped while a form is open so a
  // background refresh can't blow away unsaved input.
  useEffect(() => {
    const POLL_MS = 30000;
    const pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (showNewForm || showBulkUpload || showEmrPaste) return;
      loadWardData(true);
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadWardData(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNewForm, showBulkUpload, showEmrPaste]);

  // Replaces the old getDocs(collection(db,'patients')) full-hospital
  // scan with two targeted queries scoped to just this nurse's ward (see
  // patientDirectory.js) — the day-to-day view doesn't need to touch any
  // other ward's patients at all, so this stays fast no matter how large
  // the hospital's total patient count grows. A profile with no ward set
  // (e.g. an admin account) now sees an empty list here rather than
  // everyone — the search box below is the way to find a specific
  // patient in that case.
  async function loadWardData(force) {
    if (myWardPatients && !force) return;
    const myWard = profile?.ward || '';
    const [wardList, incoming] = await Promise.all([
      loadWardPatients(myWard),
      loadIncomingTransfers(myWard)
    ]);
    setMyWardPatients(wardList);
    setIncomingTransfers(incoming);
  }

  // Readmit action inline on the ward list — cancels a DISCHARGE/TRANS
  // OUT/DAMA/ABSC exit and restores the most recent archived admission
  // back to active (see readmitLatestAdmission in patientAdmissionStatus.js),
  // without a nurse having to open Overview and find the record by hand.
  // Keyed by patient id so busy/status only affects the row that was tapped.
  const [readmitBusyId, setReadmitBusyId] = useState(null);
  const [readmitMsgs, setReadmitMsgs] = useState({});

  async function handleReadmit(p) {
    const patientName = (p.name || '').trim() || 'this patient';
    if (!confirm('Readmit ' + patientName + '?\n\nThis cancels the exit and restores the drug chart, vitals, glycemic chart, intake & output, and seizure chart from this admission back to active. Care continues from exactly where it left off.')) return;
    if (!navigator.onLine) {
      setReadmitMsgs((m) => ({ ...m, [p.id]: { color: '#b91c1c', text: 'This needs an internet connection to safely restore the archived record. Please try again once online.' } }));
      return;
    }
    setReadmitBusyId(p.id);
    setReadmitMsgs((m) => ({ ...m, [p.id]: { color: '#555', text: 'Working\u2026' } }));
    const result = await readmitLatestAdmission({ patientId: p.id, nurseName: profile?.name });
    setReadmitBusyId(null);
    if (!result.ok) {
      setReadmitMsgs((m) => ({ ...m, [p.id]: { color: '#b91c1c', text: result.message } }));
      return;
    }
    // cancelledPendingExit: the old exit was never closed out and a new
    // admission had already started for this patient — nothing was
    // restored, the stale exit tag was just cleared (see
    // readmitLatestAdmission in patientAdmissionStatus.js).
    setReadmitMsgs((m) => ({ ...m, [p.id]: { color: '#16a34a', text: result.cancelledPendingExit ? 'Exit cancelled \u2014 patient stays on the ward.' : 'Readmitted.' } }));
    // Refresh the visible list(s) so the DISCHARGE/etc. badge drops off
    // now that the patient is active again.
    loadWardData(true);
    const term = searchQuery.trim();
    if (term) searchPatients(term).then(setSearchResults);
  }

  // Debounced cross-ward search — fires a targeted, indexed query (see
  // searchPatients in patientDirectory.js) instead of filtering an
  // already-downloaded full patient list. Clearing the box drops back to
  // the myWardPatients view above.
  useEffect(() => {
    const term = searchQuery.trim();
    if (!term) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      searchPatients(term).then(setSearchResults).finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);


  function openPatient(p) {
    navigate('/patient?patient=' + p.id);
  }

  // --- Paste from EMR (bulk fill on patient registration) -------------------
  function parseEmrPaste() {
    setEmrParseMsg('');
    if (!emrPasteText.trim()) { setEmrParseMsg('Paste the patient\u2019s EMR text first.'); return; }
    const fields = parsePatientFields(emrPasteText);
    // Ward is deliberately never taken from the paste, even though
    // parsePatientFields extracts one: a "Ward:" line in a hospital
    // EMR page reflects that outside system's own on-file ward (often
    // the patient's last/formal ward from a previous stay), not which
    // ward this admission actually belongs to. The Ward field already
    // defaults to the admitting nurse's own ward the moment this form
    // opens (see the "+ New Patient" button below) — a paste silently
    // overwriting that with a stale ward from elsewhere is exactly how
    // a patient ends up admitted to the wrong ward.
    setNewForm((f) => ({
      ...f, // keep every field not touched by the paste (armyNumber, gender,
            // pedBedType, ...) intact — rebuilding the object from just the
            // pasted fields dropped them to undefined and crashed Save
            // Patient's later .trim() calls even though they were never
            // meant to be required.
      name: fields.name || f.name,
      emr: fields.emr || f.emr,
      diagnosis: fields.diagnosis || f.diagnosis,
      ward: f.ward,
      age: fields.age || f.age,
      hospNo: fields.hospNo || f.hospNo,
      admissionDate: fields.admissionDate || f.admissionDate,
      allergies: fields.allergies || f.allergies,
      insurance: fields.insurance || f.insurance
    }));
    const { ward: _unusedWard, ...countedFields } = fields;
    const foundCount = Object.values(countedFields).filter(Boolean).length;
    setEmrParseMsg(
      (foundCount ? 'Filled ' + foundCount + ' patient field(s).' : 'Could not find patient details in that text.') +
      ' Please review everything before saving.'
    );
  }
  function clearEmrPaste() { setShowEmrPaste(false); setEmrPasteText(''); setEmrParseMsg(''); }

  async function createPatient() {
    const name = newForm.name.trim();
    const emr = newForm.emr.trim();
    const gender = (newForm.gender || '').trim();
    setNewMsg('');
    if (!name || !emr) { setNewMsg('Name and EMR number are required.'); return; }
    // Gender drives the Patient Demographics table (see
    // bumpDemographicStatForPatientWard below, and the same guard in
    // patientAdmissionStatus.js / DrugCourseChart.jsx for
    // discharge/death/BID) — those bumps are silently skipped whenever
    // gender isn't 'M' or 'F', so a patient registered without it is
    // permanently invisible to that table for the rest of their stay.
    // Required here so that can't happen going forward.
    if (gender !== 'M' && gender !== 'F') { setNewMsg('Gender is required.'); return; }

    // Insurance and Army Number are deliberately NOT required here — an
    // empty Army Number and an empty Insurance both just mean "no match"
    // to classifyAffiliation() below, which is exactly what makes a
    // patient Civilian by default. Never add a blocking check on either
    // field; see patientAffiliation.js.
    try {

    // A patient already in the system under this EMR number shouldn't get
    // a second, duplicate record just because a different ward's nurse is
    // registering her as if new. Look up an existing record by EMR first:
    // - Genuinely on an active admission somewhere else right now →
    //   refuse and point at Transfer instead (same rule, and same
    //   message, as Readmit's own guard — see readmitLatestAdmission).
    // - No ward, or a ward left over from an admission that's already
    //   been closed out → not a duplicate in any way that matters; reuse
    //   that record and land it on this ward instead of creating a new
    //   one, so the same person doesn't end up as two separate patients
    //   in the system.
    // Best-effort: if the lookup itself fails (offline, etc.), fall
    // through and create normally rather than block registration on a
    // network hiccup.
    let existing = null;
    try {
      existing = await findPatientByEmrExact(emr);
    } catch (e) { /* fall through */ }

    // hasActiveAdmissionData is itself best-effort here too: if it throws
    // (e.g. a transient network/permissions error) we fall through and
    // register normally rather than leaving the Save button looking like
    // it did nothing.
    let blockedByActiveAdmission = false;
    if (existing && existing.ward && WARD_OPTIONS.includes(existing.ward)) {
      try {
        blockedByActiveAdmission = await hasActiveAdmissionData(existing.id);
      } catch (e) { /* fall through */ }
    }
    if (blockedByActiveAdmission) {
      setNewMsg('Patient on admission in ' + existing.ward + '. You can transfer the patient to the ward if need be.');
      return;
    }

    // Every field below is optional except Name and EMR (checked above) —
    // in particular Insurance and Army Number are never required, an
    // empty Army Number/Insurance is exactly what makes classifyAffiliation()
    // default a patient to Civilian. (f || '') guards each one so a form
    // field that ends up undefined (e.g. dropped by some future paste/autofill
    // path) can never crash the save the way it used to.
    const diagnosis = (newForm.diagnosis || '').trim();
    const ward = (newForm.ward || '').trim();
    const data = {
      name, emr,
      nameLower: name.toLowerCase(), emrLower: emr.toLowerCase(), nameTokens: nameSearchTokens(name),
      diagnosis, ward,
      pedBedType: ward === 'PEDIATRIC/NICU WARD' ? (newForm.pedBedType || '') : '',
      age: (newForm.age || '').trim(),
      hospNo: (newForm.hospNo || '').trim(), admissionDate: (newForm.admissionDate || '').trim(), allergies: (newForm.allergies || '').trim(),
      insurance: (newForm.insurance || '').trim(),
      gender: (newForm.gender || '').trim(),
      armyNumber: (newForm.armyNumber || '').trim(),
      updatedAt: serverTimestamp(),
      // Brand-new record, no transfer involved — tags this patient "NEW
      // PATIENT" (blue) on the ward's roster picker for 24h. See
      // ADMISSION_TAG_LABEL/activeAdmissionTag in patientAdmissionStatus.js.
      admissionSource: 'NEW_PATIENT', admissionSourceAt: serverTimestamp()
    };
    // Recomputed from Insurance/Army Number above, never chosen by hand —
    // see classifyAffiliation in patientAffiliation.js. This is what
    // decides the Military/Civilian half of the Patient Demographics
    // bump just below.
    data.militaryCivilian = classifyAffiliation(data);
    if (existing) {
      // Reusing an existing record: clear out anything left over from
      // its last exit so it reads as a clean, active admission again —
      // same fields readmitLatestAdmission clears on a normal readmit.
      data.dischargeStatus = ''; data.dischargeStatusAt = null; data.dischargeStatShiftRef = null;
    } else {
      data.createdAt = serverTimestamp();
      data.createdBy = user ? user.uid : null;
    }

    // Client-generated ID for a brand-new record — doc() needs no network
    // round trip, so the patient is usable immediately even offline. We
    // deliberately do NOT await setDoc(): with offline persistence
    // enabled, the write lands in the local IndexedDB cache
    // synchronously, but the returned Promise itself only resolves once
    // the device is back online and the backend acknowledges the write
    // (documented Firestore SDK behavior). Awaiting it here is exactly
    // what made "Save Patient" hang forever while offline — it queues
    // fine locally and syncs automatically on reconnect, so there's
    // nothing to wait for.
    const ref = existing ? doc(db, 'patients', existing.id) : doc(collection(db, 'patients'));
    setDoc(ref, data, { merge: !!existing }).catch((e) => {
      console.warn('Patient write queued locally; will retry once back online:', e);
    });

    // Shift Statistics: a brand-new registration counts as an Admission
    // on whichever ward the patient lands on, the moment it happens —
    // the automatic counterpart to a nurse typing this into
    // WardNurse.jsx's ShiftTable by hand. Best-effort; never blocks
    // registration. Reusing an existing (fully archived, or otherwise
    // not on any real active admission) record doesn't bump anything on
    // its old ward: a patient in that state doesn't belong to any ward,
    // so there's nowhere for them to be "leaving" — see
    // admitExistingPatientToWard in patientAdmissionStatus.js, which
    // this mirrors.
    bumpShiftStatForPatientWard(data.ward, data.pedBedType, 'adm', 1).catch(() => {});

    // Patient Demographics: the same registration, counted as one
    // Admission x Military/Civilian x Male/Female cell (see
    // DemographicsTable in WardNurse.jsx) instead of a nurse typing it
    // in by hand — only when a gender was actually recorded, since
    // there's no cell to bump otherwise.
    if (data.gender === 'M' || data.gender === 'F') {
      bumpDemographicStatForPatientWard(data.ward, data.pedBedType, 'adm', data.militaryCivilian, data.gender, 1).catch(() => {});
    }

    // Update the in-memory ward list directly instead of re-querying —
    // we already have the new patient's data, so this needs no round
    // trip while offline. Only shown here if it lands on the ward
    // currently in view; otherwise it'll turn up next time that ward's
    // list loads.
    if (data.ward === (profile?.ward || '')) {
      setMyWardPatients((prev) => prev ? [...prev, { id: ref.id, ...data }] : [{ id: ref.id, ...data }]);
    }
    setShowNewForm(false);
    setNewForm(EMPTY_FORM);
    clearEmrPaste();
    openPatient({ id: ref.id });
    } catch (e) {
      // Whatever went wrong, surface it instead of leaving Save Patient
      // looking unresponsive with no feedback — that silence is exactly
      // what made this bug hard to pin down.
      console.error('createPatient failed:', e);
      setNewMsg('Could not save patient: ' + (e && e.message ? e.message : 'unknown error') + '. Please try again.');
    }
  }

  // --- Bulk upload (CSV) --------------------------------------------------
  function downloadCsvTemplate() {
    const blob = new Blob([generateCsvTemplate()], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'patient-bulk-upload-template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleBulkFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file after a fix
    if (!file) return;
    setBulkFileName(file.name);
    setBulkMsg('');
    setBulkRows(null);
    setBulkEmrMatches(new Map());
    const reader = new FileReader();
    reader.onload = () => {
      const { headerOk, rows } = parsePatientCsv(String(reader.result || ''));
      if (!headerOk) {
        setBulkMsg('Couldn\u2019t read that file \u2014 make sure it has "Name" and "EMR Number" columns (download the template below if unsure).');
        setBulkRows([]);
        return;
      }
      if (!rows.length) {
        setBulkMsg('No patient rows found in that file.');
        setBulkRows([]);
        return;
      }
      setBulkRows(rows);
      const errorCount = rows.filter(r => r.errors.length).length;
      setBulkMsg(
        rows.length + ' row(s) found' +
        (errorCount ? ', ' + errorCount + ' with errors \u2014 fix or they\u2019ll be skipped.' : ', all look good.')
      );
      // Resolve every row's EMR against Firestore once, up front — one
      // indexed lookup per row instead of the old in-memory scan of a
      // fully-downloaded patient list. Both the preview table below and
      // saveBulkPatients read from this same resolved map, so a given
      // EMR is only looked up once per file, not once per render.
      const validRows = rows.filter(r => r.errors.length === 0 && r.data.emr);
      Promise.all(validRows.map((r) => findPatientByEmrExact(r.data.emr).then((p) => [normEmr(r.data.emr), p])))
        .then((pairs) => setBulkEmrMatches(new Map(pairs.filter(([, p]) => p))));
    };
    reader.onerror = () => setBulkMsg('Could not read that file.');
    reader.readAsText(file);
  }


  // Adds a CSV row's parsed drugs onto a patient's Drug Course Chart —
  // creating the chart doc if the patient doesn't have one yet, or
  // appending onto its existing `drugs` array (skipping anything that's an
  // exact name+route+frequency+duration repeat of a drug already on the
  // chart, so re-uploading the same CSV twice doesn't double up the list).
  async function addDrugsToChart(patientId, drugsParsed) {
    if (!drugsParsed || !drugsParsed.length) return 0;
    const ref = doc(db, 'patients', patientId, 'drugCourseChart', 'main');
    let existingDrugs = [];
    try {
      const snap = await getDoc(ref);
      if (snap.exists()) existingDrugs = Array.isArray(snap.data().drugs) ? snap.data().drugs : [];
    } catch (e) {
      console.warn('Could not read existing drug chart before merging bulk-uploaded drugs:', e);
    }
    const key = (d) => [d.name, d.route, d.frequency, d.duration].map(v => (v || '').trim().toLowerCase()).join('|');
    const existingKeys = new Set(existingDrugs.map(key));
    const dupOf = new Map(); // parsed id -> id of the identical drug already on the chart
    const existingByKey = new Map();
    let existingList = existingDrugs;
    existingDrugs.forEach((d, idx) => existingByKey.set(key(d), idx));
    drugsParsed.forEach(d => {
      if (!d.id || !existingKeys.has(key(d))) return;
      const idx = existingByKey.get(key(d));
      if (!existingList[idx].id) { existingList = existingList.slice(); existingList[idx] = { ...existingList[idx], id: d.id }; }
      dupOf.set(d.id, existingList[idx].id);
    });
    // A follow-on row whose predecessor was skipped as a duplicate must
    // point at the copy already on the chart, not the discarded one.
    const toAdd = drugsParsed
      .filter(d => !existingKeys.has(key(d)))
      .map(d => (d.startsAfterId && dupOf.has(d.startsAfterId)) ? { ...d, startsAfterId: dupOf.get(d.startsAfterId) } : d);
    if (!toAdd.length) return 0;
    const merged = [...existingList, ...toAdd];
    setDoc(ref, { drugs: merged, updatedAt: serverTimestamp() }, { merge: true }).catch((e) => {
      console.warn('Bulk-uploaded drugs write queued locally; will retry once back online:', e);
    });
    return toAdd.length;
  }

  async function saveBulkPatients() {
    if (profile?.role !== 'admin') { setBulkMsg('Only an admin can bulk upload patients.'); return; }
    const validRows = (bulkRows || []).filter(r => r.errors.length === 0);
    if (!validRows.length) { setBulkMsg('No valid rows to upload.'); return; }
    setBulkSaving(true);
    const created = [];
    let newCount = 0, updatedCount = 0, drugCount = 0;
    for (const r of validRows) {
      const existing = bulkEmrMatches.get(normEmr(r.data.emr));
      let patientId;
      if (existing) {
        // Same EMR Number as a patient already on file — recognized as the
        // same patient, so no duplicate patient record is created here.
        // Per the CSV note, a re-upload like this is treated as "drugs
        // only": the existing patient's own fields are left untouched.
        patientId = existing.id;
        updatedCount++;
      } else {
        const data = {
          name: r.data.name, emr: r.data.emr,
          nameLower: (r.data.name || '').trim().toLowerCase(), emrLower: (r.data.emr || '').trim().toLowerCase(), nameTokens: nameSearchTokens(r.data.name),
          diagnosis: r.data.diagnosis,
          ward: r.data.ward, pedBedType: r.data.ward === 'PEDIATRIC/NICU WARD' ? r.data.pedBedType : '',
          age: r.data.age, hospNo: r.data.hospNo, admissionDate: r.data.admissionDate,
          allergies: r.data.allergies, insurance: r.data.insurance,
          createdAt: serverTimestamp(), createdBy: user ? user.uid : null,
          // Same "NEW PATIENT" admission tag as the single Add Patient
          // form — only for rows creating a brand-new record; a row that
          // matched an existing patient by EMR (the `existing` branch
          // above) isn't a new admission and gets no tag.
          admissionSource: 'NEW_PATIENT', admissionSourceAt: serverTimestamp()
        };
        const ref = doc(collection(db, 'patients'));
        setDoc(ref, data).catch((e) => {
          console.warn('Bulk patient write queued locally; will retry once back online:', e);
        });
        // Shift Statistics — same automatic Admission bump as the single
        // Add Patient form above, one per newly-created row.
        bumpShiftStatForPatientWard(data.ward, data.pedBedType, 'adm', 1).catch(() => {});
        created.push({ id: ref.id, ...data });
        patientId = ref.id;
        newCount++;
      }
      if (r.data.drugsParsed && r.data.drugsParsed.length) {
        drugCount += await addDrugsToChart(patientId, r.data.drugsParsed);
      }
    }
    // Only the ones landing on the ward currently in view need adding to
    // myWardPatients directly — the rest will show up next time that
    // ward's own list loads.
    const myWard = profile?.ward || '';
    const onMyWard = created.filter((p) => p.ward === myWard);
    if (onMyWard.length) setMyWardPatients((prev) => prev ? [...prev, ...onMyWard] : onMyWard);
    setBulkSaving(false);
    setBulkMsg(
      newCount + ' new patient(s) created, ' + updatedCount + ' existing patient(s) matched by EMR' +
      (drugCount ? ', ' + drugCount + ' drug(s) added to their charts.' : '.')
    );
    setBulkRows(null);
    setBulkFileName('');
  }

  function clearBulkUpload() {
    setShowBulkUpload(false);
    setBulkRows(null);
    setBulkFileName('');
    setBulkMsg('');
  }

  const q = searchQuery.trim().toLowerCase();
  const myWard = profile?.ward || '';
  // Patients mid-transfer are excluded already, inside patientDirectory.js
  // (both loadWardPatients and searchPatients filter them out) — they
  // only show up in the receiving ward's "New Patient" queue below until
  // a nurse there accepts or rejects them. With a search query, the list
  // is searchResults (cross-ward, see the debounced effect above);
  // otherwise it's this ward's own list.
  const visiblePatients = q ? (searchResults || []) : (myWardPatients || []);
  const patientsLoaded = q ? searchResults !== null : myWardPatients !== null;
  // The count shown next to the heading. Where myWard has a matching
  // nurse-report ward (see reportWardKeysForPatientWard), it's that
  // ward's live Occ from today's Shift Statistics report — a split ward
  // like PEDIATRIC/NICU WARD sums both its report wards' Occ here, with
  // the per-ward breakdown rendered separately below. Wards with no
  // report equivalent (e.g. THEATER) fall back to the actual patient
  // headcount, same as before. Either way this is independent of any
  // active search filter above, and headcount is still what a matching
  // ward report's Previous Occ auto-fills from on shift handover.
  const reportWardKeys = reportWardKeysForPatientWard(myWard);
  const isSplitWard = reportWardKeys.length > 1;
  // Per report-ward-key count: the actual number of patients currently
  // registered on this ward in the app (not the shift report's Occ
  // figure), so the badge always matches the patient list right below
  // it. For a split ward (currently only PEDIATRIC/NICU WARD), each
  // key's headcount is further narrowed to patients whose pedBedType
  // matches that key's Bed/Cot side (see
  // patientWardAndBedTypeForReportKey) — patients with no pedBedType set
  // yet aren't counted on either side here, but still show up in the
  // "Bed/Cot not set" group in the list below. myWardPatients is already
  // scoped to this ward (see loadWardData above); wardHeadcount's own
  // ward filter here is just a no-op safety net.
  const wardBreakdown = reportWardKeys.map((k) => {
    const info = patientWardAndBedTypeForReportKey(k);
    const count = wardHeadcount(myWardPatients, myWard, info?.bedType);
    return { key: k, bedType: info?.bedType || null, count };
  });
  const wardPatientCount = reportWardKeys.length
    ? wardBreakdown.reduce((sum, x) => sum + x.count, 0)
    : wardHeadcount(myWardPatients, myWard);
  // Grouped view of the patient list for a split ward — Bed / Cot
  // sections plus an "unset" bucket, instead of one flat list, so the
  // list matches the per-key badges above it. Only makes sense for the
  // unfiltered "my ward" view; a cross-ward search stays a flat list.
  const pedGroups = isSplitWard && !q
    ? (() => {
        const groups = wardBreakdown.map((b) => ({
          ...b,
          label: (WARDS.find((w) => w.key === b.key) || {}).label || b.key,
          patients: visiblePatients.filter((p) => p.pedBedType === b.bedType)
        }));
        const assigned = new Set(groups.flatMap((g) => g.patients.map((p) => p.id)));
        const unassigned = visiblePatients.filter((p) => !assigned.has(p.id));
        return { groups, unassigned };
      })()
    : null;

  return (
    <>
      <Topbar brand="68 NARHY Ward Charts">
        <a className="whoami-link" onClick={(e) => { e.preventDefault(); navigate('/profile'); }} href="/profile">
          <span className="whoami-avatar" dangerouslySetInnerHTML={{ __html: profile ? avatarMarkup(profile, 32) : '' }} />
          <span className="whoami-name">{profile ? profile.name + ' (' + profile.role + ')' : ''}</span>
        </a>
        {profile?.role === 'admin' && (
          <a href="/admin" className="btn btn-purple" style={{ padding: '6px 12px' }} onClick={(e) => { e.preventDefault(); navigate('/admin'); }}>Admin</a>
        )}
        <a href="/my-patients" className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={(e) => { e.preventDefault(); navigate('/my-patients'); }}>My Patients</a>
        {myWard && (
          <a href="#" className="btn btn-secondary notif-bell-btn" style={{ padding: '6px 12px' }} onClick={(e) => { e.preventDefault(); setShowTransfers(true); }}>
            🔔 New Patient
            {incomingTransfers.length > 0 && <span className="notif-count-badge">{incomingTransfers.length}</span>}
          </a>
        )}
      </Topbar>

      <div className="container">
        <div className="card-box">
          <label>Search Patient (EMR number or name)</label>
          <div className="search-row">
            <input
              id="searchInput"
              ref={searchInputRef}
              type="text"
              placeholder="e.g. EMR12345 or John Doe"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button className="btn btn-primary" onClick={() => searchInputRef.current && searchInputRef.current.focus()}>Search</button>
            <button className="btn btn-success" onClick={() => { setNewForm((f) => ({ ...f, ward: f.ward || myWard })); setShowNewForm(true); }}>+ New Patient</button>
            {profile?.role === 'admin' && (
              <button className="btn btn-secondary" onClick={() => setShowBulkUpload(true)}>📁 Bulk Upload</button>
            )}
          </div>
        </div>

        {showBulkUpload && profile?.role === 'admin' && (
          <div className="card-box">
            <h3 style={{ marginTop: 0 }}>Bulk Upload Patients (CSV)</h3>
            <p style={{ fontSize: 12, color: '#555' }}>
              Upload a CSV of patients and they\u2019ll be created and sorted into their wards automatically \u2014
              same fields as the New Patient form, plus an optional Drugs column that\u2019s added straight to
              each patient\u2019s Drug Course Chart. Re-uploading with the same EMR Number and just the Drugs
              column filled in adds drugs to that existing patient instead of creating a duplicate. Not sure
              of the format? Download the template first.
            </p>
            <div style={{ marginBottom: 10 }}>
              <button className="btn btn-secondary" onClick={downloadCsvTemplate}>⬇ Download CSV Template</button>
            </div>
            <div className="field">
              <label>Choose CSV file</label>
              <input type="file" accept=".csv,text/csv" onChange={handleBulkFile} />
            </div>
            {bulkFileName && <div style={{ fontSize: 12, color: '#555' }}>{bulkFileName}</div>}
            {bulkMsg && <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>{bulkMsg}</div>}

            {bulkRows && bulkRows.length > 0 && (
              <div style={{ marginTop: 10, overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Line</th>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Name</th>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>EMR</th>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Ward</th>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Drugs</th>
                      <th style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map((r) => (
                      <tr key={r.line} style={r.errors.length ? { background: '#fef2f2' } : undefined}>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>{r.line}</td>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>{r.data.name || '—'}</td>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>{r.data.emr || '—'}</td>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>{r.data.ward || '—'}</td>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12 }}>
                          {r.data.drugsParsed && r.data.drugsParsed.length
                            ? r.data.drugsParsed.length + ' drug(s)'
                            : '—'}
                          {bulkEmrMatches.has(normEmr(r.data.emr)) && (
                            <div style={{ color: '#2563eb' }}>existing patient — drugs only</div>
                          )}
                        </td>
                        <td style={{ border: '1px solid #000', padding: 3, fontSize: 12, color: r.errors.length ? '#b91c1c' : '#16a34a' }}>
                          {r.errors.length ? r.errors.join('; ') : 'OK'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                  Rows in red have errors and will be skipped. Fix them in your CSV and re-upload if needed.
                </div>
              </div>
            )}

            <div style={{ marginTop: 10 }}>
              <button
                className="btn btn-primary"
                disabled={bulkSaving || !bulkRows || !bulkRows.some(r => r.errors.length === 0)}
                onClick={saveBulkPatients}
              >
                {bulkSaving ? 'Uploading…' : 'Upload Patients'}
              </button>
              <button className="btn btn-secondary" onClick={clearBulkUpload}>Cancel</button>
            </div>
          </div>
        )}

        {showNewForm && (
          <div className="card-box">
            <h3 style={{ marginTop: 0 }}>Register New Patient</h3>

            <button className="btn btn-secondary" style={{ marginBottom: 10 }} onClick={() => setShowEmrPaste((v) => !v)}>
              {showEmrPaste ? 'Hide Paste from EMR' : '📋 Paste from EMR'}
            </button>

            {showEmrPaste && (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginBottom: 14 }}>
                <label>Paste the patient's EMR page (header + notes) here</label>
                <textarea
                  rows={6}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
                  placeholder="Copy everything from the patient's EMR page and paste it here…"
                  value={emrPasteText}
                  onChange={(e) => setEmrPasteText(e.target.value)}
                />
                <div style={{ marginTop: 8 }}>
                  <button className="btn btn-primary" onClick={parseEmrPaste}>Parse</button>
                  <button className="btn btn-secondary" onClick={clearEmrPaste}>Clear</button>
                </div>
                {emrParseMsg && <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>{emrParseMsg}</div>}
              </div>
            )}

            <PatientForm form={newForm} setForm={setNewForm} />
            <button className="btn btn-primary" onClick={createPatient}>Save Patient</button>
            <button className="btn btn-secondary" onClick={() => { setShowNewForm(false); clearEmrPaste(); }}>Cancel</button>
            {newMsg && <div className="error-msg">{newMsg}</div>}
          </div>
        )}

        <div className="card-box">
          <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span>Patients on {myWard ? titleCase(myWard) : 'All Wards'} <span className="ward-count-badge">{wardPatientCount}</span></span>
            <a href="/profile" onClick={(e) => { e.preventDefault(); navigate('/profile'); }} style={{ fontSize: 12, fontWeight: 'normal' }}>
              {myWard ? 'Switch ward' : 'Set your ward'}
            </a>
          </h3>
          {isSplitWard && (
            <div className="ward-split-counts">
              {wardBreakdown.map(({ key: k, count }) => {
                const w = WARDS.find((x) => x.key === k);
                return (
                  <span className="ward-split-badge" key={k}>
                    {w ? w.label : k}<span className="ward-count-badge">{count}</span>
                  </span>
                );
              })}
            </div>
          )}
          <div className="search-results">
            {!patientsLoaded && (searching ? 'Searching…' : 'Loading patients…')}
            {patientsLoaded && visiblePatients.length === 0 && (
              <div className="error-msg">
                {q ? 'No patient matches that search.' :
                  (myWard ? 'No patients on ' + myWard + ' yet. Use "+ New Patient" to register one.' : 'No patients registered yet. Use "+ New Patient" to register one.')}
              </div>
            )}
            {patientsLoaded && visiblePatients.length > 0 && pedGroups && (
              <>
                {pedGroups.groups.map((g) => (
                  <div key={g.key} style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 'bold', fontSize: 13, margin: '8px 0 4px' }}>{g.label} ({g.patients.length})</div>
                    {g.patients.length === 0 && <div style={{ fontSize: 12, color: '#888' }}>No patients yet.</div>}
                    {g.patients.map(p => (
                      <div key={p.id} className="search-result-item" onClick={() => openPatient(p)}>
                        <span><b>{p.name || 'Unnamed'}</b>{'. '}EMR: {p.emr || 'N/A'}<AdmissionTagBadge patient={p} /><PendingDischargeBadge patient={p} busy={readmitBusyId === p.id} message={readmitMsgs[p.id]} onReadmit={handleReadmit} /></span>
                        <span className="patient-diagnosis-col">
                          <span>{p.diagnosis || ''}</span>
                          <BedTag patient={p} />
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
                {pedGroups.unassigned.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 'bold', fontSize: 13, margin: '8px 0 4px', color: '#b45309' }}>
                      Bed/Cot not set ({pedGroups.unassigned.length})
                    </div>
                    {pedGroups.unassigned.map(p => (
                      <div key={p.id} className="search-result-item" onClick={() => openPatient(p)}>
                        <span><b>{p.name || 'Unnamed'}</b>{'. '}EMR: {p.emr || 'N/A'}<AdmissionTagBadge patient={p} /><PendingDischargeBadge patient={p} busy={readmitBusyId === p.id} message={readmitMsgs[p.id]} onReadmit={handleReadmit} /></span>
                        <span className="patient-diagnosis-col">
                          <span>{p.diagnosis || ''}</span>
                          <BedTag patient={p} />
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {patientsLoaded && visiblePatients.length > 0 && !pedGroups && visiblePatients.map(p => (
              <div key={p.id} className="search-result-item" onClick={() => openPatient(p)}>
                <span><b>{p.name || 'Unnamed'}</b>{'. '}EMR: {p.emr || 'N/A'}{q && p.ward ? '. Ward: ' + p.ward : ''}<AdmissionTagBadge patient={p} /><PendingDischargeBadge patient={p} busy={readmitBusyId === p.id} message={readmitMsgs[p.id]} onReadmit={handleReadmit} /></span>
                <span className="patient-diagnosis-col">
                  <span>{p.diagnosis || ''}</span>
                  <BedTag patient={p} />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showTransfers && (
        <NewPatientTransfersModal
          ward={myWard}
          transfers={incomingTransfers}
          onClose={() => setShowTransfers(false)}
          onResolved={() => loadWardData(true)}
        />
      )}

      {showExitToast && (
        <div className="exit-toast no-print" role="status">Press back again to exit</div>
      )}
    </>
  );
}
