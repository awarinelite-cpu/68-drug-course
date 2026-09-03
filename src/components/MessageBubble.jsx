import { useEffect, useRef, useState } from "react";

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const LONG_PRESS_MS = 300;
const LONG_PRESS_MOVE_TOLERANCE = 10; // px of finger drift still allowed mid-press

function fmtTime(ts) {
  if (!ts || typeof ts.toDate !== 'function') return '';
  return ts.toDate().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function MessageBubble({
  message: m, isMine, isGroup, senderName, readByAll, currentUid,
  onToggleReaction, onReply
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const wrapRef = useRef(null);
  const dragState = useRef({ startX: 0, startY: 0, dx: 0, dragging: false, claimed: false, longPressTimer: null });
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Tap anywhere outside an open reaction picker to dismiss it.
  useEffect(() => {
    if (!pickerOpen) return;
    function onDocClick(ev) {
      if (wrapRef.current && !wrapRef.current.contains(ev.target)) setPickerOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [pickerOpen]);

  function openPicker() {
    setPickerOpen(true);
    if (navigator.vibrate) navigator.vibrate(15);
  }

  function clearLongPress() {
    if (dragState.current.longPressTimer) {
      clearTimeout(dragState.current.longPressTimer);
      dragState.current.longPressTimer = null;
    }
  }

  function onTouchStart(ev) {
    const t = ev.touches[0];
    dragState.current.startX = t.clientX;
    dragState.current.startY = t.clientY;
    dragState.current.dx = 0;
    dragState.current.dragging = true;
    dragState.current.claimed = false;
    clearLongPress();
    // Hold-to-react: if the finger stays roughly put for LONG_PRESS_MS, pop
    // the emoji strip open and abandon swipe tracking for this touch.
    dragState.current.longPressTimer = setTimeout(() => {
      dragState.current.longPressTimer = null;
      dragState.current.dragging = false;
      setDragging(false);
      setDragX(0);
      openPicker();
    }, LONG_PRESS_MS);
  }

  function onTouchMove(ev) {
    const s = dragState.current;
    if (!s.dragging) return;
    const curX = ev.touches[0].clientX;
    const curY = ev.touches[0].clientY;
    s.dx = curX - s.startX;
    const dy = curY - s.startY;
    if (!s.claimed) {
      if (Math.abs(s.dx) < LONG_PRESS_MOVE_TOLERANCE && Math.abs(dy) < LONG_PRESS_MOVE_TOLERANCE) return;
      clearLongPress(); // real movement this early means it's not a long-press
      if (Math.abs(s.dx) <= Math.abs(dy)) { s.dragging = false; return; }
      s.claimed = true;
      setDragging(true);
    }
    ev.preventDefault();
    const clamped = Math.max(-70, Math.min(70, s.dx));
    setDragX(clamped);
  }

  function onTouchEnd() {
    const s = dragState.current;
    clearLongPress();
    s.dragging = false;
    setDragging(false);
    setDragX(0);
    if (s.claimed && Math.abs(s.dx) > 50) onReply(m, senderName);
    s.dx = 0;
  }

  const reactions = m.reactions || {};
  const chipEntries = Object.keys(reactions).filter(e => (reactions[e] || []).length > 0);
  const isStarred = (m.starredBy || []).includes(currentUid);

  return (
    <div className={"msg-row" + (isMine ? ' mine' : '')}>
      <div
        className={"msg-bubble-wrap" + (dragging ? ' dragging' : '')}
        ref={wrapRef}
        style={{ transform: `translateX(${dragX}px)` }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={clearLongPress}
      >
        {isGroup && !isMine && <div className="msg-sender-name">{senderName}</div>}

        <div className={"reaction-picker" + (pickerOpen ? ' open' : '')}>
          {REACTION_EMOJIS.map(e => (
            <span key={e} onClick={() => { onToggleReaction(m, e); setPickerOpen(false); }}>{e}</span>
          ))}
        </div>

        <div className="msg-bubble">
          {m.forwardedFrom && <div className="msg-fwd-tag">&#10148; Forwarded</div>}
          {m.replyTo && (
            <div className="msg-reply-quote">
              <span className="rq-name">{m.replyTo.senderName || ''}</span>
              {m.replyTo.text || ''}
            </div>
          )}
          {m.imageUrl && (
            <img className="msg-img" src={m.imageUrl} onClick={() => window.open(m.imageUrl, '_blank')} alt="" />
          )}
          {m.audioUrl && (
            <audio className="msg-audio" controls src={m.audioUrl} />
          )}
          {m.text}
          <div className="msg-meta">
            {isStarred && <span className="msg-star-mark">&#11088;</span>}
            <span>{fmtTime(m.createdAt)}{m.editedAt ? ' · edited' : ''}</span>
            {isMine && (
              m._pending
                ? <span className="msg-ticks msg-ticks-pending">&#128340;</span>
                : <span className={"msg-ticks" + (readByAll ? ' read' : '')}>&#10003;&#10003;</span>
            )}
          </div>
        </div>

        {chipEntries.length > 0 && (
          <div className="reaction-chips">
            {chipEntries.map(e => {
              const uids = reactions[e] || [];
              const mine = uids.includes(currentUid);
              return (
                <span key={e} className={"reaction-chip" + (mine ? ' mine' : '')} onClick={() => onToggleReaction(m, e)}>
                  {e} {uids.length}
                </span>
              );
            })}
          </div>
        )}

        <div className="msg-actions-row">
          <button onClick={() => openPicker()}>React</button>
          <button onClick={() => onReply(m, senderName)}>Reply</button>
        </div>
      </div>
    </div>
  );
}
