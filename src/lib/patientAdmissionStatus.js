import { collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { STATUS_LABELS, defaultRow } from "./drugChartHelpers.js";

function blankDrugs() { return Array(8).fill(null).map(() => ({ name: '', route: '', frequency: '', action: '', duration: '' })); }
function blankChartRows() { return Array(18).fill(null).map(() => defaultRow()); }

// The tag shown under a patient's name in the Ward Report's "Select from
// ward" picker (see WardPatientPicker in WardNurse.jsx) once they've been
// discharged or referred out — from *here*, from Patient.jsx's own status
// control, or from Drug Course Chart's inline duplicate of this flow
// (applyStatusAction in DrugCourseChart.jsx, which sets the same field —
// see ROSTER_TAG_FOR_REASON there). Deliberately not set for 'transferred':
// a ward transfer already has its own pendingTransfer marker and the
// patient is expected to keep appearing normally once accepted onto the
// receiving ward.
export const ROSTER_TAG_FOR_REASON = { discharged: 'DISCHARGE', referred: 'TRANS OUT' };

// Clears a patient's ward membership once their discharge/trans-out has
// been given a closing write-up and that Ward Report has been submitted
// (see submitReport in WardNurse.jsx) — the final step of the flow
// described on WardPatientPicker: the patient stays on the ward's picker,
// tagged DISCHARGE/TRANS OUT, so the nurse can tap their name and write
// that closing note, and only disappears from the roster once that note
// is actually submitted. Safe to call even if the patient was never
// tagged (e.g. a straight non-report discharge) — it's just a no-op wipe
// of fields that were already blank.
export async function closeOutDischargedPatient(patientId) {
  try {
    await updateDoc(doc(db, 'patients', patientId), {
      ward: '', pedBedType: '', dischargeStatus: '', dischargeStatusAt: null, updatedAt: serverTimestamp()
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.code || e.message || 'unknown error' };
  }
}

// The blue tag shown under a patient's name on the Ward Report's "Select
// from ward" picker (see WardPatientPicker in WardNurse.jsx) when they've
// recently arrived on the ward — either transferred in from Accident &
// Emergency (see acceptTransfer in wardTransfer.js, which sets this the
// moment a ward accepts a transfer whose fromWard was A&E) or freshly
// registered straight onto a ward with no transfer at all (see
// createPatient / saveBulkPatients in Home.jsx). `admissionSource` /
// `admissionSourceAt` live on the shared /patients doc, same as
// dischargeStatus — an admission recorded from either MHL or 68 shows up
// the same way on both. Unlike dischargeStatus, this never removes the
// patient from the roster (it's an admission, not an exit): it just stops
// showing, either after 24h or once a write-up for them is submitted
// through the Ward Report, whichever comes first — see activeAdmissionTag
// and clearAdmissionTag below.
export const ADMISSION_TAG_LABEL = { AE_TRANSFER: 'TRANS IN from A&E', NEW_PATIENT: 'NEW PATIENT' };

// Maps an admissionTag to the matching PATIENT_STATUS_OPTIONS string (see
// nurses-report-common.js) — these were already options on the write-up's
// own Status dropdown before this feature existed, just never set
// automatically. Used by selectPatientFromWard to pre-fill Status the
// same way it already does for dischargeStatus, so picking a tagged
// patient stamps their write-up correctly without the nurse having to
// pick it by hand.
export const ADMISSION_TAG_STATUS_STAMP = { AE_TRANSFER: 'TRANS IN FROM A&E', NEW_PATIENT: 'NEW PATIENT' };
const ADMISSION_TAG_WINDOW_MS = 24 * 60 * 60 * 1000;

function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'number') return v;
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return 0;
}

// Returns 'AE_TRANSFER' | 'NEW_PATIENT' | '' — '' once more than 24h have
// passed since admissionSourceAt, even if the fields are still set in
// Firestore (the 24h cutoff is just computed here on read each time,
// rather than needing a scheduled function to go clear it).
export function activeAdmissionTag(data) {
  if (!data || !data.admissionSource) return '';
  if (Date.now() - toMillis(data.admissionSourceAt) > ADMISSION_TAG_WINDOW_MS) return '';
  return data.admissionSource;
}

