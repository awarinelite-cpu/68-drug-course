// functions/migration-backfill-tasks.js
//
// One-off script: for every patients/{id}/drugCourseChart/main doc that
// already has a `nextDoseAt` but no `scheduledTaskName`, create the
// corresponding Cloud Task. This is the Cloud-Tasks-flavored counterpart
// to backfill-script.js (which set nextDoseAt itself) — run this AFTER
// that one, and only once nextDoseAt is populated for every chart.
//
// Lives inside functions/ (not the repo root) so it can `require` the
// already-installed firebase-admin/cloudTasksClient without a separate
// npm install.
//
// Run manually, from the functions/ directory:
//   cd functions
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node migration-backfill-tasks.js --dry-run
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node migration-backfill-tasks.js --live
//
// The service account needs Firestore read/write AND Cloud Tasks
// enqueuer permissions on gen-lang-client-0406053716 ("Neo1"). Also
// requires SEND_DOSE_ALERT_URL to be set in the environment (same value
// used by functions/lib/cloudTasksClient.js) — sendDoseAlert must already
// be deployed before running this in --live mode.
//
// SAFETY:
//   - Defaults to --dry-run (logs what it WOULD do, creates nothing).
//   - Idempotent: skips any chart that already has a scheduledTaskName,
//     so it's safe to re-run after a partial failure.
//   - Rate-limited task creation (small concurrency cap + delay) rather
//     than firing hundreds of createTask calls at once.
//   - Does NOT touch nextDoseAt, drugs, or anything else —
//     scheduledTaskName only.

'use strict';

const admin = require('firebase-admin');

// Matches backfill-script.js's admin-init pattern (explicit projectId,
// not applicationDefault()).
admin.initializeApp({ projectId: 'gen-lang-client-0406053716' });
const db = admin.firestore();

const { scheduleDoseAlertTask } = require('./lib/cloudTasksClient');

const isLive = process.argv.includes('--live');
const CONCURRENCY = 5; // Cloud Tasks createTask calls in flight at once
const DELAY_BETWEEN_BATCHES_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processInBatches(items, worker, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(worker));
    results.push(...batchResults);
    if (i + concurrency < items.length) await sleep(DELAY_BETWEEN_BATCHES_MS);
  }
  return results;
}

async function main() {
  console.log(`Running in ${isLive ? 'LIVE' : 'DRY-RUN'} mode.`);
  if (!isLive) console.log('No tasks will actually be created. Pass --live to run for real.\n');

  // Same collectionGroup shape as backfill-script.js/checkDueDrugs, but no
  // upper time bound — we want EVERY chart with a currently-set
  // nextDoseAt, due or not, since each one needs its first-ever task.
  const snap = await db.collectionGroup('drugCourseChart').get();

  // This collection only ever holds one doc, 'main' — same guard used
  // elsewhere in index.js and backfill-script.js.
  const candidates = snap.docs.filter((d) => {
    if (d.id !== 'main') return false;
    const data = d.data();
    return !!data.nextDoseAt && !data.scheduledTaskName;
  });

  console.log(`Found ${snap.docs.length} chart doc(s) total, ${candidates.length} need a task created.\n`);

  let created = 0;
  let failed = 0;

  const results = await processInBatches(candidates, async (chartDoc) => {
    const patientId = chartDoc.ref.parent.parent.id;
    const chartId = chartDoc.id;
    const nextDoseAt = chartDoc.data().nextDoseAt;
    const dueAt = nextDoseAt.toDate ? nextDoseAt.toDate() : new Date(nextDoseAt);

    if (!isLive) {
      console.log(`[dry-run] would schedule task for patient=${patientId} chart=${chartId} dueAt=${dueAt.toISOString()}`);
      return;
    }

    const taskName = await scheduleDoseAlertTask({ patientId, chartId, dueAt });
    await chartDoc.ref.update({ scheduledTaskName: taskName });
    console.log(`created task for patient=${patientId} chart=${chartId} dueAt=${dueAt.toISOString()}`);
  }, CONCURRENCY);

  results.forEach((r) => {
    if (r.status === 'fulfilled') created++;
    else {
      failed++;
      console.error('FAILED:', r.reason);
    }
  });

  console.log(`\nDone. ${isLive ? 'Created' : 'Would create'}: ${created}. Failed: ${failed}.`);
  if (failed > 0) {
    console.log('Re-run the same command — this script is idempotent and will only retry the ones that failed (already-succeeded charts now have scheduledTaskName set, so they\'ll be skipped).');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Migration script crashed:', err);
  process.exitCode = 1;
});
