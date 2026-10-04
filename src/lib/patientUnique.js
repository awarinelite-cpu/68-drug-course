import { doc, getDoc, getDocs, collection, writeBatch, serverTimestamp, updateDoc, setDoc, deleteDoc } from "firebase/firestore";
import { db } from "../firebase.js";

// ── One patient record per EMR number, enforced by the database ───────────
// /emrIndex/{key} holds exactly one document per EMR number, pointing at the
// patient that owns it. A new patient is written in the SAME batch as its
// index document, and firestore.rules only lets an index document be created
// once — so if two nurses register the same EMR at the same moment (or one is
// offline and syncs later), the second batch is rejected as a whole and no
// second record is ever stored. A lookup/query-then-create check can't give
// that guarantee on its own: two devices can both "see nothing" and both
// create.

// Lowercased, all whitespace removed — "129426", " 129426 " and "129 426"
// are the same EMR.
export function emrKeyOf(emr) {
  return String(emr == null ? "" : emr).replace(/\s+/g, "").toLowerCase();
}
export function emrIndexIdOf(emr) {
  const key = emrKeyOf(emr);
  return key ? "e_" + encodeURIComponent(key) : "";
}
export function emrIndexRef(emr) {
  const id = emrIndexIdOf(emr);
  return id ? doc(db, "emrIndex", id) : null;
}

// Who owns this EMR right now? → { patientId } or null. Ignores an index
// entry whose patient no longer exists (a stale leftover).
export async function lookupEmrOwner(emr) {
  const ref = emrIndexRef(emr);
  if (!ref) return null;
  const idx = await getDoc(ref);
  if (!idx.exists()) return null;
  const patientId = idx.data().patientId;
  if (!patientId) return null;
  const p = await getDoc(doc(db, "patients", patientId));
  return p.exists() ? { patientId, patient: { id: p.id, ...p.data() } } : null;
}

// Create a brand-new patient + its index entry atomically. Like the rest of
// the app's registration it does NOT make the caller wait on the network
// (offline registration still works — the batch syncs later). If the server
// turns it down because someone else already holds the EMR, `onDuplicate`
// gets the id of the existing patient and nothing is saved.
export function createPatientUnique(ref, data, onDuplicate) {
  const key = emrKeyOf(data.emr);
  data.emrKey = key;
  if (!key) {
    setDoc(ref, data).catch((e) => console.warn("Patient write queued locally; will retry once back online:", e));
    return;
  }
  const batch = writeBatch(db);
  batch.set(ref, data);
  batch.set(emrIndexRef(data.emr), { patientId: ref.id, emr: data.emr, key, createdAt: serverTimestamp() });
  batch.commit().catch(async (e) => {
    if (!e || e.code !== "permission-denied") {
      console.warn("Patient write queued locally; will retry once back online:", e);
      return;
    }
    // Either a genuine duplicate, or the EMR-index rules aren't deployed yet.
    let owner = null;
    try { owner = await lookupEmrOwner(data.emr); } catch (err) { /* fall through */ }
    if (owner && owner.patientId !== ref.id) {
      if (typeof onDuplicate === "function") onDuplicate(owner.patientId, owner.patient);
      return;
    }
    // Rules not deployed yet: save the patient the old way rather than lose it.
    console.warn("emrIndex rules not deployed — saving patient without the uniqueness guard.");
    setDoc(ref, data).catch((err) => console.warn("Patient write failed:", err));
  });
}

