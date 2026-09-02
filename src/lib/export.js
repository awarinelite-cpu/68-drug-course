// Patient-record export — independent of Firestore, for legal/audit purposes.
// Produces either a structured JSON dump or a formatted PDF, either scoped to
// one admission or the patient's full history (every closed admission plus
// the currently active one, if it has any data).
import { doc, getDoc, collection, getDocs, query, orderBy } from "firebase/firestore";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { db } from "../firebase.js";

// ---------- data gathering ----------

function toRows(snap) { const arr = []; snap.forEach(d => arr.push(d.data())); return arr; }

async function gatherPatient(patientId) {
  const snap = await getDoc(doc(db, 'patients', patientId));
  if (!snap.exists()) throw new Error('Patient not found.');
  return { id: patientId, ...snap.data() };
}

async function gatherActiveAdmission(patientId) {
  const [drugSnap, bgSnap, vitalsSnap, ioSnap, ioSumSnap, seizureSnap] = await Promise.all([
    getDoc(doc(db, 'patients', patientId, 'drugCourseChart', 'main')),
    getDoc(doc(db, 'patients', patientId, 'bloodGlucose', 'main')),
    getDocs(query(collection(db, 'patients', patientId, 'vitals'), orderBy('time', 'asc'))),
    getDocs(query(collection(db, 'patients', patientId, 'intakeOutput'), orderBy('time', 'asc'))),
    getDoc(doc(db, 'patients', patientId, 'intakeOutputSummary', 'current')),
    getDocs(query(collection(db, 'patients', patientId, 'seizure'), orderBy('time', 'asc')))
  ]);
  return {
    kind: 'active',
    diagnosis: (drugSnap.exists() && drugSnap.data().f_diagnosis) || 'No diagnosis entered yet',
    statusLabel: 'Currently active',
    drugCourseChart: drugSnap.exists() ? drugSnap.data() : null,
    bloodGlucose: bgSnap.exists() ? bgSnap.data() : null,
    vitals: toRows(vitalsSnap),
    intakeOutput: toRows(ioSnap),
    intakeOutputSummary: ioSumSnap.exists() ? ioSumSnap.data() : null,
    seizure: toRows(seizureSnap)
  };
}

// Reads glycemic rows for whichever chart type is active, handling both the
// current per-type schema (rows6/rows3, each row wrapped as { cells } since
// Firestore rejects bare nested arrays) and older archived docs that only
// have a single 'rows' field (which belonged to whichever chartType was
// active when it was saved).
function pickGlucoseRows(bg) {
  const unwrap = arr => (arr || []).map(r => r.cells || r);
  const chartType = bg.chartType === '3point' ? '3point' : '6point';
  if (bg.rows6 || bg.rows3) {
    return { chartType, rows: unwrap(chartType === '6point' ? bg.rows6 : bg.rows3) };
  }
  return { chartType, rows: unwrap(bg.rows) };
}

function hasActiveData(a) {
  const dc = a.drugCourseChart;
  const hasDrug = !!(dc && ((dc.f_diagnosis || '') || (dc.drugs || []).some(d => d && d.name) || (dc.rows || []).some(r => r && (r.date || r.sno))));
  const bg = a.bloodGlucose;
  const hasBg = !!(bg && pickGlucoseRows(bg).rows.some(r => Array.isArray(r) && r.some(cell => cell)));
  return hasDrug || hasBg || a.vitals.length > 0 || a.intakeOutput.length > 0 || a.seizure.length > 0;
}

function normalizeArchived(data, id) {
  const STATUS_LABELS = { referred: 'Referred to another hospital', transferred: 'Transferred to another ward', discharged: 'Discharged' };
  return {
    kind: data.archiveReason || 'closed',
    id,
    diagnosis: data.diagnosis || 'No diagnosis recorded',
    statusLabel: (data.archiveReasonLabel || STATUS_LABELS[data.archiveReason] || 'Closed') + (data.archivedAtDisplay ? ' — ' + data.archivedAtDisplay : ''),
    drugCourseChart: data.drugCourseChart || null,
    bloodGlucose: data.bloodGlucose || null,
    vitals: data.vitals || [],
    intakeOutput: data.intakeOutput || [],
    intakeOutputSummary: data.intakeOutputSummary || null,
    seizure: data.seizure || []
  };
}

async function gatherArchivedAdmission(patientId, admissionId) {
  const snap = await getDoc(doc(db, 'patients', patientId, 'admissions', admissionId));
  if (!snap.exists()) throw new Error('Admission record not found.');
  return normalizeArchived(snap.data(), admissionId);
}

