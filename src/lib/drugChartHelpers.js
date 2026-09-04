export const ROUTE_OPTIONS = ['', 'Oral', 'IV', 'IM', 'SC', 'Sublingual', 'Topical', 'Rectal', 'Suppository', 'Inhalation', 'NG Tube', 'Other'];
export const FREQ_OPTIONS = ['', 'OD', 'BD', 'TDS', 'QDS', 'STAT', 'STAT then Q4H', 'STAT then Q6H', 'STAT then Q8H', 'STAT then Q12H', 'PRN', 'Q4H', 'Q6H', 'Q8H', 'Q12H', 'Weekly', '0,12,24hr', 'Other'];
export const ACTION_OPTIONS = ['', 'Ongoing', 'Completed', 'Discontinued', 'Withheld', 'Other'];
export const STATUS_LABELS = { referred: 'Referred to another hospital', transferred: 'Transferred to another ward', discharged: 'Discharged' };
export const WARD_OPTIONS = [
  '"A" WARD', 'ACCIDENT & EMERGENCY', 'GYNAE WARD', 'MATERNITY WARD', 'PEDIATRIC/NICU WARD',
  'THEATER', 'ICU', 'FEMALE MEDICAL WARD', 'FEMALE SURGICAL WARD', 'MALE MEDICAL WARD',
  'ORTHOPEDIC WARD', 'EXTENSION WARD', 'OFFICERS WARD'
];

const ACTION_COLORS = { Ongoing: '#2563eb', Completed: '#16a34a', Discontinued: '#dc2626', Withheld: '#d97706', Other: '#6b7280' };
export function actionColor(action) { return ACTION_COLORS[action] || '#9ca3af'; }

export function defaultRow() {
  return { date: '', sno: '', time: '', dose: 'AP', route: '', nurse: '', remark: '' };
}

// --- Next dose due time --------------------------------------------------
// Same computation as functions/index.js (which is what actually sends the
// push alert): next due = this drug's own last-administered time + its
// frequency's interval, or its start/created time if never given yet. Kept
// here too so a nurse can see it at a glance without waiting on a push.
export const INTERVAL_HOURS = { OD: 24, BD: 12, TDS: 8, QDS: 6, Q4H: 4, Q6H: 6, Q8H: 8, Q12H: 12, Weekly: 168, 'STAT then Q4H': 4, 'STAT then Q6H': 6, 'STAT then Q8H': 8, 'STAT then Q12H': 12 };

function toLocalDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const d = new Date(dateStr + 'T' + timeStr + ':00');
  return isNaN(d) ? null : d;
}

function lastGivenFor(chartRows, drugIndex) {
  const times = administrationTimesFor(chartRows, drugIndex);
  return times.length ? times[times.length - 1] : null;
}

// All recorded administration times for a drug (matched by Drug S/N on the
// chart below), oldest first. Used both for "last given" (dose-due calc)
// and for counting how many doses of a fixed-sequence/STAT drug have been
// given so far.
export function administrationTimesFor(chartRows, drugIndex) {
  const times = [];
  chartRows.forEach(row => {
    const nums = (row.sno || '').match(/\d+/g) || [];
    if (!nums.some(n => parseInt(n, 10) === drugIndex + 1)) return;
    const dt = toLocalDate(row.date, row.time);
    if (dt) times.push(dt);
  });
  times.sort((a, b) => a - b);
  return times;
}

// --- Fixed dose-sequence frequencies (e.g. "0,12,24hr") ---------------
// Some drugs (loading doses, staggered courses) aren't given at a repeating
// interval but at a fixed list of hour-offsets from the first dose — e.g.
// "Artesunate 120mg 0,12,24hr" means one dose at hour 0, another at hour 12,
// and a final one at hour 24. Recognizes this whenever the frequency text is
// just a comma-separated list of numbers (optionally suffixed "hr"/"hrs"/
// "hours"), whether picked from the dropdown or typed as a custom "Other"
// frequency — so it works for any drug with this kind of schedule, not just
// the exact "0,12,24hr" option in the list.
export function parseDoseSequence(freqText) {
  if (!freqText) return null;
  const compact = freqText.replace(/\s+/g, '');
  const m = compact.match(/^(\d+(?:,\d+)+)(hrs?|hours?|h)?$/i);
  if (!m) return null;
  const nums = [...new Set(m[1].split(',').map(n => parseInt(n, 10)))].sort((a, b) => a - b);
  return nums.length >= 2 ? nums : null;
}

export function computeDueAt(d, i, chartRows) {
  const intervalHours = INTERVAL_HOURS[d.frequency];
  if (!intervalHours) return null; // STAT / PRN / custom text — not covered
  if (d.action && d.action !== 'Ongoing') return null;

  const lastGiven = lastGivenFor(chartRows, i);
  if (lastGiven) return new Date(lastGiven.getTime() + intervalHours * 3600 * 1000);
  if (d.startDate) return toLocalDate(d.startDate, '00:00');
  if (d.createdAt) { const dt = new Date(d.createdAt); return isNaN(dt) ? null : dt; }
  return null;
}

