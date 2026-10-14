import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getDocSafe } from "../lib/firestoreOffline.js";
import { db } from "../firebase.js";
import { weekId } from "../lib/nurses-report-common.js";

// The appointed Overall Nurse for the current report week as { name, phone },
// or null if nobody is appointed. The name is the live profile name when the
// profile is readable (falls back to the name stored on the appointment); the
// phone comes from the nurse's Profile page and may be empty.
export function useOverallNurseContact() {
  const [contact, setContact] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const unsub = onSnapshot(
      doc(db, "nurseReportRoles", weekId()),
      async (snap) => {
        const overall = snap.exists() ? snap.data().overallNurse : null;
        if (!overall || !overall.uid) { if (!cancelled) setContact(null); return; }
        let name = overall.name || '';
        let phone = '';
        try {
          const u = await getDocSafe(doc(db, "users", overall.uid));
          if (u && u.exists()) {
            const d = u.data();
            name = (d.name && d.name.trim()) || name;
            phone = d.phone || '';
          }
        } catch (e) { /* non-fatal: show the name without a phone */ }
        if (!cancelled) setContact({ name: name || 'Overall Nurse', phone });
      },
      () => { if (!cancelled) setContact(null); }
    );
    return () => { cancelled = true; unsub(); };
  }, []);

  return contact;
}
