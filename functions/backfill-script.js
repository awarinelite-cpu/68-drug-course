// functions/backfill-script.js
//
// One-off script: sets `nextDoseAt` on every EXISTING patients/{id}/
// drugCourseChart/main doc, using the exact same computeDueAt as the
// updateNextDoseAt Cloud Function and checkDueDrugs (imported from
// ./lib/dueLogic.js, not re-implemented here) — so nothing gets missed
// when checkDueDrugs switches to querying
// `where('nextDoseAt', '<=', now)`. Going forward, updateNextDoseAt keeps
// this field current automatically on every chart save; this script only
// needs to run ONCE, before deploying the updated checkDueDrugs, to
// backfill the charts that predate the trigger.
//
// Lives inside functions/ (not the repo root) so it can `require` the
// already-installed firebase-admin/dueLogic without a separate npm install.
//
// Run manually, from the functions/ directory:
//   cd functions
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node backfill-script.js
//
// The service account needs Firestore read/write on the
// gen-lang-client-0406053716 ("Neo1") project — e.g. a key downloaded from
// Firebase Console > Project settings > Service accounts > Generate new
// private key. If you'd rather not handle a key file, wrap the same
// earliestDueAtFor() logic below in a temporary onCall/onRequest function,
// deploy it, trigger it once, then delete it — but a plain `node` run with
// a service account key is the simplest one-shot option.
//
// Safe to re-run: it recomputes and overwrites nextDoseAt from the current
// drugs/rows on each doc every time, so running it twice just re-derives
// the same values (unless a chart genuinely changed in between runs).

'use strict';

const admin = require('firebase-admin');
const { computeDueAt, isSchedulable } = require('./lib/dueLogic');

admin.initializeApp({ projectId: 'gen-lang-client-0406053716' });
const db = admin.firestore();

function earliestDueAtFor(data) {
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
  return earliest;
}

async function main() {
  const chartsSnap = await db.collectionGroup('drugCourseChart').get();
  const mainDocs = chartsSnap.docs.filter((d) => d.id === 'main');

  console.log(`Found ${mainDocs.length} drugCourseChart/main doc(s) to backfill.`);

  let updated = 0;
  let skippedAlreadyCorrect = 0;
  let failed = 0;

  // Sequential, not Promise.all — this is a one-off script, not a
  // latency-sensitive Cloud Function; no need to hammer Firestore with
  // hundreds of concurrent writes at once. (Each write also re-fires
  // updateNextDoseAt once deployed, which will find nothing changed and
  // skip its own write, per its self-trigger-loop guard.)
  for (const doc of mainDocs) {
    const patientId = doc.ref.parent.parent.id;
    try {
      const data = doc.data() || {};
      const earliest = earliestDueAtFor(data);
      const newValue = earliest ? admin.firestore.Timestamp.fromDate(earliest) : null;

      const existing = data.nextDoseAt || null;
      const existingMs = existing && existing.toMillis ? existing.toMillis() : null;
      const newMs = newValue ? newValue.toMillis() : null;

      if (existingMs === newMs) {
        skippedAlreadyCorrect++;
        continue;
      }

      await doc.ref.set({ nextDoseAt: newValue }, { merge: true });
      updated++;
      console.log(`  patient ${patientId}: nextDoseAt -> ${earliest ? earliest.toISOString() : 'null'}`);
    } catch (e) {
      failed++;
      console.error(`  patient ${patientId}: FAILED —`, e.message || e);
    }
  }

  console.log(`\nDone. Updated ${updated}, already correct ${skippedAlreadyCorrect}, failed ${failed}.`);
  if (failed > 0) {
    console.error('Some docs failed — re-run this script to retry just those (it is safe to re-run).');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Backfill script crashed:', e);
  process.exitCode = 1;
});
