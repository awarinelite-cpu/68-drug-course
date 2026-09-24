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
  OD: 24, Mane: 24, Nocte: 24, AM: 24, PM: 24, HS: 24,
  BD: 12, TDS: 8, QDS: 6, QOD: 48,
  Q4H: 4, Q6H: 6, Q8H: 8, Q12H: 12,
  Weekly: 168,
  'STAT then Q4H': 4, 'STAT then Q6H': 6, 'STAT then Q8H': 8, 'STAT then Q12H': 12
};

// Open-ended "N times weekly" frequencies ("Twice Weekly", "Thrice Weekly",
// "4x Weekly", ...) aren't fixed keys in INTERVAL_HOURS above since the
// count is unbounded — mirrors parseWeeklyFrequency in
// src/lib/drugChartHelpers.js (kept in sync by hand, same as INTERVAL_HOURS
// itself, since that file is an ES module and this is a CommonJS Function).
const WEEKLY_WORD_MULTIPLIERS = { once: 1, twice: 2, thrice: 3, four: 4, five: 5, six: 6, seven: 7 };
function parseWeeklyFrequency(freqText) {
  const t = (freqText || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t === 'weekly') return 1;
  const word = t.replace(/\s*weekly$/, '');
  if (/ weekly$/.test(t) && WEEKLY_WORD_MULTIPLIERS[word]) return WEEKLY_WORD_MULTIPLIERS[word];
  let m = t.match(/^(\d+)\s*(?:x|times)\s*weekly$/);
  if (m) return parseInt(m[1], 10);
  m = t.match(/^(\d+)\s*\/\s*week(?:ly)?$/);
  if (m) return parseInt(m[1], 10);
  return null;
}
function intervalHoursFor(frequency) {
  const fixed = INTERVAL_HOURS[frequency];
  if (fixed) return fixed;
  const weeklyN = parseWeeklyFrequency(frequency);
  return weeklyN ? (7 * 24) / weeklyN : null;
}

// Fixed dose-sequence frequencies (e.g. "0,12,24hr") — mirrors
// parseDoseSequence in src/lib/drugChartHelpers.js (kept in sync by hand,
// same as INTERVAL_HOURS/parseWeeklyFrequency above, since that file is an
// ES module and this is a CommonJS Function). A doctor writes a loading
// dose followed by fixed hour-offsets rather than one repeating interval;
// this recognizes that pattern so the scheduler can step through its own
// hour-gaps (12h each for "0,12,24hr") instead of skipping it entirely.
function parseDoseSequence(freqText) {
  if (!freqText) return null;
  const text = freqText.trim();
  const statThen = text.match(
    /^stat\b[,\s]*then\b.*?(\d+)\s*(?:hrly|hourly|hr|hrs|hours?)\b.*?(\d+)\s*(?:hr|hrs|hours?)\b/i
  );
  if (statThen) {
    const interval = parseInt(statThen[1], 10);
    const total = parseInt(statThen[2], 10);
    if (interval > 0 && total >= interval) {
      const nums = [];
      for (let h = 0; h <= total; h += interval) nums.push(h);
      if (nums.length >= 2) return nums;
    }
  }
  const hourMatches = [...text.matchAll(/(\d+)\s*(?:hrs?|hours?)\b/gi)];
  if (hourMatches.length >= 2) {
    const nums = [...new Set(hourMatches.map((m) => parseInt(m[1], 10)))].sort((a, b) => a - b);
    if (nums.length >= 2) return nums;
  }
  const compact = text.replace(/\s+/g, '');
  const m = compact.match(/^(\d+(?:,\d+)+)(hrs?|hours?|h)?$/i);
  if (!m) return null;
  const nums = [...new Set(m[1].split(',').map((n) => parseInt(n, 10)))].sort((a, b) => a - b);
  return nums.length >= 2 ? nums : null;
}

// Count of doses actually recorded as given for this drug (matched by Drug
// S/N on the chart below) — mirrors administrationTimesFor's row-matching
// in src/lib/drugChartHelpers.js, but only needs the count here, not the
// timestamps themselves (lastGivenFor below already gets the latest one).
function administrationCountFor(drugIndex, chartRows) {
  let count = 0;
  for (const row of chartRows || []) {
    const nums = (row.sno || '').match(/\d+/g) || [];
    if (nums.some((n) => parseInt(n, 10) === drugIndex + 1)) count++;
  }
  return count;
}

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

