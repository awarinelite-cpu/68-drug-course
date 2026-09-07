import { collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { STATUS_LABELS, defaultRow } from "./drugChartHelpers.js";

function blankDrugs() { return Array(8).fill(null).map(() => ({ name: '', route: '', frequency: '', action: '', duration: '' })); }
function blankChartRows() { return Array(18).fill(null).map(() => defaultRow()); }

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
    transferWard: wardChosen || null,
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

  if (reason === 'transferred' && wardChosen) {
    // Don't move the patient onto the new ward yet — leave `ward` as-is
    // (the sending ward) and park them in a pendingTransfer instead. The
    // receiving ward's nurse sees them in their "New Patient" queue and
    // has to Accept (which finally sets ward: wardChosen) or Reject
    // (which just clears pendingTransfer, so the patient — having never
    // left `ward` — lands straight back on the sending ward's list with
    // nothing else to undo). See src/lib/wardTransfer.js.
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
      setDoc(chartRef, blankDrugChart), // full overwrite (no merge) so old data doesn't linger
      setDoc(doc(db, 'patients', patientId, 'bloodGlucose', 'main'), { chartType: '6point', rows6: [], rows3: [], updatedAt: serverTimestamp() }),
      setDoc(doc(db, 'patients', patientId, 'intakeOutputSummary', 'current'), { intake: 0, output: 0, balance: 0, periodDate: new Date().toISOString().slice(0, 10), updatedAt: serverTimestamp() }),
      clearEntries('vitals'), clearEntries('intakeOutput'), clearEntries('seizure')
    ]);
  } catch (e) {
    return { ok: false, archived: true, message: 'Archived, but could not fully reset the new charts: ' + (e.code || e.message) };
  }

  return { ok: true, label, wardChosen };
}
