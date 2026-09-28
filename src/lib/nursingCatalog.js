// Admin-uploaded NANDA-I / NIC / NOC catalogs. Stored in the existing
// nurseReportConfig collection (read: any known user, write: admin only —
// see firestore.rules), as chunked JSON strings so a large catalog never
// hits Firestore's 1 MiB document limit:
//   nurseReportConfig/catalog_meta            { nanda:{count,chunks,updatedAt}, nic:{...}, noc:{...} }
//   nurseReportConfig/catalog_<type>_<n>      { json: "[...items...]" }
// NANDA-I, NIC and NOC are copyrighted classifications: the app ships no
// catalog content itself — the admin uploads their own licensed/own-wording CSV.

import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { parseCsv, toCsv } from './csv.js';

const COLLECTION = 'nurseReportConfig';
const META_DOC = 'catalog_meta';
const CHUNK_CHARS = 300000; // well under 1 MiB even with multi-byte characters

export const CATALOG_TYPES = {
  nanda: {
    label: 'NANDA-I Nursing Diagnoses',
    nameHeader: 'diagnosis',
    nameAliases: ['diagnosis', 'name', 'nursingdiagnosis', 'label', 'title'],
    listCols: { nic_codes: 'nicCodes', noc_codes: 'nocCodes' },
    textCols: ['planning', 'implementation', 'evaluation'],
    template: {
      headers: ['code', 'diagnosis', 'domain', 'class', 'definition', 'noc_codes', 'nic_codes', 'planning', 'implementation', 'evaluation'],
      rows: [
        { code: '00132', diagnosis: 'Acute pain', domain: 'Comfort', class: 'Physical comfort', definition: 'Example: unpleasant sensation of recent onset.', noc_codes: '2102;1605', nic_codes: '1400;2210',
          planning: '', implementation: '', evaluation: '' },
        { code: '00004', diagnosis: 'Risk for infection', domain: 'Safety/protection', class: 'Infection', definition: 'Example: vulnerable to invasion by germs.', noc_codes: '', nic_codes: '',
          planning: 'Patient will stay free of signs of infection during the shift.\nWounds and lines will stay clean and intact.', implementation: 'Wash hands before and after every contact.\nKeep dressings clean, dry and intact.\nMonitor temperature and wound site each shift.', evaluation: 'Temperature within normal range; wound clean without redness, swelling or discharge.' }
      ]
    },
    hint: 'Only "diagnosis" is required. noc_codes / nic_codes link to the other two catalogs (separate codes with ; or |). If planning / implementation / evaluation are left blank, they are built from the linked NOC and NIC entries. Use ; or | between lines inside a cell (or real line breaks).'
  },
  nic: {
    label: 'NIC Nursing Interventions',
    nameHeader: 'intervention',
    nameAliases: ['intervention', 'name', 'label', 'title'],
    listCols: { activities: 'activities' },
    textCols: [],
    template: {
      headers: ['code', 'intervention', 'domain', 'class', 'definition', 'activities'],
      rows: [
        { code: '1400', intervention: 'Pain management', domain: 'Physiological: basic', class: 'Physical comfort promotion', definition: 'Example: relieving pain to a level the patient finds acceptable.',
          activities: 'Assess pain (site, severity, character) each shift|Give prescribed analgesia on time|Reposition for comfort|Reassess pain after each intervention' },
        { code: '2210', intervention: 'Analgesic administration', domain: 'Physiological: basic', class: 'Physical comfort promotion', definition: '', activities: 'Check the order and allergies|Give the drug by the prescribed route|Document time and response' }
      ]
    },
    hint: 'Only "intervention" is required. Separate activities with | (or ;). Codes must match the ones used in noc_codes / nic_codes on the NANDA file.'
  },
  noc: {
    label: 'NOC Nursing Outcomes',
    nameHeader: 'outcome',
    nameAliases: ['outcome', 'name', 'label', 'title'],
    listCols: { indicators: 'indicators' },
    textCols: [],
    template: {
      headers: ['code', 'outcome', 'domain', 'class', 'definition', 'indicators'],
      rows: [
        { code: '2102', outcome: 'Pain level', domain: 'Health knowledge & behavior', class: 'Symptom status', definition: 'Example: severity of observed or reported pain.', indicators: 'Reported pain score|Facial expression relaxed|Pulse and respiration within normal range' },
        { code: '1605', outcome: 'Pain control', domain: 'Health knowledge & behavior', class: 'Health beliefs', definition: '', indicators: 'Uses comfort measures|Reports pain controlled' }
      ]
    },
    hint: 'Only "outcome" is required. Separate indicators with | (or ;).'
  }
};

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const normCode = (c) => String(c || '').trim().replace(/^0+/, '').toLowerCase();
const splitList = (v) => String(v || '').split(/[|;\r\n]+/).map(x => x.trim()).filter(Boolean);
const cleanText = (v) => String(v || '').replace(/\r\n?/g, '\n').trim();