// Change a patient's fields, including a possible EMR correction, keeping the
// index in step. Returns { ok:true } or { ok:false, message }.
export async function updatePatientWithEmr(patientId, oldEmr, newEmr, updates) {
  const oldKey = emrKeyOf(oldEmr);
  const newKey = emrKeyOf(newEmr);
  const patientRef = doc(db, "patients", patientId);
  if (oldKey === newKey) {
    updateDoc(patientRef, { ...updates, emrKey: newKey }).catch((e) => console.warn("Patient edit queued locally; will retry once back online:", e));
    return { ok: true };
  }
  try {
    const owner = await lookupEmrOwner(newEmr);
    if (owner && owner.patientId !== patientId) {
      return { ok: false, message: "EMR " + newEmr + " already belongs to " + (owner.patient.name || "another patient") + (owner.patient.ward ? " (" + owner.patient.ward + ")" : "") + ". Open that record instead of changing this one." };
    }
  } catch (e) { /* offline: the rules still protect it when it syncs */ }
  const batch = writeBatch(db);
  batch.update(patientRef, { ...updates, emrKey: newKey });
  if (newKey) batch.set(emrIndexRef(newEmr), { patientId, emr: newEmr, key: newKey, createdAt: serverTimestamp() });
  if (oldKey) {
    try {
      const oldIdx = await getDoc(emrIndexRef(oldEmr));
      if (oldIdx.exists() && oldIdx.data().patientId === patientId) batch.delete(emrIndexRef(oldEmr));
    } catch (e) { /* ignore */ }
  }
  // Offline: like every other write in the app, queue it and don't make the
  // nurse wait (the rules still guard it when it syncs).
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    batch.commit().catch((e) => console.warn("Patient edit queued locally; will retry once back online:", e));
    return { ok: true };
  }
  try {
    await batch.commit();
    return { ok: true };
  } catch (e) {
    if (e && e.code === "permission-denied") {
      let owner = null;
      try { owner = await lookupEmrOwner(newEmr); } catch (err) { /* ignore */ }
      if (owner && owner.patientId !== patientId) return { ok: false, message: "EMR " + newEmr + " already belongs to another patient (" + (owner.patient.name || "unnamed") + ")." };
      // rules not deployed yet — fall back to the plain edit
      updateDoc(patientRef, { ...updates, emrKey: newKey }).catch(() => {});
      return { ok: true };
    }
    return { ok: false, message: "Could not save: " + (e.code || e.message || "unknown error") };
  }
}

// Drop the index entry for a patient that's being deleted (only if it is theirs).
export async function releaseEmrIndex(patientId, emr) {
  const ref = emrIndexRef(emr);
  if (!ref) return;
  try {
    const idx = await getDoc(ref);
    if (idx.exists() && idx.data().patientId === patientId) await deleteDoc(ref);
  } catch (e) { /* best effort */ }
}

// Admin: one-off backfill so patients registered before this existed are
// protected too. Skips EMR numbers that still have duplicate records (merge
// those first). Returns { indexed, skippedDuplicates, alreadyIndexed }.
export async function buildEmrIndex() {
  const snap = await getDocs(collection(db, "patients"));
  const byKey = {};
  snap.forEach((d) => {
    const k = emrKeyOf(d.data().emr);
    if (k) (byKey[k] = byKey[k] || []).push(d);
  });
  let indexed = 0, skippedDuplicates = 0, alreadyIndexed = 0;
  const entries = Object.entries(byKey);
  for (let i = 0; i < entries.length; i += 200) {
    const batch = writeBatch(db);
    let ops = 0;
    for (const [key, docs] of entries.slice(i, i + 200)) {
      if (docs.length > 1) { skippedDuplicates++; continue; }
      const d = docs[0];
      const idxRef = doc(db, "emrIndex", "e_" + encodeURIComponent(key));
      const idx = await getDoc(idxRef);
      if (idx.exists()) { alreadyIndexed++; if (d.data().emrKey !== key) { batch.update(d.ref, { emrKey: key }); ops++; } continue; }
      batch.set(idxRef, { patientId: d.id, emr: d.data().emr, key, createdAt: serverTimestamp() });
      batch.update(d.ref, { emrKey: key });
      ops += 2; indexed++;
    }
    if (ops) await batch.commit();
  }
  return { indexed, skippedDuplicates, alreadyIndexed };
}

// After merging duplicates: make the index point at the record that was kept.
export async function pointEmrIndexAt(patientId, emr) {
  const ref = emrIndexRef(emr);
  if (!ref) return;
  const key = emrKeyOf(emr);
  const cur = await getDoc(ref);
  if (!cur.exists() || cur.data().patientId !== patientId) {
    await setDoc(ref, { patientId, emr, key, createdAt: serverTimestamp() });
  }
  await updateDoc(doc(db, "patients", patientId), { emrKey: key });
}
