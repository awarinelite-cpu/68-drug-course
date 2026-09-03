import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, orderBy, query
} from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { avatarMarkup } from "../lib/avatar.js";
import Topbar from "../components/Topbar.jsx";

function fmtWhen(ts) {
  if (!ts || typeof ts.toDate !== 'function') return 'just now';
  const d = ts.toDate();
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return dateStr + ', ' + timeStr;
}

export default function Community() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();

  const [postText, setPostText] = useState('');
  const [posting, setPosting] = useState(false);
  const [loadStatus, setLoadStatus] = useState('loading'); // 'loading' | 'ready' | error string
  const [posts, setPosts] = useState([]);
  const [openComments, setOpenComments] = useState({}); // postId -> true
  const [comments, setComments] = useState({}); // postId -> array | 'loading' | error string
  const [commentInputs, setCommentInputs] = useState({}); // postId -> text
  const [editingPostId, setEditingPostId] = useState(null);
  const [editText, setEditText] = useState('');

  useEffect(() => {
    if (!user) return;
    loadFeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function loadFeed() {
    setLoadStatus('loading');
    let list = [];
    try {
      const snap = await getDocs(query(collection(db, 'communityPosts'), orderBy('createdAt', 'desc')));
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    } catch (e) {
      setLoadStatus("Couldn't load: " + (e.code || e.message || 'unknown error'));
      return;
    }
    setPosts(list);
    setLoadStatus('ready');
  }

  async function submitPost() {
    const text = postText.trim();
    if (!text) return;
    setPosting(true);
    try {
      await addDoc(collection(db, 'communityPosts'), {
        uid: user.uid,
        name: profile.name || 'Unknown',
        gender: profile.gender || null,
        role: profile.role || null,
        text,
        createdAt: serverTimestamp(),
        editedAt: null
      });
      setPostText('');
      await loadFeed();
    } catch (e) {
      alert("Couldn't post: " + (e.code || e.message || 'unknown error'));
    }
    setPosting(false);
  }

  function toggleComments(postId) {
    const willOpen = !openComments[postId];
    setOpenComments((prev) => ({ ...prev, [postId]: willOpen }));
    if (willOpen && !comments[postId]) loadComments(postId);
  }

  async function loadComments(postId) {
    setComments((prev) => ({ ...prev, [postId]: 'loading' }));
    let list = [];
    try {
      const snap = await getDocs(query(collection(db, 'communityPosts', postId, 'comments'), orderBy('createdAt', 'asc')));
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    } catch (e) {
      setComments((prev) => ({ ...prev, [postId]: "Couldn't load replies." }));
      return;
    }
    setComments((prev) => ({ ...prev, [postId]: list }));
  }

  async function submitComment(postId) {
    const text = (commentInputs[postId] || '').trim();
    if (!text) return;
    try {
      await addDoc(collection(db, 'communityPosts', postId, 'comments'), {
        uid: user.uid,
        name: profile.name || 'Unknown',
        gender: profile.gender || null,
        text,
        createdAt: serverTimestamp(),
        editedAt: null
      });
      setCommentInputs((prev) => ({ ...prev, [postId]: '' }));
      loadComments(postId);
    } catch (e) {
      alert("Couldn't post reply: " + (e.code || e.message || 'unknown error'));
    }
  }

  async function deleteComment(postId, commentId) {
    if (!confirm('Delete this reply?')) return;
    try {
      await deleteDoc(doc(db, 'communityPosts', postId, 'comments', commentId));
      loadComments(postId);
    } catch (e) {
      alert("Couldn't delete: " + (e.code || e.message || 'unknown error'));
    }
  }

  async function editComment(postId, c) {
    const newText = prompt('Edit reply:', c.text);
    if (newText === null) return;
    const trimmed = newText.trim();
    if (!trimmed) return;
    try {
      await updateDoc(doc(db, 'communityPosts', postId, 'comments', c.id), { text: trimmed, editedAt: serverTimestamp() });
      loadComments(postId);
    } catch (e) {
      alert("Couldn't save: " + (e.code || e.message || 'unknown error'));
    }
  }

  function startEditPost(p) {
    setEditingPostId(p.id);
    setEditText(p.text);
  }

  async function saveEditPost(postId) {
    const trimmed = editText.trim();
    if (!trimmed) return;
    try {
      await updateDoc(doc(db, 'communityPosts', postId), { text: trimmed, editedAt: serverTimestamp() });
      setEditingPostId(null);
      await loadFeed();
    } catch (e) {
      alert("Couldn't save: " + (e.code || e.message || 'unknown error'));
    }
  }

  async function deletePost(postId) {
    if (!confirm('Delete this post?')) return;
    try {
      await deleteDoc(doc(db, 'communityPosts', postId));
      setPosts((prev) => prev.filter(p => p.id !== postId));
    } catch (e) {
      alert("Couldn't delete: " + (e.code || e.message || 'unknown error'));
    }
  }

  return (
    <>
      <Topbar brand="Community">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => navigate('/')}>Back</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <div className="composer">
            <div className="composer-avatar" dangerouslySetInnerHTML={{ __html: profile ? avatarMarkup(profile, 40) : '' }} />
            <div style={{ flex: 1 }}>
              <textarea placeholder="Share something with the ward…" value={postText}
                onChange={(e) => setPostText(e.target.value)} />
              <div className="composer-actions">
                <button className="btn btn-primary" style={{ padding: '8px 18px' }} disabled={posting} onClick={submitPost}>
                  {posting ? 'Posting…' : 'Post'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="card-box">
          <h2 style={{ marginTop: 0 }}>Ward Feed</h2>
          {loadStatus === 'loading' && <div className="loading-note">Loading…</div>}
          {typeof loadStatus === 'string' && loadStatus !== 'loading' && loadStatus !== 'ready' && (
            <div className="loading-note">{loadStatus}</div>
          )}
          {loadStatus === 'ready' && posts.length === 0 && (
            <div className="empty-note">No posts yet. Be the first to share something with the ward.</div>
          )}
          {loadStatus === 'ready' && posts.map((p) => {
            const isMine = p.uid === user?.uid;
            const isEditing = editingPostId === p.id;
            const isOpen = !!openComments[p.id];
            const postComments = comments[p.id];
            return (
              <div className="post" key={p.id}>
                <div className="post-head">
                  <div className="post-avatar" dangerouslySetInnerHTML={{ __html: avatarMarkup({ name: p.name, gender: p.gender }, 36) }} />
                  <div>
                    <div className="post-name">{p.name}{p.role ? <span style={{ fontWeight: 'normal', color: '#6b7280' }}> · {p.role}</span> : null}</div>
                    <div className="post-meta">{fmtWhen(p.createdAt)}{p.editedAt ? ' · edited' : ''}</div>
                  </div>
                </div>

                {isEditing ? (
                  <>
                    <textarea className="edit-box" value={editText} onChange={(e) => setEditText(e.target.value)} />
                    <div className="edit-actions">
                      <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => setEditingPostId(null)}>Cancel</button>
                      <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={() => saveEditPost(p.id)}>Save</button>
                    </div>
                  </>
                ) : (
                  <div className="post-body">{p.text}</div>
                )}

                <div className="post-actions">
                  <button className="post-action-btn" onClick={() => toggleComments(p.id)}>Comments</button>
                  {isMine && !isEditing && (
                    <>
                      <button className="post-action-btn" onClick={() => startEditPost(p)}>Edit</button>
                      <button className="post-action-btn danger" onClick={() => deletePost(p.id)}>Delete</button>
                    </>
                  )}
                </div>

                <div className={"comments" + (isOpen ? ' open' : '')}>
                  <div className="comment-list">
                    {postComments === 'loading' && <div className="loading-note">Loading…</div>}
                    {typeof postComments === 'string' && postComments !== 'loading' && (
                      <div className="loading-note">{postComments}</div>
                    )}
                    {Array.isArray(postComments) && postComments.map((c) => {
                      const cMine = c.uid === user?.uid;
                      return (
                        <div className="comment" key={c.id}>
                          <div className="comment-avatar" dangerouslySetInnerHTML={{ __html: avatarMarkup({ name: c.name, gender: c.gender }, 28) }} />
                          <div className="comment-bubble">
                            <div className="comment-name">{c.name}</div>
                            <div className="comment-text">{c.text}</div>
                            <div className="comment-meta">
                              <span>{fmtWhen(c.createdAt)}{c.editedAt ? ' · edited' : ''}</span>
                              {cMine && (
                                <>
                                  <button onClick={() => editComment(p.id, c)}>Edit</button>
                                  <button onClick={() => deleteComment(p.id, c.id)}>Delete</button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="comment-form">
                    <input type="text" placeholder="Write a reply…"
                      value={commentInputs[p.id] || ''}
                      onChange={(e) => setCommentInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitComment(p.id); }} />
                    <button className="btn btn-primary" style={{ padding: '8px 14px' }} onClick={() => submitComment(p.id)}>Reply</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