export function templateCsv(type) {
  const t = CATALOG_TYPES[type].template;
  return toCsv(t.headers, t.rows);
}

// CSV text -> { items, errors, skipped }
export function parseCatalogCsv(type, text) {
  const cfg = CATALOG_TYPES[type];
  const rows = parseCsv(text);
  if (rows.length < 2) return { items: [], errors: ['The file has no data rows.'], skipped: 0 };
  const header = rows[0].map(norm);
  const find = (aliases) => header.findIndex(h => aliases.includes(h));
  const iName = find(cfg.nameAliases);
  if (iName < 0) return { items: [], errors: ['Missing the "' + cfg.nameHeader + '" column. Download the template to see the expected headers.'], skipped: 0 };
  const iCode = find(['code']), iDomain = find(['domain']), iClass = find(['class', 'classname']), iDef = find(['definition', 'description']);
  const listIdx = Object.fromEntries(Object.keys(cfg.listCols).map(k => [k, find([norm(k)])]));
  const textIdx = Object.fromEntries(cfg.textCols.map(k => [k, find([k])]));

  const items = [], errors = [], seen = new Set();
  let skipped = 0;
  rows.slice(1).forEach((r, n) => {
    const name = String(r[iName] || '').trim();
    if (!name) { skipped++; errors.push('Row ' + (n + 2) + ': no ' + cfg.nameHeader + ' — skipped.'); return; }
    const code = iCode >= 0 ? String(r[iCode] || '').trim() : '';
    const dupKey = code ? 'c' + normCode(code) : 'n' + name.toLowerCase();
    if (seen.has(dupKey)) { skipped++; errors.push('Row ' + (n + 2) + ': duplicate "' + (code || name) + '" — skipped.'); return; }
    seen.add(dupKey);
    const item = { code, name, domain: iDomain >= 0 ? String(r[iDomain] || '').trim() : '', cls: iClass >= 0 ? String(r[iClass] || '').trim() : '', definition: iDef >= 0 ? cleanText(r[iDef]) : '' };
    Object.entries(cfg.listCols).forEach(([col, key]) => { item[key] = listIdx[col] >= 0 ? splitList(r[listIdx[col]]) : []; });
    cfg.textCols.forEach((col) => { item[col] = textIdx[col] >= 0 ? cleanText(r[textIdx[col]]) : ''; });
    items.push(item);
  });
  return { items, errors, skipped };
}

function chunkItems(items) {
  const chunks = [];
  let cur = [], size = 2;
  items.forEach((it) => {
    const len = JSON.stringify(it).length + 1;
    if (cur.length && size + len > CHUNK_CHARS) { chunks.push(cur); cur = []; size = 2; }
    cur.push(it); size += len;
  });
  if (cur.length || !chunks.length) chunks.push(cur);
  return chunks;
}

let catalogPromise = null;