export function dueLabelFor(d, i, chartRows, now) {
  const dueAt = computeDueAt(d, i, chartRows);
  if (!dueAt) return { text: '—', overdue: false };
  const sameDay = dueAt.toDateString() === now.toDateString();
  const hhmm = dueAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayPart = sameDay ? '' : (dueAt.toDateString() === new Date(now.getTime() + 86400000).toDateString() ? 'Tmrw ' : dueAt.toLocaleDateString([], { weekday: 'short' }) + ' ');
  if (dueAt <= now) return { text: 'Overdue ' + dayPart + hhmm, overdue: true };
  return { text: dayPart + hhmm, overdue: false };
}

// --- Auto-complete a drug once its Duration has elapsed ---
// Accepts common shorthand: "3/7" (3 days), "2/52" (2 weeks), "1/12" (1 month),
// "5 days", "2 weeks", "1 month", or a bare number (treated as days).
export function parseDurationDays(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  let m = t.match(/^(\d+)\s*\/\s*7$/);
  if (m) return parseInt(m[1], 10);
  m = t.match(/^(\d+)\s*\/\s*52$/);
  if (m) return parseInt(m[1], 10) * 7;
  m = t.match(/^(\d+)\s*\/\s*12$/);
  if (m) return parseInt(m[1], 10) * 30;
  m = t.match(/^(\d+)\s*(day|days|d)$/);
  if (m) return parseInt(m[1], 10);
  m = t.match(/^(\d+)\s*(week|weeks|wk|wks)$/);
  if (m) return parseInt(m[1], 10) * 7;
  m = t.match(/^(\d+)\s*(month|months|mo)$/);
  if (m) return parseInt(m[1], 10) * 30;
  m = t.match(/^(\d+)$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// If a drug has no recorded start date yet, fall back to the earliest date
// it was actually administered on the chart below (matched by Drug S/N).
function inferStartDateForDrug(chartRows, index) {
  let earliest = null;
  chartRows.forEach(row => {
    if (!row.date) return;
    const nums = (row.sno || '').match(/\d+/g) || [];
    if (nums.some(n => parseInt(n, 10) === index + 1)) {
      if (!earliest || row.date < earliest) earliest = row.date;
    }
  });
  return earliest;
}

// Walks the drug list and flips Action to "Completed" for any drug whose
// duration has run out, as long as it hasn't already been manually set to a
// status the nurse controls directly (Discontinued/Withheld/Other). Returns
// a NEW drugs array if anything changed, or the same reference if not (so
// callers can skip a re-render/save when nothing changed).
export function withDrugCompletionChecked(drugs, chartRows) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let changed = false;
  const next = drugs.map((d, i) => {
    const locked = ['Discontinued', 'Withheld', 'Other', 'Completed'].includes(d.action);

    // STAT: a single one-off dose. As soon as it's recorded as given on the
    // chart below, auto-flag the drug Completed.
    if ((d.frequency || '').trim().toUpperCase() === 'STAT') {
      if (!locked && administrationTimesFor(chartRows, i).length >= 1) { changed = true; return { ...d, action: 'Completed' }; }
      return d;
    }

    // Fixed dose-sequence (e.g. "0,12,24hr"): auto-complete once every
    // scheduled dose in the sequence has been recorded as given.
    const seq = parseDoseSequence(d.frequency);
    if (seq) {
      if (!locked && administrationTimesFor(chartRows, i).length >= seq.length) { changed = true; return { ...d, action: 'Completed' }; }
      return d;
    }

    const days = parseDurationDays(d.duration);
    if (days == null) return d;
    if (locked) return d;

    let start = d.startDate || inferStartDateForDrug(chartRows, i);
    if (!start) return d;

    const startDate = new Date(start + 'T00:00:00');
    if (isNaN(startDate)) return d;
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + days);

    const needsStartDate = !d.startDate;
    const needsComplete = today >= endDate && d.action !== 'Completed';
    if (!needsStartDate && !needsComplete) return d;

    changed = true;
    return { ...d, startDate: start, ...(needsComplete ? { action: 'Completed' } : {}) };
  });
  return changed ? next : drugs;
}

// Look up the route(s) for whichever drug number(s) are written in the Drug
// S/N field (e.g. "1", "1 - Paracetamol", or "1, 3, 4") against the current
// drugs list.
export function computeRouteFromSno(snoText, drugs) {
  const nums = (snoText || '').match(/\d+/g) || [];
  const routes = [];
  nums.forEach(n => {
    const d = drugs[parseInt(n, 10) - 1];
    if (d && d.route && !routes.includes(d.route)) routes.push(d.route);
  });
  return routes.join('/');
}

// Looks at every drug number referenced in a Drug S/N entry (e.g. "1" or
// "1/2") and returns the ones whose Action is flagged (anything other than
// blank or "Ongoing"). Used to stop a nurse from charting a dose against a
// drug that's Completed/Discontinued/Withheld/Other.
export function flaggedDrugRefs(snoText, drugs) {
  const nums = (snoText || '').match(/\d+/g) || [];
  const seen = new Set();
  const blocked = [];
  nums.forEach(n => {
    if (seen.has(n)) return;
    seen.add(n);
    const d = drugs[parseInt(n, 10) - 1];
    if (d && d.action && d.action !== 'Ongoing') {
      blocked.push({ num: n, name: d.name || '', action: d.action });
    }
  });
  return blocked;
}

