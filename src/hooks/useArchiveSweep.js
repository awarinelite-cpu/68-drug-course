import { useEffect } from "react";
import { collection, doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";
import { WARDS, defaultWardDoc, reportDateId, reportPeriodLabel, weekId } from "../lib/nurses-report-common.js";

// Browser-side replacement for the old sweepClosedReports Cloud Function.
// When a signed-in nurse opens a report page (at most once per browser
// session per hour) it files any leftover submitted+locked ward reports for
// the period that just closed, then the overall report for that period.
// Both steps are idempotent: anything already archived is skipped, and
// firestore.rules only lets this create (never overwrite) archive docs.
const AUTO_BY = "Automatic archive (24hr)";

function dateIdMinusOneDay(dateId) {
  const [y, m, d] = dateId.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dt.getUTCDate()).padStart(2, "0");
}

async function archiveLeftoverWards(closedDateId, wid) {
  const fileName = reportPeriodLabel(closedDateId, "WARD");
  await Promise.all(WARDS.map(async (w) => {
    try {
      const wardRef = doc(db, "nurseReports", closedDateId, "wards", w.key);
      const wardSnap = await getDoc(wardRef);
      if (!wardSnap.exists()) return;
      const data = wardSnap.data();
      if (!data.submitted || !data.locked) return; // drafts are left alone
      const archiveRef = doc(db, "archives", "ward_" + w.key + "_" + closedDateId);
      if ((await getDoc(archiveRef)).exists()) return; // already filed
      // create-only; if another nurse got there first this is denied and we stop
      await setDoc(archiveRef, {
        type: "ward", wardKey: w.key, wardLabel: w.label, dateId: closedDateId, weekId: wid,
        fileName, data,
        archivedBy: AUTO_BY, archivedByUid: null,
        archivedAt: serverTimestamp(),
      });
      const closingOcc = typeof data.occ === "number" ? data.occ : 0;
      await setDoc(wardRef, defaultWardDoc(w, closingOcc));
    } catch (e) {
      console.warn("archive sweep (ward " + w.key + "):", e.code || e.message);
    }
  }));
}

async function archiveOverall(closedDateId, wid) {
  const overallRef = doc(db, "archives", "overall_" + closedDateId);
  if ((await getDoc(overallRef)).exists()) return;
  const wards = {};
  await Promise.all(WARDS.map(async (w) => {
    const archSnap = await getDoc(doc(db, "archives", "ward_" + w.key + "_" + closedDateId));
    if (archSnap.exists()) { wards[w.key] = archSnap.data().data; return; }
    const liveSnap = await getDoc(doc(db, "nurseReports", closedDateId, "wards", w.key));
    wards[w.key] = liveSnap.exists() ? liveSnap.data() : defaultWardDoc(w, 0);
  }));
  await setDoc(overallRef, {
    type: "overall", dateId: closedDateId, weekId: wid,
    fileName: reportPeriodLabel(closedDateId, "OVERALL"),
    wards,
    archivedBy: AUTO_BY, archivedByUid: null,
    archivedAt: serverTimestamp(),
  });
}

export async function runArchiveSweep() {
  const now = new Date();
  const closedDateId = dateIdMinusOneDay(reportDateId(now));
  const wid = weekId(now);
  await archiveLeftoverWards(closedDateId, wid);
  try { await archiveOverall(closedDateId, wid); }
  catch (e) { console.warn("archive sweep (overall):", e.code || e.message); }
}

export default function useArchiveSweep(user) {
  useEffect(() => {
    if (!user) return;
    const key = "archiveSweep:" + new Date().toISOString().slice(0, 13);
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch (e) { /* ignore */ }
    runArchiveSweep().catch((e) => console.warn("archive sweep:", e));
  }, [user]);
}
