// The "Notes" box on a nurse's patient write-up keeps the patient's
// diagnosis as its first line, written "Diagnosis: <text>", followed by the
// nurse's free-text notes. It is still ONE string saved under the existing
// `diagnosis` key, so every report already on file, the Overall Nurse view
// and the Archive all keep working with no data migration. These helpers
// split that string into its two parts (for the editor and for the styled
// read-only view) and put it back together.

const HEADER_RE = /^Diagnosis[ \t]*:[ \t]?/i;

// Newlines are not allowed inside the diagnosis line itself.
function oneLine(s) {
  return String(s || '').replace(/\s*\n+\s*/g, ' ');
}

export function splitDiagnosisNote(text) {
  const s = typeof text === 'string' ? text : '';
  const nl = s.indexOf('\n');
  const first = nl === -1 ? s : s.slice(0, nl);
  const m = HEADER_RE.exec(first);
  if (!m) return { hasHeader: false, diagnosis: '', rest: s };
  return { hasHeader: true, diagnosis: first.slice(m[0].length), rest: nl === -1 ? '' : s.slice(nl + 1) };
}

export function joinDiagnosisNote(diagnosis, rest) {
  const d = oneLine(diagnosis);
  const r = typeof rest === 'string' ? rest : '';
  if (!d && !r) return '';
  if (!d) return r;
  return r ? 'Diagnosis: ' + d + '\n' + r : 'Diagnosis: ' + d;
}

// Auto-fill from the patient's record: puts the patient's diagnosis on the
// "Diagnosis:" line only when that line is still blank, and keeps anything
// the nurse already typed as the notes underneath it.
export function withPatientDiagnosis(existing, patientDiagnosis) {
  const d = oneLine(patientDiagnosis).trim();
  const current = typeof existing === 'string' ? existing : '';
  if (!d) return current;
  const parts = splitDiagnosisNote(current);
  if (parts.diagnosis.trim()) return current;
  return joinDiagnosisNote(d, parts.rest);
}