async function gatherAllArchivedAdmissions(patientId) {
  const out = [];
  try {
    const q = query(collection(db, 'patients', patientId, 'admissions'), orderBy('archivedAt', 'asc'));
    const snap = await getDocs(q);
    snap.forEach(d => out.push(normalizeArchived(d.data(), d.id)));
  } catch (e) {
    // Composite index may not exist yet — fall back to an unordered fetch, sorted client-side.
    const snap = await getDocs(collection(db, 'patients', patientId, 'admissions'));
    const raw = [];
    snap.forEach(d => raw.push({ id: d.id, ...d.data() }));
    raw.sort((a, b) => (a.archivedAtDisplay || '').localeCompare(b.archivedAtDisplay || ''));
    raw.forEach(data => out.push(normalizeArchived(data, data.id)));
  }
  return out;
}

// scope: 'this' (default) uses admissionId if given, else the active admission.
//        'all' gathers the full history — every closed admission plus the
//        active one, if it has any data at all.
export async function buildExportRecord(patientId, { admissionId, scope, exportedBy } = {}) {
  const patient = await gatherPatient(patientId);
  let admissions;
  if (scope === 'all') {
    const active = await gatherActiveAdmission(patientId);
    const archived = await gatherAllArchivedAdmissions(patientId);
    admissions = [...(hasActiveData(active) ? [active] : []), ...archived];
  } else if (admissionId) {
    admissions = [await gatherArchivedAdmission(patientId, admissionId)];
  } else {
    admissions = [await gatherActiveAdmission(patientId)];
  }
  return { patient, admissions, exportedAt: new Date(), exportedBy: exportedBy || null };
}

// ---------- filenames / downloads ----------

function safeSlug(s) {
  return String(s || '').trim().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'patient';
}

function filenameFor(record, tag) {
  const date = record.exportedAt.toISOString().slice(0, 10);
  return safeSlug(record.patient.name) + '_' + safeSlug(record.patient.emr || record.patient.id) + '_' + tag + '_' + date;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function jsonReplacer(key, value) {
  if (value && typeof value === 'object' && typeof value.toDate === 'function') {
    try { return value.toDate().toISOString(); } catch (e) { return null; }
  }
  return value;
}

export function downloadRecordAsJson(record, tag) {
  const blob = new Blob([JSON.stringify(record, jsonReplacer, 2)], { type: 'application/json' });
  triggerDownload(blob, filenameFor(record, tag) + '.json');
}

// ---------- admin: full-database backup ----------
// There's no server here to run this on a real cron schedule — this is a
// client-side app talking to Firestore directly, with no Cloud Functions
// deployed. This is the honest substitute: a one-click, on-demand export of
// every patient's full history that an admin can run on whatever cadence
// they choose (e.g. weekly) and store off-platform.

async function gatherAllPatientIds() {
  const snap = await getDocs(collection(db, 'patients'));
  const ids = [];
  snap.forEach(d => ids.push(d.id));
  return ids;
}

export async function downloadFullBackup(exportedBy, onProgress) {
  const ids = await gatherAllPatientIds();
  const patients = [];
  for (let i = 0; i < ids.length; i++) {
    if (onProgress) onProgress(i + 1, ids.length);
    try {
      patients.push(await buildExportRecord(ids[i], { scope: 'all', exportedBy }));
    } catch (e) {
      patients.push({ patientId: ids[i], error: e.message || String(e) });
    }
  }
  const bundle = { exportedAt: new Date(), exportedBy: exportedBy || null, patientCount: patients.length, patients };
  const blob = new Blob([JSON.stringify(bundle, jsonReplacer, 2)], { type: 'application/json' });
  triggerDownload(blob, 'hospital_backup_' + new Date().toISOString().slice(0, 10) + '.json');
  return { count: patients.length };
}

// ---------- PDF ----------
// jsPDF and jspdf-autotable are bundled by Vite (no external CDN at runtime),
// so PDF export/share works fully offline and never depends on a third party.

const isAbnormalTemp = v => { const n = parseFloat(v); return !isNaN(n) && (n < 36.1 || n > 37.5); };
const isAbnormalPulse = v => { const n = parseFloat(v); return !isNaN(n) && (n < 60 || n > 100); };
const isAbnormalResp = v => { const n = parseFloat(v); return !isNaN(n) && (n < 12 || n > 20); };
const isAbnormalSpo2 = v => { const n = parseFloat(v); return !isNaN(n) && n < 95; };
const isAbnormalBP = v => {
  const m = String(v || '').match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!m) return false;
  const sys = parseInt(m[1], 10), dia = parseInt(m[2], 10);
  return sys < 90 || sys > 140 || dia < 60 || dia > 90;
};
const isAbnormalGlucose = v => { const n = parseFloat(v); return !isNaN(n) && (n < 70 || n > 180); };

