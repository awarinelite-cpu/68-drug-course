// Shared alarm configuration (sound / appearance / repeat / quiet hours /
// which frequencies alert) used by both Admin.jsx (writes the config) and
// lib/push.js (reads it to drive the actual foreground alarm). Also read by
// functions/index.js (server-side copy of the same constants, since Cloud
// Functions can't import browser ES modules) for quiet-hours suppression and
// frequency filtering.
//
// Single doc at settings/alarm — one ward, one alarm policy, so no need for
// a whole collection.
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp } from "firebase/firestore";

export const SETTINGS_DOC_PATH = ["settings", "alarm"];

// Every frequency the server's due-dose scheduler knows how to compute a
// next-dose time for (functions/index.js INTERVAL_HOURS) — kept in sync
// with that list by hand since Cloud Functions can't import this file.
export const ALL_FREQUENCIES = ["OD", "Mane", "Nocte", "HS", "BD", "TDS", "QDS", "QOD", "Q4H", "Q6H", "Q8H", "Q12H", "Weekly", "STAT then Q4H", "STAT then Q6H", "STAT then Q8H", "STAT then Q12H"];

export const SOUND_OPTIONS = [
  { value: "beep", label: "Classic Beep" },
  { value: "chime", label: "Soft Chime" },
  { value: "siren", label: "Siren" },
  { value: "urgent", label: "Urgent Triple" }
];

export const APPEARANCE_OPTIONS = [
  { value: "banner_sound", label: "Banner + Sound" },
  { value: "sound_only", label: "Sound Only" },
  { value: "banner_only", label: "Banner Only (silent)" },
  { value: "vibrate", label: "Banner + Vibrate (no sound)" }
];

export const REPEAT_OPTIONS = [
  { value: "repeat", label: "Repeat until dismissed" },
  { value: "once", label: "Single alert (no repeat)" }
];

// How long after a patient's last recorded glucose reading before the next
// one is considered "due" — unlike drugs, the glycemic chart has no
// per-entry frequency field, so this is one ward-wide interval rather than
// a per-row setting.
export const GLUCOSE_INTERVAL_OPTIONS = [
  { value: 1, label: "Every 1 hour" },
  { value: 2, label: "Every 2 hours" },
  { value: 3, label: "Every 3 hours" },
  { value: 4, label: "Every 4 hours" },
  { value: 6, label: "Every 6 hours" },
  { value: 8, label: "Every 8 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Every 24 hours" }
];

// How often the SERVER re-sends a push for a dose that's still overdue
// (due time passed, but no new administration row logged yet). This is
// separate from "Repeat Behavior" above, which only controls whether an
// *already-delivered* alert keeps sounding/vibrating in an open foreground
// tab for up to 60s — it has no effect on whether the background Cloud
// Function (functions/index.js checkDueDrugs) sends another push later.
// Without this, a dose that goes due and isn't given only ever triggers one
// push, ever, for that dose.
export const OVERDUE_REPEAT_OPTIONS = [
  { value: 5, label: "Every 5 minutes" },
  { value: 10, label: "Every 10 minutes" },
  { value: 15, label: "Every 15 minutes" },
  { value: 20, label: "Every 20 minutes" },
  { value: 30, label: "Every 30 minutes" },
  { value: 60, label: "Every 60 minutes" }
];

export const DEFAULT_ALARM_SETTINGS = {
  sound: "beep",
  appearance: "banner_sound",
  repeat: "repeat",
  quietHours: { enabled: false, start: "22:00", end: "06:00" },
  frequencies: ALL_FREQUENCIES.slice(),
  glucose: { enabled: true, intervalHours: 4 },
  overdueRepeatMinutes: 15
};

// Merges Firestore data over the defaults field-by-field, so a doc that
// predates a newly-added setting (or is missing entirely) still comes back
// fully populated rather than leaving callers to guess at undefined fields.
function mergeWithDefaults(data) {
  const d = data || {};
  const validIntervals = GLUCOSE_INTERVAL_OPTIONS.map((o) => o.value);
  const glucoseIntervalHours = validIntervals.includes(Number(d.glucose && d.glucose.intervalHours))
    ? Number(d.glucose.intervalHours)
    : DEFAULT_ALARM_SETTINGS.glucose.intervalHours;
  const validRepeatMinutes = OVERDUE_REPEAT_OPTIONS.map((o) => o.value);
  const overdueRepeatMinutes = validRepeatMinutes.includes(Number(d.overdueRepeatMinutes))
    ? Number(d.overdueRepeatMinutes)
    : DEFAULT_ALARM_SETTINGS.overdueRepeatMinutes;
  return {
    sound: d.sound || DEFAULT_ALARM_SETTINGS.sound,
    appearance: d.appearance || DEFAULT_ALARM_SETTINGS.appearance,
    repeat: d.repeat || DEFAULT_ALARM_SETTINGS.repeat,
    quietHours: {
      enabled: !!(d.quietHours && d.quietHours.enabled),
      start: (d.quietHours && d.quietHours.start) || DEFAULT_ALARM_SETTINGS.quietHours.start,
      end: (d.quietHours && d.quietHours.end) || DEFAULT_ALARM_SETTINGS.quietHours.end
    },
    frequencies: Array.isArray(d.frequencies) && d.frequencies.length
      ? d.frequencies.filter((f) => ALL_FREQUENCIES.includes(f))
      : ALL_FREQUENCIES.slice(),
    glucose: {
      enabled: d.glucose ? !!d.glucose.enabled : DEFAULT_ALARM_SETTINGS.glucose.enabled,
      intervalHours: glucoseIntervalHours
    },
    overdueRepeatMinutes
  };
}

export async function loadAlarmSettings(db) {
  try {
    const snap = await getDoc(doc(db, ...SETTINGS_DOC_PATH));
    return mergeWithDefaults(snap.exists() ? snap.data() : null);
  } catch (e) {
    // Offline, no permission yet, doc doesn't exist, etc. — fall back to
    // defaults rather than let a settings read failure break alarms entirely.
    return { ...DEFAULT_ALARM_SETTINGS };
  }
}

// Keeps a live-updated copy for pages (like lib/push.js's foreground handler)
// that stay open a long time and should pick up an admin's change without
// needing a reload. Returns the unsubscribe function.
export function watchAlarmSettings(db, onChange) {
  return onSnapshot(
    doc(db, ...SETTINGS_DOC_PATH),
    (snap) => onChange(mergeWithDefaults(snap.exists() ? snap.data() : null)),
    () => onChange({ ...DEFAULT_ALARM_SETTINGS }) // permission/offline error — keep defaults
  );
}

export async function saveAlarmSettings(db, settings) {
  const clean = mergeWithDefaults(settings);
  await setDoc(doc(db, ...SETTINGS_DOC_PATH), { ...clean, updatedAt: serverTimestamp() });
  return clean;
}
