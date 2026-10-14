import { Fragment } from 'react';

// Renders Vital Signs Roll text, bolding the chart note that leads a reading
// (e.g. "PRE-TRANSFUSION VITALS: T-36.7⁰c ...") so it stands out in the report.
const NOTE_RE = /^(.+?):\s+(T-.*)$/;

export default function VitalsNoteText({ text }) {
  const lines = String(text || '').split('\n');
  return (
    <>
      {lines.map((line, i) => {
        const m = line.match(NOTE_RE);
        return (
          <Fragment key={i}>
            {m ? <><strong>{m[1]}:</strong> {m[2]}</> : line}
            {i < lines.length - 1 ? '\n' : null}
          </Fragment>
        );
      })}
    </>
  );
}
