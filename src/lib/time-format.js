// System-wide clock format (12-hour with AM/PM, or 24-hour). Admin-only
// control on the Admin page; every page that displays a time reads this
// live via Firestore so a change takes effect everywhere — for every nurse,
// on every device — without anyone needing to reload.
//
// Single doc at settings/system, same "one ward, one shared policy" pattern
// as settings/alarm in alarm-settings.js. Kept as a plain module-level
// singleton (not just a React hook) because several callers — export.js,
// drugChartHelpers.js, patientAdmissionStatus.js — are ordinary lib
// functions, not components, and need to read the current format
// synchronously when building a display string.
import { useEffect, useState } from "react";
import { doc, setDoc, onSnapshot, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase.js";

export const TIME_SETTINGS_DOC_PATH = ["settings", "system"];

const CACHE_KEY = "wardcharts-time-format";
const DEFAULT_FORMAT = "24";

function getCachedFormat() {
  try {
    const saved = localStorage.getItem(CACHE_KEY);
    return saved === "12" || saved === "24" ? saved : DEFAULT_FORMAT;
  } catch (e) {
    return DEFAULT_FORMAT;
  }
}

let currentFormat = getCachedFormat();
const listeners = new Set();

function setCurrentFormat(next) {
  if (next === currentFormat) return;
  currentFormat = next;
  try {
    localStorage.setItem(CACHE_KEY, next);
  } catch (e) {
    /* ignore */
  }
  listeners.forEach((fn) => fn(currentFormat));
}

let watching = false;
function ensureWatching() {
  if (watching || !db) return;
  watching = true;
  onSnapshot(
    doc(db, ...TIME_SETTINGS_DOC_PATH),
    (snap) => {
      const val = snap.exists() ? snap.data().timeFormat : null;
      setCurrentFormat(val === "12" ? "12" : DEFAULT_FORMAT);
    },
    () => {
      // Offline, no permission yet, doc doesn't exist, etc. — keep
      // whatever was already cached rather than breaking every
      // timestamp in the app.
    }
  );
}
ensureWatching();

export function getTimeFormat() {
  return currentFormat;
}
export function is12Hour() {
  return currentFormat === "12";
}

export function subscribeTimeFormat(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function setTimeFormat(next) {
  const clean = next === "12" ? "12" : "24";
  setCurrentFormat(clean);
  await setDoc(
    doc(db, ...TIME_SETTINGS_DOC_PATH),
    { timeFormat: clean, updatedAt: serverTimestamp() },
    { merge: true }
  );
  return clean;
}

// For components that display a time during render (not just inside a
// click handler) — call this so the component re-renders when an admin
// changes the setting elsewhere. The return value itself isn't needed;
// formatTime()/formatDateTime() below always read the live singleton.
export function useTimeFormat() {
  const [format, setFormat] = useState(currentFormat);
  useEffect(() => {
    ensureWatching();
    return subscribeTimeFormat(setFormat);
  }, []);
  return format;
}

// Accepts a Date, a Firestore Timestamp (anything with .toDate()), an ISO
// string, or an epoch number — every shape that shows up across the app's
// various "at"/"exportedAt"/"archivedAtDisplay" style fields.
function toDateSafe(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") {
    try {
      return value.toDate();
    } catch (e) {
      return null;
    }
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Drop-in replacement for `date.toLocaleTimeString()` that respects the
// admin's chosen system time format instead of the browser's locale default.
export function formatTime(value, opts = {}) {
  const d = toDateSafe(value);
  if (!d) return "";
  return d.toLocaleTimeString([], {
    hour: opts.hour || "2-digit",
    minute: "2-digit",
    ...(opts.seconds ? { second: "2-digit" } : {}),
    hour12: is12Hour()
  });
}

// Drop-in replacement for `date.toLocaleString()` — date portion always
// follows the browser locale (day/month order etc.); only the time portion
// switches between 12-hour AM/PM and 24-hour.
export function formatDateTime(value, opts = {}) {
  const d = toDateSafe(value);
  if (!d) return "";
  const datePart = d.toLocaleDateString(
    [],
    opts.dateStyle ? { dateStyle: opts.dateStyle } : { month: "short", day: "numeric", ...(opts.year ? { year: "numeric" } : {}) }
  );
  return datePart + " " + formatTime(d, opts);
}
