import { useEffect, useRef } from "react";

// Editable "Vital Signs Roll". A <textarea> cannot bold part of its text, so
// this is a plain-text contentEditable box that bolds the chart note leading a
// reading ("PRE-TRANSFUSION VITALS: T-36.7..."). The stored value is still the
// same plain string, so saved write-ups and the report views are unaffected.
const NOTE_RE = /^(.+?):(\s+T-.*)$/;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toHtml(text) {
  return String(text || '').split('\n').map((line) => {
    const m = line.match(NOTE_RE);
    return m ? `<strong>${esc(m[1])}:</strong>${esc(m[2])}` : esc(line);
  }).join('\n');
}

function getOffset(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0).cloneRange();
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}

function setOffset(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode(), left = offset;
  while (n) {
    if (left <= n.nodeValue.length) {
      const r = document.createRange();
      r.setStart(n, left); r.collapse(true);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return;
    }
    left -= n.nodeValue.length;
    n = walker.nextNode();
  }
}

export default function VitalsRollEditor({ value, onChange }) {
  const ref = useRef(null);
  const composing = useRef(false);

  // Sync DOM from the value (external fills/edits, or note styling changes)
  // only when the markup differs, so typing is never disturbed.
  useEffect(() => {
    const el = ref.current;
    if (!el || composing.current) return;
    const html = toHtml(value);
    if (el.innerHTML !== html) {
      const focused = document.activeElement === el;
      const off = focused ? getOffset(el) : null;
      el.innerHTML = html;
      if (focused && off !== null) setOffset(el, off);
    }
  }, [value]);

  return (
    <div
      ref={ref}
      className="vitals-roll-editor"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(e) => { composing.current = false; onChange(e.currentTarget.textContent); }}
      onInput={(e) => { if (!composing.current) onChange(e.currentTarget.textContent); }}
    />
  );
}
