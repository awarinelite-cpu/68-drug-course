// functions/index.js
//
// Runs every 1 minute. A nurse's phone only ever shows one patient's chart
// at a time and is only open briefly, so alerts can't live in the page —
// they have to come from the server, watching every patient's drug chart at
// once, and push straight to each nurse's phone regardless of what's open.
//
// Due-time model: rather than a fixed ward-wide drug round, each drug's next
// dose is computed from ITS OWN last-administered time + its frequency's
// interval (falling back to when the order was created/started, for a drug
// that's never been given yet). See src/lib/push.js and src/pages/Profile.jsx
// for the client side, and src/pages/DrugCourseChart.jsx for where
// drugs/chartRows are written.
//
// Ported from the original static-HTML repo (functions/index.js there) to
// this React rebuild — same Firebase project (gen-lang-client-0406053716),
// same Firestore paths/field names, so this runs as a drop-in backend for
// the new frontend. Two changes from the original: (1) the glucose-check
// trigger reads rows6/rows3 (unwrapping each row's { cells } wrapper)
// instead of a single `rows` array, matching how src/pages/BloodGlucose.jsx
// now stores readings; (2) push-notification deep links point at this app's
// React Router routes (e.g. /charts/drug-course-chart?patient=...) instead
// of the old static .html pages.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Ward is Africa/Lagos — WAT, UTC+1 year-round, no DST — so this offset is
// safe to hardcode rather than depending on the function runtime's TZ.
const WARD_UTC_OFFSET = '+01:00';

// Mirrors WARDS in js/nurses-report-common.js — kept in sync by hand, same
// as INTERVAL_HOURS below, since that file is an ES module written for the
// browser and can't be imported into this CommonJS Cloud Function.
const WARDS = [
  { key: 'ae',       label: 'A/E',       beds: 20 },
  { key: 'matbed',   label: 'MATBED',    beds: 20 },
  { key: 'matcot',   label: 'MAT COT',   beds: 20 },
  { key: 'officers', label: 'OFFICERS',  beds: 9  },
  { key: 'fmw1',     label: 'FMW I',     beds: 18 },
  { key: 'fsw2',     label: 'FSW II',    beds: 20 },
  { key: 'mmw',      label: 'MMW',       beds: 20 },
  { key: 'paedbed',  label: 'PAED BED',  beds: 10 },
  { key: 'paedcot',  label: 'PAED COT',  beds: 18 },
  { key: 'ortho',    label: 'ORTHO',     beds: 20 },
  { key: 'gynae',    label: 'GYNAE',     beds: 18 },
  { key: 'award',    label: 'A WARD',    beds: 44 },
  { key: 'fswext',   label: 'FSW EXT',   beds: 20 },
  { key: 'eco1',     label: 'ECO I',     beds: 3  },
  { key: 'eco2',     label: 'ECO II',    beds: 3  },
  { key: 'icu',      label: 'ICU',       beds: 6  },
  { key: 'amenity',  label: 'AMENITY',   beds: 3  },
  { key: 'msw',      label: 'MSW',       beds: 18 },
  { key: 'esw',      label: 'ESW',       beds: 20 }
];

// Only standard, unambiguous frequencies are covered for now. STAT (one-off),
// PRN (as-needed), and any custom free-text frequency are intentionally
// skipped — there's no reliable interval to compute a "next due" from.
const INTERVAL_HOURS = {
  OD: 24, Mane: 24, Nocte: 24, HS: 24,
  BD: 12, TDS: 8, QDS: 6, QOD: 48,
  Q4H: 4, Q6H: 6, Q8H: 8, Q12H: 12,
  Weekly: 168,
  'STAT then Q4H': 4, 'STAT then Q6H': 6, 'STAT then Q8H': 8, 'STAT then Q12H': 12
};

function toWardDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const d = new Date(`${dateStr}T${timeStr}:00${WARD_UTC_OFFSET}`);
  return isNaN(d.getTime()) ? null : d;
}

