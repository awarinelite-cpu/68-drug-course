// Push (FCM) registration for "drug due" alerts, for both the plain web app
// (Web Push via service worker) and a future Capacitor-wrapped native app
// (native FCM via @capacitor/push-notifications, if that wrapper is added to
// this build later). Which path runs is decided at the top of each function
// by isNativePlatform().
//
// One nurse's phone is only open briefly and only ever shows one patient at
// a time, so an in-page timer can't cover the whole ward. Instead: a Cloud
// Function (deployed separately — see functions/index.js in the original
// repo) runs on a schedule server-side, checks every patient's drug chart
// for doses that are due, and pushes a notification to every nurse who has
// opted in on this screen — regardless of which page (or whether the app)
// is open on their phone at that moment.
//
// Web Push VAPID public key — Firebase Console -> Project Settings -> Cloud
// Messaging -> Web configuration -> Web Push certificates.
const VAPID_KEY = "BAPXwiBktw0KdKPUWBfE4MG-399Nj-QPAvNJLbJJ5Uq5oojGI_kYARiKq_RexHJQmomYmzpAFsAq4t-fPYj0DfY";

import { app, db } from "../firebase.js";
import { getMessaging, getToken, onMessage, isSupported } from "firebase/messaging";
import { doc, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { DEFAULT_ALARM_SETTINGS, watchAlarmSettings } from "./alarm-settings.js";

// Admin-configured alarm policy, kept live via a Firestore listener so a
// change the admin makes applies to already-open tabs without a reload.
let currentAlarmSettings = { ...DEFAULT_ALARM_SETTINGS };
let alarmSettingsWatchStarted = false;
function ensureAlarmSettingsWatch() {
  if (alarmSettingsWatchStarted) return;
  alarmSettingsWatchStarted = true;
  watchAlarmSettings(db, (settings) => { currentAlarmSettings = settings; });
}

// Ward is Africa/Lagos — UTC+1 year-round, no DST — matching the server's
// WARD_UTC_OFFSET, so quiet-hours-driven behavior here stays consistent with
// what the server already decided to (not) send.
function isWithinQuietHours(settings, now) {
  const qh = settings.quietHours;
  if (!qh || !qh.enabled) return false;
  const wardNow = new Date(now.getTime() + 60 * 60 * 1000); // UTC -> WAT
  const minutesNow = wardNow.getUTCHours() * 60 + wardNow.getUTCMinutes();
  const [sh, sm] = (qh.start || "22:00").split(":").map(Number);
  const [eh, em] = (qh.end || "06:00").split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return false;
  if (startMin < endMin) return minutesNow >= startMin && minutesNow < endMin;
  return minutesNow >= startMin || minutesNow < endMin;
}

// Firestore doc IDs can't contain "/", and an FCM token can be 140+ chars.
function tokenDocId(token) {
  return token.replace(/\//g, "_");
}

// Capacitor injects window.Capacitor at runtime in a wrapped native app, but
// this file also runs unmodified in a plain browser tab, where
// window.Capacitor doesn't exist at all.
function isNativePlatform() {
  return typeof window !== "undefined" &&
    !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

const LAST_TOKEN_KEY = "narhy_lastPushToken";

// Notification.permission, once granted, can never be un-granted by JS — only
// the user can revoke it from browser/OS settings. Track our own on/off flag
// locally instead, and treat it as the source of truth alongside permission.
const LOCAL_FLAG = "narhy_dosePushEnabled";

export function pushIsEnabled() {
  if (isNativePlatform()) {
    return localStorage.getItem(LOCAL_FLAG) === "1";
  }
  return typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    localStorage.getItem(LOCAL_FLAG) === "1";
}

// Race a step against a timeout with its own label, so a hang reports
// exactly which step it got stuck on.
function withStepTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting on: ${label}. Check your internet connection and try again.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The service worker registration for push may or may not already exist
// depending on load timing, so look for one and register fresh here if there
// isn't one, then explicitly wait for it to actually activate.
async function getActiveRegistration() {
  let registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    registration = await navigator.serviceWorker.register("/sw.js");
  }
  if (registration.active) return registration;

  const worker = registration.installing || registration.waiting;
  if (!worker) return registration;

  await new Promise((resolve) => {
    if (worker.state === "activated") { resolve(); return; }
    worker.addEventListener("statechange", function onChange() {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onChange);
        resolve();
      }
    });
  });
  return registration;
}

