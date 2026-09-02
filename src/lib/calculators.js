// js/calculators.js
// Clinical calculators — ported from the MedIndex app's React calculators to
// plain JS for the Ward Charts app. Card-based hub, one-tap access, back to
// grid at any time. Formulas match MedIndex 1:1.

const toNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const fmt = (n, d = 2) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n.toFixed(d)).toString();
};
const LB_TO_KG = 0.453592;

const CALCULATORS = [
  { key: 'simple', label: 'Simple Dose', desc: 'Desired over have, times volume', icon: '➗' },
  { key: 'drug', label: 'Drug Dosage', desc: 'Weight-based mg per kg dosing', icon: '💊' },
  { key: 'iv', label: 'IV Fluids', desc: 'Drip rate, maintenance fluids, KCl', icon: '💧' },
  { key: 'units', label: 'Unit Converter', desc: 'Mass, electrolytes, labs, and more', icon: '⇄' },
  { key: 'bmi', label: 'BMI', desc: 'Body mass index and category', icon: '⚖️' },
];

let root = null;

export function initCalculators(container) {
  root = container;
  renderHub();
}

function renderHub() {
  root.innerHTML = `
    <div class="calc-grid">
      ${CALCULATORS.map(c => `
        <button class="calc-card" data-key="${c.key}">
          <span class="calc-card-icon">${c.icon}</span>
          <span class="calc-card-text">
            <span class="calc-card-title">${c.label}</span>
            <span class="calc-card-desc">${c.desc}</span>
          </span>
          <span class="calc-card-chev">›</span>
        </button>
      `).join('')}
    </div>
  `;
  root.querySelectorAll('.calc-card').forEach(btn => {
    btn.addEventListener('click', () => renderCalculator(btn.dataset.key));
  });
}

function renderCalculator(key) {
  const c = CALCULATORS.find(x => x.key === key);
  root.innerHTML = `
    <button class="calc-back" id="calcBackBtn">‹ All Calculators</button>
    <div class="calc-header">
      <span class="calc-header-icon">${c.icon}</span>
      <div>
        <div class="calc-header-title">${c.label}</div>
        <div class="calc-header-desc">${c.desc}</div>
      </div>
    </div>
    <div id="calcBody"></div>
  `;
  document.getElementById('calcBackBtn').addEventListener('click', renderHub);
  const body = document.getElementById('calcBody');
  if (key === 'simple') renderSimpleDose(body);
  else if (key === 'drug') renderDrugDosage(body);
  else if (key === 'iv') renderIVFluids(body);
  else if (key === 'units') renderUnitConverter(body);
  else if (key === 'bmi') renderBMI(body);
}

// ── Shared UI builders ──────────────────────────────────────────────────
function twoCol(inputsHtml, resultHtml) {
  return `<div class="calc-two-col"><div class="calc-panel">${inputsHtml}</div>${resultHtml}</div>`;
}
function resultPanel(icon, bodyHtml, note) {
  return `<div class="calc-result">
    <div class="calc-result-title">${icon} Result</div>
    ${bodyHtml}
    ${note ? `<p class="calc-note">${note}</p>` : ''}
  </div>`;
}
function resultRow(label, value, unit, highlight) {
  return `<div class="calc-row ${highlight ? 'calc-row-hi' : ''}">
    <span class="calc-row-label">${label}</span>
    <span class="calc-row-value ${highlight ? 'calc-row-value-hi' : ''}">${value} <span class="calc-row-unit">${unit}</span></span>
  </div>`;
}
function segControl(id, options, selected) {
  return `<div class="calc-seg" id="${id}">
    ${options.map(o => `<button type="button" class="calc-seg-btn ${o.key === selected ? 'active' : ''}" data-val="${o.key}">${o.label}</button>`).join('')}
  </div>`;
}
function wireSeg(container, id, onChange) {
  const el = container.querySelector('#' + id);
  el.querySelectorAll('.calc-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.calc-seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.dataset.val);
    });
  });
}