// Same doc admin.html writes to and js/alarm-settings.js reads on the client
// (settings/alarm) — mirrored here by hand since Cloud Functions can't
// import that browser ES module. Only the two fields that affect whether a
// push gets sent at all are used server-side; sound/appearance/repeat are
// purely a foreground-tab concern handled in js/push.js.
const DEFAULT_FREQUENCIES = Object.keys(INTERVAL_HOURS);

async function loadAlarmSettings() {
  try {
    const snap = await db.collection('settings').doc('alarm').get();
    const d = snap.exists ? snap.data() : {};
    const frequencies = Array.isArray(d.frequencies) && d.frequencies.length
      ? d.frequencies.filter((f) => DEFAULT_FREQUENCIES.includes(f))
      : DEFAULT_FREQUENCIES;
    const qh = d.quietHours || {};
    const glucose = d.glucose || {};
    const validGlucoseIntervals = [1, 2, 3, 4, 6, 8, 12, 24];
    return {
      frequencies,
      quietHours: { enabled: !!qh.enabled, start: qh.start || '22:00', end: qh.end || '06:00' },
      glucose: {
        enabled: d.glucose ? !!glucose.enabled : true, // default on if admin hasn't touched this setting yet
        intervalHours: validGlucoseIntervals.includes(Number(glucose.intervalHours)) ? Number(glucose.intervalHours) : 4
      }
    };
  } catch (e) {
    console.error('Failed to load alarm settings, defaulting to all frequencies / no quiet hours:', e);
    return {
      frequencies: DEFAULT_FREQUENCIES,
      quietHours: { enabled: false, start: '22:00', end: '06:00' },
      glucose: { enabled: true, intervalHours: 4 }
    };
  }
}

// Ward-local "now", for comparing against the admin's quiet-hours start/end
// (which are entered as ward-local HH:mm, e.g. "22:00").
function wardMinutesNow(now) {
  const wardNow = new Date(now.getTime() + 60 * 60 * 1000); // UTC -> WAT (+1, no DST)
  return wardNow.getUTCHours() * 60 + wardNow.getUTCMinutes();
}

function isWithinQuietHours(quietHours, now) {
  if (!quietHours.enabled) return false;
  const minutesNow = wardMinutesNow(now);
  const [sh, sm] = quietHours.start.split(':').map(Number);
  const [eh, em] = quietHours.end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return false; // zero-length window — treat as disabled
  if (startMin < endMin) return minutesNow >= startMin && minutesNow < endMin;
  return minutesNow >= startMin || minutesNow < endMin; // wraps past midnight
}

// Chart rows are matched back to a drug by its "S/N" column, which contains
// the drug's 1-based row number (see refreshDrugSnoList() in
// charts/drug-course-chart.html) — same lookup drug-course-chart.html itself
// uses to infer a drug's start date from its administration history.
function lastGivenFor(drugIndex, chartRows) {
  let latest = null;
  for (const row of chartRows || []) {
    const nums = (row.sno || '').match(/\d+/g) || [];
    if (!nums.some((n) => parseInt(n, 10) === drugIndex + 1)) continue;
    const dt = toWardDate(row.date, row.time);
    if (dt && (!latest || dt > latest)) latest = dt;
  }
  return latest;
}