export async function readCatalogMeta(db) {
  try {
    const snap = await getDoc(doc(db, COLLECTION, META_DOC));
    return snap.exists() ? snap.data() : {};
  } catch (e) { return {}; }
}

// Replaces one catalog with the given items (admin only, per firestore.rules).
export async function saveCatalog(db, type, items) {
  const meta = await readCatalogMeta(db);
  const oldChunks = (meta[type] && meta[type].chunks) || 0;
  const chunks = chunkItems(items);
  for (let i = 0; i < chunks.length; i++) {
    await setDoc(doc(db, COLLECTION, 'catalog_' + type + '_' + i), { json: JSON.stringify(chunks[i]) });
  }
  await setDoc(doc(db, COLLECTION, META_DOC), { [type]: { count: items.length, chunks: chunks.length, updatedAt: serverTimestamp() } }, { merge: true });
  for (let i = chunks.length; i < oldChunks; i++) {
    try { await deleteDoc(doc(db, COLLECTION, 'catalog_' + type + '_' + i)); } catch (e) { /* stale chunk, harmless */ }
  }
  catalogPromise = null;
}

async function loadType(db, type, meta) {
  const n = (meta[type] && meta[type].chunks) || 0;
  const parts = await Promise.all(Array.from({ length: n }, (_, i) => getDoc(doc(db, COLLECTION, 'catalog_' + type + '_' + i))));
  const out = [];
  parts.forEach((s) => {
    if (!s.exists()) return;
    try { out.push(...JSON.parse(s.data().json || '[]')); } catch (e) { /* skip a corrupt chunk */ }
  });
  return out;
}

// { nanda:[], nic:[], noc:[] } — loaded once per page session and shared by
// every patient card. Empty arrays when nothing has been uploaded yet.
export function ensureCatalogLoaded(db) {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      try {
        const meta = await readCatalogMeta(db);
        const [nanda, nic, noc] = await Promise.all(['nanda', 'nic', 'noc'].map(t => loadType(db, t, meta)));
        return { nanda, nic, noc };
      } catch (e) {
        catalogPromise = null;
        return { nanda: [], nic: [], noc: [] };
      }
    })();
  }
  return catalogPromise;
}

const bullets = (arr) => arr.map(x => '\u2022 ' + x).join('\n');
// One bullet per line; lines the admin already bulleted or numbered are kept as they are.
const bulletize = (text) => String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
  .map(l => (/^([-\u2022*]|\d+[.)])\s/.test(l) ? l : '\u2022 ' + l)).join('\n');

// Starter Planning / Implementation / Evaluation text for one NANDA-I entry.
// Text the admin typed into the NANDA file's own planning / implementation /
// evaluation columns wins; otherwise it is built from the linked NOC
// outcomes (planning + evaluation) and NIC interventions (implementation).
export function buildStarterText(dx, catalog) {
  const byCode = (list) => { const m = new Map(); list.forEach(x => { if (x.code) m.set(normCode(x.code), x); }); return m; };
  const nocs = (dx.nocCodes || []).map(c => byCode(catalog.noc).get(normCode(c))).filter(Boolean);
  const nics = (dx.nicCodes || []).map(c => byCode(catalog.nic).get(normCode(c))).filter(Boolean);

  const planning = dx.planning || (nocs.length ? 'Expected outcomes:\n' + bullets(nocs.map(o => o.name)) : '');
  const implementation = bulletize(dx.implementation) || (nics.length
    ? nics.map(n => ((n.activities || []).length ? n.name + ':\n' + bullets(n.activities.slice(0, 6)) : '\u2022 ' + n.name)).join('\n\n')
    : '');
  const evaluation = dx.evaluation || (nocs.length
    ? 'Evaluate progress towards:\n' + bullets(nocs.map(o => o.name + ((o.indicators || []).length ? ' (' + o.indicators.slice(0, 4).join('; ') + ')' : '')))
    : '');
  return { planning, implementation, evaluation };
}
