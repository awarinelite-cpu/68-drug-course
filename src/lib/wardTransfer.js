import { doc, updateDoc, deleteField, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { AE_WARD_LABEL } from "./drugChartHelpers.js";

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
  const updates = {
    ward: pendingTransfer.toWard,
    pendingTransfer: deleteField(),
    updatedAt: serverTimestamp()
  };
  if (pendingTransfer.toWard === 'PEDIATRIC/NICU WARD') updates.pedBedType = pedBedType || '';
  // Tag the receiving ward's roster picker blue for 24h — see
  // ADMISSION_TAG_LABEL/activeAdmissionTag in patientAdmissionStatus.js —
  // when this transfer originated on Accident & Emergency. An ordinary
  // ward-to-ward transfer (fromWard anything else) gets no admission tag;
  // the patient just reappears on the new ward's list normally.
  if (pendingTransfer.fromWard === AE_WARD_LABEL) {
    updates.admissionSource = 'AE_TRANSFER';
    updates.admissionSourceAt = serverTimestamp();
  }
  await updateDoc(doc(db, 'patients', patientId), updates);
}

// Rejecting (e.g. no bed space) just clears the pending transfer. The
// patient's `ward` field was never actually changed while pending, so
// they reappear on their original ward's list automatically — nothing
// else needs to be undone.
export async function rejectTransfer(patientId) {
  await updateDoc(doc(db, 'patients', patientId), {
    pendingTransfer: deleteField(),
    updatedAt: serverTimestamp()
  });
}