// Clears admissionSource/admissionSourceAt once a write-up linking to this
// patient has been submitted through the Ward Report — the other way (besides
// the 24h window) this tag disappears. Safe to call even if the patient was
// never tagged, or the tag already expired — just a no-op wipe of blank fields.
export async function clearAdmissionTag(patientId) {
  try {
    await updateDoc(doc(db, 'patients', patientId), {
      admissionSource: '', admissionSourceAt: null, updatedAt: serverTimestamp()
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.code || e.message || 'unknown error' };
  }
}

// Archives every chart for a patient's current admission (drug course
// chart, blood glucose, vitals, intake & output, seizure) into a new
// `admissions` record, then resets all of those charts blank so the next
// admission starts clean. Same operation DrugCourseChart.jsx's own
// "Patient Status" control performs, but reads the drug chart straight
// from Firestore instead of an open editor's in-memory state — safe to
// call from anywhere (e.g. the Patient page, where no chart is open),
// and just as correct when called right after DrugCourseChart's own
// saveChart() flushes pending edits, since Firestore's offline cache
// makes that read-after-write consistent even before the server
// round trip finishes.
export async function applyPatientStatus({ patientId, reason, transferWard, fromWard, transferredByName }) {
  let label = STATUS_LABELS[reason];
  let wardChosen = '';
  if (reason === 'transferred') {
    wardChosen = transferWard;
    if (!wardChosen) return { ok: false, message: 'Please select which ward the patient is being transferred to.' };
    label = 'Transferred to ' + wardChosen;

    // A ward transfer isn't a discharge: the patient's admission carries
    // on, just on a different ward, so none of the current charts (drug
    // course chart, vitals, blood glucose, intake & output, seizure)
    // get archived or reset here. We only park the patient in a
    // pendingTransfer for the receiving ward to accept. See
    // src/lib/wardTransfer.js's acceptTransfer, which now simply moves
    // `ward` over with everything else left untouched.
    try {
      await updateDoc(doc(db, 'patients', patientId), {
        pendingTransfer: {
          toWard: wardChosen,
          fromWard: fromWard || '',
          transferredByName: transferredByName || '',
          transferredAt: serverTimestamp(),
          transferredAtDisplay: new Date().toLocaleString()
        },
        updatedAt: serverTimestamp()
      });
    } catch (e) {
      return { ok: false, message: 'Could not start the transfer: ' + (e.code || e.message) };
    }
    return { ok: true, label, wardChosen };
  }

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

  const chartRef = doc(db, 'patients', patientId, 'drugCourseChart', 'main');
  let drugChartData = {
    f_admission: '', f_discharge: '', f_diagnosis: '',
    rows: [], drugs: [], verbalOrders: [], careInstructions: [], auditLog: []
  };
  try {
    const chartSnap = await getDoc(chartRef);
    if (chartSnap.exists()) {
      const d = chartSnap.data();
      drugChartData = {
        f_admission: d.f_admission || '', f_discharge: d.f_discharge || '', f_diagnosis: d.f_diagnosis || '',
        rows: d.rows || [], drugs: d.drugs || [], verbalOrders: d.verbalOrders || [],
        careInstructions: d.careInstructions || [], auditLog: d.auditLog || []
      };
    }
  } catch (e) { /* fine to archive with a blank drug chart if this fails */ }

  // Discharge Date is locked (readonly) so it can only ever be set here,
  // automatically, the moment the patient is actually discharged.
  let dischargeDate = drugChartData.f_discharge;
  if (reason === 'discharged' && !dischargeDate) {
    dischargeDate = new Date().toISOString().slice(0, 10);
  }

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

  const admissionDoc = {
    diagnosis: drugChartData.f_diagnosis,
    archiveReason: reason,
    archiveReasonLabel: label,
    archivedAt: serverTimestamp(),
    archivedAtDisplay: new Date().toLocaleString(),
    drugCourseChart: { ...drugChartData, f_discharge: dischargeDate },
    bloodGlucose: bgData,
    vitals: vitalsArr,
    intakeOutput: ioArr,
    intakeOutputSummary: ioSummary,
    seizure: seizureArr
  };

  try {
    await addDoc(collection(db, 'patients', patientId, 'admissions'), admissionDoc);
  } catch (e) {
    return { ok: false, message: 'Could not save to Overview: ' + (e.code || e.message) };
  }

  const blankDrugChart = {
    f_admission: '', f_discharge: '', f_diagnosis: '',
    rows: blankChartRows(), drugs: blankDrugs(),
    verbalOrders: [], careInstructions: [], auditLog: [],
    updatedAt: serverTimestamp()
  };

  try {
    await Promise.all([
      setDoc(chartRef, blankDrugChart), // full overwrite (no merge) so old data doesn't linger
      setDoc(doc(db, 'patients', patientId, 'bloodGlucose', 'main'), { chartType: '6point', rows6: [], rows3: [], updatedAt: serverTimestamp() }),
      setDoc(doc(db, 'patients', patientId, 'intakeOutputSummary', 'current'), { intake: 0, output: 0, balance: 0, periodDate: new Date().toISOString().slice(0, 10), updatedAt: serverTimestamp() }),
      clearEntries('vitals'), clearEntries('intakeOutput'), clearEntries('seizure'),
      // Tag the patient doc itself so the Ward Report's "Select from ward"
      // picker can flag them DISCHARGE/TRANS OUT for the nurse, even
      // though they stay on the roster (still keyed by `ward`) until a
      // closing report is submitted for them — see closeOutDischargedPatient.
      updateDoc(doc(db, 'patients', patientId), { dischargeStatus: ROSTER_TAG_FOR_REASON[reason] || '', dischargeStatusAt: serverTimestamp() })
    ]);
  } catch (e) {
    return { ok: false, archived: true, message: 'Archived, but could not fully reset the new charts: ' + (e.code || e.message) };
  }

  return { ok: true, label, wardChosen };
}