const PAGE_LEFT = 40, PAGE_RIGHT = 555, PAGE_BOTTOM = 800;

function ensureSpace(pdf, y, needed) {
  if (y + needed > PAGE_BOTTOM) { pdf.addPage(); return 40; }
  return y;
}

function sectionTitle(pdf, y, text) {
  y = ensureSpace(pdf, y, 32);
  pdf.setDrawColor(209, 213, 219);
  pdf.line(PAGE_LEFT, y, PAGE_RIGHT, y);
  pdf.setFont(undefined, 'bold'); pdf.setFontSize(11);
  pdf.text(text, PAGE_LEFT, y + 15);
  pdf.setFont(undefined, 'normal'); pdf.setFontSize(9);
  return y + 24;
}

function addTable(pdf, y, head, body, opts) {
  if (!body.length) return y;
  y = ensureSpace(pdf, y, 40);
  autoTable(pdf, Object.assign({
    startY: y, head: [head], body,
    styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [17, 24, 39], fontSize: 7.5 },
    margin: { left: PAGE_LEFT, right: 842 - PAGE_RIGHT }
  }, opts || {}));
  return pdf.lastAutoTable.finalY + 10;
}

function addPatientHeader(pdf, record) {
  const p = record.patient;
  pdf.setFont(undefined, 'bold'); pdf.setFontSize(15);
  pdf.text('68 NARHY Ward Charts — Patient Record', PAGE_LEFT, 42);
  pdf.setFont(undefined, 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(90);
  pdf.text('Exported ' + record.exportedAt.toLocaleString() + (record.exportedBy ? ' by ' + record.exportedBy : ''), PAGE_LEFT, 55);
  pdf.setTextColor(0);

  const rows = [
    ['Name', p.name || '-', 'EMR', p.emr || '-'],
    ['Hospital No', p.hospNo || '-', 'Age', p.age || '-'],
    ['Ward', p.ward || '-', 'Date of Admission', p.admissionDate || '-']
  ];
  autoTable(pdf, {
    startY: 66, theme: 'plain', styles: { fontSize: 9, cellPadding: 2 },
    body: rows, margin: { left: PAGE_LEFT, right: 842 - PAGE_RIGHT },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 90 }, 2: { fontStyle: 'bold', cellWidth: 110 } }
  });
  let y = pdf.lastAutoTable.finalY + 6;

  const allergyText = (p.allergies || '').trim();
  const hasAllergy = !!allergyText && !/^(none|nil|none known)$/i.test(allergyText);
  pdf.setFont(undefined, 'bold'); pdf.setFontSize(9.5);
  if (hasAllergy) pdf.setTextColor(185, 28, 28);
  pdf.text('Allergies: ' + (allergyText || 'None known'), PAGE_LEFT, y + 10);
  pdf.setTextColor(0);
  pdf.setFont(undefined, 'normal');
  pdf.text('Diagnosis: ' + (p.diagnosis || 'Not specified'), PAGE_LEFT, y + 24);
  return y + 38;
}

function addDrugChartSection(pdf, y, dc) {
  if (!dc) return y;
  y = sectionTitle(pdf, y, 'Drug Course Chart');
  pdf.text('Diagnosis: ' + (dc.f_diagnosis || '-'), PAGE_LEFT, y);
  pdf.text('Admitted: ' + (dc.f_admission || '-') + '     Discharge Date: ' + (dc.f_discharge || '-'), PAGE_LEFT, y + 12);
  y += 26;

  const drugRows = (dc.drugs || []).filter(d => d && d.name).map(d => [d.name, d.route, d.frequency, d.action, d.duration]);
  y = addTable(pdf, y, ['Drug', 'Route', 'Frequency', 'Action', 'Duration'], drugRows);

  const adminRows = (dc.rows || []).filter(r => r && (r.date || r.sno || r.time)).map(r => [r.date, r.sno, r.time, r.dose, r.route, r.nurse, r.remark]);
  y = addTable(pdf, y, ['Date', 'Drug S/N', 'Time', 'Dose', 'Route', 'Nurse', 'Remark'], adminRows);

  const voRows = (dc.verbalOrders || []).map(o => [o.at ? new Date(o.at).toLocaleString() : '', o.text || '', o.nurse || '']);
  if (voRows.length) {
    y = ensureSpace(pdf, y, 16);
    pdf.setFont(undefined, 'bold'); pdf.text('Verbal / Emergency Orders', PAGE_LEFT, y); pdf.setFont(undefined, 'normal');
    y += 10;
    y = addTable(pdf, y, ['Time', 'Order', 'By'], voRows);
  }
  return y;
}

