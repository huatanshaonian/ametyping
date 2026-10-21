// An Excel workbook in the viewer (viewer.js): .xlsx .xlsm .xlsb, the old binary .xls, and .ods, read with
// vendor/xlsx (SheetJS, loaded the first time one is opened). Each sheet a tab along the bottom as in Excel; a sheet as
// a table with the column letters and row numbers staying in sight, values as Excel formats them (dates, percentages,
// thousands separators), numbers right-aligned, merged cells merged, hidden rows and columns left out, column widths
// as the file gives them. Long sheets a page of rows at a time. Only text is put into the page (never the file's own
// HTML); charts, pictures, colours and conditional formats are not drawn.
import { h } from '../util.js';

const PAGE = 1000;                 // rows shown at a time
const MAX_ROWS = 50000;            // rows read per sheet (a larger sheet: the first ones, said so)
const MAX_COLS = 300;              // columns shown

let loading = null;
function load() {
  if (window.XLSX && window.XLSX.read) return Promise.resolve(window.XLSX);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/xlsx/xlsx.full.min.js';
      s.onload = () => resolve(window.XLSX); s.onerror = () => reject(new Error('加载表格组件失败'));
      document.head.append(s);
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

// one sheet -> { el, rows, cols, cut } (rows / cols: how many are shown in all; cut: rows beyond MAX_ROWS left out)
function sheetTable(X, ws) {
  const data = ws['!data'] || [];
  const ref = ws['!ref'] ? X.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
  const full = ws['!fullref'] ? X.utils.decode_range(ws['!fullref']) : ref;
  const hiddenCol = (c) => !!(ws['!cols'] && ws['!cols'][c] && ws['!cols'][c].hidden);
  const hiddenRow = (r) => !!(ws['!rows'] && ws['!rows'][r] && ws['!rows'][r].hidden);
  const cols = [];
  for (let c = ref.s.c; c <= ref.e.c && cols.length < MAX_COLS; c++) if (!hiddenCol(c)) cols.push(c);
  const rows = [];
  for (let r = ref.s.r; r <= ref.e.r; r++) if (!hiddenRow(r)) rows.push(r);
  // merged cells: the top-left one spans, the others are left out
  const span = new Map(), covered = new Set();
  for (const m of ws['!merges'] || []) {
    const rs = rows.filter((r) => r >= m.s.r && r <= m.e.r).length, cs = cols.filter((c) => c >= m.s.c && c <= m.e.c).length;
    if (!rs || !cs) continue;
    span.set(m.s.r + ',' + m.s.c, { rs, cs });
    for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(r + ',' + c);
  }
  const text = (cell) => {
    if (!cell) return '';
    if (cell.t === 'e') return cell.w || '#错误';
    let s = '';
    try { s = X.utils.format_cell(cell); } catch { s = cell.v == null ? '' : String(cell.v); }
    return s || (cell.f ? '=' + cell.f : '');
  };
  const width = (c) => { const k = ws['!cols'] && ws['!cols'][c]; return k ? (k.wpx || (k.wch ? k.wch * 7 + 10 : 0)) : 0; };
  const thead = h('thead', {}, h('tr', {}, h('th', { class: 'rn', text: '' }),
    ...cols.map((c) => { const w = width(c); return h('th', { class: 'cl', text: X.utils.encode_col(c), style: w ? `min-width:${Math.min(w, 320)}px` : '' }); })));
  const tbody = h('tbody');
  const more = h('button', { class: 'btn', type: 'button' });
  const foot = h('div', { class: 'csvmore' }, more);
  let shown = 0;
  function page() {
    const to = Math.min(rows.length, shown + PAGE);
    const frag = document.createDocumentFragment();
    for (let i = shown; i < to; i++) {
      const r = rows[i], line = data[r] || [];
      const tr = h('tr', {}, h('td', { class: 'rn', text: String(r + 1) }));
      for (const c of cols) {
        const key = r + ',' + c;
        if (covered.has(key)) continue;
        const cell = line[c], v = text(cell), sp = span.get(key);
        const td = h('td', { class: cell && (cell.t === 'n' || cell.t === 'd') ? 'num' : '', text: v, title: v.length > 24 ? v : '' });
        if (sp) { if (sp.rs > 1) td.rowSpan = sp.rs; if (sp.cs > 1) td.colSpan = sp.cs; td.classList.add('mg'); }
        tr.append(td);
      }
      frag.append(tr);
    }
    tbody.append(frag);
    shown = to;
    const left = rows.length - shown;
    foot.hidden = left <= 0;
    more.textContent = `再显示 ${Math.min(PAGE, left)} 行（还有 ${left} 行）`;
  }
  more.addEventListener('click', page);
  page();
  const el = h('div', { class: 'csvwrap' }, h('table', { class: 'csv xls' }, thead, tbody), foot);
  return { el, rows: rows.length, cols: cols.length, cut: full.e.r > ref.e.r ? full.e.r - ref.e.r : 0, moreCols: ref.e.c - ref.s.c + 1 > MAX_COLS };
}

// -> { el (the sheet shown, its tabs under it), sheets, info() -- what the bar says about the sheet shown }
export async function renderWorkbook(buf) {
  const X = await load();
  const wb = X.read(new Uint8Array(buf), { type: 'array', dense: true, cellDates: true, sheetRows: MAX_ROWS, cellHTML: false, cellStyles: true });
  const meta = (wb.Workbook && wb.Workbook.Sheets) || [];
  const names = wb.SheetNames.filter((n, i) => !(meta[i] && meta[i].Hidden === 2));     // ("very hidden": not even Excel lists them)
  const body = h('div', { class: 'xls-body' });
  const tabs = h('div', { class: 'xls-tabs' });
  const el = h('div', { class: 'xls-wrap' }, body, tabs);
  const made = new Map();
  let cur = null;
  const onInfo = [];
  function pick(name) {
    if (!made.has(name)) made.set(name, sheetTable(X, wb.Sheets[name]));
    cur = made.get(name);
    body.replaceChildren(cur.el); body.scrollTop = 0; body.scrollLeft = 0;
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.name === name);
    for (const f of onInfo) f();
  }
  names.forEach((n) => {
    const i = wb.SheetNames.indexOf(n), hidden = !!(meta[i] && meta[i].Hidden);
    const b = h('button', { type: 'button', class: 'xls-tab' + (hidden ? ' hid' : ''), text: n, title: hidden ? '隐藏的工作表' : n });
    b.dataset.name = n;
    b.addEventListener('click', () => pick(n));
    tabs.append(b);
  });
  if (!names.length) { body.replaceChildren(h('div', { class: 'notice', text: '这个工作簿里没有能显示的工作表。' })); return { el, sheets: 0, info: () => '', onInfo }; }
  const first = names.find((n) => { const i = wb.SheetNames.indexOf(n); return !(meta[i] && meta[i].Hidden); }) || names[0];
  pick(first);
  const info = () => !cur ? '' : `${cur.rows} 行 × ${cur.cols} 列${cur.cut ? `（只读了前 ${MAX_ROWS} 行）` : ''}${cur.moreCols ? `（只显示前 ${MAX_COLS} 列）` : ''}${names.length > 1 ? ` · ${names.length} 个工作表` : ''}`;
  return { el, sheets: names.length, info, onInfo };
}