export function flaggedDrugMessage(blocked) {
  return blocked.map(b =>
    'Drug ' + b.num + (b.name ? ' (' + b.name + ')' : '') + ' has been marked "' + b.action + '" and cannot be added as served medication.'
  ).join('\n');
}

// --- Bulk Upload: paste "Drug Name Dosage Frequency Duration" lines and auto-parse ---
const ROUTE_ALIASES = {
  tab: 'Oral', tabs: 'Oral', tavs: 'Oral', tablet: 'Oral', tablets: 'Oral',
  cap: 'Oral', caps: 'Oral', capsule: 'Oral', capsules: 'Oral',
  susp: 'Oral', suspension: 'Oral', syr: 'Oral', syrup: 'Oral',
  iv: 'IV', 'i.v': 'IV', 'i.v.': 'IV', ivf: 'IV',
  im: 'IM', 'i.m': 'IM', 'i.m.': 'IM',
  sc: 'SC', 's.c': 'SC', 's.c.': 'SC',
  ng: 'NG Tube', ngt: 'NG Tube',
  top: 'Topical', topical: 'Topical', cream: 'Topical', oint: 'Topical', ointment: 'Topical',
  pr: 'Rectal', rectal: 'Rectal',
  sup: 'Suppository', supp: 'Suppository', suppository: 'Suppository',
  sl: 'Sublingual', sublingual: 'Sublingual',
  neb: 'Inhalation', inhaler: 'Inhalation', inhalation: 'Inhalation'
};
const FREQ_ALIASES = {
  od: 'OD', once: 'OD', bd: 'BD', tds: 'TDS', tid: 'TDS', qds: 'QDS', qid: 'QDS',
  stat: 'STAT', prn: 'PRN',
  q4h: 'Q4H', '4hrly': 'Q4H', '4hourly': 'Q4H',
  q6h: 'Q6H', '6hrly': 'Q6H', '6hourly': 'Q6H',
  q8h: 'Q8H', '8hrly': 'Q8H', '8hourly': 'Q8H',
  q12h: 'Q12H', '12hrly': 'Q12H', '12hourly': 'Q12H',
  weekly: 'Weekly'
};
const DOSAGE_RE = /^\d+(\.\d+)?(mg|g|mcg|ug|ml|iu|units?|%|mmol)$/i;
const DURATION_RE = /^x?(\d+)\s*\/\s*(7|52|12)$/i;

export function parseDrugLine(line) {
  const raw = line.trim();
  if (!raw) return null;
  let tokens = raw.split(/\s+/);

  let route = '';
  const firstKey = tokens[0].toLowerCase().replace(/\.$/, '');
  if (ROUTE_ALIASES[firstKey]) {
    route = ROUTE_ALIASES[firstKey];
    tokens = tokens.slice(1);
  }

  let dosageIdx = tokens.findIndex(t => DOSAGE_RE.test(t.replace(/,$/, '')));
  let name, dosage, rest;
  if (dosageIdx === -1) {
    name = tokens.join(' ');
    dosage = '';
    rest = [];
  } else {
    name = tokens.slice(0, dosageIdx).join(' ');
    dosage = tokens[dosageIdx];
    rest = tokens.slice(dosageIdx + 1);
  }

  let duration = '';
  const durIdx = rest.findIndex(t => DURATION_RE.test(t));
  if (durIdx !== -1) {
    const m = rest[durIdx].match(DURATION_RE);
    duration = m[1] + '/' + m[2];
    rest.splice(durIdx, 1);
  }

  const freqRaw = rest.join(' ').replace(/,+/g, ',').trim();
  const freqKey = freqRaw.toLowerCase().replace(/[\s,]/g, '');
  let frequency = '';
  if (freqKey && FREQ_ALIASES[freqKey]) {
    frequency = FREQ_ALIASES[freqKey];
  } else if (freqRaw) {
    frequency = freqRaw;
  }

  const fullName = (name + (dosage ? ' ' + dosage : '')).trim();
  return { name: fullName, route, frequency, action: '', duration, createdAt: new Date().toISOString() };
}

export function parseBulkText(text) {
  return text.split('\n').map(parseDrugLine).filter(Boolean);
}

// Compares `before` and `after` on the given fields (a { field: label } map)
// and returns one human-readable "Label: "old" → "new"" line per changed
// field. Used to build a single audit-log entry per edit session instead of
// one per keystroke.
export function diffFields(before, after, fieldLabels) {
  const changes = [];
  Object.keys(fieldLabels).forEach(f => {
    const a = (before[f] || '').toString();
    const b = (after[f] || '').toString();
    if (a !== b) changes.push(fieldLabels[f] + ': "' + (a || '—') + '" \u2192 "' + (b || '—') + '"');
  });
  return changes;
}