function computeDueAt(drug, chartRows, drugIndex) {
  const lastGiven = lastGivenFor(drugIndex, chartRows);
  if (lastGiven) {
    const intervalHours = INTERVAL_HOURS[drug.frequency];
    return new Date(lastGiven.getTime() + intervalHours * 3600 * 1000);
  }
  // Never administered yet — anchor to whichever of these is available.
  if (drug.startDate) return toWardDate(drug.startDate, '00:00');
  if (drug.createdAt) {
    const d = new Date(drug.createdAt);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Mirrors CHART_DEFS in charts/blood-glucose.html — each chart type's column
// layout by index, so the scheduler can tell a reading cell from date/time/
// remark bookkeeping. Kept in sync by hand, same as INTERVAL_HOURS above.
// dateIdx/timeIdx feed toWardDate(); readingIdxs are the glucose-value
// columns — a row counts as "a reading was taken" if any of them is filled.
const GLUCOSE_CHART_COLUMNS = {
  '6point': { dateIdx: 0, timeIdx: 1, readingIdxs: [2, 3, 4, 5, 6, 7] },
  '3point': { dateIdx: 0, timeIdx: 1, readingIdxs: [2, 3, 4] }
};

function lastGlucoseReadingAt(rows, chartType) {
  const cols = GLUCOSE_CHART_COLUMNS[chartType] || GLUCOSE_CHART_COLUMNS['6point'];
  let latest = null;
  for (const row of rows || []) {
    const hasReading = cols.readingIdxs.some((i) => (row[i] || '').toString().trim() !== '');
    if (!hasReading) continue;
    const dt = toWardDate(row[cols.dateIdx], row[cols.timeIdx]);
    if (dt && (!latest || dt > latest)) latest = dt;
  }
  return latest;
}

// Reads every nurse's registered push token across all users (see
// js/push.js's pushTokens subcollection). Shared by both scheduled checks
// below so each does this Firestore read only once per its own cycle.
async function getTokenEntries(usersSnap) {
  const tokenEntries = []; // { token, ref }
  await Promise.all(
    usersSnap.docs.map(async (u) => {
      const tokensSnap = await db.collection('users').doc(u.id).collection('pushTokens').get();
      tokensSnap.forEach((t) => {
        if (t.data().token) tokenEntries.push({ token: t.data().token, ref: t.ref });
      });
    })
  );
  return tokenEntries;
}

exports.checkDueDrugs = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'Africa/Lagos', region: 'us-central1' },
  async () => {
    const now = new Date();
    const alarmSettings = await loadAlarmSettings();

    // Quiet hours suppress sending entirely for this cycle. Doses that go
    // due during the window are deliberately left un-marked (lastAlertedFor
    // is only set for drugs actually processed below), so the very next
    // cycle after quiet hours end will catch them as still-due and alert
    // then — nothing is silently missed, it's just delayed.
    if (isWithinQuietHours(alarmSettings.quietHours, now)) {
      console.log('Within admin-configured quiet hours — skipping this cycle.');
      return;
    }

    const [patientsSnap, chartsSnap, usersSnap] = await Promise.all([
      db.collection('patients').get(),
      db.collectionGroup('drugCourseChart').get(),
      db.collection('users').get()
    ]);

    const patientNames = {};
    patientsSnap.forEach((d) => { patientNames[d.id] = d.data().name || 'Unnamed patient'; });

    const tokenEntries = await getTokenEntries(usersSnap);
    if (tokenEntries.length === 0) {
      console.log('No nurses subscribed to dose alerts — nothing to send.');
      return;
    }

    const dueByPatient = {}; // patientId -> [ "Drug name (FREQ)" ]
    const chartUpdates = [];

    chartsSnap.forEach((chartDoc) => {
      if (chartDoc.id !== 'main') return; // this collection only ever holds one doc, 'main'
      const patientId = chartDoc.ref.parent.parent.id;
      const data = chartDoc.data();
      const drugs = Array.isArray(data.drugs) ? data.drugs : [];
      const chartRows = Array.isArray(data.rows) ? data.rows : [];
      let changed = false;

      drugs.forEach((drug, i) => {
        if (!INTERVAL_HOURS[drug.frequency]) return; // STAT / PRN / custom text — not covered yet
        if (!alarmSettings.frequencies.includes(drug.frequency)) return; // admin turned this frequency off
        if (drug.action && drug.action !== 'Ongoing') return; // discontinued/withheld/completed/other

        const dueAt = computeDueAt(drug, chartRows, i);
        if (!dueAt || dueAt > now) return;

        const dueSlotKey = dueAt.toISOString();
        if (drug.lastAlertedFor === dueSlotKey) return; // already alerted for this exact dose

        drug.lastAlertedFor = dueSlotKey;
        changed = true;

        const label = `${drug.name || 'Unnamed drug'} (${drug.frequency})`;
        (dueByPatient[patientId] = dueByPatient[patientId] || []).push(label);
      });

      if (changed) chartUpdates.push(chartDoc.ref.update({ drugs }));
    });

    const patientIds = Object.keys(dueByPatient);
    if (patientIds.length === 0) {
      await Promise.all(chartUpdates);
      console.log('No doses due this cycle.');
      return;
    }

    const tokens = tokenEntries.map((t) => t.token);
    let tokensPruned = false; // token validity is the same across every send below, so only act on it once

    const sends = patientIds.map(async (patientId) => {
      const labels = dueByPatient[patientId];
      const name = patientNames[patientId] || 'a patient';
      const title = labels.length === 1 ? `Drug due — ${name}` : `${labels.length} drugs due — ${name}`;
      const body = labels.slice(0, 3).join(', ') + (labels.length > 3 ? `, +${labels.length - 3} more` : '');

      const resp = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: {
          // React Router route (this app is an SPA, not the old static
          // .html pages) — sw.js opens this straight via clients.openWindow.
          link: `/charts/drug-course-chart?patient=${patientId}`,
          tag: `due-${patientId}`
        },
        // android.notification.channel_id is only consulted by the Android
        // FCM SDK (harmless no-op for plain web-push tokens from browsers).
        // It matches the "dose-due-alerts" channel created natively in the
        // Capacitor APK's MainActivity — without pinning this explicitly,
        // Android falls back to an auto-created channel that isn't
        // guaranteed to have sound or high-importance heads-up behavior.
        // priority: 'high' asks FCM/the device to wake from Doze and
        // deliver promptly rather than batching for later.
        android: {
          priority: 'high',
          notification: { channelId: 'dose-due-alerts', sound: 'default' }
        }
      });

      if (!tokensPruned) {
        tokensPruned = true;
        resp.responses.forEach((r, idx) => {
          if (r.success) return;
          const code = r.error?.code || '';
          // Token is stale (app uninstalled, permission revoked, etc.) — remove it
          // so future cycles don't keep trying to send to it.
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
            chartUpdates.push(tokenEntries[idx].ref.delete());
          }
        });
      }
    });

    await Promise.all([...chartUpdates, ...sends]);
    console.log(`Sent due-dose alerts for ${patientIds.length} patient(s) to ${tokens.length} device(s).`);
  }
);

