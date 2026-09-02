import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../../firebase.js";
import { useGoBack } from "../../hooks/useGoBack.js";
import Topbar from "../../components/Topbar.jsx";

function fmtTimestamp(ts) {
  if (!ts || !ts.toDate) return '';
  const d = ts.toDate();
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ArchiveList() {
  const navigate = useNavigate();
  const goBack = useGoBack('/nurses-report/role-select');
  const [searchParams] = useSearchParams();
  const type = searchParams.get('type') === 'ward' ? 'ward' : 'overall';
  const wardKey = searchParams.get('ward') || '';
  const wardLabel = searchParams.get('label') || '';

  const [allFiles, setAllFiles] = useState([]);
  const [query_, setQuery] = useState('');
  const [emptyMsg, setEmptyMsg] = useState('No archived reports yet.');

  useEffect(() => {
    (async () => {
      let snap;
      try {
        snap = type === 'ward'
          ? await getDocs(query(collection(db, 'archives'), where('wardKey', '==', wardKey)))
          : await getDocs(query(collection(db, 'archives'), where('type', '==', 'overall')));
      } catch (e) {
        setEmptyMsg("Couldn't load the archive: " + (e.code || e.message || 'unknown error'));
        return;
      }
      const files = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      files.sort((a, b) => (b.dateId || '').localeCompare(a.dateId || ''));
      setAllFiles(files);
      setEmptyMsg('No archived reports yet.');
    })();
  }, [type, wardKey]);

  const q = query_.trim().toLowerCase();
  const filtered = !q ? allFiles : allFiles.filter(f =>
    f.dateId.toLowerCase().includes(q) || (f.fileName || '').toLowerCase().includes(q)
  );

  const brand = type === 'ward' ? wardLabel + ' Archive' : 'Overall Archive';
  const title = type === 'ward' ? wardLabel + ' — Ward Report Archive' : 'Overall Report Archive';
  const subtitle = type === 'ward' ? 'Every finalized 24-hour ward report for ' + wardLabel + '.' : 'Every finalized 24-hour overall report.';

  return (
    <>
      <Topbar brand={brand}>
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>
      <div className="container">
        <div className="card-box">
          <h2>{title}</h2>
          <p style={{ fontSize: 12, color: '#555', marginTop: -6 }}>{subtitle}</p>
          <div className="search-row">
            <input type="text" placeholder="Search by date, e.g. 01/09/26 or 2026-09-01" value={query_} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div style={{ fontSize: 12, color: '#666', marginTop: 8 }}>{filtered.length} file{filtered.length === 1 ? '' : 's'}</div>
          <div className="archive-grid">
            {filtered.map((f) => (
              <div className="archive-card" key={f.id} tabIndex={0}
                onClick={() => navigate('/nurses-report/archive-view?id=' + encodeURIComponent(f.id))}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate('/nurses-report/archive-view?id=' + encodeURIComponent(f.id)); }}>
                <div className="file-icon">{'\uD83D\uDCC4'}</div>
                <div className="file-name">{f.fileName || f.dateId}</div>
                <div className="file-meta">
                  Archived by {f.archivedBy || 'Unknown'}
                  {f.archivedAt && <><br />{fmtTimestamp(f.archivedAt)}</>}
                </div>
                {f.lastEditedAt && <div className="edited-badge">Edited</div>}
              </div>
            ))}
          </div>
          {filtered.length === 0 && <div className="archive-empty">{emptyMsg}</div>}
        </div>
      </div>
    </>
  );
}