// ── 1. Simple Dose Calculator (D/H x Q) ──────────────────────────────────
function renderSimpleDose(el) {
  const state = { doseInput: 'total', orderedDose: '', dosePerKg: '', weight: '', weightUnit: 'kg', availableDose: '', formType: 'solid', perMl: '1' };

  function calc() {
    const weightKg = (() => { const w = toNum(state.weight); if (w === null) return null; return state.weightUnit === 'lb' ? w * LB_TO_KG : w; })();
    const totalOrderedDose = state.doseInput === 'total' ? toNum(state.orderedDose)
      : (() => { const dpk = toNum(state.dosePerKg); if (dpk === null || weightKg === null || weightKg <= 0) return null; return dpk * weightKg; })();
    const h = toNum(state.availableDose);
    let result = null;
    if (totalOrderedDose !== null && h !== null && h > 0) {
      const q = state.formType === 'liquid' ? (toNum(state.perMl) ?? 1) : 1;
      if (q > 0) result = (totalOrderedDose / h) * q;
    }
    return { weightKg, totalOrderedDose, result };
  }

  function draw() {
    el.innerHTML = twoCol(`
      <div class="field"><label>Ordered Dose</label>
        ${segControl('sd_doseInput', [{ key: 'total', label: 'Total dose (mg)' }, { key: 'perKg', label: 'By weight (mg/kg)' }], state.doseInput)}
      </div>
      <div id="sd_doseInputArea"></div>
      <div class="field"><label>Available Dose <span class="calc-sub">(mg — strength on hand)</span></label>
        <input type="number" inputmode="decimal" min="0" id="sd_available" value="${state.availableDose}" placeholder="e.g. 500"></div>
      <div class="field"><label>Form</label>
        ${segControl('sd_form', [{ key: 'solid', label: 'Tablet / Capsule' }, { key: 'liquid', label: 'Liquid' }], state.formType)}
      </div>
      <div id="sd_liquidArea"></div>
      <button class="calc-reset" id="sd_reset">↺ Reset</button>
    `, `<div id="sd_resultPanel"></div>`);

    drawDoseInputArea();
    drawLiquidArea();
    drawResult();

    wireSeg(el, 'sd_doseInput', v => { state.doseInput = v; drawDoseInputArea(); drawResult(); });
    wireSeg(el, 'sd_form', v => { state.formType = v; drawLiquidArea(); drawResult(); });
    el.querySelector('#sd_available').addEventListener('input', e => { state.availableDose = e.target.value; drawResult(); });
    el.querySelector('#sd_reset').addEventListener('click', () => { Object.assign(state, { doseInput: 'total', orderedDose: '', dosePerKg: '', weight: '', weightUnit: 'kg', availableDose: '', formType: 'solid', perMl: '1' }); draw(); });
  }

  function drawDoseInputArea() {
    const area = el.querySelector('#sd_doseInputArea');
    if (state.doseInput === 'total') {
      area.innerHTML = `<div class="field"><input type="number" inputmode="decimal" min="0" id="sd_ordered" value="${state.orderedDose}" placeholder="e.g. 250"></div>`;
      area.querySelector('#sd_ordered').addEventListener('input', e => { state.orderedDose = e.target.value; drawResult(); });
    } else {
      area.innerHTML = `
        <div class="field"><input type="number" inputmode="decimal" min="0" id="sd_perkg" value="${state.dosePerKg}" placeholder="Dose per kg, e.g. 15 (mg/kg)"></div>
        <div class="field"><label class="calc-sublabel">Patient Weight</label>
          <div class="calc-inline">
            <input type="number" inputmode="decimal" min="0" id="sd_weight" value="${state.weight}" placeholder="e.g. 12">
            ${segControl('sd_weightUnit', [{ key: 'kg', label: 'kg' }, { key: 'lb', label: 'lb' }], state.weightUnit)}
          </div>
          <p class="calc-hint" id="sd_weightHint"></p>
        </div>`;
      area.querySelector('#sd_perkg').addEventListener('input', e => { state.dosePerKg = e.target.value; drawResult(); });
      area.querySelector('#sd_weight').addEventListener('input', e => { state.weight = e.target.value; drawResult(); });
      wireSeg(area, 'sd_weightUnit', v => { state.weightUnit = v; drawResult(); });
    }
  }

  function drawLiquidArea() {
    const area = el.querySelector('#sd_liquidArea');
    area.innerHTML = state.formType === 'liquid'
      ? `<div class="field"><label>Available dose is per <span class="calc-sub">(mL)</span></label>
          <input type="number" inputmode="decimal" min="0" id="sd_perml" value="${state.perMl}" placeholder="e.g. 5 (for 125 mg / 5 mL)"></div>`
      : '';
    const input = area.querySelector('#sd_perml');
    if (input) input.addEventListener('input', e => { state.perMl = e.target.value; drawResult(); });
  }

  function drawResult() {
    const { weightKg, totalOrderedDose, result } = calc();
    const hint = el.querySelector('#sd_weightHint');
    if (hint) hint.textContent = state.weightUnit === 'lb' && weightKg !== null ? `≈ ${weightKg.toFixed(2)} kg` : '';
    const panel = el.querySelector('#sd_resultPanel');
    let body;
    if (result === null) {
      body = `<p class="calc-empty">${state.doseInput === 'perKg' ? 'Enter the dose per kg, patient weight, and available dose to calculate.' : 'Enter the ordered and available dose to calculate.'}</p>`;
    } else {
      body = (state.doseInput === 'perKg' && totalOrderedDose !== null ? resultRow('Total ordered dose', fmt(totalOrderedDose), 'mg') : '')
        + resultRow('Give', fmt(result), state.formType === 'liquid' ? 'mL' : (result === 1 ? 'tablet / capsule' : 'tablets / capsules'), true);
    }
    panel.innerHTML = resultPanel('🧮', body,
      `Formula: (Ordered ÷ Available)${state.formType === 'liquid' ? ' × mL' : ''}${state.doseInput === 'perKg' ? ', where Ordered = mg/kg × weight' : ''}. For reference only — always verify against the prescriber's order, drug reference, and facility protocol before administration.`);
  }

  draw();
}

// ── 2. Drug Dosage Calculator ────────────────────────────────────────────
function renderDrugDosage(el) {
  const state = { weight: '', weightUnit: 'kg', doseMode: 'perKg', dosePerKg: '', fixedDose: '', frequency: '', concentration: '', maxDailyDose: '' };

  function calc() {
    const weightKg = (() => { const w = toNum(state.weight); if (w === null) return null; return state.weightUnit === 'lb' ? w * LB_TO_KG : w; })();
    if (weightKg === null || weightKg <= 0) return null;
    let dosePerAdmin = null;
    if (state.doseMode === 'perKg') {
      const dpk = toNum(state.dosePerKg);
      if (dpk === null) return null;
      dosePerAdmin = dpk * weightKg;
    } else {
      const fd = toNum(state.fixedDose);
      if (fd === null) return null;
      dosePerAdmin = fd;
    }
    const freq = toNum(state.frequency);
    const dailyDose = freq !== null ? dosePerAdmin * freq : null;
    const conc = toNum(state.concentration);
    const volumePerAdmin = conc !== null && conc > 0 ? dosePerAdmin / conc : null;
    const maxDaily = toNum(state.maxDailyDose);
    const exceedsMax = maxDaily !== null && dailyDose !== null && dailyDose > maxDaily;
    return { weightKg, dosePerAdmin, dailyDose, volumePerAdmin, exceedsMax, maxDaily };
  }

  function draw() {
    el.innerHTML = twoCol(`
      <div class="field"><label>Patient Weight</label>
        <div class="calc-inline">
          <input type="number" inputmode="decimal" min="0" id="dd_weight" value="${state.weight}" placeholder="e.g. 68">
          ${segControl('dd_weightUnit', [{ key: 'kg', label: 'kg' }, { key: 'lb', label: 'lb' }], state.weightUnit)}
        </div>
        <p class="calc-hint" id="dd_weightHint"></p>
      </div>
      <div class="field"><label>Ordered Dose</label>
        ${segControl('dd_doseMode', [{ key: 'perKg', label: 'mg / kg' }, { key: 'fixed', label: 'Fixed dose (mg)' }], state.doseMode)}
      </div>
      <div id="dd_doseArea"></div>
      <div class="field"><label>Frequency <span class="calc-sub">(doses per day, optional)</span></label>
        <input type="number" inputmode="decimal" min="0" id="dd_freq" value="${state.frequency}" placeholder="e.g. 3 (for TDS)"></div>
      <div class="field"><label>Available Concentration <span class="calc-sub">(mg/mL, optional)</span></label>
        <input type="number" inputmode="decimal" min="0" id="dd_conc" value="${state.concentration}" placeholder="e.g. 25 (mg/mL)"></div>
      <div class="field"><label>Max Daily Dose <span class="calc-sub">(mg/day, optional safety check)</span></label>
        <input type="number" inputmode="decimal" min="0" id="dd_max" value="${state.maxDailyDose}" placeholder="e.g. 4000"></div>
      <button class="calc-reset" id="dd_reset">↺ Reset</button>
    `, `<div id="dd_resultPanel"></div>`);

    drawDoseArea();
    drawResult();

    wireSeg(el, 'dd_weightUnit', v => { state.weightUnit = v; drawResult(); });
    wireSeg(el, 'dd_doseMode', v => { state.doseMode = v; drawDoseArea(); drawResult(); });
    el.querySelector('#dd_weight').addEventListener('input', e => { state.weight = e.target.value; drawResult(); });
    el.querySelector('#dd_freq').addEventListener('input', e => { state.frequency = e.target.value; drawResult(); });
    el.querySelector('#dd_conc').addEventListener('input', e => { state.concentration = e.target.value; drawResult(); });
    el.querySelector('#dd_max').addEventListener('input', e => { state.maxDailyDose = e.target.value; drawResult(); });
    el.querySelector('#dd_reset').addEventListener('click', () => { Object.assign(state, { weight: '', weightUnit: 'kg', doseMode: 'perKg', dosePerKg: '', fixedDose: '', frequency: '', concentration: '', maxDailyDose: '' }); draw(); });
  }

  function drawDoseArea() {
    const area = el.querySelector('#dd_doseArea');
    area.innerHTML = state.doseMode === 'perKg'
      ? `<div class="field"><input type="number" inputmode="decimal" min="0" id="dd_perkg" value="${state.dosePerKg}" placeholder="Dose per kg, e.g. 10 (mg/kg)"></div>`
      : `<div class="field"><input type="number" inputmode="decimal" min="0" id="dd_fixed" value="${state.fixedDose}" placeholder="Total dose in mg, e.g. 500"></div>`;
    const perkg = area.querySelector('#dd_perkg');
    if (perkg) perkg.addEventListener('input', e => { state.dosePerKg = e.target.value; drawResult(); });
    const fixed = area.querySelector('#dd_fixed');
    if (fixed) fixed.addEventListener('input', e => { state.fixedDose = e.target.value; drawResult(); });
  }

  function drawResult() {
    const r = calc();
    const hint = el.querySelector('#dd_weightHint');
    if (hint) { const w = toNum(state.weight); const kg = w !== null && state.weightUnit === 'lb' ? w * LB_TO_KG : null; hint.textContent = kg !== null ? `≈ ${kg.toFixed(2)} kg` : ''; }
    const panel = el.querySelector('#dd_resultPanel');
    let body;
    if (!r) {
      body = `<p class="calc-empty">Enter patient weight and dose to calculate.</p>`;
    } else {
      body = resultRow('Dose per administration', fmt(r.dosePerAdmin, 3), 'mg')
        + (r.dailyDose !== null ? resultRow('Total daily dose', fmt(r.dailyDose, 3), 'mg/day') : '')
        + (r.volumePerAdmin !== null ? resultRow('Volume to administer', fmt(r.volumePerAdmin, 3), 'mL / dose', true) : '')
        + (r.exceedsMax ? `<div class="calc-warning">⚠️ Calculated daily dose (${fmt(r.dailyDose, 3)} mg) exceeds the entered max daily dose (${fmt(r.maxDaily, 3)} mg). Re-check the order before administering.</div>` : '');
    }
    panel.innerHTML = resultPanel('🧮', body, "For reference only — always verify against the prescriber's order, drug reference, and facility protocol before administration.");
  }

  draw();
}

