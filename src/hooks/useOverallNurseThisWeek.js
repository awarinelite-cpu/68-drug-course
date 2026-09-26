import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { weekId } from "../lib/nurses-report-common.js";

// True while the signed-in user is the appointed Overall Nurse for the
// current report week (see nurseReportRoles/{weekId} written by
// OverallNurse.jsx's appointOverall()). Subscribes so a mid-week
// appointment/removal (or the Monday rollover) updates live without a
// refresh.
export function useOverallNurseThisWeek() {
  const { user } = useAuth();
  const [isOverall, setIsOverall] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsOverall(false);
      return;
    }
    const roleRef = doc(db, "nurseReportRoles", weekId());
    const unsub = onSnapshot(
      roleRef,
      (snap) => {
        const overall = snap.exists() ? snap.data().overallNurse : null;
        setIsOverall(!!(overall && overall.uid === user.uid));
      },
      () => setIsOverall(false)
    );
    return unsub;
  }, [user]);

  return isOverall;
}
