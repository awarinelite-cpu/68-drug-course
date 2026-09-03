import { useEffect, useMemo, useRef, useState } from "react";
import { collection, query, where, getDocs } from "firebase/firestore";
import Chart from "chart.js/auto";
import { db } from "../../firebase.js";
import { useGoBack } from "../../hooks/useGoBack.js";
import {
  WARDS, DEMOGRAPHIC_FIELDS, STAT_FIELDS, OCC_INCREASE_KEYS, OCC_DECREASE_KEYS,
  reportDateId, weekId
} from "../../lib/nurses-report-common.js";
import Topbar from "../../components/Topbar.jsx";

// The five clinical figures shown on this page (a deliberate subset of
// STAT_FIELDS — the ones relevant to trend analysis, not every column on
// the Overall Statistics table). The original app tracked Adm/Death/BID/
// C-S/Del, but this app's STAT_FIELDS doesn't carry the obstetric C/S and
// Del columns (see the open STAT_FIELDS-parity item), so S/C and VS/C
// stand in as the other two non-movement figures worth trending.
const CLINICAL_KEYS = ['adm', 'death', 'bid', 'sc', 'vsc'];
const CLINICAL_FIELDS = CLINICAL_KEYS
  .map(k => STAT_FIELDS.find(f => f.key === k))
  .filter(Boolean);

// Every Overall Statistics column that actually moves the Occ count, in
// both directions — sourced from OCC_INCREASE_KEYS/OCC_DECREASE_KEYS (the
// same classification the Overall Statistics table itself uses, see
// occDelta() in nurses-report-common.js) so this can't drift out of sync
// with what the ward/overall reports actually count as an addition or a
// reduction.
const MOVEMENT_KEYS = OCC_INCREASE_KEYS.concat(OCC_DECREASE_KEYS);
const MOVEMENT_FIELDS = STAT_FIELDS
  .filter(f => MOVEMENT_KEYS.includes(f.key))
  .map(f => ({ key: f.key, label: f.label, direction: OCC_INCREASE_KEYS.includes(f.key) ? 'increase' : 'decrease' }));

// CLINICAL_FIELDS entries that aren't already movement columns (bid, sc,
// vsc) — shown but left out of the Total Additions/Reductions/Net Change
// math below, since none of them move Occ.
const NEUTRAL_FIELDS = CLINICAL_FIELDS
  .filter(f => !MOVEMENT_KEYS.includes(f.key))
  .map(f => ({ key: f.key, label: f.label, direction: 'neutral' }));
const MOVEMENT_GRID_FIELDS = MOVEMENT_FIELDS.concat(NEUTRAL_FIELDS);

// CLINICAL_FIELDS and MOVEMENT_FIELDS can share keys (adm, death), so the
// combined field list is deduped by key before summing/blanking.
const ALL_NUMERIC_FIELDS = (() => {
  const seen = new Set();
  const out = [];
  CLINICAL_FIELDS.concat(MOVEMENT_FIELDS, DEMOGRAPHIC_FIELDS).forEach(f => {
    if (seen.has(f.key)) return;
    seen.add(f.key);
    out.push(f);
  });
  return out;
})();

function pad(n) { return String(n).padStart(2, '0'); }

