// Quietly warms the Firestore local (IndexedDB) cache with the data a
// nurse is most likely to need offline, beyond whatever page they happen
// to land on. Firestore's persistentLocalCache only holds documents that
// have actually been read at least once — it does not pre-fetch anything
// on its own — so unless a nurse has specifically opened, say, the Ward
// Nurse report today, that data simply isn't cached yet and the page will
// come up empty if they lose connection before visiting it.
//
// This mirrors prefetchRoutes.js (same idle-callback + slow-connection
// skip), but warms Firestore reads instead of JS chunks:
//   - The nurse's own ward's patient list — covers a deep link straight
//     into a chart (bypassing Home.jsx's own fetch) and any ward switch.
//   - Today's nurseReports/{dateId}/wards collection — one read seeds the
//     cache for both this nurse's own Ward Nurse report doc AND the
//     compiled Overall Nurse table (same collection, just read by whoever
//     holds that role), whether or not either page has been opened yet.

import { collection } from "firebase/firestore";
import { db } from "../firebase.js";
import { getDocsSafe } from "./firestoreOffline.js";
import { reportDateId } from "./nurses-report-common.js";
import { loadWardPatients } from "./patientDirectory.js";

function isSlowConnection() {
  const conn =
    typeof navigator !== "undefined" &&
    (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
  if (!conn) return false;
  if (conn.saveData) return true;
  return conn.effectiveType === "slow-2g" || conn.effectiveType === "2g";
}

let hasRun = false;

export function prefetchReportData(profile) {
  if (hasRun) return;
  hasRun = true;

  if (isSlowConnection()) return;

  const requestIdle =
    (typeof window !== "undefined" && window.requestIdleCallback) ||
    ((cb) => setTimeout(cb, 2000));

  requestIdle(() => {
    if (profile?.ward) {
      loadWardPatients(profile.ward).catch(() => {
        // Offline or a transient error — harmless, the normal on-page
        // fetch will retry when something actually needs this data.
      });
    }
    getDocsSafe(collection(db, "nurseReports", reportDateId(), "wards")).catch(() => {});
  });
}
