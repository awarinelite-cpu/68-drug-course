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
//   - searchPatients        -> a name/surname/EMR prefix search across the
//                              hospital, limited and indexed, instead of
//                              downloading everyone and filtering
//                              client-side
//   - findPatientByEmrExact -> one indexed lookup instead of a full scan
//
// Search relies on nameLower/emrLower/nameTokens fields written at patient
// creation and edit (see Home.jsx/Patient.jsx) — lowercased copies of
// name/emr, plus a token index for per-word search, that Firestore can run
// prefix/array-contains queries against (it has no substring/"contains"
// search, only "starts with" and exact array membership). Records created
// before these existed won't have them yet; rebuildSearchIndex() below is
// the one-time, admin-triggered backfill for those older records (see
// Admin.jsx) — the only function here that still does a full collection
// scan, and only because it has to run once.
import { collection, query, where, orderBy, limit, getDocs, writeBatch, doc as fsDoc } from "firebase/firestore";
import { db } from "../firebase.js";

const SEARCH_LIMIT = 30;

function toRecord(d) {
  return { id: d.id, ...d.data() };
}

// nameLower only supports "starts with the whole name" — fine for typing
// a patient's full name from the beginning, but names here are often
// "Rank Firstname Surname" or "Surname Firstname" with no fixed order, so
// searching just a surname (or just a given name, if it isn't the first
// word) never matched anything. This splits the name into words and, for
// each word, stores every prefix of it ("essien" -> "e", "es", "ess", ...,
// "essien") — so an array-contains query for whatever the nurse typed
// matches as soon as it's a prefix of *any* word in the name, regardless
// of where that word falls. Punctuation (ranks like "(RTD)") is stripped
// down to its letters/digits so it still indexes harmlessly.
export function nameSearchTokens(name) {
  const words = (name || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const prefixes = new Set();
  words.forEach((w) => { for (let i = 1; i <= w.length; i++) prefixes.add(w.slice(0, i)); });
  return [...prefixes];
}

// All patients currently on one ward. Mid-transfer patients are excluded
// client-side — same rule the old in-memory filter used, since they
// aren't settled on either ward's census yet.
export async function loadWardPatients(wardLabel) {
  if (!wardLabel) return [];
  const snap = await getDocs(query(collection(db, "patients"), where("ward", "==", wardLabel)));
  return snap.docs.map(toRecord).filter((p) => !p.pendingTransfer);
}

// Patients across several wards at once (e.g. Overall Nurse re-seeding
// several wards' census figures together) — one indexed query per unique
// ward label, run in parallel, instead of a getDocs(collection(db,
// 'patients')) full-hospital scan. Mid-transfer patients are excluded,
// same rule as loadWardPatients above. Callers that need per-ward
// headcounts (wardHeadcount from wardCensus.js) can filter the combined
// array down further by bedType themselves.
export async function loadPatientsForWardLabels(wardLabels) {
  const uniqueLabels = [...new Set((wardLabels || []).filter(Boolean))];
  if (!uniqueLabels.length) return [];
  const results = await Promise.all(
    uniqueLabels.map((label) =>
      getDocs(query(collection(db, "patients"), where("ward", "==", label)))
    )
  );
  const out = [];
  results.forEach((snap) => snap.forEach((d) => out.push(d.data())));
  return out.filter((p) => !p.pendingTransfer);
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

// Cross-ward name/surname/EMR lookup for the search box: matches on the
// whole name from its start (nameLower), on any individual word of the
// name from its start — first name, surname, rank, whichever the nurse
// types (nameTokens, see nameSearchTokens above) — or on the EMR number
// from its start (emrLower).
export async function searchPatients(term) {
  const t = (term || "").trim().toLowerCase();
  if (!t) return [];
  const upper = t + "\uf8ff";
  const [byName, byEmr, byToken] = await Promise.all([
    getDocs(query(collection(db, "patients"), orderBy("nameLower"), where("nameLower", ">=", t), where("nameLower", "<", upper), limit(SEARCH_LIMIT))),
    getDocs(query(collection(db, "patients"), orderBy("emrLower"), where("emrLower", ">=", t), where("emrLower", "<", upper), limit(SEARCH_LIMIT))),
    getDocs(query(collection(db, "patients"), where("nameTokens", "array-contains", t), limit(SEARCH_LIMIT)))
  ]);
  const seen = new Map();
  [...byName.docs, ...byEmr.docs, ...byToken.docs].forEach((d) => seen.set(d.id, toRecord(d)));
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

// One-time, admin-triggered backfill: writes nameLower/emrLower/nameTokens
// onto any patient record created before those fields existed, so search
// actually finds them. This is the one function here that still does a
// full collection scan — deliberately manual (not a background job) so it
// runs once as a conscious action, not silently on a schedule. Returns
// how many records it updated.
export async function rebuildSearchIndex() {
  const snap = await getDocs(collection(db, "patients"));
  const stale = snap.docs.filter((d) => {
    const data = d.data();
    return (data.name && data.nameLower === undefined) || (data.emr && data.emrLower === undefined) || (data.name && data.nameTokens === undefined);
  });
  const BATCH_SIZE = 400; // Firestore's write-batch cap is 500 ops
  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    stale.slice(i, i + BATCH_SIZE).forEach((d) => {
      const data = d.data();
      const updates = {};
      if (data.name && data.nameLower === undefined) updates.nameLower = data.name.trim().toLowerCase();
      if (data.emr && data.emrLower === undefined) updates.emrLower = data.emr.trim().toLowerCase();
      if (data.name && data.nameTokens === undefined) updates.nameTokens = nameSearchTokens(data.name);
      batch.update(fsDoc(db, "patients", d.id), updates);
    });
    await batch.commit();
  }
  return stale.length;
}