// Runs every 1 minute, same cadence and admin-configured quiet-hours/sound
// policy as checkDueDrugs above, but for the glycemic chart instead of the
// drug course chart. Unlike drugs (which have a per-row frequency like
// BD/TDS), the glycemic chart has no such field — "due" is instead a single
// ward-wide interval (settings/alarm.glucose.intervalHours, admin-configured
// in admin.html) counted from EACH PATIENT'S OWN last recorded reading (the
// Date+Time of their most recent row with any glucose value filled in). A
// patient with no reading yet has no baseline to count from, so they're
// skipped rather than alerted immediately on admission.
exports.checkDueGlucoseChecks = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'Africa/Lagos', region: 'us-central1' },
  async () => {
    const now = new Date();
    const alarmSettings = await loadAlarmSettings();

    if (!alarmSettings.glucose.enabled) {
      console.log('Glucose check reminders are turned off in Alarm Settings.');
      return;
    }
    if (isWithinQuietHours(alarmSettings.quietHours, now)) {
      console.log('Within admin-configured quiet hours — skipping glucose reminders this cycle.');
      return;
    }

    const [patientsSnap, chartsSnap, usersSnap] = await Promise.all([
      db.collection('patients').get(),
      db.collectionGroup('bloodGlucose').get(),
      db.collection('users').get()
    ]);

    const patientNames = {};
    patientsSnap.forEach((d) => { patientNames[d.id] = d.data().name || 'Unnamed patient'; });

    const tokenEntries = await getTokenEntries(usersSnap);
    if (tokenEntries.length === 0) {
      console.log('No nurses subscribed to dose alerts — nothing to send.');
      return;
    }

    const duePatientIds = [];
    const chartUpdates = [];
    const intervalMs = alarmSettings.glucose.intervalHours * 3600 * 1000;

    chartsSnap.forEach((chartDoc) => {
      if (chartDoc.id !== 'main') return; // this collection only ever holds one doc, 'main'
      const patientId = chartDoc.ref.parent.parent.id;
      const data = chartDoc.data();
      const chartType = data.chartType === '3point' ? '3point' : '6point';
      // The client (src/pages/BloodGlucose.jsx) keeps 6-point and 3-point
      // rows in separate fields (rows6/rows3) so a toggle between them
      // doesn't lose either one's data, falling back to a legacy single
      // `rows` field for any doc written before that split. Each saved row
      // is also wrapped as { cells: [...] } there — Firestore can't store
      // nested arrays directly — so unwrap it back to a plain array here
      // the same way the client's own `unwrap()` does on read.
      const rawRows = data[chartType === '3point' ? 'rows3' : 'rows6'];
      const rows = (Array.isArray(rawRows) ? rawRows : (Array.isArray(data.rows) ? data.rows : []))
        .map((r) => (r && r.cells) || r);

      const lastReadingAt = lastGlucoseReadingAt(rows, chartType);
      if (!lastReadingAt) return; // no reading recorded yet — nothing to base a "due" time on

      const dueAt = new Date(lastReadingAt.getTime() + intervalMs);
      if (dueAt > now) return;

      const dueSlotKey = dueAt.toISOString();
      if (data.lastAlertedForGlucose === dueSlotKey) return; // already alerted for this exact slot

      chartUpdates.push(chartDoc.ref.update({ lastAlertedForGlucose: dueSlotKey }));
      duePatientIds.push(patientId);
    });

    if (duePatientIds.length === 0) {
      await Promise.all(chartUpdates);
      console.log('No glucose checks due this cycle.');
      return;
    }

    const tokens = tokenEntries.map((t) => t.token);
    let tokensPruned = false; // token validity is the same across every send below, so only act on it once

    const sends = duePatientIds.map(async (patientId) => {
      const name = patientNames[patientId] || 'a patient';

      const resp = await messaging.sendEachForMulticast({
        tokens,
        notification: { title: `Glucose check due — ${name}`, body: 'A blood glucose reading is due.' },
        data: {
          link: `/charts/blood-glucose?patient=${patientId}`,
          tag: `glucose-${patientId}`
        },
        android: {
          priority: 'high',
          notification: { channelId: 'dose-due-alerts', sound: 'default' }
        }
      });

      if (!tokensPruned) {
        tokensPruned = true;
        resp.responses.forEach((r, idx) => {
          if (r.success) return;
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
            chartUpdates.push(tokenEntries[idx].ref.delete());
          }
        });
      }
    });

    await Promise.all([...chartUpdates, ...sends]);
    console.log(`Sent glucose-check reminders for ${duePatientIds.length} patient(s) to ${tokens.length} device(s).`);
  }
);

