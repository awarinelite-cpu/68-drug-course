// functions/lib/dueLogic.js
//
// Single source of truth for "when is this drug's next dose due" — pulled
// out of functions/index.js so the checkDueDrugs schedule, the
// updateNextDoseAt onDocumentWritten trigger, AND the one-off backfill
// script (../../backfill-script.js) all call the exact same computeDueAt,
// instead of each keeping its own hand-synced copy. This is a pure move,
// not a rewrite — the logic below is byte-for-byte what used to live
// directly in functions/index.js.
//
// The CLIENT-SIDE mirror in src/lib/drugChartHelpers.js is a separate,
// deliberate exception to "one place" — it runs in the browser and can't
// require() this CommonJS file, so it stays hand-synced. That duplication
// is called out in comments in both files; nothing here changes that.
//
// Pure logic only: no Firebase imports, no admin SDK, so this file can be
// required from anywhere (a Cloud Function, or a plain `node` script) with
// zero setup.

'use strict';

// Ward is Africa/Lagos — WAT, UTC+1 year-round, no DST — so this offset is
// safe to hardcode rather than depending on the process's TZ.
const WARD_UTC_OFFSET = '+01:00';

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
// src/lib/drugChartHelpers.js (kept in sync by hand, since that file is an
// ES module written for the browser and can't require() this file).
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
// parseDoseSequence in src/lib/drugChartHelpers.js. A doctor writes a
// loading dose followed by fixed hour-offsets rather than one repeating
// interval; this recognizes that pattern so the scheduler can step through
// its own hour-gaps (12h each for "0,12,24hr") instead of skipping it.
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
// in src/lib/drugChartHelpers.js, but only needs the count here.
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

// Chart rows are matched back to a drug by its "S/N" column, which contains
// the drug's 1-based row number.
function lastGivenFor(drugIndex, chartRows) {
  let latest = null;
  for (const row of chartRows || []) {
    const nums = (row.sno || '').match(/\d+/g) || [];
    const givenMatch = nums.some((n) => parseInt(n, 10) === drugIndex + 1);
    // A drug documented as "not given" (reason written via the Select
    // Drug(s) Given picker's pencil icon) still advances the due clock the
    // same as an actual dose — it just isn't counted as given anywhere else
    // (dose-sequence ticks, auto-complete). Without this, the scheduler
    // would keep re-firing the overdue alert for a dose the nurse already
    // explicitly accounted for.
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

// True only for a frequency computeDueAt can actually schedule (a fixed
// dose-sequence, or a plain/weekly repeating interval). STAT, PRN, and any
// other free-text frequency return false — there's no reliable interval to
// schedule from. Callers MUST check this before calling computeDueAt:
// computeDueAt itself doesn't guard against an unschedulable frequency, so
// calling it on a STAT/PRN drug that's never been given would silently
// anchor it to activatedAt/startDate/createdAt and treat it as immediately
// due — and if it HAS been given, `intervalHoursFor` returns null and the
// arithmetic produces an Invalid Date. This mirrors the
// `if (!doseSeq && !intervalHoursFor(...)) return;` guard that used to be
// inline in checkDueDrugs.
function isSchedulable(frequency) {
  return !!(parseDoseSequence(frequency) || intervalHoursFor(frequency));
}

module.exports = {
  WARD_UTC_OFFSET,
  INTERVAL_HOURS,
  parseWeeklyFrequency,
  intervalHoursFor,
  parseDoseSequence,
  administrationCountFor,
  toWardDate,
  lastGivenFor,
  computeDueAt,
  isSchedulable
};
