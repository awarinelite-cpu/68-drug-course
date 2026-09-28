import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { db } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useGoBack } from "../hooks/useGoBack.js";
import { downloadTextFile } from "../lib/csv.js";
import { CATALOG_TYPES, templateCsv, parseCatalogCsv, saveCatalog, readCatalogMeta } from "../lib/nursingCatalog.js";
import Topbar from "../components/Topbar.jsx";

function CatalogCard({ type, meta, onSaved }) {
  const cfg = CATALOG_TYPES[type];
  const fileRef = useRef(null);
  const [parsed, setParsed] = useState(null); // { fileName, items, errors, skipped }
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    setStatus(null); setParsed(null);
    if (!file) return;
    try {
      const text = await file.text();
      setParsed({ fileName: file.name, ...parseCatalogCsv(type, text) });
    } catch (err) {
      setStatus({ text: "Couldn't read that file: " + (err.message || 'unknown error'), error: true });
    }
  }

  async function upload() {
    if (!parsed || !parsed.items.length) return;
    const have = meta && meta.count ? ' This replaces the ' + meta.count + ' entries currently stored.' : '';
    if (!window.confirm('Upload ' + parsed.items.length + ' entries to ' + cfg.label + '?' + have)) return;
    setSaving(true); setStatus(null);
    try {
      await saveCatalog(db, type, parsed.items);
      setStatus({ text: 'Uploaded ' + parsed.items.length + ' entries.', error: false });
      setParsed(null);
      if (fileRef.current) fileRef.current.value = '';
      onSaved();
    } catch (err) {
      setStatus({ text: "Couldn't upload: " + (err.code || err.message || 'unknown error'), error: true });
    }
    setSaving(false);
  }

  const when = meta && meta.updatedAt && meta.updatedAt.toDate ? meta.updatedAt.toDate().toLocaleString() : '';

  return (
    <div className="card-box">
      <h3 style={{ marginTop: 0 }}>{cfg.label}</h3>
      <p style={{ fontSize: 13, color: '#444', marginTop: -6 }}>
        {meta && meta.count ? meta.count + ' entries stored' + (when ? ' (last upload ' + when + ')' : '') + '.' : 'Nothing uploaded yet.'}
      </p>
      <p style={{ fontSize: 12, color: '#666' }}>{cfg.hint}</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <button className="btn btn-secondary" type="button"
          onClick={() => downloadTextFile(type + '-template.csv', templateCsv(type))}>Download template</button>
      </div>
      <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} disabled={saving} />
      {parsed && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          <div><b>{parsed.fileName}</b>: {parsed.items.length} valid entries{parsed.skipped ? ', ' + parsed.skipped + ' skipped' : ''}.</div>
          {parsed.items.slice(0, 3).map((it, i) => (
            <div key={i} style={{ color: '#555' }}>{[it.code, it.name].filter(Boolean).join(' \u2014 ')}</div>
          ))}
          {parsed.errors.length > 0 && (
            <ul style={{ color: '#b45309', margin: '6px 0 0 18px', padding: 0, maxHeight: 120, overflowY: 'auto' }}>
              {parsed.errors.slice(0, 20).map((m, i) => <li key={i}>{m}</li>)}
              {parsed.errors.length > 20 && <li>…and {parsed.errors.length - 20} more.</li>}
            </ul>
          )}
          <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={saving || !parsed.items.length} onClick={upload}>
            {saving ? 'Uploading…' : 'Upload & replace'}
          </button>
        </div>
      )}
      {status && <div className={status.error ? 'error-msg' : 'info-msg'}>{status.text}</div>}
    </div>
  );
}

export default function NursingCatalog() {
  const { profile } = useAuth();
  const goBack = useGoBack('/admin');
  const isAdmin = profile?.role === 'admin';
  const [meta, setMeta] = useState({});
  const [tick, setTick] = useState(0);

  useEffect(() => { if (isAdmin) readCatalogMeta(db).then(setMeta); }, [isAdmin, tick]);

  if (!profile) return null;
  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <>
      <Topbar brand="68 NARHY Ward Charts — Nursing Catalog">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>
      <div className="container">
        <div className="card-box">
          <p style={{ fontSize: 12, color: '#666', margin: 0 }}>
            Upload the NANDA-I diagnoses, NIC interventions and NOC outcomes as CSV. Nurses then search NANDA-I diagnoses on the ward
            report; picking one fills Planning, Implementation and Evaluation with starter text they can edit. Upload NIC and NOC first
            if you link them by code from the NANDA file. NANDA-I, NIC and NOC are copyrighted — upload only content your institution is
            licensed to use, or your own wording, and have it reviewed by a nurse educator. Uploading replaces that catalog.
          </p>
        </div>
        <CatalogCard type="nanda" meta={meta.nanda} onSaved={() => setTick(t => t + 1)} />
        <CatalogCard type="nic" meta={meta.nic} onSaved={() => setTick(t => t + 1)} />
        <CatalogCard type="noc" meta={meta.noc} onSaved={() => setTick(t => t + 1)} />
      </div>
    </>
  );
}