// -- New message alerts -------------------------------------------------
//
// Unlike the dose/glucose checks above (which poll on a schedule because
// "due" is a moving target computed from elapsed time), a chat message is
// itself the trigger — so this fires straight off the Firestore write
// (js/messages.html's send handlers, both text and image) instead of
// polling. Sends to every OTHER participant's registered device(s); the
// sender never gets a push for her own message. Uses the same
// pushTokens subcollection as the dose/glucose alerts, so a nurse who has
// ever enabled "Alerts On" (js/push.js) gets message pushes automatically
// too — there's no separate opt-in toggle for chat.
exports.onNewMessage = onDocumentCreated(
  { document: 'conversations/{convoId}/messages/{messageId}', region: 'us-central1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const msg = snap.data();
    const convoId = event.params.convoId;
    const senderUid = msg.senderUid;
    if (!senderUid) return;

    const convoSnap = await db.collection('conversations').doc(convoId).get();
    if (!convoSnap.exists) return;
    const convo = convoSnap.data();
    const participants = Array.isArray(convo.participants) ? convo.participants : [];
    const recipients = participants.filter((uid) => uid !== senderUid);
    if (recipients.length === 0) return;

    const tokenEntries = [];
    await Promise.all(
      recipients.map(async (uid) => {
        const tokensSnap = await db.collection('users').doc(uid).collection('pushTokens').get();
        tokensSnap.forEach((t) => {
          if (t.data().token) tokenEntries.push({ token: t.data().token, ref: t.ref });
        });
      })
    );
    if (tokenEntries.length === 0) return;

    // Group chats show the sender's name so it's clear who spoke; a DM's
    // recipient already knows who it's with from the thread itself, so the
    // conversation title (participantNames) covers that case, matching how
    // the in-app chat list already labels DMs by the other nurse's name.
    const senderName = (convo.participantNames && convo.participantNames[senderUid]) || 'A nurse';
    const title = convo.type === 'group'
      ? `${senderName}${convo.groupName ? ' — ' + convo.groupName : ''}`
      : senderName;
    const bodyRaw = msg.text || (msg.imageUrl ? '📷 Photo' : 'New message');
    const body = bodyRaw.length > 120 ? bodyRaw.slice(0, 117) + '…' : bodyRaw;

    const tokens = tokenEntries.map((t) => t.token);
    const resp = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: {
        // NOTE: this app hasn't got a /messages route yet — the
        // nurse-to-nurse messaging system (old repo's messages.html) hasn't
        // been ported to React. This trigger is otherwise harmless (it just
        // never fires — nothing ever writes to conversations/*/messages
        // until that port happens) but update this path when it is.
        link: `/messages?convo=${convoId}`,
        tag: `msg-${convoId}`
      },
      android: {
        priority: 'high',
        notification: { channelId: 'dose-due-alerts', sound: 'default' }
      }
    });

    const cleanup = [];
    resp.responses.forEach((r, idx) => {
      if (r.success) return;
      const code = r.error?.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
        cleanup.push(tokenEntries[idx].ref.delete());
      }
    });
    await Promise.all(cleanup);

    console.log(`Sent message alert for conversation ${convoId} to ${tokens.length} device(s).`);
  }
);

