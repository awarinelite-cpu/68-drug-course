import { useEffect, useRef, useState } from 'react';

// Analog clock time picker — same look and interaction on every platform
// (desktop and mobile), instead of relying on the browser's native
// <input type="time"> control, which renders as a spinner on desktop
// and an analog clock only on some mobile browsers.
//
// value / onChange use 24-hour "HH:MM" strings, same as <input type="time">.

function parseValue(value) {
  if (value && /^\d{2}:\d{2}$/.test(value)) {
    let [h, m] = value.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    let hour12 = h % 12;
    if (hour12 === 0) hour12 = 12;
    return { hour12, minute: m, ampm };
  }
  const now = new Date();
  let h = now.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, minute: now.getMinutes(), ampm };
}

function to24(hour12, minute, ampm) {
  let h = hour12 % 12;
  if (ampm === 'PM') h += 12;
  return String(h).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

const CX = 150, CY = 150, R_FACE = 130, R_HOUR = 96, R_MIN_OUTER = 96, R_MIN_INNER = 68;

function pointFor(index, count, radius) {
  const angle = (index / count) * 2 * Math.PI - Math.PI / 2;
  return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
}

function angleToValue(clientX, clientY, svgEl, count) {
  const rect = svgEl.getBoundingClientRect();
  const scale = 300 / rect.width;
  const x = (clientX - rect.left) * scale - CX;
  const y = (clientY - rect.top) * scale - CY;
  let angle = Math.atan2(y, x) + Math.PI / 2;
  if (angle < 0) angle += 2 * Math.PI;
  const raw = (angle / (2 * Math.PI)) * count;
  return { index: Math.round(raw) % count, dist: Math.hypot(x, y) };
}

export default function TimePicker({ value, onChange, onClose, title }) {
  const init = parseValue(value);
  const [hour12, setHour12] = useState(init.hour12);
  const [minute, setMinute] = useState(init.minute);
  const [ampm, setAmpm] = useState(init.ampm);
  const [mode, setMode] = useState('hour'); // 'hour' | 'minute'
  const svgRef = useRef(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function pickFromPoint(clientX, clientY) {
    if (!svgRef.current) return;
    if (mode === 'hour') {
      const { index } = angleToValue(clientX, clientY, svgRef.current, 12);
      setHour12(index === 0 ? 12 : index);
    } else {
      const { index } = angleToValue(clientX, clientY, svgRef.current, 60);
      setMinute(index % 60);
    }
  }

  function handlePointerDown(e) {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pickFromPoint(e.clientX, e.clientY);
  }
  function handlePointerMove(e) {
    if (!draggingRef.current) return;
    pickFromPoint(e.clientX, e.clientY);
  }
  function handlePointerUp() {
    if (draggingRef.current && mode === 'hour') setMode('minute');
    draggingRef.current = false;
  }

  function handleSet() {
    onChange(to24(hour12, minute, ampm));
    onClose();
  }
  function handleClear() {
    onChange('');
    onClose();
  }

  const handAngle = mode === 'hour'
    ? ((hour12 % 12) / 12) * 2 * Math.PI - Math.PI / 2
    : (minute / 60) * 2 * Math.PI - Math.PI / 2;
  const handRadius = mode === 'hour' ? R_HOUR : (minute % 5 === 0 ? R_MIN_OUTER : R_MIN_INNER);
  const handX = CX + handRadius * Math.cos(handAngle);
  const handY = CY + handRadius * Math.sin(handAngle);

  return (
    <div className="tp-overlay no-print" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tp-box">
        {title && <div className="tp-title">{title}</div>}
        <div className="tp-body">
          <div className="tp-sidebar">
            <div className="tp-digits">
              <button
                type="button"
                className={'tp-digit' + (mode === 'hour' ? ' active' : '')}
                onClick={() => setMode('hour')}
              >{hour12}</button>
              <span className="tp-colon">:</span>
              <button
                type="button"
                className={'tp-digit' + (mode === 'minute' ? ' active' : '')}
                onClick={() => setMode('minute')}
              >{String(minute).padStart(2, '0')}</button>
            </div>
            <div className="tp-ampm">
              <button type="button" className={'tp-ampm-btn' + (ampm === 'AM' ? ' active' : '')} onClick={() => setAmpm('AM')}>AM</button>
              <button type="button" className={'tp-ampm-btn' + (ampm === 'PM' ? ' active' : '')} onClick={() => setAmpm('PM')}>PM</button>
            </div>
          </div>

          <div className="tp-face-wrap">
            <svg
              ref={svgRef}
              viewBox="0 0 300 300"
              className="tp-face"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <circle cx={CX} cy={CY} r={R_FACE} className="tp-face-bg" />
              <line x1={CX} y1={CY} x2={handX} y2={handY} className="tp-hand" />
              <circle cx={CX} cy={CY} r="4" className="tp-hand-center" />
              <circle cx={handX} cy={handY} r="16" className="tp-hand-knob" />

              {mode === 'hour' && Array.from({ length: 12 }, (_, i) => {
                const label = i === 0 ? 12 : i;
                const p = pointFor(i, 12, R_HOUR);
                const selected = hour12 === label;
                return (
                  <text key={i} x={p.x} y={p.y} className={'tp-num' + (selected ? ' selected' : '')} dominantBaseline="central" textAnchor="middle">{label}</text>
                );
              })}

              {mode === 'minute' && Array.from({ length: 12 }, (_, i) => {
                const label = i * 5;
                const p = pointFor(i, 12, R_MIN_OUTER);
                const selected = minute === label;
                return (
                  <text key={i} x={p.x} y={p.y} className={'tp-num' + (selected ? ' selected' : '')} dominantBaseline="central" textAnchor="middle">{String(label).padStart(2, '0')}</text>
                );
              })}
            </svg>
          </div>
        </div>

        <div className="tp-footer">
          <button type="button" className="tp-link" onClick={handleClear}>Clear</button>
          <div className="tp-footer-right">
            <button type="button" className="tp-link" onClick={onClose}>Cancel</button>
            <button type="button" className="tp-link tp-set" onClick={handleSet}>Set</button>
          </div>
        </div>
      </div>
    </div>
  );
}
