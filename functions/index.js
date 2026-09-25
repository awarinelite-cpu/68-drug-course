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
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const {
  INTERVAL_HOURS,
  parseDoseSequence,
  intervalHoursFor,
  administrationCountFor,
  toWardDate,
  lastGivenFor,
  computeDueAt,
  isSchedulable
} = require('./lib/dueLogic');

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

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

// INTERVAL_HOURS, parseWeeklyFrequency, intervalHoursFor, parseDoseSequence,
// administrationCountFor, and toWardDate now live in ./lib/dueLogic (see the
// import at the top of this file) — moved there, unchanged, so the
// checkDueDrugs schedule, the updateNextDoseAt trigger below, and the
// standalone backfill-script.js can all share exactly one copy.

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
    const validRepeatMinutes = [5, 10, 15, 20, 30, 60];
    return {
      frequencies,
      quietHours: { enabled: !!qh.enabled, start: qh.start || '22:00', end: qh.end || '06:00' },
      glucose: {
        enabled: d.glucose ? !!glucose.enabled : true, // default on if admin hasn't touched this setting yet
        intervalHours: validGlucoseIntervals.includes(Number(glucose.intervalHours)) ? Number(glucose.intervalHours) : 4
      },
      // Mirrors OVERDUE_REPEAT_OPTIONS in src/lib/alarm-settings.js — how
      // often a still-overdue (not-yet-given) dose gets re-pushed, since
      // otherwise a dose only ever triggers one alert for its whole life.
      overdueRepeatMinutes: validRepeatMinutes.includes(Number(d.overdueRepeatMinutes)) ? Number(d.overdueRepeatMinutes) : 15
    };
  } catch (e) {
    console.error('Failed to load alarm settings, defaulting to all frequencies / no quiet hours:', e);
    return {
      frequencies: DEFAULT_FREQUENCIES,
      quietHours: { enabled: false, start: '22:00', end: '06:00' },
      glucose: { enabled: true, intervalHours: 4 },
      overdueRepeatMinutes: 15
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

// lastGivenFor and computeDueAt now live in ./lib/dueLogic too — same note
// as above.

// NOTE: the automated glucose-check reminder (checkDueGlucoseChecks) was
// removed to cut Firestore read costs — it was one of two scheduled
// functions each doing a full, unconditional patients/users/allocations
// scan every minute (see checkDueDrugs below for the kept, optimized one).
// Manual blood-glucose logging (src/pages/BloodGlucose.jsx) is untouched;
// only the automated "due" reminder/alert was cut. GLUCOSE_CHART_COLUMNS
// and lastGlucoseReadingAt, which existed solely to support that reminder,
// were removed as dead code along with it.

// Reads registered push tokens (see js/push.js's pushTokens subcollection)
// for ONLY the given uids, instead of scanning every user in the building.
// Used by checkDueDrugs below, scoped each cycle to just the nurses
// allocated to that cycle's actually-due patients (see
// loadAllocatedUidsByPatient / tokensForPatient below). Includes role
// alongside each token, kept for parity with the rest of the token-entry
// shape used elsewhere in this file, though nothing here currently filters
// on it.
async function getTokenEntriesForUids(uids) {
  const tokenEntries = []; // { token, ref, uid, role }
  await Promise.all(
    uids.map(async (uid) => {
      const [userSnap, tokensSnap] = await Promise.all([
        db.collection('users').doc(uid).get(),
        db.collection('users').doc(uid).collection('pushTokens').get()
      ]);
      const role = userSnap.exists ? (userSnap.data().role || '') : '';
      tokensSnap.forEach((t) => {
        if (t.data().token) tokenEntries.push({ token: t.data().token, ref: t.ref, uid, role });
      });
    })
  );
  return tokenEntries;
}

// Mirrors src/pages/Patient.jsx's "Allocate to Me" — allocations/{alloc_uid_patientId}
// docs with { uid, patientId } — and src/pages/MyPatients.jsx which reads them
// back. Also reads allocations_mhl, the MHL Svelte app's own collection for
// the exact same flow (see MHL's src/routes/patient/+page.svelte —
// allocationDocRef uses "allocations_mhl" instead of "allocations", kept
// separate the same way wardMhl/pendingTransferMhl are kept separate from
// 68's ward/pendingTransfer on the shared /patients doc — see wardCensus.js).
// Both hospitals' apps share these same scheduled dose/glucose checks, so a
// patient allocated only through MHL still needs to resolve to a real
// nurse here — without this, every MHL-only allocation looked
// "unallocated" to tokensForPatient and fell back to admin/subadmin
// devices for EVERY MHL patient, regardless of ward. Returns
// patientId -> Set(uid), merging both collections since in principle a
// patient could (incorrectly) be allocated from both apps at once.
async function loadAllocatedUidsByPatient() {
  const [snap, snapMhl] = await Promise.all([
    db.collection('allocations').get(),
    db.collection('allocations_mhl').get()
  ]);
  const map = {}; // patientId -> Set(uid)
  function ingest(s) {
    s.forEach((d) => {
      const data = d.data() || {};
      if (!data.uid || !data.patientId) return;
      (map[data.patientId] = map[data.patientId] || new Set()).add(data.uid);
    });
  }
  ingest(snap);
  ingest(snapMhl);
  return map;
}

// Picks which tokens a given patient's alert should go to: only devices
// belonging to nurses that patient is currently allocated to. If NO nurse
// has allocated themselves to that patient, nobody gets alerted for it —
// deliberately, per hospital policy: an alert should only ever reach the
// nurse actually responsible for that patient, never an admin/subadmin
// device just because they happen to hold that role. Still logs a warning
// so an unallocated-but-overdue patient is visible in the Cloud Function
// logs, even though no push goes out.
function tokensForPatient(patientId, tokenEntries, allocatedUidsByPatient, patientLabel) {
  const allocatedUids = allocatedUidsByPatient[patientId];
  if (allocatedUids && allocatedUids.size > 0) {
    return tokenEntries.filter((t) => allocatedUids.has(t.uid));
  }
  console.warn(`No nurse allocated to ${patientLabel || patientId} — no alert sent (allocated-only alerting).`);
  return [];
}

// Fires automatically after every write to a patient's drug chart (i.e.
// every DrugCourseChart.jsx saveChart() call — see src/pages/
// DrugCourseChart.jsx, chartRefPath.current = doc(db, 'patients',
// patientId, 'drugCourseChart', 'main')). Recomputes nextDoseAt — the
// EARLIEST computeDueAt across this patient's Ongoing, schedulable drugs —
// using the exact same computeDueAt already used by checkDueDrugs below
// (imported from ./lib/dueLogic, not re-implemented here), and stores it on
// the same chart doc so checkDueDrugs can query
// `where('nextDoseAt', '<=', now)` instead of scanning every chart every
// cycle. This keeps computeDueAt defined in exactly ONE place — no new
// hand-sync burden, no client-side duplication, no risk of the write path
// silently drifting from the alert logic.
//
// Deliberately does NOT apply the admin alarmSettings.frequencies toggle
// (checkDueDrugs does that) — that setting lives in a separate doc and can
// change at any time independent of this chart's own writes, so baking it
// into nextDoseAt here could leave a chart's nextDoseAt stuck excluding a
// drug the admin later re-enables, with nothing to re-trigger this trigger.
// Being over-inclusive here is safe: checkDueDrugs still does its own
// per-drug alarmSettings/quiet-hours/overdue-repeat filtering before it
// actually sends anything — nextDoseAt only narrows which chart docs are
// even considered.
exports.updateNextDoseAt = onDocumentWritten(
  { document: 'patients/{patientId}/drugCourseChart/{chartId}', region: 'us-central1' },
  async (event) => {
    if (event.params.chartId !== 'main') return; // this collection only ever holds one doc, 'main'

    const after = event.data && event.data.after;
    if (!after || !after.exists) return; // doc deleted — nothing to compute

    const data = after.data() || {};
    const drugs = Array.isArray(data.drugs) ? data.drugs : [];
    const chartRows = Array.isArray(data.rows) ? data.rows : [];

    let earliest = null;
    drugs.forEach((drug, i) => {
      if (drug.action && drug.action !== 'Ongoing') return; // discontinued/withheld/completed/other
      if (!isSchedulable(drug.frequency)) return; // STAT / PRN / custom text — not covered

      const dueAt = computeDueAt(drug, chartRows, i);
      if (!dueAt) return;
      if (!earliest || dueAt < earliest) earliest = dueAt;
    });

    const newValue = earliest ? admin.firestore.Timestamp.fromDate(earliest) : null;

    // Self-trigger-loop guard: this write itself re-fires this same
    // trigger. Compare the freshly computed value against what's already
    // stored and skip the write when nothing changed — the recursive
    // invocation then sees the same drugs/rows, recomputes the identical
    // value, finds it already matches, and stops. This is the standard
    // pattern for onDocumentWritten triggers that write back to the
    // document they're watching.
    const existing = data.nextDoseAt || null;
    const existingMs = existing && existing.toMillis ? existing.toMillis() : null;
    const newMs = newValue ? newValue.toMillis() : null;
    if (existingMs === newMs) return;

    await after.ref.set({ nextDoseAt: newValue }, { merge: true });
  }
);

// Every 5 minutes. Queries only chart docs with something currently due
// (nextDoseAt <= now, kept fresh by updateNextDoseAt above) instead of
// scanning every patient's chart every cycle, then narrows the
// patients/users/allocation reads down to just that cycle's actually-due
// patients — see the collectionGroup query, db.getAll(...), and
// getTokenEntriesForUids(...) below.
exports.checkDueDrugs = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Africa/Lagos', region: 'us-central1' },
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

    const [dueChartsSnap, allocatedUidsByPatient] = await Promise.all([
      db.collectionGroup('drugCourseChart')
        .where('nextDoseAt', '<=', admin.firestore.Timestamp.fromDate(now))
        .get(),
      loadAllocatedUidsByPatient()
    ]);

    // this collection only ever holds one doc, 'main' — collectionGroup
    // scope theoretically returns other doc ids too, so keep the guard.
    const dueChartDocs = dueChartsSnap.docs.filter((d) => d.id === 'main');
    if (dueChartDocs.length === 0) {
      console.log('No doses due this cycle.');
      return;
    }

    const patientIds = [...new Set(dueChartDocs.map((d) => d.ref.parent.parent.id))];

    const patientsSnap = await db.getAll(...patientIds.map((id) => db.collection('patients').doc(id)));
    const patientNames = {};
    patientsSnap.forEach((d) => { patientNames[d.id] = (d.exists && d.data().name) || 'Unnamed patient'; });

    // Only nurses allocated to one of THIS cycle's due patients need their
    // tokens loaded — scoped via allocatedUidsByPatient instead of every
    // user, per getTokenEntriesForUids above.
    const scopedUids = new Set();
    patientIds.forEach((pid) => {
      const uids = allocatedUidsByPatient[pid];
      if (uids) uids.forEach((u) => scopedUids.add(u));
    });
    const tokenEntries = await getTokenEntriesForUids([...scopedUids]);
    if (tokenEntries.length === 0) {
      console.log('No allocated nurses with push tokens for this cycle\'s due patients — nothing to send.');
      return;
    }

    const dueByPatient = {}; // patientId -> [ "Drug name (FREQ)" ]
    const chartUpdates = [];

    dueChartDocs.forEach((chartDoc) => {
      const patientId = chartDoc.ref.parent.parent.id;
      const data = chartDoc.data();
      const drugs = Array.isArray(data.drugs) ? data.drugs : [];
      const chartRows = Array.isArray(data.rows) ? data.rows : [];
      let changed = false;

      drugs.forEach((drug, i) => {
        const doseSeq = parseDoseSequence(drug.frequency);
        if (!doseSeq && !intervalHoursFor(drug.frequency)) return; // STAT / PRN / custom text — not covered yet
        // The admin's alert-frequency toggle list only ever offers fixed,
        // literal frequency strings (see ALL_FREQUENCIES in
        // src/lib/alarm-settings.js) — a dose-sequence like "0,12,24hr" (or
        // any other hour-offset list a doctor types) can't be represented
        // there, so it's always alerted rather than silently dropped.
        if (!doseSeq && !alarmSettings.frequencies.includes(drug.frequency)) return; // admin turned this frequency off
        if (drug.action && drug.action !== 'Ongoing') return; // discontinued/withheld/completed/other

        const dueAt = computeDueAt(drug, chartRows, i);
        if (!dueAt || dueAt > now) return;

        const dueSlotKey = dueAt.toISOString();
        if (drug.lastAlertedFor === dueSlotKey) {
          // Already sent at least one alert for this exact dose. If it's
          // STILL overdue (no new administration row has come in — that
          // would've moved dueSlotKey forward via lastGivenFor/computeDueAt),
          // keep re-alerting every overdueRepeatMinutes rather than going
          // silent for the rest of the shift. This is the fix for doses that
          // go overdue and never get a second alarm.
          const lastAlertedAt = drug.lastAlertedAt ? new Date(drug.lastAlertedAt) : null;
          const elapsedMs = lastAlertedAt ? now.getTime() - lastAlertedAt.getTime() : Infinity;
          if (elapsedMs < alarmSettings.overdueRepeatMinutes * 60 * 1000) return;
        }

        const isRepeat = drug.lastAlertedFor === dueSlotKey; // set before we overwrite it below
        drug.lastAlertedFor = dueSlotKey;
        drug.lastAlertedAt = now.toISOString();
        changed = true;

        const label = `${drug.name || 'Unnamed drug'} (${drug.frequency})${isRepeat ? ' — still overdue' : ''}`;
        (dueByPatient[patientId] = dueByPatient[patientId] || []).push(label);
      });

      if (changed) chartUpdates.push(chartDoc.ref.update({ drugs }));
    });

    const duePatientIds = Object.keys(dueByPatient);
    if (duePatientIds.length === 0) {
      await Promise.all(chartUpdates);
      console.log('No doses due this cycle.');
      return;
    }

    let totalRecipientSends = 0;

    const sends = duePatientIds.map(async (patientId) => {
      const labels = dueByPatient[patientId];
      const name = patientNames[patientId] || 'a patient';
      const title = labels.length === 1 ? `Drug due — ${name}` : `${labels.length} drugs due — ${name}`;
      const body = labels.slice(0, 3).join(', ') + (labels.length > 3 ? `, +${labels.length - 3} more` : '');

      // Scoped to this patient's allocated nurse(s) — see tokensForPatient
      // above — instead of every nurse in the ward.
      const recipientEntries = tokensForPatient(patientId, tokenEntries, allocatedUidsByPatient, name);
      if (recipientEntries.length === 0) {
        console.log(`No allocated nurse for ${name} — no alert sent.`);
        return;
      }
      const recipientTokens = recipientEntries.map((t) => t.token);
      totalRecipientSends += recipientTokens.length;

      const resp = await messaging.sendEachForMulticast({
        tokens: recipientTokens,
        // Data-only on purpose — NOT a top-level `notification` field. When a
        // push carries a `notification` payload, the browser's FCM SDK
        // auto-displays it itself while the app is backgrounded/closed and
        // skips sw.js's onBackgroundMessage entirely, so our own
        // showNotification() call (with the flat `data: {link}` the
        // notificationclick handler below expects) never runs. Firebase's
        // own auto-display instead wraps the whole payload under an internal
        // key, so event.notification.data.link comes back undefined and
        // sw.js's notificationclick falls back to '/' — tapping the alert
        // opens the home page instead of the chart. Keeping this data-only
        // guarantees onBackgroundMessage (and our own link-carrying
        // showNotification call) always runs.
        data: {
          title,
          body,
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

      // recipientEntries (not the full tokenEntries) is what resp's indices
      // line up with, since each patient can be sent to a different, scoped
      // subset of devices now. Deleting an already-deleted token doc is a
      // harmless no-op, so no need to dedupe this across patients.
      resp.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code || '';
        // Token is stale (app uninstalled, permission revoked, etc.) — remove it
        // so future cycles don't keep trying to send to it.
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          chartUpdates.push(recipientEntries[idx].ref.delete());
        }
      });
    });

    await Promise.all([...chartUpdates, ...sends]);
    console.log(`Sent due-dose alerts for ${duePatientIds.length} patient(s), ${totalRecipientSends} send(s) total.`);
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
  // minInstances: 1 keeps one instance warm so a message push never waits on
  // a cold start (2nd-gen functions scale to zero by default, and a cold
  // start here was adding several seconds before the recipient's phone saw
  // anything — the whole point of a chat push is that it's near-instant).
  { document: 'conversations/{convoId}/messages/{messageId}', region: 'us-central1', minInstances: 1 },
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
      // Data-only — see the drug-due send above for why.
      data: {
        title,
        body,
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

// -- Overall Nurse appointment alert -----------------------------------
//
// When an admin/subadmin appoints (or changes) the Overall Nurse for a week
// (nurseReportRoles/<weekId>.overallNurse), tell the appointed nurse on her
// phone. Only fires when the appointed uid actually changes, so re-saving
// the same appointment doesn't buzz her again. Uses the same pushTokens
// subcollection as the other alerts (she must have enabled alerts once).
exports.onOverallNurseAppointed = onDocumentWritten(
  { document: 'nurseReportRoles/{weekId}', region: 'us-central1' },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const newUid = after && after.overallNurse && after.overallNurse.uid;
    const oldUid = before && before.overallNurse && before.overallNurse.uid;
    if (!newUid || newUid === oldUid) return;

    const tokensSnap = await db.collection('users').doc(newUid).collection('pushTokens').get();
    const tokenEntries = [];
    tokensSnap.forEach((t) => { if (t.data().token) tokenEntries.push({ token: t.data().token, ref: t.ref }); });
    if (tokenEntries.length === 0) return;

    const weekId = event.params.weekId;
    const resp = await messaging.sendEachForMulticast({
      tokens: tokenEntries.map((t) => t.token),
      data: {
        title: 'You are the Overall Nurse this week',
        body: 'You have been appointed Overall Nurse. Tap to open the Overall Nurse page.',
        link: '/nurses-report/overall-nurse',
        tag: `overall-${weekId}`
      },
      android: {
        priority: 'high',
        notification: { channelId: 'dose-due-alerts', sound: 'default' }
      }
    });

    const cleanup = [];
    resp.responses.forEach((r, idx) => {
      if (r.success) return;
      const code = (r.error && r.error.code) || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
        cleanup.push(tokenEntries[idx].ref.delete());
      }
    });
    await Promise.all(cleanup);
    console.log(`Sent Overall Nurse appointment alert to ${newUid} for week ${weekId}.`);
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

// Server-side backstop for allocation cleanup on discharge/refer/transfer.
// Both apps' client code (68's patientAdminStatus.js/DrugCourseChart.jsx,
// MHL's Svelte equivalent) already deletes the ACTING nurse's own
// allocation doc as soon as they apply the status change — but Firestore
// rules only let a nurse delete her own allocation doc (`resource.data.uid
// == request.auth.uid` on both allocations/ and allocations_mhl/, see
// firestore.rules), so if a DIFFERENT nurse had allocated themselves to
// the same patient earlier (e.g. the previous shift, or someone covering
// another ward), that doc can't be cleaned up client-side — it would sit
// there, stale, still routing this patient's due-dose/glucose alerts to a
// nurse who's no longer involved. Running with Admin SDK privileges here
// bypasses that rule to clean up every allocation for the patient, from
// either hospital's collection, regardless of who created it.
//
// Fires on any /patients/{patientId} update and inspects before/after
// rather than requiring a specific caller, so it's a backstop against ANY
// path that ends a patient's admission or moves their ward — not just the
// two client call sites that already know to clean up after themselves.
exports.clearAllocationsOnPatientStatusChange = onDocumentUpdated(
  { document: 'patients/{patientId}', region: 'us-central1' },
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const patientId = event.params.patientId;

    // Discharge/refer: dischargeStatusAt is set fresh (as a Timestamp) the
    // moment applyPatientStatus/applyStatusAction archives the admission —
    // comparing the millis (not just truthiness) means a later re-tag with
    // the exact same status/timestamp value can't be mistaken for "no
    // change" and skipped, though in practice each discharge/refer always
    // gets its own serverTimestamp() so this is mostly belt-and-braces.
    const beforeDischargeMs = before.dischargeStatusAt && before.dischargeStatusAt.toMillis ? before.dischargeStatusAt.toMillis() : 0;
    const afterDischargeMs = after.dischargeStatusAt && after.dischargeStatusAt.toMillis ? after.dischargeStatusAt.toMillis() : 0;
    const justDischarged = !!after.dischargeStatus && afterDischargeMs !== beforeDischargeMs;

    // Transfer: either hospital's pendingTransfer(Mhl) field gets freshly
    // set with a new transferredAt the moment the sending ward starts the
    // transfer (see applyPatientStatus's 'transferred' branch / its MHL
    // equivalent) — the admission carries on, just on a different ward, so
    // the sending ward's claim on this patient no longer applies.
    function transferJustStarted(field) {
      const b = before[field] && before[field].transferredAt && before[field].transferredAt.toMillis ? before[field].transferredAt.toMillis() : 0;
      const a = after[field] && after[field].transferredAt && after[field].transferredAt.toMillis ? after[field].transferredAt.toMillis() : 0;
      return !!(after[field] && a && a !== b);
    }

    if (!justDischarged && !transferJustStarted('pendingTransfer') && !transferJustStarted('pendingTransferMhl')) return;

    const [snap, snapMhl] = await Promise.all([
      db.collection('allocations').where('patientId', '==', patientId).get(),
      db.collection('allocations_mhl').where('patientId', '==', patientId).get()
    ]);
    const refs = [...snap.docs, ...snapMhl.docs].map((d) => d.ref);
    if (refs.length === 0) return;
    await Promise.all(refs.map((r) => r.delete()));
    console.log(`Cleared ${refs.length} allocation(s) for patient ${patientId} after status change.`);
  }
);
