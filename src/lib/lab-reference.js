// js/lab-reference.js
// Clinical Lab Reference — ported from the MedIndex app's React
// LabReferencePage to plain JS for the Ward Charts app. Same data
// (js/labs-data.js), same category color coding, search, and night /
// reading mode toggles — rebuilt with template strings + DOM listeners.

import { LABS } from './labs-data.js';

const CAT_META = {
  Hematology:          { color: '#EF4444', bg: 'rgba(239,68,68,.1)',   border: 'rgba(239,68,68,.25)' },
  'WBC Differential':  { color: '#3B82F6', bg: 'rgba(59,130,246,.1)',  border: 'rgba(59,130,246,.25)' },
  Chemistry:           { color: '#0D9488', bg: 'rgba(13,148,136,.1)',  border: 'rgba(13,148,136,.25)' },
  Electrolytes:        { color: '#6366F1', bg: 'rgba(99,102,241,.1)',  border: 'rgba(99,102,241,.25)' },
  Coagulation:         { color: '#DC2626', bg: 'rgba(220,38,38,.1)',   border: 'rgba(220,38,38,.25)' },
  ABG:                 { color: '#7C3AED', bg: 'rgba(124,58,237,.1)',  border: 'rgba(124,58,237,.25)' },
  Thyroid:             { color: '#DB2777', bg: 'rgba(219,39,119,.1)',  border: 'rgba(219,39,119,.25)' },
  Liver:                { color: '#D97706', bg: 'rgba(217,119,6,.1)',  border: 'rgba(217,119,6,.25)' },
  'Lipid Panel':        { color: '#059669', bg: 'rgba(5,150,105,.1)',  border: 'rgba(5,150,105,.25)' },
  Urinalysis:            { color: '#CA8A04', bg: 'rgba(202,138,4,.1)', border: 'rgba(202,138,4,.25)' },
  Cardiac:               { color: '#E11D48', bg: 'rgba(225,29,72,.1)', border: 'rgba(225,29,72,.25)' },
  Serology:               { color: '#9333EA', bg: 'rgba(147,51,234,.1)', border: 'rgba(147,51,234,.25)' },
  Hormonal:                { color: '#C026D3', bg: 'rgba(192,38,211,.1)', border: 'rgba(192,38,211,.25)' },
  Microbiology:             { color: '#16A34A', bg: 'rgba(22,163,74,.1)', border: 'rgba(22,163,74,.25)' },
  'Tumor Markers':           { color: '#B45309', bg: 'rgba(180,83,9,.1)', border: 'rgba(180,83,9,.25)' },
  Pharmacology:                { color: '#4338CA', bg: 'rgba(67,56,202,.1)', border: 'rgba(67,56,202,.25)' },
};
const DEFAULT_META = { color: '#0D9488', bg: 'rgba(13,148,136,.1)', border: 'rgba(13,148,136,.25)' };
const getMeta = (cat) => CAT_META[cat] || DEFAULT_META;

const CATEGORIES = ['All', ...Array.from(new Set(LABS.map(l => l.cat)))];
const TOTAL_PARAMS = LABS.reduce((s, l) => s + 1 + (l.children?.length || 0), 0);

const NIGHT_KEY = 'wardcharts-labs-night';
const READING_KEY = 'wardcharts-labs-reading';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

let root = null;
let state = { search: '', activeCat: 'All', nightMode: false, readingMode: false };

export function initLabReference(container) {
  root = container;
  try { state.nightMode = localStorage.getItem(NIGHT_KEY) === '1'; } catch (e) {}
  try { state.readingMode = localStorage.getItem(READING_KEY) === '1'; } catch (e) {}
  renderAll();
}

function applyTheme() {
  root.className = 'lab-root' + (state.readingMode ? ' reading' : '');
  root.dataset.theme = state.nightMode ? 'night' : 'light';
}

