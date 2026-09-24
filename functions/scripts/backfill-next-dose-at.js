// functions/scripts/backfill-next-dose-at.js
//
// One-time migration: sets nextDoseAt on every existing
// patients/*/drugCourseChart/main doc so the new indexed query in
// checkDueDrugs (functions/index.js:
// collectionGroup('drugCourseChart').where('nextDoseAt','<=',now)) picks up
// already-in-progress drug courses from the very first run after deploy.
//
// WITHOUT running this once, a chart that nobody happens to open+save after
// the deploy has no nextDoseAt field yet and will never be matched by that
// query — its due doses would silently stop alerting until a nurse next
// opens and saves that specific chart (which triggers the client-side
// computeChartNextDoseAt write in DrugCourseChart.jsx's saveChart). Run this
// BEFORE (or immediately after) deploying the new checkDueDrugs, not weeks
// later.
//
// Idempotent (just recomputes the same value from current chart data each
// time) and safe to run while the app is live — it's a one-time full
// collection-group scan, not a recurring job, so the read cost is a single
// one-off expense, not an ongoing per-minute one.
//
// Usage:
//   cd functions
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/backfill-next-dose-at.js
// (or run from an environment already authenticated as a project
// editor/owner, e.g. Cloud Shell with the right project selected — then
// GOOGLE_APPLICATION_CREDENTIALS isn't needed).

const admin = require('firebase-admin');
// Reuses index.js's own admin.initializeApp()/db/computeChartNextDoseAt —
// requiring it here does NOT deploy or invoke any of its Cloud Functions,
// it just runs the top-level setup code in this Node process.
const { computeChartNextDoseAt } = require('../index.js')._internal;
const db = admin.firestore();

async function main() {
  const chartsSnap = await db.collectionGroup('drugCourseChart').get();
  let updated = 0, cleared = 0, skipped = 0;
  const writes = [];

  chartsSnap.forEach((doc) => {
    if (doc.id !== 'main') { skipped++; return; } // this collection only ever holds one doc, 'main'
    const data = doc.data();
    const drugs = Array.isArray(data.drugs) ? data.drugs : [];
    const chartRows = Array.isArray(data.rows) ? data.rows : [];
    const nextDoseAt = computeChartNextDoseAt(drugs, chartRows);

    if (nextDoseAt) {
      writes.push(doc.ref.update({ nextDoseAt }));
      updated++;
    } else if (data.nextDoseAt !== undefined) {
      // No eligible drug on this chart (empty, discharged, or STAT/PRN-only)
      // but an old/stray value is sitting there — clear it so it can't keep
      // matching the query forever.
      writes.push(doc.ref.update({ nextDoseAt: admin.firestore.FieldValue.delete() }));
      cleared++;
    }
  });

  await Promise.all(writes);
  console.log(`Backfill complete: ${updated} chart(s) got a nextDoseAt, ${cleared} cleared, ${skipped} non-'main' doc(s) skipped.`);
}

main().catch((e) => {
  console.error('Backfill failed:', e);
  process.exit(1);
});
