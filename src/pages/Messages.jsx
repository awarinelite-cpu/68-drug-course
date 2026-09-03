import { useEffect, useMemo, useState } from "react";
import {
  collection, getDocs, doc, getDoc, setDoc, addDoc, serverTimestamp, query, where
} from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { avatarMarkup } from "../lib/avatar.js";
import Topbar from "../components/Topbar.jsx";
import ChatThread from "../components/ChatThread.jsx";

const ONLINE_WINDOW_MS = 2 * 60 * 1000; // "online" = active in the last 2 minutes

function fmtWhen(ts) {
  if (!ts || typeof ts.toDate !== 'function') return '';
  const d = ts.toDate();
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return dateStr + ', ' + timeStr;
}

function convoIdFor(uidA, uidB) {
  const [a, b] = [uidA, uidB].sort();
  return 'dm_' + a + '_' + b;
}

function groupAvatarHtml(size = 40) {
  return '<div class="group-avatar" style="width:' + size + 'px;height:' + size + 'px;">&#128101;</div>';
}

function isRecentlyActive(lastActive) {
  if (!lastActive || typeof lastActive.toMillis !== 'function') return false;
  return (Date.now() - lastActive.toMillis()) < ONLINE_WINDOW_MS;
}

export default function Messages() {
  const { user, profile } = useAuth();
  const currentUid = user?.uid;

  const [tab, setTab] = useState('chats');
  const [dirLoading, setDirLoading] = useState(true);
  const [dirError, setDirError] = useState(null);
  const [allNurses, setAllNurses] = useState([]);
  const [nurseByUid, setNurseByUid] = useState({});
  const [search, setSearch] = useState('');

  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState(null);
  const [allConvos, setAllConvos] = useState([]);

  const [groupName, setGroupName] = useState('');
  const [selectedGroupUids, setSelectedGroupUids] = useState(new Set());
  const [creatingGroup, setCreatingGroup] = useState(false);

  const [activeConvoId, setActiveConvoId] = useState(null);

  useEffect(() => {
    if (!currentUid) return;
    loadDirectory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUid]);

  useEffect(() => {
    if (!currentUid || dirLoading) return;
    loadChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUid, dirLoading]);

  // Deep link from a message-alert notification (functions/index.js's
  // onNewMessage sends data.link = "/messages?convo=<id>"). Open straight
  // into that thread rather than leaving the nurse to hunt for it.
  useEffect(() => {
    const convoParam = new URLSearchParams(window.location.search).get('convo');
    if (convoParam) setActiveConvoId(convoParam);
  }, []);

  // getDocs() can hang indefinitely (bad rules, dropped connection, etc.)
  // without ever resolving or rejecting. Race it against a timeout so a
  // hang always surfaces something actionable instead of failing silently.
  async function loadDirectory() {
    setDirLoading(true);
    setDirError(null);
    const DIRECTORY_TIMEOUT_MS = 15000;
    try {
      const snap = await Promise.race([
        getDocs(collection(db, 'users')),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timed out after ' + (DIRECTORY_TIMEOUT_MS / 1000) + 's')), DIRECTORY_TIMEOUT_MS)
        )
      ]);
      const nurses = [];
      const byUid = {};
      snap.forEach(d => {
        const n = { uid: d.id, ...d.data() };
        byUid[d.id] = n;
        if (d.id !== currentUid) nurses.push(n);
      });
      setAllNurses(nurses);
      setNurseByUid(byUid);
    } catch (e) {
      setDirError("Couldn't load directory: " + (e.code || e.message || 'unknown error'));
    }
    setDirLoading(false);
  }

  async function loadChats() {
    setChatsLoading(true);
    setChatsError(null);
    let convos = [];
    try {
      const snap = await getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', currentUid)));
      snap.forEach(d => convos.push({ id: d.id, ...d.data() }));
    } catch (e) {
      setChatsError("Couldn't load: " + (e.code || e.message || 'unknown error'));
      setChatsLoading(false);
      return;
    }
    convos.sort((a, b) => {
      const at = a.lastMessageAt?.toMillis ? a.lastMessageAt.toMillis() : 0;
      const bt = b.lastMessageAt?.toMillis ? b.lastMessageAt.toMillis() : 0;
      return bt - at;
    });
    setAllConvos(convos);
    setChatsLoading(false);
  }

  const filteredDirectory = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = term ? allNurses.filter(n => (n.name || '').toLowerCase().includes(term)) : allNurses;
    return list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [allNurses, search]);

  async function startChat(nurse) {
    const convoId = convoIdFor(currentUid, nurse.uid);
    try {
      const convoRef = doc(db, 'conversations', convoId);
      const existing = await getDoc(convoRef);
      if (!existing.exists()) {
        await setDoc(convoRef, {
          type: 'dm',
          participants: [currentUid, nurse.uid],
          participantNames: { [currentUid]: profile.name || 'Unknown', [nurse.uid]: nurse.name || 'Unknown' },
          participantGenders: { [currentUid]: profile.gender || null, [nurse.uid]: nurse.gender || null },
          createdBy: currentUid,
          createdAt: serverTimestamp(),
          lastMessageText: '', lastMessageAt: serverTimestamp(), lastMessageSenderUid: null,
          readBy: {}
        });
      }
      setActiveConvoId(convoId);
    } catch (e) {
      alert("Couldn't start chat: " + (e.code || e.message || 'unknown error'));
    }
  }

  function toggleGroupPick(uid) {
    setSelectedGroupUids(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  async function createGroup() {
    const name = groupName.trim();
    if (!name) { alert('Give the group a name.'); return; }
    if (selectedGroupUids.size < 1) { alert('Pick at least one other nurse.'); return; }
    setCreatingGroup(true);
    const participants = [currentUid, ...Array.from(selectedGroupUids)];
    const participantNames = { [currentUid]: profile.name || 'Unknown' };
    const participantGenders = { [currentUid]: profile.gender || null };
    participants.forEach(uid => {
      const n = nurseByUid[uid];
      if (n) { participantNames[uid] = n.name || 'Unknown'; participantGenders[uid] = n.gender || null; }
    });
    try {
      const convoRef = await addDoc(collection(db, 'conversations'), {
        type: 'group',
        groupName: name,
        participants, participantNames, participantGenders,
        createdBy: currentUid,
        createdAt: serverTimestamp(),
        lastMessageText: '', lastMessageAt: serverTimestamp(), lastMessageSenderUid: null,
        readBy: {}
      });
      setGroupName('');
      setSelectedGroupUids(new Set());
      setActiveConvoId(convoRef.id);
    } catch (e) {
      alert("Couldn't create group: " + (e.code || e.message || 'unknown error'));
    }
    setCreatingGroup(false);
  }

  function closeThread() {
    setActiveConvoId(null);
    // Drop the deep-link query param so re-opening the list doesn't jump
    // straight back into the same thread on next mount.
    if (window.location.search.includes('convo=')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    loadChats();
  }

  if (activeConvoId) {
    return (
      <ChatThread
        convoId={activeConvoId}
        currentUid={currentUid}
        currentProfile={profile}
        nurseByUid={nurseByUid}
        allNurses={allNurses}
        allConvos={allConvos}
        onBack={closeThread}
      />
    );
  }

  return (
    <>
      <Topbar brand="Messages" />
      <div className="container">
        <div className="card-box">
          <div className="msg-tabs">
            <button className={"msg-tab-btn" + (tab === 'chats' ? ' active' : '')} onClick={() => setTab('chats')}>Chats</button>
            <button className={"msg-tab-btn" + (tab === 'directory' ? ' active' : '')} onClick={() => setTab('directory')}>New Message</button>
            <button className={"msg-tab-btn" + (tab === 'newgroup' ? ' active' : '')} onClick={() => setTab('newgroup')}>New Group</button>
          </div>

          <div className={"msg-pane" + (tab === 'chats' ? ' active' : '')}>
            {chatsLoading && <div className="loading-note">Loading…</div>}
            {chatsError && <div className="loading-note">{chatsError}</div>}
            {!chatsLoading && !chatsError && allConvos.length === 0 && (
              <div className="empty-note">No conversations yet. Start one from "New Message" or "New Group".</div>
            )}
            {!chatsLoading && allConvos.map(c => {
              const isGroup = c.type === 'group';
              const otherUid = isGroup ? null : (c.participants || []).find(u => u !== currentUid);
              const title = isGroup ? (c.groupName || 'Group') : ((c.participantNames && c.participantNames[otherUid]) || 'Unknown');
              const otherGender = isGroup ? null : (c.participantGenders && c.participantGenders[otherUid]) || null;
              const otherNurse = otherUid ? nurseByUid[otherUid] : null;
              const online = !isGroup && otherNurse && isRecentlyActive(otherNurse.lastActive);

              const readTs = c.readBy && c.readBy[currentUid];
              const lastTs = c.lastMessageAt?.toMillis ? c.lastMessageAt.toMillis() : 0;
              const readMs = readTs?.toMillis ? readTs.toMillis() : 0;
              const unread = c.lastMessageSenderUid && c.lastMessageSenderUid !== currentUid && lastTs > readMs;

              return (
                <div key={c.id} className="chat-item" onClick={() => setActiveConvoId(c.id)}>
                  <div className="chat-avatar-wrap">
                    <div dangerouslySetInnerHTML={{ __html: isGroup ? groupAvatarHtml(40) : avatarMarkup({ name: title, gender: otherGender }, 40) }} />
                    {online && <div className="online-dot" />}
                  </div>
                  <div className="chat-main">
                    <div className="chat-name">{title}</div>
                    <div className="chat-preview">{c.lastMessageText || 'No messages yet'}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
                    <div className="chat-when">{fmtWhen(c.lastMessageAt)}</div>
                    {unread && <div className="unread-dot" />}
                  </div>
                </div>
              );
            })}
          </div>

          <div className={"msg-pane" + (tab === 'directory' ? ' active' : '')}>
            <input type="text" placeholder="Search nurses by name…" value={search} onChange={e => setSearch(e.target.value)} style={{ marginBottom: 12 }} />
            {dirLoading && <div className="loading-note">Loading…</div>}
            {dirError && <div className="loading-note">{dirError}</div>}
            {!dirLoading && !dirError && filteredDirectory.length === 0 && <div className="empty-note">No matches.</div>}
            {!dirLoading && filteredDirectory.map(n => (
              <div key={n.uid} className="chat-item" onClick={() => startChat(n)}>
                <div className="chat-avatar-wrap">
                  <div dangerouslySetInnerHTML={{ __html: avatarMarkup(n, 40) }} />
                  {isRecentlyActive(n.lastActive) && <div className="online-dot" />}
                </div>
                <div className="chat-main">
                  <div className="chat-name">{n.name || 'Unnamed'}</div>
                  <div className="chat-preview">{n.role || ''}{n.department ? ' · ' + n.department : ''}</div>
                </div>
              </div>
            ))}
          </div>

          <div className={"msg-pane" + (tab === 'newgroup' ? ' active' : '')}>
            <input type="text" placeholder="Group name…" value={groupName} onChange={e => setGroupName(e.target.value)} style={{ marginBottom: 12 }} />
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Select members:</div>
            {allNurses.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(n => (
              <label key={n.uid} className={"nurse-pick" + (selectedGroupUids.has(n.uid) ? ' picked' : '')}>
                <input type="checkbox" checked={selectedGroupUids.has(n.uid)} onChange={() => toggleGroupPick(n.uid)} />
                <div dangerouslySetInnerHTML={{ __html: avatarMarkup(n, 32) }} />
                <span>{n.name || 'Unnamed'}</span>
              </label>
            ))}
            <button className="btn btn-primary" style={{ width: '100%', padding: 10, marginTop: 8 }} onClick={createGroup} disabled={creatingGroup}>
              {creatingGroup ? 'Creating…' : 'Create Group'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
