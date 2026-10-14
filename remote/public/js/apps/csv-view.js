// A CSV / TSV file in the viewer as a table (viewer.js): the first row as the column heads, staying in sight while the
// rest scrolls, the rows numbered as a spreadsheet numbers them, numbers right-aligned. A long file is shown a page of
// rows at a time (「再显示 N 行」); a long cell is cut to the column's width, the whole of it on hover.
import { h } from '../util.js';
import { guessSep, parseCsv, numericCols } from './csv-parse.js';

const PAGE = 1000;
const SEPS = { ',': '逗号', ';': '分号', '\t': 'Tab', '|': '竖线' };

// -> { el, rows: how many, cols: how many, sep: what separates the cells (said in words) }
export function csvTable(text, name) {
  const sep = guessSep(text, name);
  const rows = parseCsv(text, sep);
  const ncol = Math.max(0, ...rows.map((r) => r.length));
  const num = numericCols(rows);
  const cell = (tag, v, c) => h(tag, { class: num[c] ? 'num' : '', text: v, title: v.length > 24 ? v : '' });
  const head = rows[0] || [];
  const thead = h('thead', {}, h('tr', {}, h('th', { class: 'rn', text: '' }), ...Array.from({ length: ncol }, (_, c) => cell('th', head[c] || '', c))));
  const tbody = h('tbody');
  const more = h('button', { class: 'btn', type: 'button' });
  const foot = h('div', { class: 'csvmore' }, more);
  let shown = 1;
  function page() {
    const to = Math.min(rows.length, shown + PAGE);
    const frag = document.createDocumentFragment();
    for (let r = shown; r < to; r++) frag.append(h('tr', {}, h('td', { class: 'rn', text: String(r) }), ...Array.from({ length: ncol }, (_, c) => cell('td', rows[r][c] || '', c))));
    tbody.append(frag);
    shown = to;
    const left = rows.length - shown;
    foot.hidden = left <= 0;
    more.textContent = `再显示 ${Math.min(PAGE, left)} 行（还有 ${left} 行）`;
  }
  more.addEventListener('click', page);
  page();
  const el = h('div', { class: 'csvwrap' }, h('table', { class: 'csv' }, thead, tbody), foot);
  return { el, rows: Math.max(0, rows.length - 1), cols: ncol, sep: SEPS[sep] || sep };
}
