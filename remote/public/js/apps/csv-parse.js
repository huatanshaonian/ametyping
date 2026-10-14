// A CSV / TSV file taken apart into rows of cells (csv-view.js shows them as a table). As Excel and most programs write
// it: a cell in double quotes may hold the separator, line breaks and "" for a quote; the lines end in \n or \r\n; a
// byte order mark at the start is no part of the first cell. The separator is guessed from the first lines when the
// name does not say (a .tsv is tab-separated): the one of , ; tab | that splits them into the same number of cells,
// most of them. No imports: the tests load this file as it is.

// the separator: from the name, or from the first lines
export function guessSep(text, name = '') {
  if (/\.tsv$/i.test(name)) return '\t';
  const head = String(text).replace(/^﻿/, '').slice(0, 64 * 1024);
  let best = ',', score = -1;
  for (const sep of [',', ';', '\t', '|']) {
    const counts = parseCsv(head, sep, 20).slice(0, -1).map((r) => r.length);   // (the last may be cut short)
    if (!counts.length) counts.push(parseCsv(head, sep, 1)[0].length);
    const n = counts[0];
    if (n < 2) continue;
    // (the same number of cells on every line counts for most; then how many)
    const same = counts.filter((c) => c === n).length / counts.length;
    const s = same * 100 + Math.min(n, 50);
    if (s > score) { score = s; best = sep; }
  }
  return best;
}

// -> [[cell, ...], ...]; at most max rows (the rest is not read)
export function parseCsv(text, sep = ',', max = Infinity) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', i = 0, quoted = false;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); rows.push(row); row = []; };
  while (i < s.length && rows.length < max) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { quoted = true; i++; continue; }
    if (c === sep) { endCell(); i++; continue; }
    if (c === '\r' && s[i + 1] === '\n') { endRow(); i += 2; continue; }
    if (c === '\n' || c === '\r') { endRow(); i++; continue; }
    cell += c; i++;
  }
  // (the last line, when the file does not end with a line break)
  if (rows.length < max && (cell !== '' || row.length)) endRow();
  return rows;
}

// whether a column holds numbers (shown right-aligned): every cell that is not empty, from the second row on
export function numericCols(rows) {
  const n = Math.max(0, ...rows.map((r) => r.length)), out = [];
  for (let c = 0; c < n; c++) {
    let any = false, all = true;
    for (let r = 1; r < rows.length && all; r++) {
      const v = (rows[r][c] || '').trim();
      if (!v) continue;
      any = true;
      if (!/^[-+]?(\d{1,3}(,\d{3})+|\d*)(\.\d+)?([eE][-+]?\d+)?%?$/.test(v) || !/\d/.test(v)) all = false;
    }
    out.push(any && all);
  }
  return out;
}