// Chart rows are matched back to a drug by its "S/N" column, which contains
// the drug's 1-based row number (see refreshDrugSnoList() in
// charts/drug-course-chart.html) — same lookup drug-course-chart.html itself
// uses to infer a drug's start date from its administration history.
function lastGivenFor(drugIndex, chartRows) {
  let latest = null;
  for (const row of chartRows || []) {
    const nums = (row.sno || '').match(/\d+/g) || [];
    const givenMatch = nums.some((n) => parseInt(n, 10) === drugIndex + 1);
    // A drug that was documented as "not given" (reason written via the
    // Select Drug(s) Given picker's pencil icon) still advances the due
    // clock the same as an actual dose — it just isn't counted as given
    // anywhere else (dose-sequence ticks, auto-complete). Without this, the
    // scheduler would keep re-firing the overdue alert for a dose the nurse
    // already explicitly accounted for.
    const skippedMatch = Array.isArray(row.skipped) &&
      row.skipped.some((s) => s && parseInt(s.num, 10) === drugIndex + 1);
    if (!givenMatch && !skippedMatch) continue;
    const dt = toWardDate(row.date, row.time);
    if (dt && (!latest || dt > latest)) latest = dt;
  }
  return latest;
}

function computeDueAt(drug, chartRows, drugIndex) {
  // Fixed dose-sequence (e.g. "0,12,24hr"): step through the sequence's own
  // hour-gaps (12h each, for that example) instead of one repeating
  // interval — see parseDoseSequence above and computeDueAt in
  // src/lib/drugChartHelpers.js (client-side twin of this function).
  const seq = parseDoseSequence(drug.frequency);
  if (seq) {
    const givenCount = administrationCountFor(drugIndex, chartRows);
    if (givenCount >= seq.length) return null; // sequence complete
    if (givenCount === 0) {
      if (drug.activatedAt) { const at = new Date(drug.activatedAt); if (!isNaN(at.getTime())) return at; }
      if (drug.startDate) return toWardDate(drug.startDate, '00:00');
      if (drug.createdAt) {
        const d = new Date(drug.createdAt);
        return isNaN(d.getTime()) ? null : d;
      }
      return null;
    }
    const lastGiven = lastGivenFor(drugIndex, chartRows);
    if (!lastGiven) return null;
    const stepHours = seq[givenCount] - seq[givenCount - 1];
    return new Date(lastGiven.getTime() + stepHours * 3600 * 1000);
  }

  const lastGiven = lastGivenFor(drugIndex, chartRows);
  if (lastGiven) {
    const intervalHours = intervalHoursFor(drug.frequency);
    return new Date(lastGiven.getTime() + intervalHours * 3600 * 1000);
  }
  // Never administered yet — anchor to whichever of these is available.
  // A follow-on drug (2nd half of an "X then Y" order) is due from the moment
  // it was activated, not midnight of that day.
  if (drug.activatedAt) { const at = new Date(drug.activatedAt); if (!isNaN(at.getTime())) return at; }
  if (drug.startDate) return toWardDate(drug.startDate, '00:00');
  if (drug.createdAt) {
    const d = new Date(drug.createdAt);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Earliest due time across every currently-relevant drug on a chart —
// server-side twin of computeChartNextDoseAt in src/lib/drugChartHelpers.js
// (kept in sync by hand, same as computeDueAt/INTERVAL_HOURS above). Used
// after checkDueDrugs processes a chart to refresh its nextDoseAt field, and
// by the one-time backfill script (scripts/backfill-next-dose-at.js) to seed
// it on every chart that predates this field.
//
// Deliberately does NOT consider the admin's Alarm Settings frequency
// on/off toggle (loadAlarmSettings().frequencies) — see the client-side
// twin's comment for why: this field must never end up LATER than a drug's
// true next-due moment, only ever earlier (a harmless, cheap extra
// candidate for checkDueDrugs's own per-drug filter below to discard).
function computeChartNextDoseAt(drugs, chartRows) {
  let earliest = null;
  (drugs || []).forEach((drug, i) => {
    if (drug.action && drug.action !== 'Ongoing') return;
    if (!parseDoseSequence(drug.frequency) && !intervalHoursFor(drug.frequency)) return;
    const dueAt = computeDueAt(drug, chartRows, i);
    if (dueAt && (!earliest || dueAt < earliest)) earliest = dueAt;
  });
  return earliest;
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
// Includes uid/role alongside each token so callers can scope a given
// patient's alert down to just the nurse(s) that patient is allocated to
// (see allocatedUidsByPatient / tokensForPatient below) rather than
// blasting every nurse in the building for every patient.
async function getTokenEntries(usersSnap) {
  const tokenEntries = []; // { token, ref, uid, role }
  await Promise.all(
    usersSnap.docs.map(async (u) => {
      const role = (u.data() || {}).role || '';
      const tokensSnap = await db.collection('users').doc(u.id).collection('pushTokens').get();
      tokensSnap.forEach((t) => {
        if (t.data().token) tokenEntries.push({ token: t.data().token, ref: t.ref, uid: u.id, role });
      });
    })
  );
  return tokenEntries;
}

// Scoped alternative to getTokenEntries above: reads pushTokens only for the
// given uids, instead of every user in the building. Used by checkDueDrugs
// now that its candidate set is already narrowed to this cycle's actually-
// due patients — role isn't included since neither this nor tokensForPatient
// below ever branches on it (allocated-only alerting has no admin/subadmin
// fallback), so there's no reason to also fetch each user doc just for that
// field. getTokenEntries(usersSnap) above is now unused within this file
// (was shared by checkDueGlucoseChecks, since removed) — left in place
// rather than deleted; flagged in the PR notes.
async function getTokenEntriesForUids(uids) {
  const tokenEntries = []; // { token, ref, uid }
  await Promise.all(
    uids.map(async (uid) => {
      const tokensSnap = await db.collection('users').doc(uid).collection('pushTokens').get();
      tokensSnap.forEach((t) => {
        if (t.data().token) tokenEntries.push({ token: t.data().token, ref: t.ref, uid });
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

    // Indexed pre-filter instead of pulling every chart in the building —
    // see computeChartNextDoseAt above for what this field means and why
    // it's safe to filter on directly (it can only be too early, never too
    // late, relative to a drug's true due time). Requires a collection-group
    // index on drugCourseChart.nextDoseAt — see firestore.indexes.json.
    const chartsSnap = await db.collectionGroup('drugCourseChart')
      .where('nextDoseAt', '<=', now)
      .get();

    if (chartsSnap.empty) {
      console.log('No charts with a due dose this cycle.');
      return;
    }

    // This collection only ever holds one doc, 'main' — guard anyway in
    // case of stray data from an old export/import.
    const candidateDocs = chartsSnap.docs.filter((d) => d.id === 'main');
    if (candidateDocs.length === 0) {
      console.log('No charts with a due dose this cycle.');
      return;
    }

    // Only fetch the specific patients these candidate charts belong to,
    // not the whole patients collection — a batched getAll() instead of
    // one .get() per id.
    const patientIds = [...new Set(candidateDocs.map((d) => d.ref.parent.parent.id))];
    const patientDocs = patientIds.length
      ? await db.getAll(...patientIds.map((id) => db.collection('patients').doc(id)))
      : [];
    const patientNames = {};
    patientDocs.forEach((d) => { if (d.exists) patientNames[d.id] = d.data().name || 'Unnamed patient'; });

    const dueByPatient = {}; // patientId -> [ "Drug name (FREQ)" ]
    const chartUpdates = [];

    candidateDocs.forEach((chartDoc) => {
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

      // Refresh nextDoseAt for the whole chart (every drug, not just the
      // one(s) that fired this cycle) so the next cycle's indexed query
      // reflects the true next due time. Only written when it actually
      // moved, to avoid a pointless write when nothing on this chart's due
      // schedule changed (e.g. this doc only matched because another drug
      // on it is still-overdue-and-repeating).
      const newNextDoseAt = computeChartNextDoseAt(drugs, chartRows);
      const prevMs = data.nextDoseAt && data.nextDoseAt.toMillis ? data.nextDoseAt.toMillis() : null;
      const newMs = newNextDoseAt ? newNextDoseAt.getTime() : null;
      const update = { drugs };
      if (newMs !== prevMs) update.nextDoseAt = newNextDoseAt || null;
      if (changed || update.nextDoseAt !== undefined) chartUpdates.push(chartDoc.ref.update(update));
    });

    const duePatientIds = Object.keys(dueByPatient);
    if (duePatientIds.length === 0) {
      await Promise.all(chartUpdates);
      console.log('No doses due this cycle.');
      return;
    }

    // allocations/allocations_mhl are only scanned once we know there's
    // actually something due to alert on this cycle — most 5-minute cycles
    // have nothing due at all now that the query above pre-filters, so this
    // full scan (still worth doing in full at this cadence — see PR notes)
    // is skipped entirely on those.
    const allocatedUidsByPatient = await loadAllocatedUidsByPatient();

    // Push tokens are read only for nurses actually allocated to THIS
    // cycle's due patients, not every user in the building.
    const scopedUids = new Set();
    duePatientIds.forEach((pid) => {
      const uids = allocatedUidsByPatient[pid];
      if (uids) uids.forEach((u) => scopedUids.add(u));
    });

    const tokenEntries = scopedUids.size ? await getTokenEntriesForUids([...scopedUids]) : [];
    if (tokenEntries.length === 0) {
      console.log('No allocated nurses with push tokens for this cycle\'s due patients.');
      await Promise.all(chartUpdates);
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
// Unlike the scheduled due-dose check above (which polls because "due" is a
// moving target computed from elapsed time), a chat message is
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

// Exposed only for scripts/backfill-next-dose-at.js (the one-time migration
// that seeds nextDoseAt on every chart that predates this field) — a plain
// object export, not an onSchedule/onCall/onDocumentX trigger, so
// `firebase deploy --only functions` ignores it; it isn't deployed.
exports._internal = { computeChartNextDoseAt };
