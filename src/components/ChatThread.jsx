import { useEffect, useRef, useState } from "react";
import {
  collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, serverTimestamp, orderBy, query, onSnapshot
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "../firebase.js";
import { avatarMarkup } from "../lib/avatar.js";
import Topbar from "./Topbar.jsx";
import MessageBubble from "./MessageBubble.jsx";

const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const TYPING_IDLE_MS = 3000;

function fmtWhen(ts) {
  if (!ts || typeof ts.toDate !== 'function') return '';
  const d = ts.toDate();
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return dateStr + ', ' + timeStr;
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
function convoIdFor(uidA, uidB) {
  const [a, b] = [uidA, uidB].sort();
  return 'dm_' + a + '_' + b;
}

export default function ChatThread({ convoId, currentUid, currentProfile, nurseByUid, allNurses, allConvos, onBack }) {
  const [convo, setConvo] = useState(null);
  const [msgs, setMsgs] = useState(null); // null while loading
  const [msgsError, setMsgsError] = useState(null);
  const [typers, setTypers] = useState([]);
  const [input, setInput] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);
  const [uploading, setUploading] = useState(null); // status text while an attachment uploads
  const imageInputRef = useRef(null);

  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const recordingStreamRef = useRef(null);
  const recordingStartRef = useRef(0);
  const recordingTimerRef = useRef(null);

  const [fwdMessage, setFwdMessage] = useState(null); // message currently being forwarded, or null

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
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') stopRecording(false);
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
    const replySnapshot = replyingTo;
    setReplyingTo(null);
    try {
      await addDoc(collection(db, 'conversations', convoId, 'messages'), {
        senderUid: currentUid, text,
        replyTo: replySnapshot || null,
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

  function setReplyTarget(message, senderName) {
    setReplyingTo({
      messageId: message.id,
      senderName: senderName || (message.senderUid === currentUid ? 'You' : 'Nurse'),
      text: message.text || (message.imageUrl ? '📷 Photo' : (message.audioUrl ? '🎤 Voice note' : ''))
    });
  }

  async function handleImagePicked(ev) {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Only images can be attached.'); return; }
    if (file.size > 10 * 1024 * 1024) { alert('Image is too large (max 10MB).'); return; }

    const replySnapshot = replyingTo;
    setReplyingTo(null);
    setUploading('Uploading image…');
    try {
      const path = 'chatUploads/' + convoId + '/' + Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, file);
      const url = await getDownloadURL(fileRef);
      await addDoc(collection(db, 'conversations', convoId, 'messages'), {
        senderUid: currentUid, text: '', imageUrl: url,
        replyTo: replySnapshot || null,
        reactions: {}, starredBy: [],
        createdAt: serverTimestamp(), editedAt: null
      });
      await updateDoc(doc(db, 'conversations', convoId), {
        lastMessageText: '📷 Photo', lastMessageAt: serverTimestamp(), lastMessageSenderUid: currentUid
      });
    } catch (e) {
      alert("Couldn't upload image: " + (e.code || e.message || 'unknown error'));
    }
    setUploading(null);
  }

  function micClick() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      stopRecording(true);
    } else {
      startRecording();
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Voice recording isn't supported on this device/browser.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert("Couldn't access the microphone: " + (e.message || 'permission denied'));
      return;
    }
    recordingStreamRef.current = stream;
    recordedChunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    mr.addEventListener('dataavailable', (ev) => { if (ev.data && ev.data.size > 0) recordedChunksRef.current.push(ev.data); });
    mr.addEventListener('stop', onRecordingStopped);
    mr.start();
    mediaRecorderRef.current = mr;
    recordingStartRef.current = Date.now();
    setRecording(true);
    setRecordSecs(0);
    recordingTimerRef.current = setInterval(() => {
      setRecordSecs(Math.floor((Date.now() - recordingStartRef.current) / 1000));
    }, 500);
  }

  function stopRecording(shouldSend) {
    const mr = mediaRecorderRef.current;
    if (!mr) return;
    mr._shouldSend = shouldSend;
    if (mr.state === 'recording') mr.stop();
    clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    setRecording(false);
  }

  async function onRecordingStopped() {
    const mr = mediaRecorderRef.current;
    const shouldSend = mr && mr._shouldSend;
    if (recordingStreamRef.current) {
      recordingStreamRef.current.getTracks().forEach(t => t.stop());
      recordingStreamRef.current = null;
    }
    const chunks = recordedChunksRef.current;
    recordedChunksRef.current = [];
    const mrType = mr ? mr.mimeType : '';
    mediaRecorderRef.current = null;
    if (!shouldSend || chunks.length === 0) return;

    const blob = new Blob(chunks, { type: mrType || 'audio/webm' });
    if (blob.size < 500) return; // too short / silent tap

    setUploading('Uploading voice note…');
    try {
      const ext = (mrType && mrType.includes('mp4')) ? 'm4a' : 'webm';
      const path = 'chatUploads/' + convoId + '/' + Date.now() + '_voice.' + ext;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, blob, { contentType: mrType || 'audio/webm' });
      const url = await getDownloadURL(fileRef);
      await addDoc(collection(db, 'conversations', convoId, 'messages'), {
        senderUid: currentUid, text: '', audioUrl: url,
        replyTo: null,
        reactions: {}, starredBy: [],
        createdAt: serverTimestamp(), editedAt: null
      });
      await updateDoc(doc(db, 'conversations', convoId), {
        lastMessageText: '🎤 Voice note', lastMessageAt: serverTimestamp(), lastMessageSenderUid: currentUid
      });
    } catch (e) {
      alert("Couldn't upload voice note: " + (e.code || e.message || 'unknown error'));
    }
    setUploading(null);
  }

  async function toggleStar(message) {
    const starredBy = (message.starredBy || []).slice();
    const idx = starredBy.indexOf(currentUid);
    if (idx !== -1) starredBy.splice(idx, 1); else starredBy.push(currentUid);
    try {
      await updateDoc(doc(db, 'conversations', convoId, 'messages', message.id), { starredBy });
    } catch (e) {
      alert("Couldn't star: " + (e.code || e.message || 'unknown error'));
    }
  }

  async function deleteMessage(message) {
    if (!confirm('Delete this message?')) return;
    try {
      await deleteDoc(doc(db, 'conversations', convoId, 'messages', message.id));
    } catch (e) {
      alert("Couldn't delete: " + (e.code || e.message || 'unknown error'));
    }
  }

  async function editMessage(message) {
    const newText = prompt('Edit message:', message.text);
    if (newText === null) return;
    const trimmed = newText.trim();
    if (!trimmed) return;
    try {
      await updateDoc(doc(db, 'conversations', convoId, 'messages', message.id), { text: trimmed, editedAt: serverTimestamp() });
    } catch (e) {
      alert("Couldn't save: " + (e.code || e.message || 'unknown error'));
    }
  }

  async function forwardMessageTo(targetConvoId, message) {
    try {
      await addDoc(collection(db, 'conversations', targetConvoId, 'messages'), {
        senderUid: currentUid,
        text: message.text || '',
        imageUrl: message.imageUrl || null,
        audioUrl: message.audioUrl || null,
        replyTo: null,
        forwardedFrom: message.senderUid || null,
        reactions: {}, starredBy: [],
        createdAt: serverTimestamp(), editedAt: null
      });
      const preview = message.imageUrl ? '📷 Photo' : (message.audioUrl ? '🎤 Voice note' : message.text);
      await updateDoc(doc(db, 'conversations', targetConvoId), {
        lastMessageText: preview, lastMessageAt: serverTimestamp(), lastMessageSenderUid: currentUid
      });
    } catch (e) {
      alert("Couldn't forward: " + (e.code || e.message || 'unknown error'));
    }
  }

  async function forwardToNurse(nurse, message) {
    const targetConvoId = convoIdFor(currentUid, nurse.uid);
    try {
      const convoRef = doc(db, 'conversations', targetConvoId);
      const existing = await getDoc(convoRef);
      if (!existing.exists()) {
        await setDoc(convoRef, {
          type: 'dm',
          participants: [currentUid, nurse.uid],
          participantNames: { [currentUid]: currentProfile.name || 'Unknown', [nurse.uid]: nurse.name || 'Unknown' },
          participantGenders: { [currentUid]: currentProfile.gender || null, [nurse.uid]: nurse.gender || null },
          createdBy: currentUid,
          createdAt: serverTimestamp(),
          lastMessageText: '', lastMessageAt: serverTimestamp(), lastMessageSenderUid: null,
          readBy: {}
        });
      }
      await forwardMessageTo(targetConvoId, message);
    } catch (e) {
      alert("Couldn't forward: " + (e.code || e.message || 'unknown error'));
    }
  }

  async function toggleReaction(message, emoji) {
    const reactions = JSON.parse(JSON.stringify(message.reactions || {}));
    let hadThisEmoji = false;
    Object.keys(reactions).forEach(e => {
      const idx = (reactions[e] || []).indexOf(currentUid);
      if (idx !== -1) {
        if (e === emoji) hadThisEmoji = true;
        reactions[e].splice(idx, 1);
      }
    });
    if (!hadThisEmoji) {
      reactions[emoji] = reactions[emoji] || [];
      reactions[emoji].push(currentUid);
    }
    try {
      await updateDoc(doc(db, 'conversations', convoId, 'messages', message.id), { reactions });
    } catch (e) {
      alert("Couldn't react: " + (e.code || e.message || 'unknown error'));
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
                <MessageBubble
                  key={m.id}
                  message={m}
                  isMine={isMine}
                  isGroup={isGroup}
                  senderName={senderName}
                  readByAll={readByAll}
                  currentUid={currentUid}
                  onToggleReaction={toggleReaction}
                  onReply={setReplyTarget}
                  onToggleStar={toggleStar}
                  onForward={setFwdMessage}
                  onEdit={editMessage}
                  onDelete={deleteMessage}
                />
              );
            })}
            {uploading && <div className="loading-note">{uploading}</div>}
          </div>

          {replyingTo && (
            <div className="reply-preview">
              <div className="rp-text"><b>{replyingTo.senderName}:</b> {replyingTo.text}</div>
              <button onClick={() => setReplyingTo(null)}>&times;</button>
            </div>
          )}

          {recording && (
            <div className="recording-bar">
              <span className="rec-dot" />
              <span className="rec-time">Recording {String(Math.floor(recordSecs / 60)).padStart(2, '0')}:{String(recordSecs % 60).padStart(2, '0')}</span>
              <button className="rec-cancel" onClick={() => stopRecording(false)}>Cancel</button>
              <button className="rec-send" onClick={() => stopRecording(true)}>Send</button>
            </div>
          )}

          <input type="file" ref={imageInputRef} accept="image/*" style={{ display: 'none' }} onChange={handleImagePicked} />
          <div className="thread-compose">
            <button className="attach-btn" title="Attach image" onClick={() => imageInputRef.current?.click()} disabled={!!uploading || recording}>&#128206;</button>
            <input
              type="text"
              placeholder="Type a message…"
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') sendMessage(); }}
              disabled={recording}
            />
            <button className={"mic-btn" + (recording ? ' recording' : '')} title="Record voice note" onClick={micClick}>&#127908;</button>
            <button className="btn btn-primary" style={{ padding: '10px 16px' }} onClick={sendMessage} disabled={recording}>Send</button>
          </div>
        </div>
      </div>

      {fwdMessage && (
        <div className="fwd-overlay open" onClick={(ev) => { if (ev.target.classList.contains('fwd-overlay')) setFwdMessage(null); }}>
          <div className="fwd-box">
            <div className="fwd-head">
              <h3>Forward message to…</h3>
              <button className="fwd-close" onClick={() => setFwdMessage(null)}>&times;</button>
            </div>
            <div className="fwd-list">
              {allConvos && allConvos.length > 0 && (
                <>
                  <div className="fwd-section-label">Chats</div>
                  {allConvos.map(c => {
                    const isGroup = c.type === 'group';
                    const otherUid = isGroup ? null : (c.participants || []).find(u => u !== currentUid);
                    const title = isGroup ? (c.groupName || 'Group') : ((c.participantNames && c.participantNames[otherUid]) || 'Unknown');
                    return (
                      <div key={c.id} className="fwd-item" onClick={() => { const msg = fwdMessage; setFwdMessage(null); forwardMessageTo(c.id, msg); }}>
                        <div dangerouslySetInnerHTML={{ __html: isGroup ? groupAvatarHtml(32) : avatarMarkup({ name: title }, 32) }} />
                        <span className="fwd-name">{title}</span>
                      </div>
                    );
                  })}
                </>
              )}
              <div className="fwd-section-label">New chat</div>
              {(allNurses || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(n => (
                <div key={n.uid} className="fwd-item" onClick={() => { const msg = fwdMessage; setFwdMessage(null); forwardToNurse(n, msg); }}>
                  <div dangerouslySetInnerHTML={{ __html: avatarMarkup(n, 32) }} />
                  <span className="fwd-name">{n.name || 'Unnamed'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