// Call from a user gesture (button tap) — browsers require that for the
// permission prompt to show at all. onProgress(label), if given, fires right
// before each step starts.
export async function enablePushForThisDevice(uid, onProgress) {
  const note = (label) => { if (onProgress) onProgress(label); };

  if (isNativePlatform()) {
    return enablePushNative(uid, note);
  }

  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    throw new Error("This browser doesn't support push notifications.");
  }
  note("Checking browser support…");
  if (!(await withStepTimeout(isSupported(), 8000, "checking browser support"))) {
    throw new Error("This browser doesn't support Firebase push messaging.");
  }

  note("Requesting notification permission…");
  const permission = await withStepTimeout(Notification.requestPermission(), 8000, "requesting notification permission");
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  note("Waiting for the service worker…");
  const registration = await withStepTimeout(getActiveRegistration(), 10000, "service worker becoming ready");
  const messaging = getMessaging(app);
  note("Requesting a push token from Google…");
  const token = await withStepTimeout(
    getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration }),
    15000,
    "requesting a push token from Google"
  );
  if (!token) throw new Error("Could not get a push token from the browser.");

  note("Saving the push token…");
  await withStepTimeout(
    setDoc(doc(db, "users", uid, "pushTokens", tokenDocId(token)), {
      token,
      userAgent: navigator.userAgent,
      createdAt: serverTimestamp()
    }),
    8000,
    "saving the push token to your account"
  );
  localStorage.setItem(LOCAL_FLAG, "1");
  registerForegroundHandler(messaging);

  return token;
}

// Native path: uses @capacitor/push-notifications if that plugin is present
// at runtime (added if this app is later wrapped with Capacitor).
async function enablePushNative(uid, note) {
  const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
  if (!PushNotifications) {
    throw new Error("Push notifications plugin isn't available in this build.");
  }

  note("Requesting notification permission…");
  const permStatus = await withStepTimeout(
    PushNotifications.requestPermissions(), 8000, "requesting notification permission"
  );
  if (permStatus.receive !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  note("Registering with Google (FCM)…");
  const token = await withStepTimeout(
    new Promise((resolve, reject) => {
      let regListener, errListener;
      const cleanup = () => { regListener?.remove(); errListener?.remove(); };
      PushNotifications.addListener("registration", (token) => {
        cleanup();
        resolve(token.value);
      }).then((l) => { regListener = l; });
      PushNotifications.addListener("registrationError", (err) => {
        cleanup();
        reject(new Error(err?.error || "Native push registration failed."));
      }).then((l) => { errListener = l; });
      PushNotifications.register();
    }),
    15000,
    "registering for push with FCM"
  );

  note("Saving the push token…");
  await withStepTimeout(
    setDoc(doc(db, "users", uid, "pushTokens", tokenDocId(token)), {
      token,
      userAgent: navigator.userAgent + " (native app)",
      createdAt: serverTimestamp()
    }),
    8000,
    "saving the push token to your account"
  );
  localStorage.setItem(LOCAL_FLAG, "1");
  localStorage.setItem(LAST_TOKEN_KEY, token);
  registerForegroundHandlerNative(PushNotifications);

  return token;
}

// Wires up the in-page alarm+banner for messages that arrive while this tab
// is open and focused. Firebase only auto-shows the OS notification tray for
// BACKGROUND messages (handled by public/sw.js) — a foreground tab has to
// catch the message itself via onMessage.
let foregroundHandlerAttached = false;
function registerForegroundHandler(messaging) {
  if (foregroundHandlerAttached) return;
  foregroundHandlerAttached = true;
  ensureAlarmSettingsWatch();
  onMessage(messaging, (payload) => {
    // Sends are data-only now (see functions/index.js) so title/body live
    // under `data`, not `payload.notification`.
    const d = payload.data || {};
    showForegroundBanner(d.title, d.body, d.link);
  });
}

let nativeForegroundHandlerAttached = false;
function registerForegroundHandlerNative(PushNotifications) {
  if (nativeForegroundHandlerAttached) return;
  nativeForegroundHandlerAttached = true;
  ensureAlarmSettingsWatch();
  PushNotifications.addListener("pushNotificationReceived", (notification) => {
    // Sends are data-only now (see functions/index.js), so on some Android
    // builds notification.title/body won't be populated by the OS —
    // fall back to the data fields in that case.
    const d = notification.data || {};
    showForegroundBanner(notification.title || d.title, notification.body || d.body, d.link);
  });
}

// Call on every app load (regardless of whether push was just enabled here
// or on a totally different device/session previously) so a tab that's open
// always has a live alarm handler.
export async function initForegroundAlertsIfEnabled() {
  if (!pushIsEnabled()) return;

  if (isNativePlatform()) {
    const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
    if (PushNotifications) registerForegroundHandlerNative(PushNotifications);
    return;
  }

  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
  try {
    if (!(await isSupported())) return;
    const messaging = getMessaging(app);
    registerForegroundHandler(messaging);
  } catch (e) {
    // Non-fatal — background alerts (public/sw.js) still work even if this fails.
  }
}

export async function disablePushForThisDevice(uid) {
  localStorage.removeItem(LOCAL_FLAG);

  if (isNativePlatform()) {
    const token = localStorage.getItem(LAST_TOKEN_KEY);
    localStorage.removeItem(LAST_TOKEN_KEY);
    if (token) {
      await deleteDoc(doc(db, "users", uid, "pushTokens", tokenDocId(token))).catch(() => {});
    }
    return;
  }

  if (!(await isSupported())) return;
  const messaging = getMessaging(app);
  let token;
  try {
    token = await getToken(messaging, { vapidKey: VAPID_KEY });
  } catch (e) {
    return;
  }
  if (token) {
    await deleteDoc(doc(db, "users", uid, "pushTokens", tokenDocId(token))).catch(() => {});
  }
}

// Generates the alarm tone with an oscillator rather than an audio file — no
// asset to host. A brand-new AudioContext always starts life "suspended" and
// can only move to "running" as a result of a real user gesture, so we keep
// ONE AudioContext for the whole page lifetime and unlock it on the first
// tap/keydown/touch anywhere on the page.
let sharedCtx = null;
function getSharedAudioContext() {
  if (!sharedCtx) {
    try {
      sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      return null;
    }
  }
  return sharedCtx;
}

function tryResume(ctx) {
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
}

(function unlockAudioOnFirstGesture() {
  const tryUnlock = () => tryResume(getSharedAudioContext());
  ["pointerdown", "keydown", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, tryUnlock, { passive: true });
  });
})();

