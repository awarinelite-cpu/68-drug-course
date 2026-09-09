export const ROUTE_OPTIONS = ['', 'Oral', 'IV', 'IM', 'SC', 'Sublingual', 'Topical', 'Rectal', 'Suppository', 'Inhalation', 'NG Tube', 'Other'];
export const FREQ_OPTIONS = ['', 'OD', 'Daily', 'Mane', 'Nocte', 'HS', 'BD', 'TDS', 'Premeal TDS', 'QDS', 'QOD', 'STAT', 'STAT then Q4H', 'STAT then Q6H', 'STAT then Q8H', 'STAT then Q12H', 'PRN', 'Q4H', 'Q6H', '8hrly', 'Q8H', '12hrly', 'Q12H', 'Weekly', '0,12,24hr', 'Other'];
export const ACTION_OPTIONS = ['', 'Ongoing', 'Completed', 'Discontinued', 'Withheld', 'Other'];
export const STATUS_LABELS = { referred: 'Referred to another hospital', transferred: 'Transferred to another ward', discharged: 'Discharged' };
export const WARD_OPTIONS = [
  '"A" WARD', 'ACCIDENT & EMERGENCY', 'GYNAE WARD', 'MATERNITY WARD', 'PEDIATRIC/NICU WARD',
  'THEATER', 'ICU', 'FEMALE MEDICAL WARD', 'FEMALE SURGICAL WARD', 'MALE MEDICAL WARD',
  'ORTHOPEDIC WARD', 'EXTENSION WARD', 'OFFICERS WARD'
];

// PEDIATRIC/NICU WARD is one patient-chart ward but two physically
// separate report wards (PAED BED / PAED COT, see wardNameMatch.js) —
// a patient registered there needs to say which one they're actually
// in so census counts and the Home page list can be split correctly.
// Blank means "not set yet" (e.g. an older record, or a patient just
// transferred in from another ward) — treated as unassigned rather than
// guessed at.
export const PED_BED_TYPES = ['Bed', 'Cot'];

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
export const INTERVAL_HOURS = { OD: 24, Mane: 24, Nocte: 24, HS: 24, BD: 12, TDS: 8, QDS: 6, QOD: 48, Q4H: 4, Q6H: 6, Q8H: 8, Q12H: 12, Weekly: 168, 'STAT then Q4H': 4, 'STAT then Q6H': 6, 'STAT then Q8H': 8, 'STAT then Q12H': 12 };

// "8hrly" and "Q8H" (likewise "12hrly"/"Q12H") are two labels a doctor
// might pick for the exact same schedule — the frequency dropdown offers
// both, but they must resolve to the same computed due time rather than
// "8hrly" silently falling through INTERVAL_HOURS with no match.
const FREQ_SYNONYMS = { '8hrly': 'Q8H', '12hrly': 'Q12H' };
export function normalizeFrequency(freq) {
  const key = (freq || '').trim();
  return FREQ_SYNONYMS[key] || key;
}

// The "0,12,24hr" fixed dose-sequence always spans 24 hours (dose at hour
// 0, 12, and 24) — so its Duration is always "24hrs", not something a
// nurse should have to type separately. Returns the forced duration text,
// or null if the frequency isn't this pattern.
export function autoDurationForFrequency(freq) {
  return (freq || '').trim() === '0,12,24hr' ? '24hrs' : null;
}

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
  const text = freqText.trim();

  // "STAT, then Xhrly for a total of Yhrs" — a loading dose followed by
  // repeat dosing at a fixed interval up to a stated total duration, e.g.
  // "stat, then 8hrly 24hrs" means doses at hour 0, 8, 16 and 24.
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

  // A list of hour-offsets, each individually suffixed "hr"/"hrs"/"hours",
  // however they're separated by punctuation/filler words — e.g.
  // "at 0hrs, 12hrs and 24hrs" or "0hrs / 12hrs / 24hrs".
  const hourMatches = [...text.matchAll(/(\d+)\s*(?:hrs?|hours?)\b/gi)];
  if (hourMatches.length >= 2) {
    const nums = [...new Set(hourMatches.map(m => parseInt(m[1], 10)))].sort((a, b) => a - b);
    if (nums.length >= 2) return nums;
  }

  // Bare comma-separated numbers with at most one trailing hr/hrs/hours
  // suffix — the exact "0,12,24hr" dropdown option, or typed the same way.
  const compact = text.replace(/\s+/g, '');
  const m = compact.match(/^(\d+(?:,\d+)+)(hrs?|hours?|h)?$/i);
  if (!m) return null;
  const nums = [...new Set(m[1].split(',').map(n => parseInt(n, 10)))].sort((a, b) => a - b);
  return nums.length >= 2 ? nums : null;
}

