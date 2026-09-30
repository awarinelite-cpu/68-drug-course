// Parole / D/Parole name tables for the A Ward report. Read-only: patients
// get onto these lists from the Patient page's Status control (Parole /
// D/Parole), and the ward report just displays them. Each entry is
// { id, name, emr, age, sex, since } where `since` is the millisecond
// timestamp the tag was set (0 when unknown). The counts of these two lists
// feed the Parole / D/Parole columns of the ward and overall statistics
// tables — they are never added to the ward's total.

// YYYY-MM-DD -> DD/MM/YY; falls back to `ms` (tag time) for the start date
// on entries tagged before dates were recorded.
function fmtDate(iso, ms) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (m) return m[3] + '/' + m[2] + '/' + m[1].slice(2);
  return ms ? fmtSince(ms) : '\u2014';
}

function fmtSince(ms) {
  if (!ms) return '\u2014';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '\u2014';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function ParoleTable({ title, rows }) {
  const list = Array.isArray(rows) ? rows : [];
  return (
    <div className="parole-block">
      <h3 className="parole-heading">{title} <span className="parole-count">({list.length})</span></h3>
      <div className="table-wrap">
        <table className="shift parole-table">
          <thead>
            <tr><th>S/N</th><th>Name</th><th>EMR</th><th>Age</th><th>Sex</th><th>Commenced</th><th>Return Date</th></tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: '#9ca3af' }}>No patients</td></tr>
            ) : list.map((p, i) => (
              <tr key={p.id || i}>
                <td>{i + 1}</td>
                <td style={{ textAlign: 'left' }}>{p.name || '\u2014'}</td>
                <td>{p.emr || '\u2014'}</td>
                <td>{p.age || '\u2014'}</td>
                <td>{p.sex || '\u2014'}</td>
                <td>{fmtDate(p.startDate, p.since)}</td>
                <td>{fmtDate(p.returnDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// A table only appears while it has at least one patient.
export function hasAny(list) { return Array.isArray(list) && list.length > 0; }

export default function ParoleTables({ paroleList, dParoleList }) {
  return (
    <>
      {hasAny(paroleList) && <ParoleTable title="Parole" rows={paroleList} />}
      {hasAny(dParoleList) && <ParoleTable title="D/Parole" rows={dParoleList} />}
    </>
  );
}
