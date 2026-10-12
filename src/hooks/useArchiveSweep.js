import { useEffect } from "react";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "../firebase.js";

// Replaces the old daily cron: archiving of the closed ward-day now runs only
// when a signed-in nurse opens a report page (a user action), at most once per
// browser session per hour.
export default function useArchiveSweep(user) {
  useEffect(() => {
    if (!user) return;
    const key = "archiveSweep:" + new Date().toISOString().slice(0, 13);
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch (e) { /* ignore */ }
    httpsCallable(getFunctions(app), "sweepClosedReports")().catch((e) => console.warn("archive sweep:", e));
  }, [user]);
}
