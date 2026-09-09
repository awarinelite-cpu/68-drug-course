import { WARD_OPTIONS, PED_BED_TYPES, parseBulkText } from "./drugChartHelpers.js";

// --- CSV template ----------------------------------------------------------
// Column order matches PatientForm.jsx field-for-field so a filled-in
// template maps straight onto the same patient record `createPatient()`
// writes to Firestore. The trailing "Drugs" column is separate — it feeds
// the patient's Drug Course Chart, not the patient record itself (see
// parsePatientCsv below).
export const CSV_HEADERS = [
  'Name', 'EMR Number', 'Diagnosis', 'Ward', 'Bed/Cot', 'Age',
  'Hospital No', 'Date of Admission', 'Allergies', 'Insurance', 'Drugs'
];

const SAMPLE_ROWS = [
  ['John Doe', 'EMR12345', 'Malaria', 'MALE MEDICAL WARD', '', '34', 'H-00123', '2026-09-01', 'None known', 'NHIS',
    'Tabs Artemether/Lumefantrine 80/480mg bd x 3/7\nIV Paracetamol 1g tds'],
  ['Baby Grace', 'EMR12346', 'Neonatal jaundice', 'PEDIATRIC/NICU WARD', 'Cot', '3 days', 'H-00124', '2026-09-02', '', '', ''],
];

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Downloadable/fillable template — header row, sample rows, and the exact
// ward list as a comment line so it's clear what's acceptable in the Ward
// column without having to guess or open the app.
export function generateCsvTemplate() {
  const lines = [CSV_HEADERS.map(csvEscape).join(',')];
  for (const row of SAMPLE_ROWS) lines.push(row.map(csvEscape).join(','));
  lines.push('');
  lines.push('# Acceptable Ward values (must match one of these, case-insensitive):');
  lines.push('# ' + WARD_OPTIONS.join(' | '));
  lines.push('# Bed/Cot only applies to PEDIATRIC/NICU WARD — use "Bed" or "Cot", leave blank otherwise.');
  lines.push('# Drugs column: one drug order per line (same free-typed format as "Bulk Upload Drugs" on a');
  lines.push('# patient\u2019s Drug Course Chart) — e.g. "Tabs Omeprazole 20mg bd x2/52" or "IV Ceftriaxone 1g 12hrly".');
  lines.push('# To add drugs to a patient you already uploaded, re-upload with the SAME EMR Number and only the');
  lines.push('# Drugs column filled in — matching EMR Number is recognized as the same patient, so no duplicate');
  lines.push('# patient is created; the drugs are just added to that patient\u2019s existing Drug Course Chart.');
  return lines.join('\r\n');
}

// --- CSV parsing -------------------------------------------------------
// Small RFC4180-ish parser (quoted fields, embedded commas/newlines,
// doubled-quote escaping) — no external dependency needed for a flat
// 9-column sheet.
export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^\uFEFF/, ''); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (c === '\r') {
      // swallow; \n (if present) will terminate the row
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // Drop blank lines and comment lines (template's "# Acceptable Ward…" footer)
  return rows.filter(r => r.length && !(r.length === 1 && r[0].trim() === '') && !r[0].trim().startsWith('#'));
}

function normalizeWard(raw) {
  return String(raw || '').trim().toUpperCase();
}

// Matches a free-text ward against WARD_OPTIONS case-insensitively.
// Returns the canonical WARD_OPTIONS string, or null if nothing matches.
export function matchWard(raw) {
  const norm = normalizeWard(raw);
  if (!norm) return '';
  return WARD_OPTIONS.find(w => w.toUpperCase() === norm) || null;
}

function matchBedType(raw) {
  const norm = String(raw || '').trim().toLowerCase();
  if (!norm) return '';
  return PED_BED_TYPES.find(t => t.toLowerCase() === norm) || null;
}

// Parses raw CSV text into { rows, headerOk } where each row is
// { line, data, errors } — data is shaped exactly like PatientForm's
// `form` object (and createPatient()'s Firestore doc) when valid.
export function parsePatientCsv(text) {
  const table = parseCsvText(text);
  if (!table.length) return { headerOk: false, rows: [] };

  const header = table[0].map(h => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name.toLowerCase());
  const col = {
    name: idx('name'),
    emr: idx('emr number'),
    diagnosis: idx('diagnosis'),
    ward: idx('ward'),
    pedBedType: idx('bed/cot'),
    age: idx('age'),
    hospNo: idx('hospital no'),
    admissionDate: idx('date of admission'),
    allergies: idx('allergies'),
    insurance: idx('insurance'),
    drugs: idx('drugs'),
  };
  const headerOk = col.name !== -1 && col.emr !== -1;
  if (!headerOk) return { headerOk: false, rows: [] };

  const get = (r, key) => (col[key] !== -1 && r[col[key]] != null) ? String(r[col[key]]).trim() : '';

  const rows = table.slice(1).map((r, i) => {
    const errors = [];
    const name = get(r, 'name');
    const emr = get(r, 'emr');
    if (!name) errors.push('Name is required');
    if (!emr) errors.push('EMR Number is required');

    const wardRaw = get(r, 'ward');
    let ward = '';
    if (wardRaw) {
      const matched = matchWard(wardRaw);
      if (matched === null) errors.push('Ward "' + wardRaw + '" doesn\u2019t match any known ward');
      else ward = matched;
    }

    const pedRaw = get(r, 'pedBedType');
    let pedBedType = '';
    if (ward === 'PEDIATRIC/NICU WARD' && pedRaw) {
      const matched = matchBedType(pedRaw);
      if (matched === null) errors.push('Bed/Cot "' + pedRaw + '" must be "Bed" or "Cot"');
      else pedBedType = matched;
    }

    const admissionDateRaw = get(r, 'admissionDate');
    if (admissionDateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(admissionDateRaw)) {
      errors.push('Date of Admission "' + admissionDateRaw + '" should be YYYY-MM-DD');
    }

    // Drugs column: same free-typed "one order per line" format as the
    // Drug Course Chart's own Bulk Upload Drugs feature — reuse its parser
    // directly so both entry points understand the exact same syntax.
    const drugsRaw = get(r, 'drugs');
    const drugsParsed = drugsRaw ? parseBulkText(drugsRaw) : [];

    return {
      line: i + 2, // +1 for header row, +1 for 1-indexing
      data: {
        name, emr, diagnosis: get(r, 'diagnosis'), ward, pedBedType,
        age: get(r, 'age'), hospNo: get(r, 'hospNo'),
        admissionDate: admissionDateRaw, allergies: get(r, 'allergies'), insurance: get(r, 'insurance'),
        drugsRaw, drugsParsed
      },
      errors
    };
  });

  return { headerOk: true, rows };
}