// -- Auto-archive stale ward reports ----------------------------------
//
// Third way a ward report reaches the permanent archive, alongside (1) a
// nurse tapping "Move to Archive" on her own ward and (2) the Overall
// Nurse/admin/subadmin's full-batch "Save to Archive". This is the safety
// net for a report nobody manually moved: once a ward's report is
// submitted + locked and its 24-hour period has actually closed, it
// shouldn't be able to sit there forever blocking that ward's next report.
//
// Mirrors archiveOneWard() in js/nurses-report-common.js by hand (same
// reason INTERVAL_HOURS/WARDS above are hand-mirrored) — files
// archives/ward_<key>_<dateId>, then resets the live ward doc to blank/
// unlocked, carrying the closing Occ forward as the new period's starting
// census. Runs with the Admin SDK, which bypasses firestore.rules
// entirely, so this never hits the permission-denied a nurse can hit on a
// second manual attempt.

function pad2(n) { return String(n).padStart(2, '0'); }

// Same "ward-local calendar date" math as wardLocalParts() in
// js/nurses-report-common.js.
function wardLocalParts(d) {
  const wat = new Date(d.getTime() + 60 * 60 * 1000);
  return { y: wat.getUTCFullYear(), m: wat.getUTCMonth(), day: wat.getUTCDate(), hour: wat.getUTCHours() };
}

// Same 9 AM–to–9 AM period convention as reportDateId() in
// js/nurses-report-common.js.
function reportDateId(d) {
  const p = wardLocalParts(d);
  const base = new Date(Date.UTC(p.y, p.m, p.day - (p.hour < 9 ? 1 : 0)));
  return base.getUTCFullYear() + '-' + pad2(base.getUTCMonth() + 1) + '-' + pad2(base.getUTCDate());
}

