import EntryChart from "../components/EntryChart.jsx";

// 24-hour I&O periods run 6:00 AM to 6:00 AM the following day (standard
// nursing shift convention) rather than midnight to midnight.
const PERIOD_START_HOUR = 6;

// row.time is stored as a naive local "YYYY-MM-DDTHH:MM" string (see the
// time-input default in EntryChart), so `new Date(row.time)` reconstructs
// the same local date/time it was entered as — safe to use directly.
function dateDisplayOf(row) {
  if (!row.time) return '';
  const d = new Date(row.time);
  return isNaN(d) ? row.time.slice(0, 10) : d.toLocaleDateString();
}
function timeDisplayOf(row) {
  if (!row.time) return '';
  const d = new Date(row.time);
  return isNaN(d) ? row.time.slice(11, 16) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// The 6:00 AM start of the 24-hour period that a given Date falls within
// (a time before 6 AM belongs to the period that started the previous day).
function periodStart(d) {
  const p = new Date(d);
  if (p.getHours() < PERIOD_START_HOUR) p.setDate(p.getDate() - 1);
  p.setHours(PERIOD_START_HOUR, 0, 0, 0);
  return p;
}
function periodKeyOf(row) {
  if (!row.time) return '';
  const d = new Date(row.time);
  return isNaN(d) ? '' : periodStart(d).toISOString();
}
function periodRangeLabel(start) {
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const fmt = d => d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return '24-Hour Balance (' + fmt(start) + ' – ' + fmt(end) + ')';
}

// Running balance for each entry, resetting to 0 at the start of each 6 AM–6 AM
// period, in strict time order regardless of whether a row is intake or output.
// Once a period has actually ended, a bold period-summary row is inserted right
// after its last entry — maroon when the period closed in deficit — before the
// next period's entries continue below it, restarting from 0.
//
// For a live chart a period only counts as "ended" once the real-world clock has
// passed its 6 AM cutoff (checked against `now`). For a closed admission (discharged/
// referred/transferred), `closeContext.closedAt` is set — the admission's final
// period is force-closed AT THAT MOMENT instead, since a closed record's last
// period will otherwise never reach its normal 6 AM boundary; that summary row's
// label reflects the actual discharge time rather than the usual next-6-AM mark.
// Rows come in oldest→newest; the summary rows keep that order too.
function deriveIOBalance(ascRows, closeContext) {
  const closedAt = closeContext && closeContext.closedAt instanceof Date && !isNaN(closeContext.closedAt) ? closeContext.closedAt : null;
  const nowKey = periodStart(new Date()).toISOString();
  const out = [];
  let currentKey = null, currentStart = null, running = 0, periodIntake = 0, periodOutput = 0;

  function flushPeriod(isLast) {
    if (currentKey === null) return;
    const closedByClock = currentKey < nowKey;
    const closedByDischarge = isLast && closedAt;
    if (!closedByClock && !closedByDischarge) return;
    const rangeLabel = closedByDischarge
      ? '24-Hour Balance (' + currentStart.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + currentStart.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' – ' + (closeContext.closedAtDisplay || closedAt.toLocaleString()) + ', admission closed)'
      : periodRangeLabel(currentStart);
    out.push({
      isPeriodSummary: true,
      summaryText: rangeLabel + ' — Total Intake: ' + periodIntake + ' ml, Total Output: ' + periodOutput + ' ml, Balance: ' + running + ' ml' + (running < 0 ? ' (deficit)' : ''),
      deficit: running < 0
    });
  }

  ascRows.forEach(row => {
    const key = periodKeyOf(row);
    if (key !== currentKey) {
      flushPeriod(false);
      currentKey = key;
      currentStart = periodStart(new Date(row.time));
      running = 0; periodIntake = 0; periodOutput = 0;
    }
    const intake = parseFloat(row.intakeAmount) || 0;
    const output = parseFloat(row.outputAmount) || 0;
    running += intake - output;
    periodIntake += intake; periodOutput += output;
    out.push({ ...row, balance: running, dateDisplay: dateDisplayOf(row), timeDisplay: timeDisplayOf(row) });
  });
  flushPeriod(true); // the most recent group — closed by clock, by discharge, or (if neither) left open
  return out;
}

// Totals for the current (ongoing) 24-hour period, used by the summary card
// and the auto-saved summary document. For a closed admission this instead
// totals the final period, up through the moment it was closed.
function computeTodayTotals(rawRows, closeContext) {
  const closedAt = closeContext && closeContext.closedAt instanceof Date && !isNaN(closeContext.closedAt) ? closeContext.closedAt : null;
  let targetKey;
  if (closedAt) {
    const closedRows = rawRows.filter(r => r.time);
    targetKey = closedRows.length ? periodKeyOf(closedRows[closedRows.length - 1]) : periodStart(closedAt).toISOString();
  } else {
    targetKey = periodStart(new Date()).toISOString();
  }
  let intake = 0, output = 0;
  rawRows.forEach(row => {
    if (periodKeyOf(row) === targetKey) {
      intake += parseFloat(row.intakeAmount) || 0;
      output += parseFloat(row.outputAmount) || 0;
    }
  });
  return { intake, output, balance: intake - output };
}

const columns = [
  // Single datetime input drives entry (and sorting/day-boundary logic), but
  // the table shows it as separate Date and Time columns — see
  // dateDisplayOf/timeDisplayOf and deriveIOBalance.
  { key: 'time', label: 'Time', type: 'datetime-local', formOnly: true },
  { key: 'dateDisplay', label: 'Date', computed: true },
  { key: 'timeDisplay', label: 'Time', computed: true },
  {
    // Dropdown (not free text) for route of intake, with an "OTHERS" option
    // that reveals a small textarea to specify the custom route. Starts on
    // "SELECT" (placeholder) — this is the on/off switch for the whole
    // intake group: leaving it on SELECT means nothing gets recorded for
    // intake on this entry, even if Nature of Fluid / Intake Vol. were filled in.
    key: 'intakeType', label: 'Route of Intake', type: 'select',
    options: ['Oral', 'NG/PEG', 'OTHERS'], placeholder: 'SELECT',
    otherOption: 'OTHERS', otherPlaceholder: 'Specify the route',
    group: 'intake', groupGate: true,
    groupLabel: 'Intake', groupColor: 'rgba(46, 204, 113, 0.12)'
  },
  {
    // Free text (fluid names vary too much for a fixed dropdown). In the
    // Entries table this shows as a truncated, tappable cell that opens
    // a popup with the full name — same pattern as the Diagnosis field on
    // the Drug Course Chart — so long fluid names don't break the layout.
    key: 'natureOfFluid', label: 'Nature of Fluid', type: 'text', popup: true, group: 'intake'
  },
  { key: 'intakeAmount', label: 'Intake Vol. (ml)', type: 'text', group: 'intake' },
  {
    // Starts on "SELECT" — the on/off switch for the output group: leaving
    // it on SELECT means nothing gets recorded for output on this entry,
    // even if Output Vol. was filled in.
    key: 'outputType', label: 'Type of Output', type: 'select',
    options: ['URINE', 'VOMITING', 'DRAINAGE', 'DRAIN/OTHER'], placeholder: 'SELECT',
    group: 'output', groupGate: true,
    groupLabel: 'Output', groupColor: 'rgba(255, 152, 0, 0.12)'
  },
  { key: 'outputAmount', label: 'Output Vol. (ml)', type: 'text', group: 'output' },
  { key: 'balance', label: 'Balance (ml)', computed: true, abnormal: v => parseFloat(v) < 0, deficitShade: true },
  { key: 'notes', label: 'Notes', type: 'text' }
];

const summary = {
  label: '24-Hour Balance (Today)',
  archivedLabel: 'Balance at Close (Last 24-Hour Period)',
  storeAt: ['intakeOutputSummary', 'current'],
  archivedKey: 'intakeOutputSummary',
  compute: computeTodayTotals
};

export default function IntakeOutput() {
  return (
    <EntryChart
      title="Intake & Output Chart"
      collectionName="intakeOutput"
      columns={columns}
      deriveRows={deriveIOBalance}
      sortOrder="asc"
      summary={summary}
      entryNoun="Entry"
    />
  );
}
