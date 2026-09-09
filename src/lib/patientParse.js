// Parses a raw block of text copied straight off a hospital EMR page (patient
// header + doctor's/physio notes) into the fields on the "Register New
// Patient" form, plus pulls out every "Currently on:" / "Prescription"
// drug-order block (not just the newest) so the full list can be run
// through the existing bulk drug parser (parseBulkText) — older orders a
// doctor has since annotated "(completed)"/"(discontinued)"/"(withheld)"
// are kept and flagged rather than dropped in favor of only the latest note.
//
// This is heuristic, not a guarantee — EMR note formatting varies by
// clinician and facility. Everything it produces is meant to be shown to the
// nurse for review/edit before saving, never written straight to the
// database unseen.

function grabLabel(text, labels) {
  for (const label of labels) {
    const re = new RegExp('^[ \\t]*' + label + '\\s*:\\s*(.+)$', 'im');
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// Converts a handful of common EMR date formats (DD/MM/YYYY, DD-MM-YY,
// DD-MMM-YYYY) to the yyyy-mm-dd an <input type="date"> needs. Returns ''
// for anything it doesn't recognize (e.g. a relative phrase like "Last week
// Friday") rather than guess — a wrong admission date is worse than a blank one.
export function toISODate(raw) {
  if (!raw) return '';
  let m = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/);
  if (m) return '20' + m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = raw.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return m[3] + '-' + String(mo).padStart(2, '0') + '-' + m[1].padStart(2, '0');
  }
  return '';
}

// --- "Encounters" timeline format --------------------------------------
// Some EMR pages (the "Encounters" tab) paste as a reverse-chronological
// log of dated entries instead of a single structured note, e.g.:
//
//   MERCY AYORINDE / A & E CLINIC
//   Notes
//   25-08-2026
//   ...free text, may include an "Assessment"/"PLAN" sub-section...
//   25-AUG-2026 [ 03:03 PM ]
//    Comment:(0)      Chat      Attachment:(0)      -
//
// Each entry ends with a "DD-MMM-YYYY [ HH:MM AM/PM ]" footer line, and
// (when present) is preceded by an "Author / Department" line and a
// bare entry-type line (Notes, Lab Result, Lab Request, Transfusion
// Order, Prescription, etc). This section parses that structure so the
// diagnosis/drug-plan extractors below can find the most *recent* entry
// of a given type rather than just the first one in the pasted text.

const ENTRY_TYPE_RE = /^(Notes|Lab Result|Lab Request|Transfusion Order|Prescription|Vital Signs|Tx Plan|Investigations?|Others)$/i;
const AUTHOR_RE = /^[A-Z][A-Za-z.'-]*(?:\s+[A-Z0-9][A-Za-z.'-]*)*\s*\/\s*[A-Z0-9 &.]+$/;
const FOOTER_DATETIME_RE = /^(\d{1,2})-([A-Za-z]{3,9})-(\d{4})\s*\[\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\]$/i;

function parseFooterTimestamp(line) {
  const m = line.match(FOOTER_DATETIME_RE);
  if (!m) return null;
  const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  let hour = parseInt(m[4], 10) % 12;
  if (m[6].toUpperCase() === 'PM') hour += 12;
  return new Date(parseInt(m[3], 10), mo - 1, parseInt(m[1], 10), hour, parseInt(m[5], 10)).getTime();
}

// Splits a pasted "Encounters" log into { type, content, ts } entries.
// `ts` is a millisecond timestamp parsed from the entry's own footer line
// (null if unparseable), used so callers can sort by true recency instead
// of relying on the paste already being newest-first.
export function parseEncounterEntries(text) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    if (!ENTRY_TYPE_RE.test(lines[i]) || !AUTHOR_RE.test(lines[i - 1])) continue;
    let end = lines.length;
    let ts = null;
    for (let j = i + 1; j < lines.length; j++) {
      const footTs = parseFooterTimestamp(lines[j]);
      if (footTs !== null) { end = j; ts = footTs; break; }
    }
    const content = lines.slice(i + 1, end).filter(Boolean).join('\n');
    entries.push({ type: lines[i], content, ts });
    i = end; // resume scanning after this entry's footer
  }
  return entries;
}