// One "cycle" of oscillator scheduling per admin-selected sound.
const SOUND_PATTERNS = {
  beep(ctx) {
    [880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(ctx.destination);
      const start = ctx.currentTime + i * 0.22;
      osc.start(start);
      osc.stop(start + 0.18);
    });
  },
  chime(ctx) {
    [988, 784].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.28;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.52);
    });
  },
  siren(ctx) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    gain.gain.value = 0.16;
    const start = ctx.currentTime;
    const dur = 0.85;
    osc.frequency.setValueAtTime(500, start);
    osc.frequency.linearRampToValueAtTime(1000, start + dur / 2);
    osc.frequency.linearRampToValueAtTime(500, start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur);
  },
  urgent(ctx) {
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 1046;
      gain.gain.value = 0.22;
      osc.connect(gain).connect(ctx.destination);
      const start = ctx.currentTime + i * 0.16;
      osc.start(start);
      osc.stop(start + 0.09);
    }
  }
};

function playSoundPattern(ctx, soundType) {
  (SOUND_PATTERNS[soundType] || SOUND_PATTERNS.beep)(ctx);
}

const MAX_ALARM_MS = 60000;

function startAlarmLoop(soundType, repeatMode) {
  let stopped = false;
  const ctx = getSharedAudioContext();
  if (!ctx) return () => {};

  tryResume(ctx);

  function tick() {
    if (stopped) return;
    tryResume(ctx);
    if (ctx.state !== "running") return;
    playSoundPattern(ctx, soundType);
  }

  tick();
  const interval = repeatMode === "once" ? null : setInterval(tick, 900);
  const maxTimer = repeatMode === "once" ? null : setTimeout(stop, MAX_ALARM_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    if (interval) clearInterval(interval);
    if (maxTimer) clearTimeout(maxTimer);
  }
  return stop;
}

function tryVibrate(repeatMode) {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  const pulse = [250, 150, 250];
  navigator.vibrate(repeatMode === "once" ? pulse : pulse.concat([300, 250, 150, 250]));
}

function showForegroundBanner(title, body, link) {
  const settings = currentAlarmSettings;

  if (isWithinQuietHours(settings, new Date())) return;

  const appearance = settings.appearance || "banner_sound";
  const showBanner = appearance !== "sound_only";
  const playSound = appearance === "banner_sound" || appearance === "sound_only";
  const vibrate = appearance === "vibrate";

  const stopAlarm = playSound ? startAlarmLoop(settings.sound, settings.repeat) : () => {};
  if (vibrate) tryVibrate(settings.repeat);

  if (!showBanner) {
    if (settings.repeat === "once") return;
    setTimeout(stopAlarm, MAX_ALARM_MS);
    return;
  }

  const banner = document.createElement("div");
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:6000; " +
    "background:#111827; color:#fff; padding:12px 16px; border-radius:10px; " +
    "box-shadow:0 4px 16px rgba(0,0,0,.3); max-width:92vw; cursor:pointer; font-size:13px;";
  banner.innerHTML =
    '<div style="font-weight:bold; margin-bottom:2px;">' + (title || "Drug due") + "</div>" +
    "<div>" + (body || "") + "</div>" +
    '<div style="margin-top:6px; font-size:11px; opacity:.75;">Tap to dismiss</div>';

  const cleanup = () => { stopAlarm(); banner.remove(); };
  banner.addEventListener("click", () => {
    if (link) window.location.href = link;
    cleanup();
  });
  document.body.appendChild(banner);
  setTimeout(cleanup, MAX_ALARM_MS);
}