function renderAll() {
  applyTheme();
  root.innerHTML = `
    <div class="lab-header">
      <div class="lab-header-inner">
        <div class="lab-title-row">
          <div class="lab-title-group">
            <div class="lab-logo">🔬</div>
            <div>
              <h2 class="lab-title">Clinical Lab Reference</h2>
              <div class="lab-subtitle">${LABS.length} panels · ${TOTAL_PARAMS} total parameters</div>
            </div>
          </div>
          <div class="lab-toggles">
            <button class="lab-toggle-pill ${state.nightMode ? 'active' : ''}" id="lab_nightBtn">${state.nightMode ? '🌙' : '☀️'} ${state.nightMode ? 'Night' : 'Day'}</button>
            <button class="lab-toggle-pill ${state.readingMode ? 'active' : ''}" id="lab_readingBtn">📖 Reading</button>
          </div>
        </div>
        <div class="lab-search-wrap">
          <span class="lab-search-icon">🔍</span>
          <input type="text" id="lab_search" class="lab-search" placeholder="Search panels, parameters, causes, management…" value="${esc(state.search)}">
          ${state.search ? '<button class="lab-search-clear" id="lab_clear">✕</button>' : ''}
        </div>
        <div class="lab-cats" id="lab_cats">
          ${CATEGORIES.map(cat => {
            const meta = getMeta(cat);
            const active = state.activeCat === cat;
            const bg = active ? (cat === 'All' ? 'var(--lab-active-all)' : meta.color) : 'var(--lab-chip-bg)';
            const color = active ? '#fff' : 'var(--lab-chip-text)';
            return `<button class="lab-cat-chip" data-cat="${esc(cat)}" style="background:${bg};color:${color};">${esc(cat)}</button>`;
          }).join('')}
        </div>
      </div>
    </div>
    <div class="lab-results" id="lab_results"></div>
  `;

  root.querySelector('#lab_nightBtn').addEventListener('click', () => {
    state.nightMode = !state.nightMode;
    try { localStorage.setItem(NIGHT_KEY, state.nightMode ? '1' : '0'); } catch (e) {}
    renderAll();
  });
  root.querySelector('#lab_readingBtn').addEventListener('click', () => {
    state.readingMode = !state.readingMode;
    try { localStorage.setItem(READING_KEY, state.readingMode ? '1' : '0'); } catch (e) {}
    renderAll();
  });
  root.querySelector('#lab_search').addEventListener('input', e => { state.search = e.target.value; renderResults(); syncClearBtn(); });
  const clearBtn = root.querySelector('#lab_clear');
  if (clearBtn) clearBtn.addEventListener('click', () => { state.search = ''; root.querySelector('#lab_search').value = ''; renderResults(); syncClearBtn(); });
  root.querySelectorAll('.lab-cat-chip').forEach(btn => {
    btn.addEventListener('click', () => { state.activeCat = btn.dataset.cat; renderAll(); root.querySelector('#lab_search').focus(); });
  });

  renderResults();
}

function syncClearBtn() {
  const wrap = root.querySelector('.lab-search-wrap');
  let btn = root.querySelector('#lab_clear');
  if (state.search && !btn) {
    btn = document.createElement('button');
    btn.className = 'lab-search-clear';
    btn.id = 'lab_clear';
    btn.textContent = '✕';
    btn.addEventListener('click', () => { state.search = ''; root.querySelector('#lab_search').value = ''; renderResults(); syncClearBtn(); });
    wrap.appendChild(btn);
  } else if (!state.search && btn) {
    btn.remove();
  }
}

function getFiltered() {
  const term = state.search.toLowerCase().trim();
  return LABS.filter(lab => {
    if (state.activeCat !== 'All' && lab.cat !== state.activeCat) return false;
    if (!term) return true;
    const matches = (l) => l.name.toLowerCase().includes(term) || l.abbr.toLowerCase().includes(term) ||
      [...(l.lowCauses || []), ...(l.highCauses || []), ...(l.solutionLow || []), ...(l.solutionHigh || [])]
        .some(s => s.toLowerCase().includes(term));
    if (matches(lab)) return true;
    if (lab.children) return lab.children.some(matches);
    return false;
  });
}

function renderResults() {
  const results = root.querySelector('#lab_results');
  const filtered = getFiltered();

  const statsHtml = `
    <div class="lab-stats-bar">
      <span class="lab-stats-text">${filtered.length === LABS.length ? `All ${LABS.length} panels` : `${filtered.length} of ${LABS.length} panels`}</span>
      ${(state.search || state.activeCat !== 'All') ? `<button class="lab-clear-filters" id="lab_clearFilters">Clear filters</button>` : ''}
    </div>`;

  if (filtered.length === 0) {
    results.innerHTML = statsHtml + `
      <div class="lab-empty">
        <div class="lab-empty-icon">🔬</div>
        <div class="lab-empty-title">No results found</div>
        <div class="lab-empty-sub">Try a different search term</div>
      </div>`;
  } else {
    results.innerHTML = statsHtml + filtered.map((lab, i) => panelCardHtml(lab, i)).join('');
  }

  const cf = results.querySelector('#lab_clearFilters');
  if (cf) cf.addEventListener('click', () => { state.search = ''; state.activeCat = 'All'; renderAll(); });

  wirePanelCards(results);
}

function listSectionHtml(id, title, items, color, emoji) {
  if (!items || items.length === 0) return '';
  return `
    <div class="lab-list-section" data-list="${id}">
      <button class="lab-list-toggle" data-list-toggle="${id}">
        <span>${emoji}</span>
        <span class="lab-list-title" style="color:${color};">${esc(title)}</span>
        <span class="lab-list-count">▼ ${items.length}</span>
      </button>
      <ul class="lab-list-items" id="${id}" style="display:none;">
        ${items.map(item => `<li>${esc(item)}</li>`).join('')}
      </ul>
    </div>`;
}

