// Targeted Firestore queries for the Home page's patient list, replacing
// what used to be one getDocs(collection(db,'patients')) — a full download
// of every patient in the hospital's shared record, every time Home
// loaded or polled. That was fine at a few hundred patients; at real EMR
// scale (tens of thousands) it becomes a slow, expensive read for a page
// that, day to day, only needs to show one nurse's own ward plus whatever
// she searches for. Every function here reads only what's actually needed:
//
//   - loadWardPatients      -> just this ward's patients (where ward == X)
//   - loadIncomingTransfers -> just transfers pending into this ward
//   - searchPatients        -> a name/EMR prefix search across the
//                              hospital, limited and indexed, instead of
//                              downloading everyone and filtering
//                              client-side
//   - findPatientByEmrExact -> one indexed lookup instead of a full scan
//
// Search relies on nameLower/emrLower fields written at patient creation
// (see Home.jsx) — lowercased copies of name/emr that Firestore can run a
// prefix range query against (it has no substring/"contains" search, only
// "starts with"). Records created before this existed won't have those
// fields yet; rebuildSearchIndex() below is the one-time, admin-triggered
// backfill for those older records (see Admin.jsx) — the only function
// here that still does a full collection scan, and only because it has
// to run once.
import { collection, query, where, orderBy, limit, getDocs, writeBatch, doc as fsDoc } from "firebase/firestore";
import { db } from "../firebase.js";

const SEARCH_LIMIT = 30;

function toRecord(d) {
  return { id: d.id, ...d.data() };
}

// All patients currently on one ward. Mid-transfer patients are excluded
// client-side — same rule the old in-memory filter used, since they
// aren't settled on either ward's census yet.
export async function loadWardPatients(wardLabel) {
  if (!wardLabel) return [];
  const snap = await getDocs(query(collection(db, "patients"), where("ward", "==", wardLabel)));
  return snap.docs.map(toRecord).filter((p) => !p.pendingTransfer);
}

// Patients with a transfer pending onto this ward — queries the nested
// pendingTransfer.toWard field directly rather than scanning every
// patient for one; Firestore indexes map subfields for equality
// automatically, so this needs no manual composite index.
export async function loadIncomingTransfers(wardLabel) {
  if (!wardLabel) return [];
  const snap = await getDocs(query(collection(db, "patients"), where("pendingTransfer.toWard", "==", wardLabel)));
  return snap.docs.map(toRecord);
}

// Cross-ward name/EMR lookup for the search box. Firestore can't do
// "contains X anywhere" without extra tooling (e.g. Algolia) — this does
// "starts with X" on both name and EMR, which covers typing a patient's
// name or EMR number from the start (the normal case) but won't find a
// mid-name substring the old in-memory .includes() search used to catch.
export async function searchPatients(term) {
  const t = (term || "").trim().toLowerCase();
  if (!t) return [];
  const upper = t + "\uf8ff";
  const [byName, byEmr] = await Promise.all([
    getDocs(query(collection(db, "patients"), orderBy("nameLower"), where("nameLower", ">=", t), where("nameLower", "<", upper), limit(SEARCH_LIMIT))),
    getDocs(query(collection(db, "patients"), orderBy("emrLower"), where("emrLower", ">=", t), where("emrLower", "<", upper), limit(SEARCH_LIMIT)))
  ]);
  const seen = new Map();
  [...byName.docs, ...byEmr.docs].forEach((d) => seen.set(d.id, toRecord(d)));
  return [...seen.values()].filter((p) => !p.pendingTransfer);
}

// One indexed exact-match lookup for EMR-paste / bulk-upload dedup,
// replacing a client-side scan of every patient's EMR field.
export async function findPatientByEmrExact(emr) {
  const norm = (emr || "").trim().toLowerCase();
  if (!norm) return null;
  const snap = await getDocs(query(collection(db, "patients"), where("emrLower", "==", norm), limit(1)));
  return snap.empty ? null : toRecord(snap.docs[0]);
}

// One-time, admin-triggered backfill: writes nameLower/emrLower onto any
// patient record created before those fields existed, so search actually
// finds them. This is the one function here that still does a full
// collection scan — deliberately manual (not a background job) so it
// runs once as a conscious action, not silently on a schedule. Returns
// how many records it updated.
export async function rebuildSearchIndex() {
  const snap = await getDocs(collection(db, "patients"));
  const stale = snap.docs.filter((d) => {
    const data = d.data();
    return (data.name && data.nameLower === undefined) || (data.emr && data.emrLower === undefined);
  });
  const BATCH_SIZE = 400; // Firestore's write-batch cap is 500 ops
  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    stale.slice(i, i + BATCH_SIZE).forEach((d) => {
      const data = d.data();
      const updates = {};
      if (data.name && data.nameLower === undefined) updates.nameLower = data.name.trim().toLowerCase();
      if (data.emr && data.emrLower === undefined) updates.emrLower = data.emr.trim().toLowerCase();
      batch.update(fsDoc(db, "patients", d.id), updates);
    });
    await batch.commit();
  }
  return stale.length;
}