export function computeDueAt(d, i, chartRows) {
  const intervalHours = INTERVAL_HOURS[normalizeFrequency(d.frequency)];
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

// --- Hour-based durations (e.g. "24hrs", "48hrs", "1hr") -----------------
// Some courses are timed in hours rather than days, most often a loading
// dose followed by repeat dosing up to a stated cutoff (e.g. "STAT then
// 8hrly 24hrs" runs for 24 hours total). Also accepts the "x/24" fraction
// form, matching the existing 7/12/52 day/month/week fraction notation
// (24 being the hours-in-a-day denominator, so "1/24" = 1 hour).
// Returned separately from parseDurationDays (rather than folded into it as
// a fraction of a day) so callers can apply hour-precision completion math
// instead of losing sub-day precision to whole-day rounding.
export function parseDurationHours(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  let m = t.match(/^(\d+)\s*\/\s*24$/);
  if (m) return parseInt(m[1], 10);
  m = t.match(/^(\d+)\s*(hrs?|hours?|h)$/);
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
  const now = new Date();
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

    const hours = parseDurationHours(d.duration);
    const days = hours == null ? parseDurationDays(d.duration) : null;
    if (hours == null && days == null) return d;
    if (locked) return d;

    let start = d.startDate || inferStartDateForDrug(chartRows, i);
    if (!start) return d;

    const startDate = new Date(start + 'T00:00:00');
    if (isNaN(startDate)) return d;
    const endDate = new Date(startDate);
    if (hours != null) endDate.setHours(endDate.getHours() + hours);
    else endDate.setDate(endDate.getDate() + days);

    const needsStartDate = !d.startDate;
    // Hour-based durations need to-the-hour precision (the current moment),
    // day-based ones keep the existing midnight-to-midnight comparison.
    const needsComplete = (hours != null ? now : today) >= endDate && d.action !== 'Completed';
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
  od: 'OD', once: 'OD', daily: 'OD', dly: 'OD', bd: 'BD', tds: 'TDS', tid: 'TDS', qds: 'QDS', qid: 'QDS',
  stat: 'STAT', prn: 'PRN',
  mane: 'Mane', morning: 'Mane',
  nocte: 'Nocte', night: 'Nocte',
  hs: 'HS', bedtime: 'HS', atbedtime: 'HS',
  qod: 'QOD', eod: 'QOD', altday: 'QOD', alternateday: 'QOD', alternatedays: 'QOD',
  q4h: 'Q4H', '4hrly': 'Q4H', '4hourly': 'Q4H',
  q6h: 'Q6H', '6hrly': 'Q6H', '6hourly': 'Q6H',
  q8h: 'Q8H', '8hrly': 'Q8H', '8hourly': 'Q8H',
  q12h: 'Q12H', '12hrly': 'Q12H', '12hourly': 'Q12H',
  weekly: 'Weekly',
  '01224hr': '0,12,24hr', '01224hrs': '0,12,24hr'
};
const DOSAGE_RE = /^\d+(\.\d+)?(mg|g|mcg|ug|mls?|l|cc|iu|units?|%|mmol)$/i;
// Compound doses for combination drugs, e.g. Artemether/Lumefantrine
// "80/480mg" — two numbers sharing one trailing unit.
const COMPOUND_DOSAGE_RE = /^\d+(\.\d+)?\/\d+(\.\d+)?(mg|g|mcg|ug|mls?|l|cc|iu|units?|%|mmol)$/i;
const BARE_PERCENT_RE = /^\d+(\.\d+)?%$/;
const DURATION_RE = /^x?(\d+)\s*\/\s*(7|52|12|24)$/i;
// A duration given as a plain hour count rather than a day/week/month
// fraction, e.g. "24hrs", "48hrs", "72hrs", "1hr" — common for a loading
// dose followed by a stated total course length ("stat, then 8hrly 24hrs").
const DURATION_HOURS_RE = /^x?(\d+)\s*(hrs?|hours?)$/i;
// The second half of a duration spelled out as two tokens rather than one
// ("10 days", "2 weeks", "1 month") — matched against the token right
// after a bare number so "500mg" (a dose, already consumed earlier) and
// other numbers elsewhere in the line aren't mistaken for a duration.
const DURATION_WORD_RE = /^(days?|d|weeks?|wks?|months?|mo)$/i;
function isDosageToken(t) { return DOSAGE_RE.test(t) || COMPOUND_DOSAGE_RE.test(t); }

// A dose written with a stray space before its unit ("120 mg" instead of
// "120mg") — merged back into a single token so it's indistinguishable
// from a normal dose to the rest of the parser.
const UNIT_WORD_RE = /^(mg|g|mcg|ug|mls?|l|cc|iu|units?|mmol)$/i;

// Lines that ride along in a pasted drug/order list but aren't medication
// orders at all — a referral or consult request. Treating these as a drug
// would create a bogus "Oral" row with no dose or frequency; recognized
// here so parseBulkText can skip them instead (log the referral itself as
// a Care Instruction/Verbal Order rather than a drug).
const NON_DRUG_LINE_RE = /^(consult(?:ation)?s?\s+(?:to|with)\b|refer(?:ral)?\s+to\b|review\s+by\b)/i;

// A dose given as a bare quantity rather than a strength, e.g. "Tothema i
// bd x 7/7" (1 capsule/ampoule, no mg figure attached — common for
// hematinics and combination tonics). Matched only when immediately
// followed by a recognized frequency word, so a stray "i"/"1" elsewhere in
// a line doesn't get mistaken for a dose.
const QTY_RE = /^(i|ii|iii|iv|v|\d+)$/i;

// Status annotations a doctor appends after a completed/stopped course,
// e.g. "(completed)", "(discontinued)". Pulled into the Action column
// instead of being left to pollute the Frequency text.
const STATUS_ANNOTATION_MAP = {
  completed: 'Completed', complete: 'Completed', done: 'Completed',
  discontinued: 'Discontinued', stopped: 'Discontinued', dc: 'Discontinued', "dc'd": 'Discontinued', dcd: 'Discontinued',
  withheld: 'Withheld', held: 'Withheld', hold: 'Withheld'
};

// Fluid orders that alternate two bags in one regimen, e.g. "5% D/water
// 500mls to alt with 500mls of D/Saline 8hrly" — both fluids belong
// together as one drug-name/dosage description; only the trailing
// frequency word should be split out.
const ALT_RE = /\balt(?:ernating)?\b/i;

export function parseDrugLine(line) {
  const raw = line.trim();
  if (!raw) return null;
  if (NON_DRUG_LINE_RE.test(raw)) return null;
  let tokens = raw.split(/\s+/);

  let route = '';
  const firstKey = tokens[0].toLowerCase().replace(/\.$/, '');
  if (ROUTE_ALIASES[firstKey]) {
    route = ROUTE_ALIASES[firstKey];
    tokens = tokens.slice(1);
  } else {
    // No route prefix in the order (e.g. "Indapamide 1.5mg dly") — nursing
    // drug orders default to oral/tablet when a route isn't stated.
    route = 'Oral';
  }

  // Alternating-fluid orders ("...to alt with...") describe two bags as one
  // combined regimen — splitting on the first strength/volume token (the
  // normal flow below) would cut the name off mid-description. Keep the
  // whole thing together and only pull a trailing frequency word off the end.
  if (ALT_RE.test(raw)) return parseAlternatingFluidLine(tokens, route);

  let dosageIdx = tokens.findIndex(t => isDosageToken(t.replace(/,$/, '')));
  // A leading bare percentage (e.g. "5%", "0.9%") describes the fluid's
  // concentration and belongs in the name ("5% D/water 500mls"), not the
  // dose itself — the real dose (a volume like "500mls") comes later in
  // the line. Without this, "IV 5% D/water 500mls..." would treat "5%" as
  // the whole dose and truncate the name down to nothing.
  if (dosageIdx === 0 && BARE_PERCENT_RE.test(tokens[0])) {
    const nextIdx = tokens.slice(1).findIndex(t => isDosageToken(t.replace(/,$/, '')));
    dosageIdx = nextIdx === -1 ? -1 : nextIdx + 1;
  }
  // A dose split across two tokens by a stray space (e.g. "Artesunate 120
  // mg" instead of "120mg") — merge the bare number and its unit word into
  // a single token in place so it parses exactly like a normal dose.
  if (dosageIdx === -1) {
    const bareIdx = tokens.findIndex((t, idx) =>
      /^\d+(\.\d+)?$/.test(t) && UNIT_WORD_RE.test((tokens[idx + 1] || '').replace(/[,.]$/, ''))
    );
    if (bareIdx !== -1) {
      tokens = [
        ...tokens.slice(0, bareIdx),
        tokens[bareIdx] + tokens[bareIdx + 1].toLowerCase().replace(/[,.]$/, ''),
        ...tokens.slice(bareIdx + 2)
      ];
      dosageIdx = bareIdx;
    }
  }
  // No numeric+unit dose found at all — some orders (hematinics/tonics
  // like "Tothema i bd x 7/7") are dosed by bare quantity instead of a
  // strength. If a roman-numeral/plain-number token is immediately
  // followed by a recognized frequency word, treat that as the dose split
  // point rather than letting the whole line fall into the Name field.
  if (dosageIdx === -1) {
    const qIdx = tokens.findIndex((t, idx) => {
      if (idx === 0 || !QTY_RE.test(t)) return false;
      const nextKey = (tokens[idx + 1] || '').toLowerCase().replace(/\.$/, '');
      return !!FREQ_ALIASES[nextKey];
    });
    if (qIdx !== -1) dosageIdx = qIdx;
  }
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

  // An order can carry an additive after the main dose/frequency, e.g.
  // "IV 0.9 N/saline 1L 8hrly + 3cc Vit Bco". Split it off before duration/
  // frequency parsing so it doesn't get swallowed into the Frequency cell,
  // then fold it back into the drug name.
  let additive = '';
  const plusIdx = rest.findIndex(t => t === '+');
  if (plusIdx !== -1) {
    additive = rest.slice(plusIdx).join(' ');
    rest = rest.slice(0, plusIdx);
  }

  let duration = '';
  const durIdx = rest.findIndex(t => DURATION_RE.test(t) || DURATION_HOURS_RE.test(t));
  if (durIdx !== -1) {
    const fracM = rest[durIdx].match(DURATION_RE);
    if (fracM) {
      duration = fracM[1] + '/' + fracM[2];
    } else {
      const hrM = rest[durIdx].match(DURATION_HOURS_RE);
      duration = hrM[1] + 'hrs';
    }
    rest.splice(durIdx, 1);
  } else {
    // Duration spelled out as two tokens instead of one, e.g. "10 days",
    // "2 weeks", "1 month" — find a bare number immediately followed by
    // one of those unit words and pull the pair out together.
    const wordIdx = rest.findIndex((t, idx) =>
      idx > 0 && /^\d+$/.test(rest[idx - 1]) && DURATION_WORD_RE.test(t.replace(/[.,]$/, ''))
    );
    if (wordIdx !== -1) {
      duration = rest[wordIdx - 1] + ' ' + rest[wordIdx].replace(/[.,]$/, '').toLowerCase();
      rest.splice(wordIdx - 1, 2);
    }
  }

  // "@" just introduces the clock times (e.g. "@ 0,12,24hrs") and carries no
  // information of its own once the times are parsed as the frequency.
  rest = rest.filter(t => t !== '@');

  // A duration written with a space ("bd x 2/7") leaves a dangling "x"
  // behind once DURATION_RE has already pulled "2/7" out on its own —
  // that lone "x" carries no meaning of its own and would otherwise stick
  // to the Frequency text (e.g. "bd x (completed)").
  rest = rest.filter(t => t.toLowerCase() !== 'x');

  // A trailing status note like "(completed)"/"(discontinued)" documents
  // that the course is done rather than describing the frequency — pull it
  // into the Action column instead of leaving it stuck in Frequency text.
  let action = '';
  rest = rest.filter((t) => {
    const m = t.match(/^\(?([a-z']+)\)?$/i);
    const key = m ? m[1].toLowerCase() : '';
    if (STATUS_ANNOTATION_MAP[key]) { action = STATUS_ANNOTATION_MAP[key]; return false; }
    return true;
  });

  const freqRaw = rest.join(' ').replace(/,+/g, ',').trim();
  const freqKey = freqRaw.toLowerCase().replace(/[\s,]/g, '');
  let frequency = '';
  // "stat, then 8hrly" / "stat then Q8H" (however the hour word is styled,
  // and once its trailing "24hrs" total has already been pulled into
  // duration above) — normalize to the canonical "STAT then QXH" dropdown
  // option so it matches the frequency picker instead of sticking as
  // free text.
  const statThenM = freqRaw.match(/^stat[,\s]*then\s+q?(\d+)\s*(?:hrly|hourly|h)\b/i);
  if (statThenM) {
    frequency = 'STAT then Q' + statThenM[1] + 'H';
  } else if (freqKey && FREQ_ALIASES[freqKey]) {
    frequency = FREQ_ALIASES[freqKey];
  } else if (freqRaw) {
    frequency = freqRaw;
  }

  duration = autoDurationForFrequency(frequency) || duration;

  const fullName = (name + (dosage ? ' ' + dosage : '') + (additive ? ' ' + additive : '')).trim();
  return { name: fullName, route, frequency, action, duration, createdAt: new Date().toISOString() };
}

// Alternating-fluid orders ("...to alt with...") keep both fluids together
// as one drug name/dosage description (they're one combined regimen, not
// two separate drugs) — only a trailing frequency word (and an optional
// duration) get split out.
function parseAlternatingFluidLine(tokens, route) {
  let rest = tokens.slice();

  let duration = '';
  const durIdx = rest.findIndex(t => DURATION_RE.test(t));
  if (durIdx !== -1) {
    const m = rest[durIdx].match(DURATION_RE);
    duration = m[1] + '/' + m[2];
    rest.splice(durIdx, 1);
  }
  rest = rest.filter(t => t.toLowerCase() !== 'x');

  // An additive tacked on at the end, e.g. "...1L 8 hrly + Vit BCO" — split
  // it off before hunting for the trailing frequency so it doesn't get
  // mistaken for part of the frequency search, then fold it back into name.
  let additive = '';
  const plusIdx = rest.findIndex(t => t === '+');
  if (plusIdx !== -1) {
    additive = rest.slice(plusIdx).join(' ');
    rest = rest.slice(0, plusIdx);
  }

  // The trailing frequency may be written as one token ("8hrly") or two
  // ("8 hrly") — try the two-token form first since it's a superset check.
  let frequency = '';
  if (rest.length >= 2) {
    const twoKey = (rest[rest.length - 2] + rest[rest.length - 1]).replace(/[.,]$/, '').toLowerCase();
    if (FREQ_ALIASES[twoKey]) {
      frequency = rest[rest.length - 2] + ' ' + rest[rest.length - 1].replace(/[.,]$/, ''); // keep as written, not normalized
      rest = rest.slice(0, -2);
    }
  }
  if (!frequency && rest.length) {
    const last = rest[rest.length - 1].replace(/[.,]$/, '');
    const lastKey = last.toLowerCase();
    if (FREQ_ALIASES[lastKey]) {
      frequency = last; // keep as written (e.g. "8hrly"), not the normalized code
      rest = rest.slice(0, -1);
    }
  }

  duration = autoDurationForFrequency(frequency) || duration;

  const name = (rest.join(' ') + (additive ? ' ' + additive : '')).trim();
  return { name, route, frequency, action: '', duration, createdAt: new Date().toISOString() };
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