function addVitalsSection(pdf, y, vitals) {
  if (!vitals.length) return y;
  y = sectionTitle(pdf, y, 'Vital Signs');
  const body = vitals.map(v => [v.time || '', v.temp || '', v.pulse || '', v.resp || '', v.bp || '', v.spo2 || '', v.notes || '']);
  return addTable(pdf, y, ['Time', 'Temp (°C)', 'Pulse', 'Resp', 'BP', 'SpO2 (%)', 'Notes'], body, {
    didParseCell(data) {
      if (data.section !== 'body') return;
      const col = data.column.index, val = data.cell.raw;
      const abnormal = (col === 1 && isAbnormalTemp(val)) || (col === 2 && isAbnormalPulse(val)) ||
        (col === 3 && isAbnormalResp(val)) || (col === 4 && isAbnormalBP(val)) || (col === 5 && isAbnormalSpo2(val));
      if (abnormal) { data.cell.styles.fillColor = [254, 226, 226]; data.cell.styles.textColor = [127, 29, 29]; data.cell.styles.fontStyle = 'bold'; }
    }
  });
}

// A saved row that predates the Time column (added after Date) is one cell
// short for its chart type — insert a blank Time cell so old values still
// land under the correct headers instead of shifting one column left.
const PRE_TIME_COLUMN_COUNT = { '6point': 8, '3point': 5 };
function migrateGlucoseRow(chartType, row) {
  if (Array.isArray(row) && row.length === PRE_TIME_COLUMN_COUNT[chartType]) {
    return [row[0], '', ...row.slice(1)];
  }
  return row;
}

function addGlucoseSection(pdf, y, bg) {
  if (!bg) return y;
  const { chartType, rows: rawRows } = pickGlucoseRows(bg);
  const rows = rawRows.map(r => migrateGlucoseRow(chartType, r));
  if (!rows.some(r => Array.isArray(r) && r.some(c => c))) return y;
  const is6 = chartType !== '3point';
  const head = is6
    ? ['Date', 'Time', 'FBS', '2h PP', 'Pre-Lunch', '2h PL', 'Pre-Dinner', '2h PD', 'Remark']
    : ['Date', 'Time', 'FBS', 'RBS', 'RBS', 'Remark'];
  const valueCols = is6 ? [2, 3, 4, 5, 6, 7] : [2, 3, 4];
  const body = rows.filter(r => Array.isArray(r) && r.some(c => c)).map(r => head.map((_, i) => r[i] || ''));
  y = sectionTitle(pdf, y, 'Glycemic Chart (' + (is6 ? '6 Points' : '3 Points') + ')');
  return addTable(pdf, y, head, body, {
    didParseCell(data) {
      if (data.section !== 'body') return;
      if (valueCols.includes(data.column.index) && isAbnormalGlucose(data.cell.raw)) {
        data.cell.styles.fillColor = [254, 226, 226]; data.cell.styles.textColor = [127, 29, 29]; data.cell.styles.fontStyle = 'bold';
      }
    }
  });
}

function withIOBalance(io) {
  const asc = io.slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  let day = null, running = 0;
  return asc.map(r => {
    const d = (r.time || '').slice(0, 10);
    if (d !== day) { day = d; running = 0; }
    running += (parseFloat(r.intakeAmount) || 0) - (parseFloat(r.outputAmount) || 0);
    return { ...r, balance: running };
  }).sort((a, b) => (b.time || '').localeCompare(a.time || ''));
}

function addIOSection(pdf, y, io, ioSummary) {
  if (!io.length) return y;
  y = sectionTitle(pdf, y, 'Intake & Output');
  const rows = withIOBalance(io);
  const body = rows.map(r => [r.time || '', r.intakeType || '', r.intakeAmount || '', r.outputType || '', r.outputAmount || '', r.balance]);
  y = addTable(pdf, y, ['Time', 'Route of Intake', 'Intake Vol. (ml)', 'Type of Output', 'Output Vol. (ml)', 'Balance (ml)'], body, {
    didParseCell(data) {
      if (data.section !== 'body') return;
      if (data.column.index === 5 && parseFloat(data.cell.raw) < 0) {
        data.cell.styles.fillColor = [254, 243, 199]; data.cell.styles.textColor = [120, 53, 15]; data.cell.styles.fontStyle = 'bold';
      }
    }
  });
  if (ioSummary) {
    y = ensureSpace(pdf, y, 16);
    const deficit = (ioSummary.balance || 0) < 0;
    pdf.setFont(undefined, 'bold');
    if (deficit) pdf.setTextColor(120, 53, 15);
    pdf.text('24-Hour Balance: Intake ' + (ioSummary.intake || 0) + ' ml — Output ' + (ioSummary.output || 0) + ' ml — Balance ' + (ioSummary.balance || 0) + ' ml' + (deficit ? ' (deficit)' : ''), PAGE_LEFT, y);
    pdf.setTextColor(0); pdf.setFont(undefined, 'normal');
    y += 16;
  }
  return y;
}

