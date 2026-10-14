import { useLayoutEffect, useRef } from "react";

// Ward report heading. In a wide (desktop) layout it is forced onto ONE line
// and scaled so the text runs from the left edge of the table to the right
// edge. In a narrow (phone) layout it falls back to the normal wrapping title.
const DESKTOP_MIN_WIDTH = 700;
const MAX_FONT_PX = 34;

export default function FitTitle({ children, className = "ward-report-title" }) {
  const wrapRef = useRef(null);
  const textRef = useRef(null);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const text = textRef.current;
    if (!wrap || !text) return;

    function fit() {
      const w = wrap.clientWidth;
      if (w < DESKTOP_MIN_WIDTH) {
        text.style.whiteSpace = '';
        text.style.fontSize = '';
        text.style.display = '';
        return;
      }
      text.style.display = 'inline-block';
      text.style.whiteSpace = 'nowrap';
      text.style.fontSize = '20px';
      const natural = text.scrollWidth;
      const size = Math.min(MAX_FONT_PX, Math.floor((20 * w / natural) * 100) / 100);
      text.style.fontSize = size + 'px';
    }

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    return () => ro.disconnect();
  }, [children]);

  return (
    <div ref={wrapRef} style={{ width: '100%', overflow: 'hidden' }}>
      <div ref={textRef} className={className}>{children}</div>
    </div>
  );
}
