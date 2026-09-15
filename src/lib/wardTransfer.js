import { doc, getDoc, updateDoc, deleteField, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { AE_WARD_LABEL } from "./drugChartHelpers.js";
import { bumpShiftStatForPatientWard } from "./shiftStatsSync.js";

// Returns the patients (from a caller's already-fetched patients list)
// currently pending transfer INTO the given ward — the "New Patient" queue
// a ward's nurse sees before choosing to accept or reject each one.
export function pendingTransfersFor(patients, ward) {
  if (!ward) return [];
  return (patients || []).filter(p => p.pendingTransfer && p.pendingTransfer.toWard === ward);
}

// Accepting moves the patient onto this ward for real. Their charts were
// never touched during the transfer (only a real discharge/referral
// archives and resets them), so this is just the ward reassignment the
// receiving nurse has been holding off on — care continues on the same
// drug course chart, vitals, blood glucose, intake & output, and seizure
// records the sending ward was using. `pedBedType` ('Bed' | 'Cot') is
// only relevant when accepting into PEDIATRIC/NICU WARD — see
// NewPatientTransfersModal, which is the only caller that passes it.
export async function acceptTransfer(patientId, pendingTransfer, pedBedType) {
  // Needed to resolve the *sending* ward's Shift Statistics key below —
  // pedBedType (the function argument) only ever describes the
  // *receiving* ward's Bed/Cot split (see the caller comment above), so
  // if the patient was leaving PAED BED/COT the sending side needs their
  // pre-transfer bed type, read here before it's overwritten.
  let priorPedBedType = '';
  try {
    const snap = await getDoc(doc(db, 'patients', patientId));
    if (snap.exists()) priorPedBedType = snap.data().pedBedType || '';
  } catch (e) { /* fine to skip the automatic stat bump below if this fails */ }

  const updates = {
    ward: pendingTransfer.toWard,
    pendingTransfer: deleteField(),
    updatedAt: serverTimestamp()
  };
  if (pendingTransfer.toWard === 'PEDIATRIC/NICU WARD') updates.pedBedType = pedBedType || '';
  // Tag the receiving ward's roster blue for 24h so the accepting nurse
  // actually notices a new arrival — see ADMISSION_TAG_LABEL/
  // activeAdmissionTag in patientAdmissionStatus.js. Every accepted
  // transfer gets tagged now, not just ones originating on A&E: AE
  // origin keeps the existing 'AE_TRANSFER' tag (labelled "TRANS IN
  // from A&E"), and any other origin ward gets the generic
  // 'WARD_TRANSFER' tag, with transferFromWard recording which ward it
  // came from so the badge can say "TRANS IN from <ward>".
  updates.admissionSource = pendingTransfer.fromWard === AE_WARD_LABEL ? 'AE_TRANSFER' : 'WARD_TRANSFER';
  updates.admissionSourceAt = serverTimestamp();
  updates.transferFromWard = pendingTransfer.fromWard || '';
  await updateDoc(doc(db, 'patients', patientId), updates);

  // Shift Statistics: acceptance is the moment the patient actually
  // leaves the sending ward's roster and joins the receiving ward's, so
  // that's when the internal Transfer Out / Transfer In columns count it
  // — not when the transfer was merely started (see applyPatientStatus
  // in patientAdmissionStatus.js, which deliberately doesn't bump
  // anything for reason: 'transferred'). Best-effort; the transfer
  // itself already succeeded above.
  bumpShiftStatForPatientWard(pendingTransfer.fromWard, priorPedBedType, 'transferOut', 1).catch(() => {});
  bumpShiftStatForPatientWard(pendingTransfer.toWard, pedBedType, 'transferIn', 1).catch(() => {});
}

// Rejecting (e.g. no bed space) clears the pending transfer. The
// patient's `ward` field was never actually changed while pending, so
// they reappear on their original ward's list automatically — but with
// nothing else, the sending ward would have no way to tell "rejected"
// apart from "nobody's looked at it yet". Tagging admissionSource here
// reuses the same TRANS IN/NEW PATIENT mechanism from patientAdmissionStatus.js
// (AdmissionTagBadge in Home.jsx) to surface a visible tag on the patient's
// card — self-clearing after 24h or on the next Ward Report write-up,
// same as those other tags. transferRejectedByWard records which ward
// rejected it, so the badge can say who instead of just "rejected".
export async function rejectTransfer(patientId, pendingTransfer) {
  await updateDoc(doc(db, 'patients', patientId), {
    pendingTransfer: deleteField(),
    admissionSource: 'TRANSFER_REJECTED',
    admissionSourceAt: serverTimestamp(),
    transferRejectedByWard: (pendingTransfer && pendingTransfer.toWard) || '',
    updatedAt: serverTimestamp()
  });
}
