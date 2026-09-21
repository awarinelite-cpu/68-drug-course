import { useEffect, useRef } from "react";
import { splitDiagnosisNote, joinDiagnosisNote } from "../lib/diagnosisNote.js";

// Read-only "Diagnosis: GASTRITIS" line shown at the top of a saved note
// (Ward Nurse, Overall Nurse and Archive views): bold Arial Black, larger.
export function DiagnosisHeadline({ diagnosis }) {
  return (
    <p className="patient-note-diagnosis">
      <span>Diagnosis:</span> <span>{diagnosis}</span>
    </p>
  );
}

// The editable "Notes" box. Looks like one textarea, with the bold
// "Diagnosis: <patient diagnosis>" line sitting inside it at the top and the
// nurse's notes underneath. A plain <textarea> cannot bold one line, so the
// box is a bordered wrapper around a small diagnosis field plus a borderless
// notes textarea. The value in and out is still the single `diagnosis`
// string ("Diagnosis: X\n<notes>"), see lib/diagnosisNote.js.
export default function DiagnosisNoteEditor({ value, onChange }) {
  const { diagnosis, rest } = splitDiagnosisNote(value);
  const headRef = useRef(null);
  const bodyRef = useRef(null);

  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [diagnosis]);

  return (
    <div className="diagnosis-note-box">
      <div className="diagnosis-note-head">
        <span className="diagnosis-note-key">Diagnosis:</span>
        <textarea ref={headRef} rows={1} className="diagnosis-note-input" placeholder="Patient diagnosis"
          value={diagnosis}
          onChange={(e) => onChange(joinDiagnosisNote(e.target.value, rest))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); bodyRef.current?.focus(); } }} />
      </div>
      <textarea ref={bodyRef} className="diagnosis-note-body" value={rest}
        onChange={(e) => onChange(joinDiagnosisNote(diagnosis, e.target.value))} />
    </div>
  );
}