// ── 3. IV Fluids Calculator (drip / maintenance / KCl) ───────────────────
const DROP_FACTORS = [10, 15, 20, 60];
const DROP_FACTOR_LABELS = { 10: '10 gtt/mL (macro)', 15: '15 gtt/mL (macro)', 20: '20 gtt/mL (macro)', 60: '60 gtt/mL (micro / pediatric)' };
const KCL_CONCENTRATIONS = [
  { value: '2', label: '2 mmol/mL (15% KCl, standard liquid — 20 mmol in 10 mL)' },
  { value: '1.34', label: '1.34 mmol/mL (10% liquid KCl)' },
  { value: '0.2', label: '0.2 mmol/mL (15 mmol in 75 mL)' },
  { value: 'custom', label: 'Custom concentration...' },
];

function renderIVFluids(el) {
  function drawSubHub() {
    el.innerHTML = `<div class="calc-grid calc-grid-3">
      <button class="calc-card" data-sub="drip"><span class="calc-card-icon">🕐</span><span class="calc-card-text"><span class="calc-card-title">Drip Rate</span><span class="calc-card-desc">mL/hr and gtt/min from volume and time</span></span></button>
      <button class="calc-card" data-sub="maintenance"><span class="calc-card-icon">👶</span><span class="calc-card-text"><span class="calc-card-title">Maintenance Fluids</span><span class="calc-card-desc">Holliday-Segar 4-2-1 rule by weight</span></span></button>
      <button class="calc-card" data-sub="kcl"><span class="calc-card-icon">🧪</span><span class="calc-card-text"><span class="calc-card-title">KCl / IV Additive</span><span class="calc-card-desc">Volume to draw up from a dose</span></span></button>
    </div>`;
    el.querySelectorAll('[data-sub]').forEach(btn => btn.addEventListener('click', () => drawSub(btn.dataset.sub)));
  }

  function drawSub(sub) {
    el.innerHTML = `<button class="calc-back calc-back-sm" id="iv_back">‹ IV Fluids</button><div id="iv_subBody"></div>`;
    el.querySelector('#iv_back').addEventListener('click', drawSubHub);
    const body = el.querySelector('#iv_subBody');
    if (sub === 'drip') drawDrip(body);
    else if (sub === 'maintenance') drawMaintenance(body);
    else drawKcl(body);
  }

  function drawDrip(body) {
    const state = { volume: '', hours: '', minutes: '', dropFactor: 20 };
    function calc() {
      const h = toNum(state.hours) || 0, m = toNum(state.minutes) || 0;
      const totalMinutes = h * 60 + m;
      const vol = toNum(state.volume);
      if (vol === null || vol <= 0 || totalMinutes <= 0) return null;
      const mlPerHr = vol / (totalMinutes / 60);
      const dropsPerMin = (vol * state.dropFactor) / totalMinutes;
      return { mlPerHr, dropsPerMin, dropsPerSec: dropsPerMin / 60 };
    }
    function draw() {
      body.innerHTML = twoCol(`
        <div class="field"><label>Volume to Infuse (mL)</label><input type="number" inputmode="decimal" min="0" id="iv_vol" value="${state.volume}" placeholder="e.g. 1000"></div>
        <div class="field"><label>Infusion Time</label>
          <div class="calc-inline">
            <input type="number" inputmode="decimal" min="0" id="iv_hours" value="${state.hours}" placeholder="Hours">
            <input type="number" inputmode="decimal" min="0" max="59" id="iv_mins" value="${state.minutes}" placeholder="Minutes">
          </div>
        </div>
        <div class="field"><label>Giving Set Drop Factor</label>
          <select id="iv_drop">${DROP_FACTORS.map(d => `<option value="${d}" ${d === state.dropFactor ? 'selected' : ''}>${DROP_FACTOR_LABELS[d]}</option>`).join('')}</select>
        </div>
        <button class="calc-reset" id="iv_reset">↺ Reset</button>
      `, `<div id="iv_resultPanel"></div>`);
      const upd = () => draw2();
      body.querySelector('#iv_vol').addEventListener('input', e => { state.volume = e.target.value; upd(); });
      body.querySelector('#iv_hours').addEventListener('input', e => { state.hours = e.target.value; upd(); });
      body.querySelector('#iv_mins').addEventListener('input', e => { state.minutes = e.target.value; upd(); });
      body.querySelector('#iv_drop').addEventListener('change', e => { state.dropFactor = Number(e.target.value); upd(); });
      body.querySelector('#iv_reset').addEventListener('click', () => { Object.assign(state, { volume: '', hours: '', minutes: '', dropFactor: 20 }); draw(); });
      draw2();
    }
    function draw2() {
      const r = calc();
      const panel = body.querySelector('#iv_resultPanel');
      const bodyHtml = r
        ? resultRow('Infusion rate', fmt(r.mlPerHr), 'mL/hr') + resultRow('Drip rate', fmt(r.dropsPerMin), 'gtt/min', true) + resultRow('Drops per second', r.dropsPerSec.toFixed(2), 'gtt/sec')
        : `<p class="calc-empty">Enter volume and time to calculate the flow rate.</p>`;
      panel.innerHTML = resultPanel('💧', bodyHtml, 'Round drops/min to the nearest whole drop when setting a manual gravity infusion. Always double-check against pump settings and facility protocol.');
    }
    draw();
  }

  function drawMaintenance(body) {
    const state = { weight: '' };
    function calc() {
      const w = toNum(state.weight);
      if (w === null || w <= 0) return null;
      let mlPerHr;
      if (w <= 10) mlPerHr = w * 4;
      else if (w <= 20) mlPerHr = 10 * 4 + (w - 10) * 2;
      else mlPerHr = 10 * 4 + 10 * 2 + (w - 20) * 1;
      return { mlPerHr, mlPerDay: mlPerHr * 24 };
    }
    function draw() {
      body.innerHTML = twoCol(`
        <div class="field"><label>Patient Weight (kg)</label>
          <input type="number" inputmode="decimal" min="0" id="mf_weight" value="${state.weight}" placeholder="e.g. 24">
          <p class="calc-hint">Uses the Holliday–Segar (4-2-1) rule: 4 mL/kg/hr for the first 10 kg, 2 mL/kg/hr for the next 10 kg, and 1 mL/kg/hr for each kg above 20 kg.</p>
        </div>
        <button class="calc-reset" id="mf_reset">↺ Reset</button>
      `, `<div id="mf_resultPanel"></div>`);
      body.querySelector('#mf_weight').addEventListener('input', e => { state.weight = e.target.value; draw2(); });
      body.querySelector('#mf_reset').addEventListener('click', () => { state.weight = ''; draw(); });
      draw2();
    }
    function draw2() {
      const r = calc();
      const panel = body.querySelector('#mf_resultPanel');
      const bodyHtml = r ? resultRow('Maintenance rate', fmt(r.mlPerHr), 'mL/hr', true) + resultRow('Total daily volume', fmt(r.mlPerDay), 'mL/day')
        : `<p class="calc-empty">Enter weight to calculate maintenance fluid needs.</p>`;
      panel.innerHTML = resultPanel('👶', bodyHtml, 'Intended primarily for pediatric maintenance fluid estimation. Adjust for fever, renal/cardiac status, and fluid restriction per clinical judgment.');
    }
    draw();
  }

  function drawKcl(body) {
    const state = { dose: '', doseUnit: 'mmol', conc: '2', customConc: '' };
    function concVal() { return state.conc === 'custom' ? toNum(state.customConc) : toNum(state.conc); }
    function calc() {
      const d = toNum(state.dose);
      const cv = concVal();
      if (d === null || d <= 0 || !cv || cv <= 0) return null;
      return d / cv;
    }
    function draw() {
      body.innerHTML = twoCol(`
        <div class="field"><label>Prescribed Dose</label>
          <div class="calc-inline">
            <input type="number" inputmode="decimal" min="0" id="kcl_dose" value="${state.dose}" placeholder="e.g. 20">
            <select id="kcl_unit"><option value="mmol" ${state.doseUnit === 'mmol' ? 'selected' : ''}>mmol</option><option value="mEq" ${state.doseUnit === 'mEq' ? 'selected' : ''}>mEq</option></select>
          </div>
          <p class="calc-hint">Potassium is monovalent, so 1 mmol K⁺ = 1 mEq K⁺.</p>
        </div>
        <div class="field"><label>Solution Concentration</label>
          <select id="kcl_conc">${KCL_CONCENTRATIONS.map(c => `<option value="${c.value}" ${c.value === state.conc ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        </div>
        <div id="kcl_customArea"></div>
        <button class="calc-reset" id="kcl_reset">↺ Reset</button>
      `, `<div id="kcl_resultPanel"></div>`);
      drawCustom();
      body.querySelector('#kcl_dose').addEventListener('input', e => { state.dose = e.target.value; draw2(); });
      body.querySelector('#kcl_unit').addEventListener('change', e => { state.doseUnit = e.target.value; draw2(); });
      body.querySelector('#kcl_conc').addEventListener('change', e => { state.conc = e.target.value; drawCustom(); draw2(); });
      body.querySelector('#kcl_reset').addEventListener('click', () => { Object.assign(state, { dose: '', doseUnit: 'mmol', conc: '2', customConc: '' }); draw(); });
      draw2();
    }
    function drawCustom() {
      const area = body.querySelector('#kcl_customArea');
      area.innerHTML = state.conc === 'custom'
        ? `<div class="field"><label>Custom Concentration (mmol/mL)</label><input type="number" inputmode="decimal" min="0" step="0.01" id="kcl_custom" value="${state.customConc}" placeholder="e.g. 1.5"></div>`
        : '';
      const input = area.querySelector('#kcl_custom');
      if (input) input.addEventListener('input', e => { state.customConc = e.target.value; draw2(); });
    }
    function draw2() {
      const r = calc();
      const panel = body.querySelector('#kcl_resultPanel');
      const bodyHtml = r
        ? resultRow('Volume to draw up', fmt(r), 'mL', true) + resultRow('Prescribed dose', state.dose, `${state.doseUnit} = ${state.dose} ${state.doseUnit === 'mmol' ? 'mEq' : 'mmol'}`)
        : `<p class="calc-empty">Enter a dose and concentration to calculate the volume to draw up.</p>`;
      panel.innerHTML = resultPanel('🧪', bodyHtml, 'Always confirm the exact mmol/mL or mEq/mL strength printed on the vial or ampoule label, since KCl formulations vary by manufacturer and region. Never administer KCl undiluted or by IV push.');
    }
    draw();
  }

  drawSubHub();
}

// ── 4. Unit Converter ────────────────────────────────────────────────────
const UC_CATEGORIES = [
  { key: 'mass', label: 'Mass (mcg / mg / g / kg)' },
  { key: 'percent', label: '% w/v ↔ mg/mL' },
  { key: 'electrolyte', label: 'Electrolytes (mEq / mmol ↔ mg)' },
  { key: 'lab', label: 'Lab Values (mmol/L ↔ mg/dL)' },
  { key: 'units', label: 'Units / IU ↔ mL' },
  { key: 'volume', label: 'Volume (mL / L / fl oz)' },
  { key: 'weight', label: 'Body Weight (kg ↔ lb)' },
  { key: 'height', label: 'Height (cm ↔ in)' },
  { key: 'temp', label: 'Temperature (°C ↔ °F)' },
];
const MASS_UNITS = [{ key: 'mcg', label: 'mcg', factor: 0.001 }, { key: 'mg', label: 'mg', factor: 1 }, { key: 'g', label: 'g', factor: 1000 }, { key: 'kg', label: 'kg', factor: 1000000 }];
const VOLUME_UNITS = [{ key: 'ml', label: 'mL', factor: 1 }, { key: 'cc', label: 'cc', factor: 1 }, { key: 'l', label: 'L', factor: 1000 }, { key: 'floz', label: 'fl oz (US)', factor: 29.5735 }];
const ELECTROLYTES = [
  { key: 'na', label: 'Sodium (Na⁺)', mw: 23, valence: 1 },
  { key: 'k', label: 'Potassium (K⁺)', mw: 39, valence: 1 },
  { key: 'ca', label: 'Calcium (Ca²⁺)', mw: 40, valence: 2 },
  { key: 'mg', label: 'Magnesium (Mg²⁺)', mw: 24, valence: 2 },
  { key: 'cl', label: 'Chloride (Cl⁻)', mw: 35.5, valence: 1 },
  { key: 'hco3', label: 'Bicarbonate (HCO₃⁻)', mw: 61, valence: 1 },
  { key: 'po4', label: 'Phosphate (PO₄³⁻)', mw: 95, valence: 3 },
];
const LAB_ANALYTES = [
  { key: 'glucose', label: 'Glucose', siUnit: 'mmol/L', factor: 18.016 },
  { key: 'urea', label: 'Urea', siUnit: 'mmol/L', factor: 6.006 },
  { key: 'bun', label: 'Urea Nitrogen (BUN)', siUnit: 'mmol/L', factor: 2.801 },
  { key: 'creatinine', label: 'Creatinine', siUnit: 'µmol/L', factor: 0.0113 },
  { key: 'calcium', label: 'Calcium (total)', siUnit: 'mmol/L', factor: 4.008 },
  { key: 'magnesium', label: 'Magnesium', siUnit: 'mmol/L', factor: 2.431 },
  { key: 'phosphate', label: 'Phosphate', siUnit: 'mmol/L', factor: 3.097 },
  { key: 'cholesterol', label: 'Total Cholesterol', siUnit: 'mmol/L', factor: 38.67 },
  { key: 'triglyceride', label: 'Triglycerides', siUnit: 'mmol/L', factor: 88.57 },
  { key: 'bilirubin', label: 'Bilirubin (total)', siUnit: 'µmol/L', factor: 0.0585 },
  { key: 'uricacid', label: 'Uric Acid', siUnit: 'µmol/L', factor: 0.0168 },
];

function renderUnitConverter(el) {
  let category = 'mass';

  function draw() {
    el.innerHTML = `
      <div class="field calc-max-xl"><label>Conversion Type</label>
        <select id="uc_category">${UC_CATEGORIES.map(c => `<option value="${c.key}" ${c.key === category ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
      </div>
      <div id="uc_body"></div>
    `;
    el.querySelector('#uc_category').addEventListener('change', e => { category = e.target.value; drawBody(); });
    drawBody();
  }

  function drawBody() {
    const body = el.querySelector('#uc_body');
    if (category === 'mass') drawFactorConverter(body, MASS_UNITS, 'mg', 'mcg', 'Scale', '1 g = 1000 mg = 1,000,000 mcg. Always double-check decimal points — mg/mcg mix-ups are a leading cause of dosing errors.');
    else if (category === 'volume') drawFactorConverter(body, VOLUME_UNITS, 'ml', 'l', '💧', '1 cc (cubic centimetre) = 1 mL exactly — the two units are used interchangeably in clinical practice (e.g. syringe sizes marked "cc"). 1 L = 1000 mL. 1 US fl oz ≈ 29.57 mL — useful for oral fluid charting when intake is recorded in ounces.');
    else if (category === 'percent') drawPercent(body);
    else if (category === 'electrolyte') drawElectrolyte(body);
    else if (category === 'lab') drawLab(body);
    else if (category === 'units') drawUnitsToVolume(body);
    else if (category === 'weight') drawPair(body, 'kg', 'lb', 'e.g. 70', 'e.g. 154.3', v => v * 2.20462, v => v / 2.20462, '1 kg = 2.20462 lb.');
    else if (category === 'height') drawPair(body, 'cm', 'in', 'e.g. 170', 'e.g. 66.9', v => v / 2.54, v => v * 2.54, '1 in = 2.54 cm.');
    else if (category === 'temp') drawPair(body, '°C', '°F', 'e.g. 37', 'e.g. 98.6', v => (v * 9) / 5 + 32, v => ((v - 32) * 5) / 9, '°F = (°C × 9/5) + 32. Normal body temperature ≈ 37°C / 98.6°F.');
  }

  function drawFactorConverter(body, units, defFrom, defTo, icon, note) {
    const state = { value: '', from: defFrom, to: defTo };
    function calc() {
      const v = toNum(state.value);
      if (v === null) return null;
      const from = units.find(u => u.key === state.from), to = units.find(u => u.key === state.to);
      if (!from || !to) return null;
      return (v * from.factor) / to.factor;
    }
    function draw() {
      body.innerHTML = twoCol(`
        <div class="field"><label>Value</label><input type="number" inputmode="decimal" min="0" id="fc_value" value="${state.value}" placeholder="e.g. 500"></div>
        <div class="calc-inline calc-inline-end">
          <div class="field" style="flex:1"><label>From</label><select id="fc_from">${units.map(u => `<option value="${u.key}" ${u.key === state.from ? 'selected' : ''}>${u.label}</option>`).join('')}</select></div>
          <button type="button" class="calc-swap" id="fc_swap" title="Swap units">⇄</button>
          <div class="field" style="flex:1"><label>To</label><select id="fc_to">${units.map(u => `<option value="${u.key}" ${u.key === state.to ? 'selected' : ''}>${u.label}</option>`).join('')}</select></div>
        </div>
        <button class="calc-reset" id="fc_reset">↺ Reset</button>
      `, `<div id="fc_resultPanel"></div>`);
      body.querySelector('#fc_value').addEventListener('input', e => { state.value = e.target.value; draw2(); });
      body.querySelector('#fc_from').addEventListener('change', e => { state.from = e.target.value; draw2(); });
      body.querySelector('#fc_to').addEventListener('change', e => { state.to = e.target.value; draw2(); });
      body.querySelector('#fc_swap').addEventListener('click', () => { const t = state.from; state.from = state.to; state.to = t; draw(); });
      body.querySelector('#fc_reset').addEventListener('click', () => { Object.assign(state, { value: '', from: defFrom, to: defTo }); draw(); });
      draw2();
    }
    function draw2() {
      const r = calc();
      const fromLabel = units.find(u => u.key === state.from)?.label;
      const toLabel = units.find(u => u.key === state.to)?.label;
      const panel = body.querySelector('#fc_resultPanel');
      panel.innerHTML = resultPanel(icon, r !== null ? resultRow(`${state.value || 0} ${fromLabel} =`, fmt(r, 6), toLabel, true) : `<p class="calc-empty">Enter a value to convert.</p>`, note);
    }
    draw();
  }

  function drawPercent(body) {
    const state = { percent: '', mgPerMl: '' };
    function draw() {
      body.innerHTML = twoCol(`
        <div class="field"><label>% w/v Solution</label><input type="number" inputmode="decimal" min="0" id="pc_percent" value="${state.percent}" placeholder="e.g. 0.9 (for normal saline)"></div>
        <div class="calc-arrow-divider">⇅</div>
        <div class="field"><label>Concentration (mg/mL)</label><input type="number" inputmode="decimal" min="0" id="pc_mgml" value="${state.mgPerMl}" placeholder="e.g. 9"></div>
        <button class="calc-reset" id="pc_reset">↺ Reset</button>
      `, `<div id="pc_resultPanel"></div>`);
      body.querySelector('#pc_percent').addEventListener('input', e => {
        state.percent = e.target.value;
        const n = toNum(e.target.value);
        state.mgPerMl = n !== null ? String(Number((n * 10).toFixed(6))) : '';
        body.querySelector('#pc_mgml').value = state.mgPerMl;
        draw2();
      });
      body.querySelector('#pc_mgml').addEventListener('input', e => {
        state.mgPerMl = e.target.value;
        const n = toNum(e.target.value);
        state.percent = n !== null ? String(Number((n / 10).toFixed(6))) : '';
        body.querySelector('#pc_percent').value = state.percent;
        draw2();
      });
      body.querySelector('#pc_reset').addEventListener('click', () => { Object.assign(state, { percent: '', mgPerMl: '' }); draw(); });
      draw2();
    }
    function draw2() {
      const panel = body.querySelector('#pc_resultPanel');
      const has = state.percent !== '' && state.mgPerMl !== '';
      panel.innerHTML = resultPanel('%', has ? resultRow(`${state.percent}% w/v =`, state.mgPerMl, 'mg/mL', true) : `<p class="calc-empty">Enter a % concentration or mg/mL value to convert.</p>`,
        '% w/v means grams per 100 mL, so 1% = 1 g/100 mL = 10 mg/mL. E.g. 0.9% normal saline = 9 mg/mL.');
    }
    draw();
  }

  function drawElectrolyte(body) {
    const state = { ionKey: 'na', mode: 'mgToMeq', value: '' };
    function calc() {
      const ion = ELECTROLYTES.find(e => e.key === state.ionKey);
      const v = toNum(state.value);
      if (v === null || !ion) return null;
      if (state.mode === 'mgToMeq') { const mEq = (v * ion.valence) / ion.mw; return { mEq, mmol: mEq / ion.valence }; }
      const mg = (v * ion.mw) / ion.valence;
      return { mg, mmol: v / ion.valence };
    }
    function draw() {
      const ion = ELECTROLYTES.find(e => e.key === state.ionKey);
      body.innerHTML = twoCol(`
        <div class="field"><label>Electrolyte</label><select id="el_ion">${ELECTROLYTES.map(e => `<option value="${e.key}" ${e.key === state.ionKey ? 'selected' : ''}>${e.label}</option>`).join('')}</select></div>
        <div class="field"><label>Convert</label>${segControl('el_mode', [{ key: 'mgToMeq', label: 'mg → mEq' }, { key: 'meqToMg', label: 'mEq → mg' }], state.mode)}</div>
        <div class="field"><label>${state.mode === 'mgToMeq' ? 'Elemental mass (mg)' : 'Milliequivalents (mEq)'}</label>
          <input type="number" inputmode="decimal" min="0" id="el_value" value="${state.value}" placeholder="${state.mode === 'mgToMeq' ? 'e.g. 1000' : 'e.g. 40'}"></div>
        <button class="calc-reset" id="el_reset">↺ Reset</button>
      `, `<div id="el_resultPanel"></div>`);
      body.querySelector('#el_ion').addEventListener('change', e => { state.ionKey = e.target.value; draw(); });
      wireSeg(body, 'el_mode', v => { state.mode = v; draw(); });
      body.querySelector('#el_value').addEventListener('input', e => { state.value = e.target.value; draw2(); });
      body.querySelector('#el_reset').addEventListener('click', () => { Object.assign(state, { ionKey: 'na', mode: 'mgToMeq', value: '' }); draw(); });
      draw2();
    }
    function draw2() {
      const r = calc();
      const ion = ELECTROLYTES.find(e => e.key === state.ionKey);
      const panel = body.querySelector('#el_resultPanel');
      const bodyHtml = r
        ? (state.mode === 'mgToMeq' ? resultRow('Milliequivalents', fmt(r.mEq), 'mEq', true) + resultRow('Millimoles', fmt(r.mmol), 'mmol')
          : resultRow('Elemental mass', fmt(r.mg), 'mg', true) + resultRow('Millimoles', fmt(r.mmol), 'mmol'))
        : `<p class="calc-empty">Select an electrolyte and enter a value to convert.</p>`;
      panel.innerHTML = resultPanel('⚡', bodyHtml, `Based on elemental ${ion.label.replace(/\s*\(.*\)/, '')} — MW ${ion.mw} g/mol, valence ${ion.valence}. Conversion is for the elemental ion, not a specific salt form (e.g. calcium gluconate vs calcium chloride contain different elemental calcium per gram — check product labeling).`);
    }
    draw();
  }

  function drawLab(body) {
    const state = { analyteKey: 'glucose', mode: 'siToConv', value: '' };
    function calc() {
      const a = LAB_ANALYTES.find(x => x.key === state.analyteKey);
      const v = toNum(state.value);
      if (v === null || !a) return null;
      return state.mode === 'siToConv' ? v * a.factor : v / a.factor;
    }
    function draw() {
      const a = LAB_ANALYTES.find(x => x.key === state.analyteKey);
      body.innerHTML = twoCol(`
        <div class="field"><label>Lab Value</label><select id="lb_analyte">${LAB_ANALYTES.map(x => `<option value="${x.key}" ${x.key === state.analyteKey ? 'selected' : ''}>${x.label}</option>`).join('')}</select></div>
        <div class="field"><label>Convert</label>${segControl('lb_mode', [{ key: 'siToConv', label: `${a.siUnit} → mg/dL` }, { key: 'convToSi', label: `mg/dL → ${a.siUnit}` }], state.mode)}</div>
        <div class="field"><label>Value (${state.mode === 'siToConv' ? a.siUnit : 'mg/dL'})</label>
          <input type="number" inputmode="decimal" min="0" id="lb_value" value="${state.value}" placeholder="e.g. 5.5"></div>
        <button class="calc-reset" id="lb_reset">↺ Reset</button>
      `, `<div id="lb_resultPanel"></div>`);
      body.querySelector('#lb_analyte').addEventListener('change', e => { state.analyteKey = e.target.value; draw(); });
      wireSeg(body, 'lb_mode', v => { state.mode = v; draw(); });
      body.querySelector('#lb_value').addEventListener('input', e => { state.value = e.target.value; draw2(); });
      body.querySelector('#lb_reset').addEventListener('click', () => { Object.assign(state, { analyteKey: 'glucose', mode: 'siToConv', value: '' }); draw(); });
      draw2();
    }
    function draw2() {
      const r = calc();
      const a = LAB_ANALYTES.find(x => x.key === state.analyteKey);
      const panel = body.querySelector('#lb_resultPanel');
      panel.innerHTML = resultPanel('🧪', r !== null ? resultRow(`${state.value} ${state.mode === 'siToConv' ? a.siUnit : 'mg/dL'} =`, fmt(r), state.mode === 'siToConv' ? 'mg/dL' : a.siUnit, true) : `<p class="calc-empty">Select a lab value and enter a result to convert.</p>`,
        "Standard published SI-to-conventional conversion factors. Always confirm against your lab's reference range, as reporting units can vary by institution.");
    }
    draw();
  }

  function drawUnitsToVolume(body) {
    const state = { concentration: '', mode: 'unitsToMl', value: '' };
    function calc() {
      const conc = toNum(state.concentration), v = toNum(state.value);
      if (conc === null || conc <= 0 || v === null) return null;
      return state.mode === 'unitsToMl' ? v / conc : v * conc;
    }
    function draw() {
      body.innerHTML = twoCol(`
        <div class="field"><label>Concentration on the label <span class="calc-sub">(units/mL)</span></label>
          <input type="number" inputmode="decimal" min="0" id="uv_conc" value="${state.concentration}" placeholder="e.g. 100 (U-100 insulin)">
          <p class="calc-hint">Works for any "units" or "IU" based product — insulin, heparin, penicillin, vitamin D, etc. Always read the concentration from the specific vial/pen you are using; it is not standard across products.</p></div>
        <div class="field"><label>Convert</label>${segControl('uv_mode', [{ key: 'unitsToMl', label: 'Units → mL' }, { key: 'mlToUnits', label: 'mL → Units' }], state.mode)}</div>
        <div class="field"><label>${state.mode === 'unitsToMl' ? 'Ordered dose (units)' : 'Volume (mL)'}</label>
          <input type="number" inputmode="decimal" min="0" id="uv_value" value="${state.value}" placeholder="${state.mode === 'unitsToMl' ? 'e.g. 500' : 'e.g. 2'}"></div>
        <button class="calc-reset" id="uv_reset">↺ Reset</button>
      `, `<div id="uv_resultPanel"></div>`);
      body.querySelector('#uv_conc').addEventListener('input', e => { state.concentration = e.target.value; draw2(); });
      wireSeg(body, 'uv_mode', v => { state.mode = v; draw(); });
      body.querySelector('#uv_value').addEventListener('input', e => { state.value = e.target.value; draw2(); });
      body.querySelector('#uv_reset').addEventListener('click', () => { Object.assign(state, { concentration: '', mode: 'unitsToMl', value: '' }); draw(); });
      draw2();
    }
    function draw2() {
      const r = calc();
      const panel = body.querySelector('#uv_resultPanel');
      panel.innerHTML = resultPanel('💉', r !== null ? resultRow(state.mode === 'unitsToMl' ? 'Volume to draw up' : 'Total units', fmt(r), state.mode === 'unitsToMl' ? 'mL' : 'units', true) : `<p class="calc-empty">Enter the label concentration and a units or mL value to convert.</p>`,
        'Double-check the concentration against the product label every time — units-based products (e.g. insulin, heparin) vary widely between formulations and are a common source of dosing errors.');
    }
    draw();
  }

  function drawPair(body, unit1, unit2, ph1, ph2, toUnit2, toUnit1, note) {
    const state = { val1: '', val2: '' };
    function draw() {
      body.innerHTML = twoCol(`
        <div class="field"><label>${unit1}</label><input type="number" inputmode="decimal" id="pr_1" value="${state.val1}" placeholder="${ph1}"></div>
        <div class="calc-arrow-divider">⇅</div>
        <div class="field"><label>${unit2}</label><input type="number" inputmode="decimal" id="pr_2" value="${state.val2}" placeholder="${ph2}"></div>
        <button class="calc-reset" id="pr_reset">↺ Reset</button>
      `, `<div id="pr_resultPanel"></div>`);
      body.querySelector('#pr_1').addEventListener('input', e => {
        state.val1 = e.target.value;
        const n = toNum(e.target.value);
        state.val2 = n !== null ? String(Number(toUnit2(n).toFixed(4))) : '';
        body.querySelector('#pr_2').value = state.val2;
        draw2('1');
      });
      body.querySelector('#pr_2').addEventListener('input', e => {
        state.val2 = e.target.value;
        const n = toNum(e.target.value);
        state.val1 = n !== null ? String(Number(toUnit1(n).toFixed(4))) : '';
        body.querySelector('#pr_1').value = state.val1;
        draw2('2');
      });
      body.querySelector('#pr_reset').addEventListener('click', () => { Object.assign(state, { val1: '', val2: '' }); draw(); });
      draw2(null);
    }
    function draw2(lastEdited) {
      const panel = body.querySelector('#pr_resultPanel');
      const has = lastEdited && state.val1 !== '' && state.val2 !== '';
      const bodyHtml = has
        ? resultRow(lastEdited === '1' ? `${state.val1} ${unit1} =` : `${state.val2} ${unit2} =`, lastEdited === '1' ? state.val2 : state.val1, lastEdited === '1' ? unit2 : unit1, true)
        : `<p class="calc-empty">Enter a value in either field to convert.</p>`;
      panel.innerHTML = resultPanel('⇄', bodyHtml, note);
    }
    draw();
  }

  draw();
}

// ── 5. BMI Calculator ────────────────────────────────────────────────────
function renderBMI(el) {
  const state = { unit: 'metric', heightCm: 175, weightKg: 70, heightFt: 5, heightIn: 9, weightLbs: 154 };

  function calc() {
    let heightInMeters, weightInKg;
    if (state.unit === 'metric') { heightInMeters = state.heightCm / 100; weightInKg = state.weightKg; }
    else { const totalInches = state.heightFt * 12 + state.heightIn; heightInMeters = (totalInches * 2.54) / 100; weightInKg = state.weightLbs * 0.45359237; }
    if (heightInMeters <= 0 || weightInKg <= 0) return { bmi: 0, category: 'Invalid Input', cls: '' };
    const bmi = weightInKg / (heightInMeters * heightInMeters);
    let category, cls;
    if (bmi < 18.5) { category = 'Underweight'; cls = 'calc-bmi-under'; }
    else if (bmi < 25) { category = 'Normal weight'; cls = 'calc-bmi-normal'; }
    else if (bmi < 30) { category = 'Overweight'; cls = 'calc-bmi-over'; }
    else { category = 'Obesity'; cls = 'calc-bmi-obese'; }
    return { bmi: parseFloat(bmi.toFixed(1)), category, cls };
  }

  function draw() {
    const r = calc();
    const gaugePercent = Math.min(Math.max((r.bmi - 12) / (40 - 12), 0), 1);
    const needleRotation = gaugePercent * 180 - 90;

    el.innerHTML = `
      <div class="calc-bmi-card">
        <div class="calc-bmi-header">
          <span class="calc-bmi-title">⚖️ BMI Calculator</span>
          ${segControl('bmi_unit', [{ key: 'metric', label: 'Metric' }, { key: 'imperial', label: 'Imperial' }], state.unit)}
        </div>
        <div class="calc-bmi-body">
          <label>Height</label>
          <div id="bmi_heightArea"></div>
          <label>Weight</label>
          <div id="bmi_weightArea"></div>
          <div class="calc-bmi-gauge-card">
            <svg viewBox="0 0 200 110" class="calc-bmi-gauge">
              <defs>
                <linearGradient id="bmiGaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#3B82F6" /><stop offset="35%" stop-color="#10B981" /><stop offset="70%" stop-color="#F59E0B" /><stop offset="100%" stop-color="#EF4444" />
                </linearGradient>
              </defs>
              <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="#E2E8F0" stroke-width="16" stroke-linecap="round" />
              <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#bmiGaugeGrad)" stroke-width="16" stroke-linecap="round" />
              <g transform="translate(100, 100) rotate(${needleRotation})">
                <line x1="0" y1="0" x2="0" y2="-66" stroke="#0F172A" stroke-width="4" stroke-linecap="round" />
                <circle cx="0" cy="0" r="6" fill="#0F172A" />
              </g>
            </svg>
            <div class="calc-bmi-score">${r.bmi}</div>
            <div class="calc-bmi-badge ${r.cls}">✨ ${r.category}</div>
          </div>
        </div>
      </div>
    `;
    drawHeightArea();
    drawWeightArea();
    wireSeg(el, 'bmi_unit', v => toggleUnit(v));
  }

  function toggleUnit(newUnit) {
    if (newUnit === state.unit) return;
    if (newUnit === 'imperial') {
      const totalIn = state.heightCm / 2.54;
      state.heightFt = Math.floor(totalIn / 12);
      state.heightIn = Math.round(totalIn % 12);
      state.weightLbs = Math.round(state.weightKg * 2.20462);
    } else {
      const totalIn = state.heightFt * 12 + state.heightIn;
      state.heightCm = Math.round(totalIn * 2.54);
      state.weightKg = Math.round(state.weightLbs / 2.20462);
    }
    state.unit = newUnit;
    draw();
  }

  function drawHeightArea() {
    const area = el.querySelector('#bmi_heightArea');
    if (state.unit === 'metric') {
      area.innerHTML = `<div class="calc-bmi-bignum"><input type="number" min="50" max="250" id="bmi_hcm" value="${state.heightCm || ''}"><span class="calc-bmi-unit">cm</span></div>`;
      area.querySelector('#bmi_hcm').addEventListener('input', e => { state.heightCm = Math.max(0, parseInt(e.target.value) || 0); drawResultOnly(); });
    } else {
      area.innerHTML = `<div class="calc-inline">
        <div class="calc-bmi-medium"><span class="calc-bmi-medlabel">Feet</span><input type="number" min="1" max="8" id="bmi_hft" value="${state.heightFt || ''}"></div>
        <div class="calc-bmi-medium"><span class="calc-bmi-medlabel">Inches</span><input type="number" min="0" max="11" id="bmi_hin" value="${state.heightIn || ''}"></div>
      </div>`;
      area.querySelector('#bmi_hft').addEventListener('input', e => { state.heightFt = Math.max(0, parseInt(e.target.value) || 0); drawResultOnly(); });
      area.querySelector('#bmi_hin').addEventListener('input', e => { state.heightIn = Math.max(0, parseInt(e.target.value) || 0); drawResultOnly(); });
    }
  }

  function drawWeightArea() {
    const area = el.querySelector('#bmi_weightArea');
    if (state.unit === 'metric') {
      area.innerHTML = `<div class="calc-bmi-bignum"><input type="number" min="10" max="300" id="bmi_wkg" value="${state.weightKg || ''}"><span class="calc-bmi-unit">kg</span></div>`;
      area.querySelector('#bmi_wkg').addEventListener('input', e => { state.weightKg = Math.max(0, parseInt(e.target.value) || 0); drawResultOnly(); });
    } else {
      area.innerHTML = `<div class="calc-bmi-bignum"><input type="number" min="20" max="600" id="bmi_wlb" value="${state.weightLbs || ''}"><span class="calc-bmi-unit">lbs</span></div>`;
      area.querySelector('#bmi_wlb').addEventListener('input', e => { state.weightLbs = Math.max(0, parseInt(e.target.value) || 0); drawResultOnly(); });
    }
  }

  function drawResultOnly() {
    // Redraw only the gauge/score/badge without losing input focus on every keystroke.
    const r = calc();
    const gaugePercent = Math.min(Math.max((r.bmi - 12) / (40 - 12), 0), 1);
    const needleRotation = gaugePercent * 180 - 90;
    const g = el.querySelector('.calc-bmi-gauge g');
    if (g) g.setAttribute('transform', `translate(100, 100) rotate(${needleRotation})`);
    const score = el.querySelector('.calc-bmi-score');
    if (score) score.textContent = r.bmi;
    const badge = el.querySelector('.calc-bmi-badge');
    if (badge) { badge.className = `calc-bmi-badge ${r.cls}`; badge.innerHTML = `✨ ${r.category}`; }
  }

  draw();
}