// Diagnosis phrasings seen in free-text doctor's notes, checked in order.
// Label forms ("Diagnosis: X" / "Assessment: X" / the common "Ass" shorthand
// with a dash instead of a colon, e.g. "Ass – CKD" or "Ass---Improving")
// are checked first since they're the least ambiguous when present. The
// captured text itself is taken verbatim — short abbreviations like "CKD",
// "COPD", "OCD" are valid diagnoses on their own and need no expansion.
const DIAGNOSIS_PATTERNS = [
  /^(?:Medical\s+)?Diagnosis\s*:\s*(.+?)(?:[.\n]|$)/im,
  /^Ass(?:essment)?\s*(?:[-\u2010-\u2015]+|:)\s*(.+?)(?:[.\n]|$)/im,
  /\bmanaged as a (?:known )?case of\s+(.+?)(?:[.\n]|$)/i,
  /\b(?:known )?case of\s+(.+?)(?:[.\n]|$)/i,
  /^Ass(?:essment)?\s*\n\s*\??\s*(.+?)(?:[.\n]|$)/im,
  /^\?\s*([A-Z].+?)(?:[.\n]|$)/m
];

// Scans "Notes" entries from an Encounters-style paste for the most recent
// mention of a working diagnosis (e.g. "managed as a case of Anaemia in a
// known Schizophrenic px"). Entries are ranked by their own parsed
// timestamp where available, falling back to paste order (EMR encounter
// logs are conventionally newest-first) when timestamps can't be parsed.
export function extractLatestDiagnosis(text) {
  const notes = parseEncounterEntries(text)
    .map((e, idx) => ({ ...e, idx }))
    .filter((e) => /^notes$/i.test(e.type))
    .sort((a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity) || a.idx - b.idx);
  for (const entry of notes) {
    for (const pat of DIAGNOSIS_PATTERNS) {
      const m = entry.content.match(pat);
      if (m && m[1] && m[1].trim()) return m[1].trim().replace(/\s+/g, ' ');
    }
  }
  return '';
}


// Pulls insurance/registration-type info off the EMR patient-header block,
// e.g.:
//   REG. TYPE: NHIS
//   HMO/Company : Defence Health Maintenance Limited (DHML)
//   NHIS NO.: 06NA/59/5278
// Returns a single display-ready string ("NHIS – Defence Health
// Maintenance Limited (DHML), NHIS No: 06NA/59/5278") or '' if none of
// these labels are present. Values are read independently so a paste
// missing the HMO/NHIS-No lines (or using only one of them) still yields
// whatever was actually found instead of failing closed.
export function extractInsurance(text) {
  const norm = (text || '').replace(/\r\n/g, '\n');
  const regType = grabLabel(norm, ['REG\\.?\\s*TYPE']);
  const hmo = grabLabel(norm, ['HMO\\s*/\\s*Company', 'HMO']);
  const nhisNo = grabLabel(norm, ['NHIS\\s*NO\\.?']);
  if (!regType && !hmo && !nhisNo) return '';
  let out = regType || (nhisNo ? 'NHIS' : '') || '';
  const extras = [];
  if (hmo) extras.push(hmo);
  if (nhisNo) extras.push('NHIS No: ' + nhisNo);
  if (extras.length) out = (out ? out + ' \u2013 ' : '') + extras.join(', ');
  return out.trim();
}

