// 文献 › 证据表: what the papers say, field by field, under one schema (server: /api/lit/evidence*, /api/lit/contradictions*,
// /api/lit/matrix). Three views over the same schema:
//   证据表      one row a paper, one column a schema field: value + unit + p.N + ✓ (quote found in the PDF) / ⚠ (not found);
//               a click on a cell shows the quote, the way to that page of the PDF, and 改值 → 保存并标为人审确认
//   矛盾与边界  the clustered claims that disagree (矛盾) or only differ in their conditions (边界差异); 确认有价值 / 误报忽略
//   范式矩阵    papers counted by two fields (row × column); the empty combinations are the gaps
// The CSS file is not part of this tab: the few things the shared literature.css classes do not cover are inline styles.
import { h } from '../util.js';
import { get, post } from './lit-api.js';
import { pdfPageUrl } from './lit-split.js';

const VIEWS = [['table', '证据表'], ['conflict', '矛盾与边界'], ['matrix', '范式矩阵']];
const VERDICT = { contradiction: '矛盾', conflict: '矛盾', boundary: '边界差异', condition: '边界差异', consistent: '一致', agree: '一致', '矛盾': '矛盾', '边界差异': '边界差异', '一致': '一致' };
const VERDICT_COLOR = { '矛盾': 'var(--bad)', '边界差异': 'var(--warn)', '一致': 'var(--ok-text)' };
const STATUS = [['', '全部状态'], ['pending', '待判断'], ['confirmed', '有价值'], ['dismissed', '已忽略']];
const STATUS_TEXT = { pending: '待判断', confirmed: '有价值', dismissed: '已忽略' };
const DEF_ROW = 'flow_chem_model', DEF_COL = 'em_method';
const SCHEMA_KEY = 'lit.evidence.schema';

// the little styles: a grid table on white, its cells, the panel under it
const S = {
  scroll: 'flex:1;min-height:0;overflow:auto;background:var(--body);',
  table: 'border-collapse:collapse;font-size:12px;background:var(--surface);',
  th: 'position:sticky;top:0;z-index:1;padding:3px 6px;border:1px solid var(--edge);background:var(--tint);color:var(--border);font-weight:bold;text-align:left;white-space:nowrap;',
  thFirst: 'position:sticky;top:0;left:0;z-index:2;padding:3px 6px;border:1px solid var(--edge);background:var(--tint);color:var(--border);font-weight:bold;text-align:left;min-width:220px;',
  td: 'padding:3px 6px;border:1px solid var(--edge);vertical-align:top;max-width:220px;',
  tdFirst: 'position:sticky;left:0;padding:3px 6px;border:1px solid var(--edge);vertical-align:top;background:var(--surface);min-width:220px;max-width:320px;',
  panel: 'flex:none;max-height:45%;overflow:auto;padding:8px 12px;border-top:2px solid var(--border);background:var(--surface);font-size:12.5px;line-height:1.6;',
  quote: 'margin:4px 0;padding:4px 8px;background:var(--tint);border-left:3px solid var(--border);white-space:pre-wrap;color:var(--ink);',
  card: 'margin:0 0 10px;padding:8px 10px;border:1px solid var(--edge);border-left:4px solid var(--border);background:var(--surface);line-height:1.55;font-size:12.5px;',
};
const pct = (x) => (x == null || isNaN(x) ? '' : Math.round(+x * 100) + '%');
const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function mount(el, ctx) {
  const schemaSel = h('select', { class: 'field', title: '证据 Schema（领域字段集合）' });
  schemaSel.style.flex = '0 0 auto';
  const segs = VIEWS.map(([id, text]) => h('button', { class: 'lit-tab lf-seg', type: 'button', text, dataset: { view: id }, onclick: () => pick(id) }));
  const refreshBtn = h('button', { class: 'btn', type: 'button', text: '刷新', onclick: async () => { await loadSchemas(); pick(view); } });
  const st = h('span', { class: 'lit-st' });
  const box = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;' });
  el.append(h('div', { class: 'lit-sub' }, schemaSel, h('span', { class: 'lf-segs' }, ...segs), refreshBtn, st), box);

  let schemas = [], view = 'table', cur = null;    // cur: the mounted view { el, refresh }
  const schema = () => schemas.find((s) => s.id === schemaSel.value) || null;
  const views = {};

  async function loadSchemas() {
    const r = await get('/api/lit/evidence/schemas');
    schemas = (r && r.schemas) || [];
    let want = schemaSel.value; try { want = want || localStorage.getItem(SCHEMA_KEY) || ''; } catch {}
    schemaSel.replaceChildren(...schemas.map((s) => h('option', { value: s.id, text: s.name || s.id, title: s.description || '' })));
    if (schemas.some((s) => s.id === want)) schemaSel.value = want;
    return schemas.length > 0;
  }
  function pick(id) {
    view = id;
    for (const b of segs) b.classList.toggle('on', b.dataset.view === id);
    if (!views[id]) views[id] = (id === 'table' ? tableView : id === 'conflict' ? conflictView : matrixView)(ctx, schema, (t) => { st.textContent = t; });
    box.replaceChildren(views[id].el);
    cur = views[id];
    if (schemas.length) cur.refresh(); else box.replaceChildren(h('p', { class: 'lit-empty', text: '读不到证据 Schema（/api/lit/evidence/schemas）。服务端的证据模块还没开启，或者还没有定义任何领域字段。' }));
  }
  schemaSel.addEventListener('change', () => {
    try { localStorage.setItem(SCHEMA_KEY, schemaSel.value); } catch {}
    for (const v of Object.values(views)) if (v.reset) v.reset();
    pick(view);
  });
  let first = true;
  return {
    async refresh() { if (first) { first = false; await loadSchemas(); pick(view); } else if (cur && schemas.length) cur.refresh(); },
    onLit: (w) => { if (/^(evidence|contradictions|matrix)/.test(w) && cur) cur.refresh(); },
  };
}
export const render = mount;      // (the name the task contract used; literature.js calls mount)