function addSeizureSection(pdf, y, seizure) {
  if (!seizure.length) return y;
  y = sectionTitle(pdf, y, 'Seizure Chart');
  const body = seizure.map(s => [s.time || '', s.duration || '', s.type || '', s.description || '']);
  return addTable(pdf, y, ['Time', 'Duration', 'Type', 'Description'], body);
}

function addAdmissionSection(pdf, y, admission, index, total) {
  y = ensureSpace(pdf, y, 44);
  pdf.setFillColor(243, 244, 246);
  pdf.rect(36, y - 13, PAGE_RIGHT - 36 + 4, 22, 'F');
  pdf.setFont(undefined, 'bold'); pdf.setFontSize(12);
  const heading = (admission.kind === 'active' ? 'ACTIVE ADMISSION' : 'CLOSED ADMISSION') + (total > 1 ? ' (' + (index + 1) + ' of ' + total + ')' : '');
  pdf.text(heading, 42, y + 2);
  pdf.setFont(undefined, 'normal'); pdf.setFontSize(9);
  y += 20;
  pdf.text((admission.diagnosis || '') + '   —   ' + (admission.statusLabel || ''), PAGE_LEFT, y);
  y += 18;

  y = addDrugChartSection(pdf, y, admission.drugCourseChart);
  y = addVitalsSection(pdf, y, admission.vitals || []);
  y = addGlucoseSection(pdf, y, admission.bloodGlucose);
  y = addIOSection(pdf, y, admission.intakeOutput || [], admission.intakeOutputSummary);
  y = addSeizureSection(pdf, y, admission.seizure || []);
  return y;
}

function buildPdfDocument(record) {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = addPatientHeader(pdf, record);

  if (!record.admissions.length) {
    pdf.setFont(undefined, 'italic');
    pdf.text('No admission data recorded yet.', PAGE_LEFT, y + 10);
  } else {
    record.admissions.forEach((adm, i) => {
      if (i > 0) { pdf.addPage(); y = 40; }
      addAdmissionSection(pdf, y, adm, i, record.admissions.length);
    });
  }

  const pageCount = pdf.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    pdf.setPage(p);
    pdf.setFontSize(7.5); pdf.setTextColor(140);
    pdf.text('Confidential patient record — for authorized hospital use only.', PAGE_LEFT, 822);
    pdf.text('Page ' + p + ' of ' + pageCount, PAGE_RIGHT - 55, 822);
    pdf.setTextColor(0);
  }
  return pdf;
}

export async function downloadRecordAsPdf(record, tag) {
  const pdf = buildPdfDocument(record);
  pdf.save(filenameFor(record, tag) + '.pdf');
}

// Builds the same PDF as downloadRecordAsPdf but returns it as a File, for
// handing to the Web Share API (or anything else that wants the raw bytes)
// instead of triggering a download.
export async function getRecordPdfFile(record, tag) {
  const pdf = buildPdfDocument(record);
  const blob = pdf.output('blob');
  return new File([blob], filenameFor(record, tag) + '.pdf', { type: 'application/pdf' });
}

// Every "Share" action in the app goes through this: builds the PDF and hands
// it to the OS share sheet (so it can go to WhatsApp, email, etc. as an actual
// file) when the browser supports sharing files. If it doesn't, or sharing
// fails for a reason other than the user cancelling, it falls back to just
// downloading the PDF so the nurse still ends up with the file.
export async function sharePdf(record, tag, shareText) {
  const file = await getRecordPdfFile(record, tag);
  if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: (record.patient.name || 'Patient') + ' — Record',
        text: shareText || ''
      });
      return { shared: true };
    } catch (e) {
      if (e && e.name === 'AbortError') return { shared: false, cancelled: true };
      // Fall through to a plain download for any other share failure.
    }
  }
  triggerDownload(file, file.name);
  return { shared: false, downloaded: true };
}
