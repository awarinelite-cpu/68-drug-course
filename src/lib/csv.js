// Small, dependency-free CSV helpers for the Nursing Catalog upload page.

// Parses CSV text into an array of rows (arrays of strings). Handles a UTF-8
// BOM, quoted fields with commas / line breaks / "" escapes, CRLF or LF line
// endings, and (auto-detected from the first line) comma, semicolon or tab
// separators — Excel in some regions saves "CSV" with semicolons.
export function parseCsv(text) {
  let s = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = s.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const delim = counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';'
    : counts['\t'] > counts[','] ? '\t' : ',';

  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// Turns a list of objects into CSV text (BOM included so Excel opens UTF-8).
export function toCsv(headers, rows) {
  const esc = (v) => {
    const t = String(v ?? '');
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const lines = [headers.map(esc).join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(',')));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function downloadTextFile(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
