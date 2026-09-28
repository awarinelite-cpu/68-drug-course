import { useEffect, useMemo, useState } from "react";
import { db } from "../firebase.js";
import { ensureCatalogLoaded } from "../lib/nursingCatalog.js";

// Searchable NANDA-I picker shown above the Nursing Diagnosis box. The list
// comes from the admin-uploaded catalog (Admin > Nursing Catalog); when
// nothing has been uploaded it renders nothing, leaving the plain textarea.
// onPick(entry, catalog) does the actual filling — see applyNursingDiagnosis
// in WardNurse.jsx.
export default function NursingDiagnosisPicker({ onPick }) {
  const [catalog, setCatalog] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    ensureCatalogLoaded(db).then((c) => { if (alive) setCatalog(c); });
    return () => { alive = false; };
  }, []);

  const results = useMemo(() => {
    if (!catalog) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (d) => {
      const hay = (d.name + ' ' + d.code + ' ' + d.domain + ' ' + d.cls).toLowerCase();
      return words.every(w => hay.includes(w));
    };
    return catalog.nanda.filter(hit);
  }, [catalog, q]);

  if (!catalog || !catalog.nanda.length) return null;

  function pick(d) {
    setOpen(false); setQ('');
    onPick(d, catalog);
  }

  return (
    <div className="nanda-picker">
      <input type="search" placeholder={'Search NANDA-I diagnoses (' + catalog.nanda.length + ')\u2026'} value={q}
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      {open && (
        <div className="nanda-results">
          {results.length === 0 && <div className="nanda-empty">No matching diagnosis.</div>}
          {results.length > 0 && <div className="nanda-empty">Showing {results.length} of {catalog.nanda.length} diagnoses. Type to narrow the list.</div>}
          {results.map((d, i) => (
            <button type="button" key={(d.code || d.name) + i} className="nanda-result" onClick={() => pick(d)}>
              <span>{d.name}</span>
              {(d.code || d.domain) && <small>{[d.code, d.domain].filter(Boolean).join(' \u00B7 ')}</small>}
            </button>
          ))}
          <button type="button" className="nanda-close" onClick={() => setOpen(false)}>Close list</button>
        </div>
      )}
    </div>
  );
}