export function parsePatientFields(text) {
  const norm = (text || '').replace(/\r\n/g, '\n');
  const out = { name: '', emr: '', diagnosis: '', ward: '', age: '', hospNo: '', admissionDate: '', allergies: '', insurance: '' };

  // --- Name ----------------------------------------------------------------
  // 1) A name line immediately followed by a lone ID-number line — the
  //    pattern doctor's notes tend to open with ("Ernest Ukolio\n139680").
  let m = norm.match(/^([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3})\n(\d{4,8})\s*$/m);
  if (m) { out.name = m[1].trim(); out.emr = m[2]; }
  // 2) Explicit "Name:" field on a structured assessment form.
  if (!out.name) out.name = grabLabel(norm, ['Name']);
  // 3) EMR patient-header line: "SURNAME, GIVENMale/Female, born X years ago".
  if (!out.name) {
    const hm = norm.match(/^([A-Z][A-Za-z'.-]+),\s*([A-Z][A-Za-z'.-]+)\s*(Male|Female)\s*,?\s*born\s+([\d.]+)\s+years?\s+ago/im);
    if (hm) {
      out.name = hm[2][0] + hm[2].slice(1).toLowerCase() + ' ' + hm[1][0] + hm[1].slice(1).toLowerCase();
      out.age = out.age || String(Math.floor(parseFloat(hm[4])));
    }
  }

  // --- EMR / patient ID ------------------------------------------------------
  out.emr = out.emr || grabLabel(norm, ['PID', 'EMR(?: Number| No)?\\.?']);

  // --- Hospital No -----------------------------------------------------------
  out.hospNo = grabLabel(norm, ['Hospital No\\.?', 'Hosp No\\.?', 'Hospital Number', 'Folder No\\.?']);

  // --- Ward --------------------------------------------------------------
  out.ward = grabLabel(norm, ['Ward']);

  // --- Age -----------------------------------------------------------------
  if (!out.age) {
    const a = grabLabel(norm, ['Age']);
    if (a) { const am = a.match(/\d+/); out.age = am ? am[0] : a; }
  }
  if (!out.age) {
    const am = norm.match(/\b(\d{1,3})\s*[- ]?years?[- ]old\b/i);
    if (am) out.age = am[1];
  }

  // --- Diagnosis -----------------------------------------------------------
  // Try the recency-aware picker first: on an Encounters-style paste with
  // several dated Notes entries, this ranks by each entry's own parsed
  // timestamp so an older entry's diagnosis line (which may well appear
  // earlier in the raw text than the newest entry's) can't win by accident.
  // Only fall back to a flat whole-text label scan for pastes that aren't
  // in that dated/multi-entry format to begin with (e.g. a single
  // structured assessment form with one "Diagnosis:" line).
  out.diagnosis = extractLatestDiagnosis(norm);
  if (!out.diagnosis) out.diagnosis = grabLabel(norm, ['Medical Diagnosis', 'Diagnosis', 'Ass(?:essment)?']);

  // --- Allergies -----------------------------------------------------------
  let allergies = grabLabel(norm, ['Allergies']);
  if (allergies === '0' || /^none$/i.test(allergies)) allergies = 'None known';
  out.allergies = allergies;

  // --- Insurance / NHIS ------------------------------------------------------
  out.insurance = extractInsurance(norm);

  // --- Date of Admission -----------------------------------------------------
  const admLabel = grabLabel(norm, ['Date of Admission']);
  out.admissionDate = toISODate(admLabel);

  return out;
}

// Section headers that signal the "Currently on:" drug list has ended.
const STOP_WORDS = ['glycemic chart', 'o/e', 'vitals', 'assessment', 'chest', 'cvs', 'abd', 'review of investigations', 'plan'];

// Pulls the lines under every "Currently on:" heading — not just the first
// one — out of the pasted note, each block stopping at the next section
// header or the next "Currently on:" heading. A single paste can carry more
// than one such block (an admission note plus a later ward-round note that
// restates/updates the list), and older orders that a doctor has since
// marked "(completed)"/"(discontinued)"/"(withheld)" still need to show up
// so they can be flagged rather than silently dropped in favor of only the
// newest block. Returns a newline-joined block ready for parseBulkText(),
// which will run every line (from every block) through the per-line status
// annotation detection in parseDrugLine.
export function extractDrugSection(text) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/currently on\s*:/i.test(lines[i])) continue;
    const collected = [];
    for (let j = i + 1; j < lines.length && collected.length < 20; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      if (/currently on\s*:/i.test(line)) break; // next "Currently on:" block starts here
      if (STOP_WORDS.some(w => lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + ':'))) break;
      collected.push(line);
    }
    if (collected.length) blocks.push(collected.join('\n'));
  }
  if (blocks.length) return blocks.join('\n');

  // No "Currently on:" note-style block — fall back to every "Prescription"
  // entry from an Encounters-style timeline paste (not just the most recent
  // one), so earlier orders that were later discontinued/completed/withheld
  // still surface and can be flagged instead of being dropped.
  const rx = parseEncounterEntries(text).filter((e) => /^prescription$/i.test(e.type));
  return rx.map((e) => e.content).join('\n');
}
