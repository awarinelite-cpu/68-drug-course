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
    const hm = norm.match(/^([A-Z][A-Za-z'.-]+),\s*([A-Z][A-Za-z'.-]+)(Male|Female)\s*,?\s*born\s+([\d.]+)\s+years?\s+ago/im);
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
  if (startIdx === -1) return '';
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