function dateIdMinusOneDay(dateId) {
  const [y, m, d] = dateId.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}

// Same Monday-anchored week id as weekId() in js/nurses-report-common.js.
function weekIdFor(d) {
  const p = wardLocalParts(d);
  const date = new Date(Date.UTC(p.y, p.m, p.day));
  const dow = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((dow + 6) % 7));
  return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
}

function reportPeriodLabel(dateId, kind) {
  const [y, m, d] = dateId.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 1));
  const fmt = dt => pad2(dt.getUTCDate()) + '/' + pad2(dt.getUTCMonth() + 1) + '/' + String(dt.getUTCFullYear()).slice(2);
  return '24 HOURS ' + kind + ' REPORT WEF 0900HRS OF ' + fmt(start) + ' TO 0900HRS OF ' + fmt(end);
}

// A fresh, unsubmitted ward doc — same shape as defaultWardDoc() in
// js/nurses-report-common.js.
function defaultWardDoc(w, startOcc) {
  const occ = typeof startOcc === 'number' ? startOcc : 0;
  return {
    label: w.label, beds: w.beds, startOcc: occ, occ: occ, vac: w.beds - occ,
    locked: false, submitted: false,
    shifts: { am: { nurseOnDuty: '' }, pm: { nurseOnDuty: '' } },
    patients: [], nightUpdate: '', nightUpdateBy: '', nightUpdatedAt: null
  };
}

