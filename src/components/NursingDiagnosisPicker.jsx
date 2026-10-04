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
  const [domain, setDomain] = useState('');
  const [cls, setCls] = useState('');

  useEffect(() => {
    let alive = true;
    ensureCatalogLoaded(db).then((c) => { if (alive) setCatalog(c); });
    return () => { alive = false; };
  }, []);

  const OTHER = 'Other / not classified';
  const domOf = (d) => (d.domain || '').trim() || OTHER;
  const clsOf = (d) => (d.cls || '').trim() || OTHER;

  // Domains (with how many diagnoses each holds) and the classes inside the chosen domain.
  const domains = useMemo(() => {
    if (!catalog) return [];
    const m = new Map();
    catalog.nanda.forEach((d) => m.set(domOf(d), (m.get(domOf(d)) || 0) + 1));
    return [...m.entries()].sort((a, b) => (a[0] === OTHER) - (b[0] === OTHER) || a[0].localeCompare(b[0]));
  }, [catalog]);
  const classes = useMemo(() => {
    if (!catalog || !domain) return [];
    const m = new Map();
    catalog.nanda.filter((d) => domOf(d) === domain).forEach((d) => m.set(clsOf(d), (m.get(clsOf(d)) || 0) + 1));
    return [...m.entries()].sort((a, b) => (a[0] === OTHER) - (b[0] === OTHER) || a[0].localeCompare(b[0]));
  }, [catalog, domain]);

  const results = useMemo(() => {
    if (!catalog) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (d) => {
      if (domain && domOf(d) !== domain) return false;
      if (cls && clsOf(d) !== cls) return false;
      const hay = (d.name + ' ' + d.code + ' ' + d.domain + ' ' + d.cls).toLowerCase();
      return words.every(w => hay.includes(w));
    };
    return catalog.nanda.filter(hit);
  }, [catalog, q, domain, cls]);

  if (!catalog || !catalog.nanda.length) return null;

  function pick(d) {
    setOpen(false); setQ('');
    onPick(d, catalog);
  }

  return (
    <div className="nanda-picker">
      <div className="nanda-filters">
        <select value={domain} onChange={(e) => { setDomain(e.target.value); setCls(''); setOpen(true); }} aria-label="Domain">
          <option value="">All domains</option>
          {domains.map(([name, n]) => <option key={name} value={name}>{name + ' (' + n + ')'}</option>)}
        </select>
        <select value={cls} disabled={!domain} onChange={(e) => { setCls(e.target.value); setOpen(true); }} aria-label="Class">
          <option value="">{domain ? 'All classes in this domain' : 'Choose a domain first'}</option>
          {classes.map(([name, n]) => <option key={name} value={name}>{name + ' (' + n + ')'}</option>)}
        </select>
        {(domain || cls) && <button type="button" className="nanda-clear" onClick={() => { setDomain(''); setCls(''); }}>Clear</button>}
      </div>
      <input type="search" placeholder={'Search NANDA-I diagnoses (' + catalog.nanda.length + ')\u2026'} value={q}
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      {open && (
        <div className="nanda-results">
          {results.length === 0 && <div className="nanda-empty">No matching diagnosis.</div>}
          {results.length > 0 && <div className="nanda-empty">Showing {results.length} of {catalog.nanda.length} diagnoses. Type to narrow the list.</div>}
          {results.map((d, i) => (
            <button type="button" key={(d.code || d.name) + i} className="nanda-result" onClick={() => pick(d)}>
              <span>{d.name}</span>
              {(d.code || d.domain || d.cls) && <small>{[d.code, d.domain, d.cls].filter(Boolean).join(' \u00B7 ')}</small>}
            </button>
          ))}
          <button type="button" className="nanda-close" onClick={() => setOpen(false)}>Close list</button>
        </div>
      )}
    </div>
  );
}