// ── 证据表 ────────────────────────────────────────────────────────────────────────────────────────────────
function tableView(ctx, schema, say) {
  const q = h('input', { class: 'field', type: 'search', placeholder: '在证据里找：题目、citekey、字段值、原文' });
  const only = h('input', { type: 'checkbox' });
  const scroll = h('div', { style: S.scroll });
  const panel = h('div', { style: S.panel, hidden: true });
  const el = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;' },
    h('div', { class: 'lit-sub lp-bar' }, q, h('label', { style: 'font-size:12px;white-space:nowrap;' }, only, ' 仅看已核验')), scroll, panel);
  let items = [], stats = null, sel = null;     // sel: { key, field }

  async function refresh() {
    const s = schema(); if (!s) return;
    scroll.replaceChildren(h('p', { class: 'lit-empty', text: '读取证据…' }));
    const r = await get(`/api/lit/evidence?schema=${encodeURIComponent(s.id)}&onlyVerified=${only.checked ? 1 : 0}`);
    if (!r || !r.ok) { scroll.replaceChildren(h('p', { class: 'lit-empty bad', text: (r && (r.msg || r.error)) || '读不到证据表。' })); say(''); return; }
    items = r.items || []; stats = r.stats || null;
    draw();
    if (sel) showCell(sel.key, sel.field);
  }
  function fieldsOf() { const s = schema(); return (s && s.fields) || []; }
  function hay(it) {
    const f = it.fields || {};
    return [it.title, it.citekey, it.year, ...Object.values(f).map((c) => c && [c.value, c.unit, c.quote].map(str).join(' '))].join(' ').toLowerCase();
  }
  function draw() {
    const terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = terms.length ? items.filter((it) => { const t = hay(it); return terms.every((w) => t.includes(w)); }) : items;
    const fs = fieldsOf();
    const sum = stats ? Object.entries(stats).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k} ${typeof v === 'number' && v > 0 && v < 1 ? pct(v) : v}`).join(' · ') : '';
    say(`${hit.length === items.length ? items.length : hit.length + ' / ' + items.length} 篇${sum ? ' · ' + sum : ''}`);
    if (!hit.length) { scroll.replaceChildren(h('p', { class: 'lit-empty', text: items.length ? '没有符合的论文。' : '这个 Schema 下还没有抽取出证据。' })); return; }
    const head = h('tr', {}, h('th', { style: S.thFirst, text: '论文' }), h('th', { style: S.th, text: '核验率' }),
      ...fs.map((f) => h('th', { style: S.th, text: f.label || f.key, title: [f.key, f.hint].filter(Boolean).join('：') })));
    const rows = hit.map((it) => h('tr', {},
      h('td', { style: S.tdFirst },
        h('div', { style: 'font-weight:bold;color:var(--ink);', text: it.title || it.zoteroKey }),
        h('div', { style: 'color:var(--muted);font-size:11px;display:flex;gap:4px;align-items:center;flex-wrap:wrap;' },
          h('span', { text: [it.year, it.citekey].filter(Boolean).join(' · ') }),
          it.humanVerified ? h('i', { class: 'tag c', text: '已人审' }) : null)),
      h('td', { style: S.td + 'white-space:nowrap;color:' + ((+it.verifiedRatio || 0) >= 0.8 ? 'var(--ok-text)' : (+it.verifiedRatio || 0) >= 0.5 ? 'var(--warn)' : 'var(--bad)') + ';', text: pct(it.verifiedRatio) }),
      ...fs.map((f) => cell(it, f))));
    scroll.replaceChildren(h('table', { style: S.table }, h('thead', {}, head), h('tbody', {}, ...rows)));
  }
  function cell(it, f) {
    const c = (it.fields || {})[f.key];
    const has = c && c.value != null && c.value !== '';
    const on = sel && sel.key === it.zoteroKey && sel.field === f.key;
    const td = h('td', { style: S.td + (has ? 'cursor:pointer;' : 'color:var(--muted);') + (on ? 'outline:2px solid var(--border);outline-offset:-2px;' : ''), title: has ? (c.quote ? '点开看原文' : '没有原文引用') : '' });
    if (!has) { td.textContent = '—'; return td; }
    td.append(h('span', { style: 'color:var(--ink);', text: str(c.value) + (c.unit ? ' ' + c.unit : '') }),
      c.page ? h('span', { style: 'color:var(--muted);font-size:11px;', text: ' p.' + c.page }) : null,
      h('span', { style: 'margin-left:3px;color:' + (c.verified ? 'var(--ok-text)' : 'var(--warn)') + ';', text: c.verified ? '✓' : '⚠', title: c.verified ? '原文在 PDF 里核对到了' : '原文没核对上（可能是模型编的，要人看）' }));
    td.addEventListener('click', () => showCell(it.zoteroKey, f.key));
    return td;
  }
  function showCell(key, field) {
    const it = items.find((x) => x.zoteroKey === key), f = fieldsOf().find((x) => x.key === field);
    const c = it && (it.fields || {})[field];
    if (!it || !f || !c) { sel = null; panel.hidden = true; return; }
    sel = { key, field }; draw();
    const val = h('input', { class: 'field', value: str(c.value), style: 'flex:1 1 200px;min-width:0;' });
    const unit = h('input', { class: 'field', value: c.unit || '', placeholder: '单位', style: 'flex:0 0 90px;' });
    const msg = h('span', { class: 'lit-st' });
    const save = h('button', { class: 'btn go', type: 'button', text: '保存并标为人审确认', onclick: async () => {
      save.disabled = true; msg.textContent = '保存中…'; msg.classList.remove('bad');
      const fields = { [field]: { ...c, value: val.value.trim(), unit: unit.value.trim(), verified: true } };
      const r = await post('/api/lit/evidence/verify', { key, schemaId: schema().id, fields });
      save.disabled = false;
      if (!r || !r.ok) { msg.textContent = (r && (r.msg || r.error)) || '没保存上'; msg.classList.add('bad'); return; }
      const i = items.findIndex((x) => x.zoteroKey === key);
      if (i >= 0) items[i] = r.item ? { ...items[i], ...r.item } : { ...items[i], humanVerified: true, fields: { ...items[i].fields, ...fields } };
      showCell(key, field); panel.querySelector('.lit-st').textContent = '已保存，标为人审确认。';
    } });
    const page = +c.page || 0;
    panel.replaceChildren(
      h('div', { style: 'display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;' },
        h('b', { style: 'color:var(--border);', text: (f.label || f.key) + '：' }),
        h('span', { style: 'color:var(--ink);', text: it.title || key }),
        h('span', { class: 'lit-sp' }),
        h('button', { class: 'btn', type: 'button', text: '关闭', onclick: () => { sel = null; panel.hidden = true; draw(); } })),
      f.hint ? h('div', { class: 'lf-m', text: f.hint }) : null,
      h('div', { class: 'lf-m', text: (c.verified ? '✓ 原文在 PDF 里核对到了' : '⚠ 原文没核对上，请对照 PDF') + (it.humanVerified ? ' · 已人审' : '') }),
      c.quote ? h('div', { style: S.quote, text: c.quote }) : h('p', { class: 'lit-empty', text: '没有原文引用。' }),
      h('div', { class: 'gbtns', style: 'display:flex;gap:6px;flex-wrap:wrap;margin:4px 0;' },
        h('a', { class: 'btn', href: pdfPageUrl(key, page), target: '_blank', rel: 'noopener', text: page ? `打开 PDF 第 ${page} 页` : '打开 PDF' }),
        ctx.openReader ? h('button', { class: 'btn', type: 'button', text: page ? `深读窗口第 ${page} 页` : '深读窗口', onclick: () => ctx.openReader(key, page || undefined) }) : null,
        ctx.openItem ? h('button', { class: 'btn', type: 'button', text: '文献库里看这篇', onclick: () => ctx.openItem(key) }) : null),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;' }, val, unit, save, msg));
    panel.hidden = false;
  }
  let t = null;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(draw, 150); });
  only.addEventListener('change', refresh);
  return { el, refresh, reset() { sel = null; panel.hidden = true; } };
}

// ── 矛盾与边界 ────────────────────────────────────────────────────────────────────────────────────────────
function conflictView(ctx, schema, say) {
  const status = h('select', { class: 'field' }, ...STATUS.map(([value, text]) => h('option', { value, text })));
  status.style.flex = '0 0 auto';
  const runMsg = h('span', { class: 'lit-st' });
  const run = h('button', { class: 'btn go', type: 'button', text: '运行聚类矛盾分析', title: '把这个 Schema 下的论断按主题聚类，找出互相矛盾或只是条件不同的结论', onclick: async () => {
    const s = schema(); if (!s) return;
    run.disabled = true; runMsg.classList.remove('bad'); runMsg.textContent = '正在分析…（可能要一两分钟）';
    const r = await post('/api/lit/contradictions/run', { schemaId: s.id });
    run.disabled = false;
    if (!r || !r.ok) { runMsg.textContent = (r && (r.msg || r.error)) || '分析没跑成'; runMsg.classList.add('bad'); return; }
    runMsg.textContent = `分析了 ${r.analyzed ?? '?'} 组，找出 ${(r.items || []).length} 条。`;
    if (Array.isArray(r.items)) { items = r.items; draw(); } else refresh();
  } });
  const list = h('div', { class: 'lf-list' });
  const el = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;' }, h('div', { class: 'lit-sub' }, run, status, runMsg), list);
  let items = [];

  async function refresh() {
    const s = schema(); if (!s) return;
    const r = await get('/api/lit/contradictions?schema=' + encodeURIComponent(s.id));
    if (!r || !r.ok) { list.replaceChildren(h('p', { class: 'lit-empty bad', text: (r && (r.msg || r.error)) || '读不到矛盾清单。' })); say(''); return; }
    items = r.items || [];
    draw();
  }
  function draw() {
    const want = status.value;
    const hit = want ? items.filter((x) => (x.status || 'pending') === want) : items;
    const n = (v) => items.filter((x) => VERDICT[x.verdict] === v).length;
    say(`${items.length} 条 · 矛盾 ${n('矛盾')} · 边界差异 ${n('边界差异')} · 一致 ${n('一致')}`);
    list.replaceChildren(...(hit.length ? hit.map(card) : [h('p', { class: 'lit-empty', text: items.length ? '这个状态下没有。' : '还没有分析结果。点「运行聚类矛盾分析」。' })]));
  }
  function card(x) {
    const v = VERDICT[x.verdict] || x.verdict || '未定';
    const color = VERDICT_COLOR[v] || 'var(--border)';
    const stat = x.status || 'pending';
    const set = async (s) => {
      const r = await post('/api/lit/contradictions/status', { id: x.id, status: s });
      if (r && r.ok) { x.status = s; draw(); } else runMsg.textContent = (r && (r.msg || r.error)) || '状态没改成';
    };
    return h('div', { style: S.card + 'border-left-color:' + color + ';' + (stat === 'dismissed' ? 'opacity:.6;' : '') },
      h('div', { class: 'lf-h' },
        h('i', { class: 'tag', style: 'color:' + color + ' !important;border-color:' + color + ';', text: v }),
        h('b', { style: 'color:var(--ink);', text: x.topic || '(无主题)' }),
        h('i', { class: 'tag' + (stat === 'confirmed' ? ' c' : ''), text: STATUS_TEXT[stat] || stat }),
        x.updated ? h('span', { class: 'lf-m', text: x.updated }) : null),
      x.summary ? h('div', { class: 'lf-one', text: x.summary }) : null,
      diffTable(x.paramDiff),
      Array.isArray(x.claimIds) && x.claimIds.length ? h('div', { class: 'lf-m', text: `涉及 ${x.claimIds.length} 条论断：${x.claimIds.slice(0, 8).join('、')}${x.claimIds.length > 8 ? ' …' : ''}` }) : null,
      h('div', { style: 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;' },
        h('button', { class: 'btn go', type: 'button', text: '确认有价值', disabled: stat === 'confirmed', onclick: () => set('confirmed') }),
        h('button', { class: 'btn no', type: 'button', text: '误报忽略', disabled: stat === 'dismissed', onclick: () => set('dismissed') }),
        stat !== 'pending' ? h('button', { class: 'btn', type: 'button', text: '退回待判断', onclick: () => set('pending') }) : null));
  }
  status.addEventListener('change', draw);
  return { el, refresh, reset() { runMsg.textContent = ''; } };
}

// paramDiff in whichever shape it comes: [{param, a, b, ...}] rows, { param: { paperA: v, paperB: v } }, { param: [v, v] }
function diffTable(d) {
  if (!d || (typeof d === 'object' && !Object.keys(d).length)) return null;
  if (typeof d !== 'object') return h('div', { class: 'lf-m', text: '参数差异：' + d });
  let cols, rows;
  if (Array.isArray(d)) {
    if (!d.length) return null;
    if (d.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      cols = [...new Set(d.flatMap((r) => Object.keys(r)))];
      rows = d.map((r) => cols.map((c) => str(r[c])));
    } else { cols = ['参数差异']; rows = d.map((r) => [str(r)]); }
  } else {
    const inner = [...new Set(Object.values(d).flatMap((v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [])))];
    const maxLen = Math.max(0, ...Object.values(d).map((v) => (Array.isArray(v) ? v.length : 0)));
    const sub = inner.length ? inner : maxLen ? Array.from({ length: maxLen }, (_, i) => '论断 ' + (i + 1)) : ['值'];
    cols = ['参数', ...sub];
    rows = Object.entries(d).map(([k, v]) => [k, ...(inner.length && v && typeof v === 'object' && !Array.isArray(v) ? inner.map((c) => str(v[c])) : Array.isArray(v) ? sub.map((_, i) => str(v[i])) : [str(v)])]);
  }
  return h('div', { style: 'overflow-x:auto;margin:4px 0;' }, h('table', { style: S.table },
    h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', { style: S.th + 'position:static;', text: c })))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c, i) => h('td', { style: S.td + (i === 0 ? 'font-weight:bold;color:var(--border);' : ''), text: c })))))));
}

// ── 范式矩阵 ──────────────────────────────────────────────────────────────────────────────────────────────
function matrixView(ctx, schema, say) {
  const rowSel = h('select', { class: 'field', title: '行字段' }), colSel = h('select', { class: 'field', title: '列字段' });
  rowSel.style.flex = colSel.style.flex = '0 0 auto';
  const scroll = h('div', { style: S.scroll + 'padding:8px 12px;' });
  const panel = h('div', { style: S.panel, hidden: true });
  const el = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;' },
    h('div', { class: 'lit-sub' }, h('span', { class: 'lit-st', text: '行' }), rowSel, h('span', { class: 'lit-st', text: '× 列' }), colSel,
      h('button', { class: 'btn', type: 'button', text: '对调', onclick: () => { const r = rowSel.value; rowSel.value = colSel.value; colSel.value = r; refresh(); } })),
    scroll, panel);
  let schemaId = null, data = null, selCell = null;

  function fillSelects() {
    const s = schema(); if (!s || s.id === schemaId) return;
    schemaId = s.id;
    const fs = s.fields || [];
    const opts = () => fs.map((f) => h('option', { value: f.key, text: f.label || f.key }));
    rowSel.replaceChildren(...opts()); colSel.replaceChildren(...opts());
    const has = (k) => fs.some((f) => f.key === k);
    rowSel.value = has(DEF_ROW) ? DEF_ROW : (fs[0] || {}).key || '';
    colSel.value = has(DEF_COL) ? DEF_COL : (fs[1] || fs[0] || {}).key || '';
  }
  async function refresh() {
    const s = schema(); if (!s) return;
    fillSelects();
    if (!rowSel.value || !colSel.value) { scroll.replaceChildren(h('p', { class: 'lit-empty', text: '这个 Schema 没有可用的字段。' })); return; }
    scroll.replaceChildren(h('p', { class: 'lit-empty', text: '统计中…' }));
    const r = await get(`/api/lit/matrix?schema=${encodeURIComponent(s.id)}&row=${encodeURIComponent(rowSel.value)}&col=${encodeURIComponent(colSel.value)}`);
    if (!r || !r.ok) { scroll.replaceChildren(h('p', { class: 'lit-empty bad', text: (r && (r.msg || r.error)) || '读不到矩阵。' })); say(''); return; }
    data = r; draw();
  }
  const label = (x) => (x && typeof x === 'object' ? x.label || x.value || x.key || x.id || '' : str(x));
  const ident = (x) => (x && typeof x === 'object' ? x.value ?? x.key ?? x.id ?? x.label : x);
  // cells as [{row, col, count, papers}] or { [row]: { [col]: n | papers[] | { count, papers } } }
  function cellAt(r, c) {
    const cs = data.cells;
    let v = null;
    if (Array.isArray(cs)) v = cs.find((x) => x && String(ident(x.row)) === String(r) && String(ident(x.col)) === String(c)) || null;
    else if (cs && typeof cs === 'object') v = (cs[r] || {})[c] ?? null;
    if (v == null) return { count: 0, papers: [] };
    if (typeof v === 'number') return { count: v, papers: [] };
    if (Array.isArray(v)) return { count: v.length, papers: v };
    const papers = v.papers || v.items || v.keys || [];
    return { count: v.count ?? papers.length, papers };
  }
  function draw() {
    const rows = data.rows || [], cols = data.cols || [];
    const gaps = data.gaps || [];
    const filled = rows.reduce((n, r) => n + cols.filter((c) => cellAt(ident(r), ident(c)).count > 0).length, 0);
    say(`${data.totalPapers ?? '?'} 篇 · ${rows.length} × ${cols.length} 格 · 有论文 ${filled} 格 · 空白 ${rows.length * cols.length - filled} 格`);
    if (!rows.length || !cols.length) { scroll.replaceChildren(h('p', { class: 'lit-empty', text: '这两个字段下还没有论文有值。' })); return; }
    const max = Math.max(1, ...rows.flatMap((r) => cols.map((c) => cellAt(ident(r), ident(c)).count)));
    const fname = (k) => { const f = ((schema() || {}).fields || []).find((x) => x.key === k); return f ? f.label || f.key : k; };
    const table = h('table', { style: S.table },
      h('thead', {}, h('tr', {}, h('th', { style: S.thFirst + 'min-width:140px;', text: `${fname(data.rowField || rowSel.value)} \\ ${fname(data.colField || colSel.value)}` }),
        ...cols.map((c) => h('th', { style: S.th, text: label(c) })))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', { style: S.tdFirst + 'min-width:140px;font-weight:bold;color:var(--border);', text: label(r) }),
        ...cols.map((c) => {
          const x = cellAt(ident(r), ident(c));
          const on = selCell && selCell[0] === String(ident(r)) && selCell[1] === String(ident(c));
          if (!x.count) return h('td', { style: S.td + 'text-align:center;color:var(--muted);background:var(--tint);', text: '0', title: '空白：还没有论文用这个组合' });
          const a = 0.15 + 0.6 * (x.count / max);
          return h('td', { style: S.td + `text-align:center;cursor:pointer;font-weight:bold;color:${a > 0.5 ? 'var(--on-fill)' : 'var(--ink)'};background:color-mix(in srgb, var(--fill) ${Math.round(a * 100)}%, var(--surface));` + (on ? 'outline:2px solid var(--border);outline-offset:-2px;' : ''),
            text: String(x.count), title: '点开看这几篇', onclick: () => showCell(r, c, x) });
        }))))));
    const gapBox = gaps.length ? h('div', { style: 'margin-top:10px;font-size:12.5px;' },
      h('b', { style: 'color:var(--border);', text: `空白组合（${gaps.length}）：` }),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;' }, ...gaps.map((g) => h('i', { class: 'tag', style: 'font-size:11.5px;', text: gapText(g) })))) : null;
    scroll.replaceChildren(table, gapBox);
  }
  function gapText(g) {
    if (g == null) return '';
    if (Array.isArray(g)) return g.map(label).join(' × ');
    if (typeof g === 'object') return g.label || [label(g.row), label(g.col)].filter(Boolean).join(' × ') + (g.reason ? '（' + g.reason + '）' : '');
    return String(g);
  }
  function showCell(r, c, x) {
    selCell = [String(ident(r)), String(ident(c))]; draw();
    const paper = (p) => {
      const key = typeof p === 'string' ? p : p.zoteroKey || p.key;
      const title = typeof p === 'string' ? p : p.title || key;
      const meta = typeof p === 'object' ? [p.year, p.citekey].filter(Boolean).join(' · ') : '';
      return h('div', { class: 'lb-i', style: 'cursor:pointer;padding:3px 0;', title: '文献库里看这篇', onclick: () => key && ctx.openItem && ctx.openItem(key) },
        h('span', { style: 'color:var(--ink);', text: title }), meta ? h('span', { class: 'lf-m', text: '  ' + meta }) : null);
    };
    panel.replaceChildren(
      h('div', { style: 'display:flex;align-items:baseline;gap:6px;' },
        h('b', { style: 'color:var(--border);', text: `${label(r)} × ${label(c)}：${x.count} 篇` }), h('span', { class: 'lit-sp' }),
        h('button', { class: 'btn', type: 'button', text: '关闭', onclick: () => { selCell = null; panel.hidden = true; draw(); } })),
      ...(x.papers.length ? x.papers.map(paper) : [h('p', { class: 'lit-empty', text: '服务端没有给出这一格的论文列表。' })]));
    panel.hidden = false;
  }
  rowSel.addEventListener('change', () => { selCell = null; panel.hidden = true; refresh(); });
  colSel.addEventListener('change', () => { selCell = null; panel.hidden = true; refresh(); });
  return { el, refresh, reset() { schemaId = null; selCell = null; panel.hidden = true; } };
}
