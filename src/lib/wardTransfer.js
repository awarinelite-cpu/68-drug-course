import { doc, updateDoc, deleteField, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";

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
// records the sending ward was using.
export async function acceptTransfer(patientId, pendingTransfer) {
  await updateDoc(doc(db, 'patients', patientId), {
    ward: pendingTransfer.toWard,
    pendingTransfer: deleteField(),
    updatedAt: serverTimestamp()
  });
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