function daysInMonth(y, m) { // m is 1-based
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDaysId(dateId, days) {
  const [y, m, d] = dateId.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
}

// Standard ISO-8601 week-number algorithm (Thursday-anchored) — used only
// to cap the week picker's max attribute at the current ISO week.
function isoWeekNumber(d) {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Monday=0..Sunday=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  return 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
}

// period is one of 'today'/'week'/'month'/'year'. selection is whatever
// that period's picker last produced — null until the user has picked
// something, in which case this falls back to "today/this week/this
// month/this year". startId/endId span the FULL chosen period (all 7 days
// of the picked week, the whole picked month, Jan 1–Dec 31 of the picked
// year) rather than always ending at today. endId is still capped at
// todayId, since no ward can have filed a report for a date that hasn't
// happened yet.
function computeRange(period, selection) {
  const todayId = reportDateId();
  let startId, endId;

  if (period === 'today') {
    startId = endId = selection || todayId;
  } else if (period === 'week') {
    let monday;
    if (selection) {
      const jan4 = new Date(Date.UTC(selection.isoYear, 0, 4));
      const ref = new Date(jan4);
      ref.setUTCDate(jan4.getUTCDate() + (selection.isoWeek - 1) * 7);
      monday = weekId(ref);
    } else {
      monday = weekId();
    }
    startId = monday;
    endId = addDaysId(monday, 6);
  } else if (period === 'month') {
    const [ty, tm] = todayId.split('-').map(Number);
    const y = selection ? selection.year : ty;
    const m = selection ? selection.month : tm;
    startId = y + '-' + pad(m) + '-01';
    endId = y + '-' + pad(m) + '-' + pad(daysInMonth(y, m));
  } else { // year
    const y = selection || Number(todayId.split('-')[0]);
    startId = y + '-01-01';
    endId = y + '-12-31';
  }

  if (endId > todayId) endId = todayId;
  if (startId > endId) startId = endId; // guard against an all-future selection
  return { startId, endId, todayId };
}

function fmtDate(dateId) {
  const [y, m, d] = dateId.split('-');
  return d + '/' + m + '/' + y;
}

function blankTotals() {
  const t = {};
  ALL_NUMERIC_FIELDS.forEach(f => { t[f.key] = 0; });
  return t;
}

function blankPerWardTotals() {
  const t = {};
  WARDS.forEach(w => { t[w.key] = blankTotals(); });
  return t;
}

function sumWardsMap(wardsMap, into) {
  WARDS.forEach(w => {
    const data = (wardsMap && wardsMap[w.key]) || {};
    ALL_NUMERIC_FIELDS.forEach(f => { into[f.key] += typeof data[f.key] === 'number' ? data[f.key] : 0; });
  });
}

function sumWardsMapPerWard(wardsMap, into) {
  WARDS.forEach(w => {
    const data = (wardsMap && wardsMap[w.key]) || {};
    ALL_NUMERIC_FIELDS.forEach(f => { into[w.key][f.key] += typeof data[f.key] === 'number' ? data[f.key] : 0; });
  });
}

// Pulls every archived "overall" day within [startId, endId], sums them,
// then — since a day isn't archived until the Overall Nurse saves it —
// separately reads today's live ward docs and adds them in if today falls
// in range and wasn't already covered by an archive.
async function loadTotals(period, selection) {
  const { startId, endId, todayId } = computeRange(period, selection);
  const totals = blankTotals();
  const perWard = blankPerWardTotals();
  let daysCovered = 0;

  const archiveSnap = await getDocs(query(collection(db, 'archives'), where('type', '==', 'overall')));
  let todayArchived = false;
  archiveSnap.forEach(docSnap => {
    const data = docSnap.data();
    if (!data.dateId || data.dateId < startId || data.dateId > endId) return;
    sumWardsMap(data.wards, totals);
    sumWardsMapPerWard(data.wards, perWard);
    daysCovered += 1;
    if (data.dateId === todayId) todayArchived = true;
  });

  if (todayId >= startId && todayId <= endId && !todayArchived) {
    const wardsSnap = await getDocs(collection(db, 'nurseReports', todayId, 'wards'));
    const liveWardsMap = {};
    wardsSnap.forEach(d => { liveWardsMap[d.id] = d.data(); });
    if (Object.keys(liveWardsMap).length) {
      sumWardsMap(liveWardsMap, totals);
      sumWardsMapPerWard(liveWardsMap, perWard);
      daysCovered += 1;
    }
  }

  return { totals, perWard, startId, endId, daysCovered };
}

function openPicker(input) {
  if (!input) return;
  try {
    if (typeof input.showPicker === 'function') { input.showPicker(); return; }
  } catch (e) { /* fall through to the click fallback */ }
  input.focus();
  input.click();
}

export default function Analytics() {
  const goBack = useGoBack('/nurses-report/role-select');

  const [activePeriod, setActivePeriod] = useState('today');
  const [phase, setPhase] = useState('loading'); // 'loading' | 'summary' | 'empty' | 'error'
  const [errorText, setErrorText] = useState('');
  const [rangeLabel, setRangeLabel] = useState('');
  const [totals, setTotals] = useState(null);
  const [perWard, setPerWard] = useState(null);
  const [breakdownField, setBreakdownField] = useState('adm');

  const periodSelectionRef = useRef({ today: null, week: null, month: null, year: null });
  const loadTokenRef = useRef(0);

  const dayPickerRef = useRef(null);
  const weekPickerRef = useRef(null);
  const monthPickerRef = useRef(null);
  const yearPickerRef = useRef(null);

  const barCanvasRef = useRef(null);
  const movementCanvasRef = useRef(null);
  const sexPieCanvasRef = useRef(null);
  const affiliationPieCanvasRef = useRef(null);
  const wardBreakdownCanvasRef = useRef(null);

  const barChartRef = useRef(null);
  const movementChartRef = useRef(null);
  const sexPieRef = useRef(null);
  const affiliationPieRef = useRef(null);
  const wardBreakdownChartRef = useRef(null);

  const [yearOptions] = useState(() => {
    const ty = Number(reportDateId().split('-')[0]);
    const years = [];
    for (let y = ty; y >= ty - 5; y--) years.push(y);
    return years;
  });

  // Cap every picker at "now" — no ward has ever filed a report for a
  // date that hasn't happened yet.
  useEffect(() => {
    const todayIdForCaps = reportDateId();
    if (dayPickerRef.current) dayPickerRef.current.max = todayIdForCaps;
    if (monthPickerRef.current) monthPickerRef.current.max = todayIdForCaps.slice(0, 7);
    if (weekPickerRef.current) {
      const nowMonday = weekId();
      const [wy, wm, wd] = nowMonday.split('-').map(Number);
      weekPickerRef.current.max = wy + '-W' + pad(isoWeekNumber(new Date(Date.UTC(wy, wm - 1, wd))));
    }
  }, []);

  async function loadAndRender(period) {
    setActivePeriod(period);
    const myToken = ++loadTokenRef.current;
    setPhase('loading');

    let result;
    try {
      result = await loadTotals(period, periodSelectionRef.current[period]);
    } catch (e) {
      if (myToken !== loadTokenRef.current) return;
      setErrorText("Couldn't load: " + (e.code || e.message || 'unknown error'));
      setPhase('error');
      return;
    }
    if (myToken !== loadTokenRef.current) return; // a newer period was picked while this was loading

    const { totals: t, perWard: pw, startId, endId, daysCovered } = result;
    setRangeLabel(
      (startId === endId ? fmtDate(startId) : fmtDate(startId) + ' \u2013 ' + fmtDate(endId)) +
      (daysCovered ? ' \u00b7 ' + daysCovered + ' day' + (daysCovered === 1 ? '' : 's') + ' of reports' : '')
    );

    if (daysCovered === 0) {
      setTotals(null);
      setPerWard(null);
      setPhase('empty');
      return;
    }

    setTotals(t);
    setPerWard(pw);
    setPhase('summary');
  }

  useEffect(() => { loadAndRender('today'); }, []);

  // Destroy every chart instance on unmount.
  useEffect(() => {
    return () => {
      [barChartRef, movementChartRef, sexPieRef, affiliationPieRef, wardBreakdownChartRef].forEach(r => {
        if (r.current) r.current.destroy();
      });
    };
  }, []);

  // Bar / movement / pie charts — redraw whenever totals change.
  useEffect(() => {
    if (!totals) return;

    if (barChartRef.current) barChartRef.current.destroy();
    barChartRef.current = new Chart(barCanvasRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels: CLINICAL_FIELDS.map(f => f.label),
        datasets: [{
          data: CLINICAL_FIELDS.map(f => totals[f.key]),
          backgroundColor: ['#2563eb', '#dc2626', '#d97706', '#7c3aed', '#0891b2']
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });

    if (movementChartRef.current) movementChartRef.current.destroy();
    movementChartRef.current = new Chart(movementCanvasRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels: MOVEMENT_FIELDS.map(f => f.label),
        datasets: [{
          data: MOVEMENT_FIELDS.map(f => totals[f.key]),
          backgroundColor: MOVEMENT_FIELDS.map(f => f.direction === 'increase' ? '#16a34a' : '#dc2626')
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });

    if (sexPieRef.current) sexPieRef.current.destroy();
    sexPieRef.current = new Chart(sexPieCanvasRef.current.getContext('2d'), {
      type: 'pie',
      data: {
        labels: ['Male', 'Female', 'Children'],
        datasets: [{ data: [totals.male, totals.female, totals.child], backgroundColor: ['#2563eb', '#db2777', '#f59e0b'] }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } }
    });

    if (affiliationPieRef.current) affiliationPieRef.current.destroy();
    affiliationPieRef.current = new Chart(affiliationPieCanvasRef.current.getContext('2d'), {
      type: 'pie',
      data: {
        labels: ['Soldiers', 'Civilians'],
        datasets: [{ data: [totals.soldier, totals.civilian], backgroundColor: ['#16a34a', '#6b7280'] }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } }
    });
  }, [totals]);

  // Ward Breakdown chart — redraw whenever perWard or the chosen field
  // changes. Ranked descending so the leading ward reads first.
  const breakdownLeaderText = useMemo(() => {
    if (!perWard) return '';
    const field = MOVEMENT_GRID_FIELDS.find(f => f.key === breakdownField) || MOVEMENT_GRID_FIELDS[0];
    const ranked = WARDS
      .map(w => ({ label: w.label, count: perWard[w.key][field.key] || 0 }))
      .sort((a, b) => b.count - a.count);
    if (ranked[0] && ranked[0].count > 0) {
      const tiedLeaders = ranked.filter(r => r.count === ranked[0].count);
      return tiedLeaders.length > 1
        ? tiedLeaders.map(r => r.label).join(', ') + ' tied for the most ' + field.label + ' (' + ranked[0].count + ' each)'
        : ranked[0].label + ' led with ' + ranked[0].count + ' ' + field.label;
    }
    return 'No ' + field.label + ' recorded by any ward this period.';
  }, [perWard, breakdownField]);

  useEffect(() => {
    if (!perWard || !wardBreakdownCanvasRef.current) return;
    const field = MOVEMENT_GRID_FIELDS.find(f => f.key === breakdownField) || MOVEMENT_GRID_FIELDS[0];
    const ranked = WARDS
      .map(w => ({ label: w.label, count: perWard[w.key][field.key] || 0 }))
      .sort((a, b) => b.count - a.count);
    const color = field.direction === 'increase' ? '#16a34a' : field.direction === 'decrease' ? '#dc2626' : '#2563eb';

    if (wardBreakdownChartRef.current) wardBreakdownChartRef.current.destroy();
    wardBreakdownChartRef.current = new Chart(wardBreakdownCanvasRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels: ranked.map(r => r.label),
        datasets: [{ data: ranked.map(r => r.count), backgroundColor: color }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
  }, [perWard, breakdownField]);

  const additions = totals ? MOVEMENT_FIELDS.filter(f => f.direction === 'increase').reduce((s, f) => s + totals[f.key], 0) : 0;
  const reductions = totals ? MOVEMENT_FIELDS.filter(f => f.direction === 'decrease').reduce((s, f) => s + totals[f.key], 0) : 0;
  const net = additions - reductions;

  return (
    <>
      <Topbar brand="Analytics">
        <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={goBack}>Back</button>
      </Topbar>

      <div className="container">
        <div className="card-box">
          <h1 style={{ margin: 0, fontSize: 18 }}>Hospital Statistics</h1>
          <div className="period-row">
            <span className="picker-anchor">
              <button
                className={'period-btn' + (activePeriod === 'today' ? ' active' : '')}
                onClick={() => openPicker(dayPickerRef.current)}
              >
                Today
              </button>
              <input
                type="date" ref={dayPickerRef} className="hidden-picker" aria-hidden="true" tabIndex={-1}
                onChange={e => {
                  if (!e.target.value) return;
                  periodSelectionRef.current.today = e.target.value;
                  loadAndRender('today');
                }}
              />
            </span>
            <span className="picker-anchor">
              <button
                className={'period-btn' + (activePeriod === 'week' ? ' active' : '')}
                onClick={() => openPicker(weekPickerRef.current)}
              >
                This Week
              </button>
              <input
                type="week" ref={weekPickerRef} className="hidden-picker" aria-hidden="true" tabIndex={-1}
                onChange={e => {
                  if (!e.target.value) return;
                  const [yStr, wStr] = e.target.value.split('-W');
                  periodSelectionRef.current.week = { isoYear: Number(yStr), isoWeek: Number(wStr) };
                  loadAndRender('week');
                }}
              />
            </span>
            <span className="picker-anchor">
              <button
                className={'period-btn' + (activePeriod === 'month' ? ' active' : '')}
                onClick={() => openPicker(monthPickerRef.current)}
              >
                This Month
              </button>
              <input
                type="month" ref={monthPickerRef} className="hidden-picker" aria-hidden="true" tabIndex={-1}
                onChange={e => {
                  if (!e.target.value) return;
                  const [yStr, mStr] = e.target.value.split('-');
                  periodSelectionRef.current.month = { year: Number(yStr), month: Number(mStr) };
                  loadAndRender('month');
                }}
              />
            </span>
            <span className="picker-anchor">
              <button
                className={'period-btn' + (activePeriod === 'year' ? ' active' : '')}
                onClick={() => openPicker(yearPickerRef.current)}
              >
                This Year
              </button>
              <select
                ref={yearPickerRef} className="hidden-picker" aria-hidden="true" tabIndex={-1}
                defaultValue={yearOptions[0]}
                onChange={e => {
                  periodSelectionRef.current.year = Number(e.target.value);
                  loadAndRender('year');
                }}
              >
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </span>
          </div>
          <div className="range-label">{rangeLabel}</div>
          {phase === 'loading' && <div className="loading-note">Loading…</div>}
          {phase === 'error' && <div className="loading-note">{errorText}</div>}
        </div>


        {phase === 'summary' && totals && (
          <>
            <div className="card-box">
              <h2>Patient Movement (Additions / Reductions)</h2>
              <div className="stat-grid">
                <div className="stat-box"><div className="n" style={{ color: '#16a34a' }}>{additions}</div><div className="l">Total Additions</div></div>
                <div className="stat-box"><div className="n" style={{ color: '#dc2626' }}>{reductions}</div><div className="l">Total Reductions</div></div>
                <div className="stat-box"><div className="n" style={{ color: net >= 0 ? '#16a34a' : '#dc2626' }}>{net > 0 ? '+' : ''}{net}</div><div className="l">Net Change</div></div>
              </div>
              <div className="stat-grid" style={{ marginTop: 6 }}>
                {MOVEMENT_GRID_FIELDS.map(f => {
                  const color = f.direction === 'increase' ? '#16a34a' : f.direction === 'decrease' ? '#dc2626' : '#374151';
                  return (
                    <div className="stat-box" key={f.key}>
                      <div className="n" style={{ color }}>{totals[f.key]}</div>
                      <div className="l">{f.label}</div>
                    </div>
                  );
                })}
              </div>
              <h3>Patient Demographics</h3>
              <div className="stat-grid">
                {DEMOGRAPHIC_FIELDS.map(f => (
                  <div className="stat-box demo" key={f.key}>
                    <div className="n">{totals[f.key]}</div>
                    <div className="l">{f.label}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card-box">
              <h2>Ward Breakdown</h2>
              <div className="range-label" style={{ marginTop: 0 }}>Which ward led in a given column, for the selected period.</div>
              <select
                value={breakdownField}
                onChange={e => setBreakdownField(e.target.value)}
                style={{ marginTop: 10, width: '100%', padding: '10px 8px', borderRadius: 8, border: '2px solid #e5e7eb', fontWeight: 'bold', fontSize: 13, color: '#374151' }}
              >
                {MOVEMENT_GRID_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
              <div className="range-label" style={{ marginTop: 8, fontWeight: 'bold', color: '#111827' }}>{breakdownLeaderText}</div>
              <div className="chart-wrap" id="wardBreakdownWrap"><canvas ref={wardBreakdownCanvasRef}></canvas></div>
            </div>

            <div className="card-box">
              <h2>Admission, Death, BID, S/C, VS/C</h2>
              <div className="chart-wrap"><canvas ref={barCanvasRef}></canvas></div>

              <h3>Patient Movement — what added or reduced the count</h3>
              <div className="chart-wrap"><canvas ref={movementCanvasRef}></canvas></div>

              <div className="pie-grid">
                <div>
                  <h3>Male / Female / Children</h3>
                  <div className="chart-wrap" style={{ height: 220 }}><canvas ref={sexPieCanvasRef}></canvas></div>
                </div>
                <div>
                  <h3>Soldiers / Civilians</h3>
                  <div className="chart-wrap" style={{ height: 220 }}><canvas ref={affiliationPieCanvasRef}></canvas></div>
                </div>
              </div>
            </div>
          </>
        )}

        {phase === 'empty' && (
          <div className="card-box">
            <div className="empty-note">No archived or live reports found for this period.</div>
          </div>
        )}
      </div>
    </>
  );
}