// Runs once a day, shortly after the 0900 ward-day rollover, so it's
// always looking back at the period that JUST closed (never the one still
// in progress). 09:05 rather than exactly 09:00 to give any nurse's own
// last-second manual archive click a moment to land first.
exports.autoArchiveWardReports = onSchedule(
  { schedule: '5 9 * * *', timeZone: 'Africa/Lagos', region: 'us-central1' },
  async () => {
    const now = new Date();
    const closedDateId = dateIdMinusOneDay(reportDateId(now));
    const wid = weekIdFor(now);
    const fileName = reportPeriodLabel(closedDateId, 'WARD');

    const results = await Promise.all(WARDS.map(async (w) => {
      const wardRef = db.collection('nurseReports').doc(closedDateId).collection('wards').doc(w.key);
      const wardSnap = await wardRef.get();
      if (!wardSnap.exists) return null;
      const data = wardSnap.data();
      // Only sweep up reports actually finished and left behind — a draft
      // that was never submitted/locked is left alone; there's nothing to
      // archive and nothing worth resetting.
      if (!data.submitted || !data.locked) return null;

      const archiveRef = db.collection('archives').doc('ward_' + w.key + '_' + closedDateId);
      const archiveSnap = await archiveRef.get();
      if (archiveSnap.exists) return null; // already filed manually — nothing to do

      await archiveRef.set({
        type: 'ward', wardKey: w.key, wardLabel: w.label, dateId: closedDateId, weekId: wid,
        fileName,
        data,
        archivedBy: 'Automatic archive (24hr)', archivedByUid: null,
        archivedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const closingOcc = typeof data.occ === 'number' ? data.occ : 0;
      await wardRef.set(defaultWardDoc(w, closingOcc));
      return w.key;
    }));

    const archived = results.filter(Boolean);
    console.log(archived.length
      ? `Auto-archived ${archived.length} ward report(s) for ${closedDateId}: ${archived.join(', ')}`
      : `No leftover submitted+locked ward reports to auto-archive for ${closedDateId}.`);
  }
);

// Runs 5 minutes after autoArchiveWardReports (09:05), so by the time this
// reads anything, every ward that was submitted+locked for the closed
// period already has its archives/ward_{key}_{dateId} doc filed — either
// because the Overall Nurse (or a ward nurse) archived it manually earlier,
// or because the 09:05 job just swept it up automatically. This job covers
// the remaining gap: it only fires if the Overall Nurse never clicked
// "Save to Archive" themselves, so a compiled archives/overall_{dateId} doc
// still gets written even on a day nobody pressed the button.
//
// Mirrors saveToArchive()'s overall payload shape in overall-nurse.html,
// but can't reuse its wardData snapshot (that only exists in the browser,
// taken at click time) — instead it sources each ward's slice from the
// already-filed archives/ward_{key}_{dateId} doc. A ward that was never
// submitted+locked that period has no such doc (autoArchiveWardReports
// skips it, leaving the live doc untouched), so falls back to reading that
// live doc directly.
exports.autoArchiveOverallReport = onSchedule(
  { schedule: '10 9 * * *', timeZone: 'Africa/Lagos', region: 'us-central1' },
  async () => {
    const now = new Date();
    const closedDateId = dateIdMinusOneDay(reportDateId(now));
    const wid = weekIdFor(now);

    const overallRef = db.collection('archives').doc('overall_' + closedDateId);
    const overallSnap = await overallRef.get();
    if (overallSnap.exists) {
      console.log(`Overall report for ${closedDateId} already archived (manually) — nothing to do.`);
      return;
    }

    const wards = {};
    await Promise.all(WARDS.map(async (w) => {
      const archiveRef = db.collection('archives').doc('ward_' + w.key + '_' + closedDateId);
      const archiveSnap = await archiveRef.get();
      if (archiveSnap.exists) {
        wards[w.key] = archiveSnap.data().data;
        return;
      }
      // Never submitted+locked that period, so autoArchiveWardReports left
      // the live doc alone — read it directly rather than defaulting to
      // blank, in case a draft with real data was just never locked.
      const wardRef = db.collection('nurseReports').doc(closedDateId).collection('wards').doc(w.key);
      const wardSnap = await wardRef.get();
      wards[w.key] = wardSnap.exists ? wardSnap.data() : defaultWardDoc(w, 0);
    }));

    await overallRef.set({
      type: 'overall', dateId: closedDateId, weekId: wid,
      fileName: reportPeriodLabel(closedDateId, 'OVERALL'),
      wards,
      archivedBy: 'Automatic archive (24hr)', archivedByUid: null,
      archivedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Auto-archived overall report for ${closedDateId}.`);
  }
);

// Callable from admin.html's "All Users" delete button. Deleting the
// users/{uid} Firestore doc alone (which the client can already do directly
// under firestore.rules' isAdmin() check) is enough to lock the account out
// of the app on next login — see the "account isn't set up yet" branch in
// js/auth-guard.js — but the underlying Firebase Auth account would still
// exist and could still authenticate. Removing that requires the Admin SDK,
// which only runs here, not in the browser, so a real "delete user" has to
// go through this callable rather than client-side deleteDoc the way patient
// deletes do.
exports.deleteUserAccount = onCall({ region: 'us-central1' }, async (request) => {
  const callerUid = request.auth && request.auth.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const callerSnap = await db.collection('users').doc(callerUid).get();
  if (!callerSnap.exists || callerSnap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access only.');
  }

  const targetUid = request.data && request.data.uid;
  if (!targetUid || typeof targetUid !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing user id.');
  }
  if (targetUid === callerUid) {
    throw new HttpsError('failed-precondition', "You can't delete your own account.");
  }

  // Firestore doesn't cascade-delete subcollections when the parent doc is
  // removed (same reasoning as PATIENT_SUBCOLLECTIONS cleanup in admin.html
  // for patient deletes) — clear the user's registered push-notification
  // tokens first so they don't sit orphaned.
  const tokensSnap = await db.collection('users').doc(targetUid).collection('pushTokens').get();
  await Promise.all(tokensSnap.docs.map((d) => d.ref.delete()));

  await db.collection('users').doc(targetUid).delete();

  try {
    await admin.auth().deleteUser(targetUid);
  } catch (e) {
    // Already gone from Auth (e.g. the account was created but never
    // completed sign-in) isn't worth surfacing as a failure — the goal, no
    // more sign-in access, is already achieved.
    if (e.code !== 'auth/user-not-found') {
      throw new HttpsError('internal', e.message || 'Failed to delete the account.');
    }
  }

  return { success: true };
});
