// Parses a raw block of text copied straight off a hospital EMR page (patient
// header + doctor's/physio notes) into the fields on the "Register New
// Patient" form, plus pulls out the "Currently on:" drug-order block so it
// can be run through the existing bulk drug parser (parseBulkText).
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
const DIAGNOSIS_PATTERNS = [
  /\bmanaged as a (?:known )?case of\s+(.+?)(?:[.\n]|$)/i,
  /\b(?:known )?case of\s+(.+?)(?:[.\n]|$)/i,
  /^Assessment\s*\n\s*\??\s*(.+?)(?:[.\n]|$)/im,
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


export function parsePatientFields(text) {
  const norm = (text || '').replace(/\r\n/g, '\n');
  const out = { name: '', emr: '', diagnosis: '', ward: '', age: '', hospNo: '', admissionDate: '', allergies: '' };

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
  out.diagnosis = grabLabel(norm, ['Medical Diagnosis', 'Diagnosis', 'Assessment']);
  if (!out.diagnosis) out.diagnosis = extractLatestDiagnosis(norm);

  // --- Allergies -----------------------------------------------------------
  let allergies = grabLabel(norm, ['Allergies']);
  if (allergies === '0' || /^none$/i.test(allergies)) allergies = 'None known';
  out.allergies = allergies;

  // --- Date of Admission -----------------------------------------------------
  const admLabel = grabLabel(norm, ['Date of Admission']);
  out.admissionDate = toISODate(admLabel);

  return out;
}

// Section headers that signal the "Currently on:" drug list has ended.
const STOP_WORDS = ['glycemic chart', 'o/e', 'vitals', 'assessment', 'chest', 'cvs', 'abd', 'review of investigations', 'plan'];

// Pulls the lines under the first "Currently on:" heading — the patient's
// active medication orders — out of the pasted note, stopping at the next
// section header. Returns a newline-joined block ready for parseBulkText().
export function extractDrugSection(text) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const startIdx = lines.findIndex(l => /currently on\s*:/i.test(l));
  if (startIdx !== -1) {
    const collected = [];
    for (let i = startIdx + 1; i < lines.length && collected.length < 20; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      if (STOP_WORDS.some(w => lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + ':'))) break;
      collected.push(line);
    }
    return collected.join('\n');
  }
  // No "Currently on:" note-style block — try the most recent "Prescription"
  // entry from an Encounters-style timeline paste instead (falls back to
  // paste order, conventionally newest-first, when timestamps don't parse).
  const rx = parseEncounterEntries(text)
    .map((e, idx) => ({ ...e, idx }))
    .filter((e) => /^prescription$/i.test(e.type))
    .sort((a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity) || a.idx - b.idx);
  return rx.length ? rx[0].content : '';
}
