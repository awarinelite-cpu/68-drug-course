// Run: node test-sequential.mjs
// Checks that "X <freq> x <duration> then Y" orders split into two rows, the
// 2nd starting Inactive, and that it activates when the 1st is Completed.
import assert from 'node:assert/strict';
import { parseBulkText, activateFollowOnDrugs, withDrugCompletionChecked } from './src/lib/drugChartHelpers.js';

const cases = [
  ['IV Pentazocine 30mg 6 hourly x 48 hours then PRN for 2/7',
    { name: 'Pentazocine 30mg', route: 'IV', frequency: 'Q6H', duration: '48hrs' },
    { name: 'Pentazocine 30mg', route: 'IV', frequency: 'PRN', duration: '2/7' }],
  ['IV PCM 900mg 8 hourly x 72 hours then switch to Tabs PCM 1g TDS',
    { name: 'PCM 900mg', route: 'IV', frequency: 'Q8H', duration: '72hrs' },
    { name: 'PCM 1g', route: 'Oral', frequency: 'TDS', duration: '' }],
  ['IM Diclofenac 75mg 12 hourly x 72 hours then switch to Tabs Arthrotec 75mg BD',
    { name: 'Diclofenac 75mg', route: 'IM', frequency: 'Q12H', duration: '72hrs' },
    { name: 'Arthrotec 75mg', route: 'Oral', frequency: 'BD', duration: '' }],
];
for (const [line, a, b] of cases) {
  const [r1, r2, extra] = parseBulkText(line);
  assert.equal(extra, undefined);
  assert.deepEqual({ name: r1.name, route: r1.route, frequency: r1.frequency, duration: r1.duration }, a);
  assert.deepEqual({ name: r2.name, route: r2.route, frequency: r2.frequency, duration: r2.duration }, b);
  assert.notEqual(r1.action, 'Inactive');
  assert.equal(r2.action, 'Inactive');
  assert.equal(r2.startsAfterId, r1.id);
  assert.match(r2.actionNote, /^To be commenced when .+ is completed$/);
  const done = activateFollowOnDrugs([{ ...r1, action: 'Completed' }, r2]);
  assert.equal(done[1].action, 'Ongoing');
}

// Lines that must NOT be treated as sequential courses
assert.equal(parseBulkText('IVF normal saline 500mls fast over 30 mins then 500ml over 1 hr, then 500mls 4hrly').length, 3);
assert.equal(parseBulkText('Artesunate 120mg stat, then 8hrly 24hrs').length, 1);

// Auto-completion: 48h course whose first dose was 49h ago completes and starts the follow-on
const [a, b] = parseBulkText(cases[0][0]);
const t = new Date(Date.now() - 49 * 3600e3), p = (n) => String(n).padStart(2, '0');
const rows = [{ date: `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`, time: `${p(t.getHours())}:${p(t.getMinutes())}`, sno: '1', skipped: [] }];
const out = withDrugCompletionChecked([a, b], rows);
assert.equal(out[0].action, 'Completed');
assert.equal(out[1].action, 'Ongoing');
console.log('all sequential-prescription checks passed');