function paramCardHtml(param, meta, uid) {
  return `
    <div class="lab-param-card" data-param="${uid}">
      <button class="lab-param-header" data-param-toggle="${uid}">
        <div class="lab-param-main">
          <div class="lab-param-nameline">
            <span class="lab-param-name">${esc(param.name)}</span>
            ${param.unit ? `<span class="lab-param-unit" style="background:${meta.color}22;color:${meta.color};">${esc(param.unit)}</span>` : ''}
          </div>
          <div class="lab-param-abbr">${esc(param.abbr)}</div>
          <div class="lab-param-normal">📏 ${esc(param.normal)}</div>
        </div>
        <span class="lab-chevron" data-param-chevron="${uid}">▼</span>
      </button>
      <div class="lab-param-detail" id="detail_${uid}" style="display:none; border-top:1px solid ${meta.border};">
        ${listSectionHtml(`${uid}_low`, 'Low Causes', param.lowCauses, '#F87171', '⬇️')}
        ${listSectionHtml(`${uid}_high`, 'High Causes', param.highCauses, '#FB923C', '⬆️')}
        ${listSectionHtml(`${uid}_slow`, 'Management — Low', param.solutionLow, '#34D399', '💊')}
        ${listSectionHtml(`${uid}_shigh`, 'Management — High', param.solutionHigh, '#60A5FA', '🏥')}
      </div>
    </div>`;
}

function panelCardHtml(lab, i) {
  const meta = getMeta(lab.cat);
  const hasChildren = lab.children && lab.children.length > 0;
  const panelId = `panel_${i}`;
  const showNormal = lab.normal && lab.normal !== 'Panel test — see individual components below';

  const bodyHtml = !hasChildren
    ? `<div class="lab-panel-body-inner">
        ${listSectionHtml(`${panelId}_low`, 'Low Causes', lab.lowCauses, '#F87171', '⬇️')}
        ${listSectionHtml(`${panelId}_high`, 'High Causes', lab.highCauses, '#FB923C', '⬆️')}
        ${listSectionHtml(`${panelId}_slow`, 'Management — Low', lab.solutionLow, '#34D399', '💊')}
        ${listSectionHtml(`${panelId}_shigh`, 'Management — High', lab.solutionHigh, '#60A5FA', '🏥')}
      </div>`
    : `<div class="lab-panel-body-inner">
        ${(lab.lowCauses?.length > 0 || lab.highCauses?.length > 0) ? `
          <div class="lab-panel-overview">
            <div class="lab-panel-overview-label">Panel Overview</div>
            ${listSectionHtml(`${panelId}_ov_low`, 'Low Panel', lab.lowCauses, '#F87171', '⬇️')}
            ${listSectionHtml(`${panelId}_ov_high`, 'High Panel', lab.highCauses, '#FB923C', '⬆️')}
          </div>` : ''}
        <div class="lab-section-label">Individual Parameters</div>
        ${lab.children.map((child, j) => paramCardHtml(child, meta, `${panelId}_c${j}`)).join('')}
      </div>`;

  return `
    <div class="lab-panel-card" data-panel="${panelId}">
      <button class="lab-panel-header" data-panel-toggle="${panelId}">
        <span class="lab-panel-icon">${lab.icon}</span>
        <div class="lab-panel-main">
          <div class="lab-panel-nameline">
            <span class="lab-panel-name">${esc(lab.name)}</span>
            <span class="lab-panel-badge" style="background:${meta.bg};color:${meta.color};border:1px solid ${meta.border};">${esc(lab.cat)}</span>
            ${hasChildren ? `<span class="lab-panel-childcount">${lab.children.length} parameters</span>` : ''}
          </div>
          <div class="lab-panel-abbr">${esc(lab.abbr)}</div>
          ${showNormal ? `<div class="lab-panel-normal">📏 ${esc(lab.normal)}</div>` : ''}
        </div>
        <span class="lab-chevron-box" data-panel-chevron="${panelId}">▼</span>
      </button>
      <div class="lab-panel-body" id="body_${panelId}" style="display:none; border-top:1px solid var(--lab-divider);">
        ${bodyHtml}
      </div>
    </div>`;
}

function wirePanelCards(scope) {
  scope.querySelectorAll('[data-panel-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.panelToggle;
      const body = scope.querySelector('#body_' + id);
      const chev = scope.querySelector(`[data-panel-chevron="${id}"]`);
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      chev.textContent = open ? '▼' : '▲';
      btn.closest('.lab-panel-card').classList.toggle('open', !open);
    });
  });
  scope.querySelectorAll('[data-param-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.paramToggle;
      const detail = scope.querySelector('#detail_' + id);
      const chev = scope.querySelector(`[data-param-chevron="${id}"]`);
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : '';
      chev.textContent = open ? '▼' : '▲';
    });
  });
  scope.querySelectorAll('[data-list-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.listToggle;
      const list = scope.querySelector('#' + CSS.escape(id));
      const open = list.style.display !== 'none';
      list.style.display = open ? 'none' : '';
      const countSpan = btn.querySelector('.lab-list-count');
      countSpan.textContent = (open ? '▼ ' : '▲ ') + list.children.length;
    });
  });
}
