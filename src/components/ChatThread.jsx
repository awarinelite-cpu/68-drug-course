import { useEffect, useRef, useState } from "react";
import {
  collection, doc, setDoc, addDoc, updateDoc, serverTimestamp, orderBy, query, onSnapshot
} from "firebase/firestore";
import { db } from "../firebase.js";
import { avatarMarkup } from "../lib/avatar.js";
import Topbar from "./Topbar.jsx";

const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const TYPING_IDLE_MS = 3000;

function fmtWhen(ts) {
  if (!ts || typeof ts.toDate !== 'function') return '';
  const d = ts.toDate();
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return dateStr + ', ' + timeStr;
}
function fmtTime(ts) {
  if (!ts || typeof ts.toDate !== 'function') return '';
  return ts.toDate().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function groupAvatarHtml(size = 40) {
  return '<div class="group-avatar" style="width:' + size + 'px;height:' + size + 'px;">&#128101;</div>';
}
function isRecentlyActive(lastActive) {
  if (!lastActive || typeof lastActive.toMillis !== 'function') return false;
  return (Date.now() - lastActive.toMillis()) < ONLINE_WINDOW_MS;
}
function otherUidOf(convo, currentUid) {
  return (convo.participants || []).find(u => u !== currentUid);
}

export default function ChatThread({ convoId, currentUid, currentProfile, nurseByUid, onBack }) {
  const [convo, setConvo] = useState(null);
  const [msgs, setMsgs] = useState(null); // null while loading
  const [msgsError, setMsgsError] = useState(null);
  const [typers, setTypers] = useState([]);
  const [input, setInput] = useState('');

  const iAmTypingRef = useRef(false);
  const typingTimeoutRef = useRef(null);
  const msgsWrapRef = useRef(null);
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    setConvo(null);
    setMsgs(null);
    setMsgsError(null);
    setTypers([]);

    const unsubConvo = onSnapshot(doc(db, 'conversations', convoId), (snap) => {
      if (!snap.exists()) return;
      const c = { id: snap.id, ...snap.data() };
      setConvo(c);
      markRead();
    });

    const msgsQuery = query(collection(db, 'conversations', convoId, 'messages'), orderBy('createdAt', 'asc'));
    // includeMetadataChanges: true is required so this fires again once a
    // pending write actually reaches the server — without it, a message
    // written while offline gets exactly one snapshot (hasPendingWrites:
    // true) and the tick UI would never learn it later synced.
    const unsubMessages = onSnapshot(msgsQuery, { includeMetadataChanges: true }, (snap) => {
      const list = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }));
      setMsgs(list);
    }, (e) => {
      setMsgsError("Couldn't load: " + (e.code || e.message || 'unknown error'));
    });

    const unsubTyping = onSnapshot(collection(db, 'conversations', convoId, 'typing'), (snap) => {
      const list = [];
      snap.forEach(d => {
        if (d.id === currentUid) return;
        const data = d.data();
        if (data.typing && data.updatedAt && Date.now() - data.updatedAt.toMillis() < TYPING_IDLE_MS + 2000) {
          list.push(nurseByUid[d.id] ? nurseByUid[d.id].name : 'Someone');
        }
      });
      setTypers(list);
    });

    return () => {
      unsubConvo();
      unsubMessages();
      unsubTyping();
      clearTypingFlag();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convoId]);

  useEffect(() => {
    if (!msgs) return;
    const wrap = msgsWrapRef.current;
    if (!wrap) return;
    if (wasAtBottomRef.current || msgs.length <= 1) wrap.scrollTop = wrap.scrollHeight;
  }, [msgs]);

  function handleScroll() {
    const wrap = msgsWrapRef.current;
    if (!wrap) return;
    wasAtBottomRef.current = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 30;
  }

  async function markRead() {
    try {
      await updateDoc(doc(db, 'conversations', convoId), { ['readBy.' + currentUid]: serverTimestamp() });
    } catch (e) { /* non-fatal */ }
  }

  function handleInputChange(v) {
    setInput(v);
    if (!iAmTypingRef.current) {
      iAmTypingRef.current = true;
      setDoc(doc(db, 'conversations', convoId, 'typing', currentUid), { typing: true, updatedAt: serverTimestamp() }).catch(() => {});
    }
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(clearTypingFlag, TYPING_IDLE_MS);
  }

  function clearTypingFlag() {
    if (!iAmTypingRef.current) return;
    iAmTypingRef.current = false;
    setDoc(doc(db, 'conversations', convoId, 'typing', currentUid), { typing: false, updatedAt: serverTimestamp() }).catch(() => {});
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text) return;
    setInput('');
    clearTimeout(typingTimeoutRef.current);
    clearTypingFlag();
    try {
      await addDoc(collection(db, 'conversations', convoId, 'messages'), {
        senderUid: currentUid, text,
        replyTo: null,
        reactions: {}, starredBy: [],
        createdAt: serverTimestamp(), editedAt: null
      });
      await updateDoc(doc(db, 'conversations', convoId), {
        lastMessageText: text, lastMessageAt: serverTimestamp(), lastMessageSenderUid: currentUid
      });
    } catch (e) {
      alert("Couldn't send: " + (e.code || e.message || 'unknown error'));
    }
  }

  if (!convo) {
    return (
      <>
        <Topbar brand="Messages">
          <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={onBack}>Back</button>
        </Topbar>
        <div className="container"><div className="card-box"><div className="loading-note">Loading…</div></div></div>
      </>
    );
  }

  const isGroup = convo.type === 'group';
  const otherUid = isGroup ? null : otherUidOf(convo, currentUid);
  const otherNurse = otherUid ? nurseByUid[otherUid] : null;
  const otherGender = isGroup ? null : (convo.participantGenders && convo.participantGenders[otherUid]) || null;
  const headName = isGroup ? (convo.groupName || 'Group') : ((convo.participantNames && convo.participantNames[otherUid]) || 'Unknown');
  const online = !isGroup && otherNurse && isRecentlyActive(otherNurse.lastActive);

  let statusClass = 'thread-head-status';
  let statusText = '';
  if (isGroup) {
    statusText = (convo.participants || []).length + ' members';
  } else {
    statusClass += online ? ' online' : '';
    statusText = online ? 'Online' : (otherNurse && otherNurse.lastActive ? 'Last seen ' + fmtWhen(otherNurse.lastActive) : '');
  }
  if (typers.length) {
    statusClass = 'thread-head-status typing';
    statusText = typers.join(', ') + (typers.length > 1 ? ' are typing…' : ' is typing…');
  }

  const otherParticipants = (convo.participants || []).filter(u => u !== currentUid);

  return (
    <>
      <Topbar brand="Messages" />
      <div className="container">
        <div className="card-box thread-view">
          <div className="thread-head">
            <button className="thread-back" onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#2563eb', padding: '0 6px 0 0' }}>&larr;</button>
            <div dangerouslySetInnerHTML={{ __html: isGroup ? groupAvatarHtml(32) : avatarMarkup({ name: '', gender: otherGender }, 32) }} />
            <div className="thread-head-info">
              <div className="thread-head-name">{headName}</div>
              <div className={statusClass}>{statusText}</div>
            </div>
          </div>

          <div className="thread-msgs" ref={msgsWrapRef} onScroll={handleScroll}>
            {msgsError && <div className="loading-note">{msgsError}</div>}
            {msgs === null && !msgsError && <div className="loading-note">Loading…</div>}
            {msgs && msgs.map(m => {
              const isMine = m.senderUid === currentUid;
              let readByAll = false;
              if (isMine && convo.readBy) {
                readByAll = otherParticipants.length > 0 && otherParticipants.every(uid => {
                  const rt = convo.readBy[uid];
                  const rms = rt?.toMillis ? rt.toMillis() : 0;
                  const mms = m.createdAt?.toMillis ? m.createdAt.toMillis() : Infinity;
                  return rms >= mms;
                });
              }
              const senderName = (m.senderUid && nurseByUid[m.senderUid] && nurseByUid[m.senderUid].name) ||
                (convo.participantNames && convo.participantNames[m.senderUid]) || '';

              return (
                <div key={m.id} className={"msg-row" + (isMine ? ' mine' : '')}>
                  <div className="msg-bubble-wrap">
                    {isGroup && !isMine && <div className="msg-sender-name">{senderName}</div>}
                    <div className="msg-bubble">
                      {m.text}
                      <div className="msg-meta">
                        <span>{fmtTime(m.createdAt)}{m.editedAt ? ' · edited' : ''}</span>
                        {isMine && (
                          m._pending
                            ? <span className="msg-ticks msg-ticks-pending">&#128340;</span>
                            : <span className={"msg-ticks" + (readByAll ? ' read' : '')}>&#10003;&#10003;</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="thread-compose">
            <input
              type="text"
              placeholder="Type a message…"
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') sendMessage(); }}
            />
            <button className="btn btn-primary" style={{ padding: '10px 16px' }} onClick={sendMessage}>Send</button>
          </div>
        </div>
      </div>
    </>
  );
}
