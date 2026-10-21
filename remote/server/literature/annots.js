// 批注 on a paper's PDF -- highlights, underlines, notes on the page -- made in the 深读 PDF and kept in Zotero itself:
// annotation items under the PDF attachment, through the local API, exactly as Zotero's reader makes them. So Zotero
// (and its other devices) shows them, and the cards read them (mirror.annotationsOf -> the card prompts); the ones
// made in Zotero are shown in the 深读 PDF the same way.
//   GET  /api/lit/annots?key=     { canWrite, items: [{ id, type, color, text, comment, pageIndex, pageLabel, rects | paths, width }] }
//   POST /api/lit/annots/add      { key, type: highlight | underline | note, color, text, comment, pageIndex, pageLabel, rects, top, offset }
//                                 (rects in PDF points, as Zotero keeps them; top: from the page's top, offset: of the
//                                 text in the page -- Zotero's order)
//   POST /api/lit/annots/update   { key, id, comment?, color?, type? (highlight <-> underline) }
//   POST /api/lit/annots/delete   { key, id }
// The copy of the library (mirror.js) catches up within a minute or at once (a refresh after each change); till then the
// changes made here are laid over it.
'use strict';

const KEY = /^[A-Z0-9]{8}$/;
// Zotero's palette (its reader offers these)
const COLORS = new Set(['#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5', '#e56eee', '#f19837', '#aaaaaa']);
const MADE = new Set(['highlight', 'underline', 'note']);
const NOTE = 22;                                                 // a note's square on the page (points), as Zotero's

const num = (x) => (Number.isFinite(+x) ? Math.round(+x * 1000) / 1000 : NaN);
function cleanRects(rects) {
  if (!Array.isArray(rects) || !rects.length || rects.length > 300) return null;
  const out = [];
  for (const r of rects) {
    if (!Array.isArray(r) || r.length !== 4) return null;
    const v = r.map(num);
    if (v.some((x) => !Number.isFinite(x) || Math.abs(x) > 1e5)) return null;
    out.push([Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])]);
  }
  return out;
}
// Zotero's order of the annotations: page | where the text starts in the page | distance from the page's top
const pad = (n, w, max) => String(Math.max(0, Math.min(max, Math.floor(+n || 0)))).padStart(w, '0');
const sortIndex = (pageIndex, offset, top) => `${pad(pageIndex, 5, 99999)}|${pad(offset, 6, 999999)}|${pad(top, 5, 99999)}`;

// a Zotero annotation (the mirror's, or one just written) as the PDF draws it
function out(a) {
  let pos = a.position;
  if (typeof pos === 'string') { try { pos = JSON.parse(pos); } catch { pos = null; } }
  pos = pos || {};
  const o = { id: a.key, type: a.type, color: a.color || '#ffd400', text: a.text || '', comment: a.comment || '', pageIndex: +pos.pageIndex || 0, pageLabel: a.page || '' };
  if (Array.isArray(pos.rects)) o.rects = pos.rects;
  if (Array.isArray(pos.paths)) { o.paths = pos.paths; o.width = +pos.width || 1; }
  return o;
}

function createAnnots({ api, mirror, log = () => {}, onChange = () => {}, now = () => Date.now() }) {
  // the stored PDF the 深读 window shows (fulltext.pdfBytes reads the same one)
  const attOf = (key) => { const a = mirror.pdfOf(key); return a && (a.linkMode === 'imported_file' || a.linkMode === 'imported_url') ? a : null; };
  // changes made here that the copy of the library may not have yet: id -> { key, a (null: deleted), at }
  const recent = new Map();
  const need = { ok: false, need: 'authorize', msg: '还没有 Zotero 写入授权（控制面板 › 文献 里授权一次）' };
  const fail = (e) => (e && e.need === 'authorize' ? { ...need, msg: e.message } : { ok: false, msg: (e && e.message) || String(e) });
  const touched = (key, id, a) => {
    recent.set(id, { key, a, at: now() });
    mirror.refresh(true).catch(() => {});
    onChange(key);
  };

  function list(key) {
    const att = attOf(key);
    if (!att) return { canWrite: api.canWrite(), items: [] };
    const have = new Map(mirror.annotationsOf(key).filter((a) => a.attachment === att.key).map((a) => [a.key, a]));
    for (const [id, r] of recent) {
      if (r.key !== key) continue;
      const m = have.get(id);
      // caught up: the copy has it (as changed here), or no longer has a deleted one -- or it is long past
      const same = r.a ? m && m.comment === r.a.comment && m.color === r.a.color && m.type === r.a.type : !m;
      if (same || now() - r.at > 10 * 60e3) { recent.delete(id); continue; }
      if (r.a) have.set(id, r.a); else have.delete(id);
    }
    const items = [...have.values()].map(out).sort((x, y) => x.pageIndex - y.pageIndex || String(x.id).localeCompare(String(y.id)));
    return { canWrite: api.canWrite(), items };
  }

  async function add(d) {
    const key = String(d.key || ''), att = attOf(key);
    if (!att) return { ok: false, msg: '这篇没有存在 Zotero 里的 PDF' };
    if (!api.canWrite()) return need;
    const type = MADE.has(d.type) ? d.type : 'highlight';
    const color = COLORS.has(d.color) ? d.color : '#ffd400';
    const pageIndex = Math.floor(+d.pageIndex);
    if (!(pageIndex >= 0 && pageIndex < 10000)) return { ok: false, msg: '页码不对' };
    let rects = cleanRects(d.rects);
    if (!rects) return { ok: false, msg: '位置不对' };
    if (type === 'note') rects = [[rects[0][0], rects[0][1], rects[0][0] + NOTE, rects[0][1] + NOTE]];
    const text = type === 'note' ? '' : String(d.text || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
    if (type !== 'note' && !text) return { ok: false, msg: '没有选中文字' };
    const comment = String(d.comment || '').slice(0, 10000);
    const position = { pageIndex, rects };
    const item = { itemType: 'annotation', parentItem: att.key, annotationType: type, annotationText: text, annotationComment: comment, annotationColor: color,
      annotationPageLabel: String(d.pageLabel || pageIndex + 1).slice(0, 20), annotationSortIndex: sortIndex(pageIndex, d.offset, d.top), annotationPosition: JSON.stringify(position), tags: [] };
    let id;
    try { [id] = await api.createItems([item]); } catch (e) { return fail(e); }
    if (!id) return { ok: false, msg: 'Zotero 没收下这条批注' };
    const a = { key: id, type, color, text, comment, page: item.annotationPageLabel, position, attachment: att.key };
    touched(key, id, a);
    log(`文献：在 Zotero 里加了一条${type === 'note' ? '便签' : type === 'underline' ? '下划线' : '高亮'}（${key} 第 ${item.annotationPageLabel} 页）`);
    return { ok: true, item: out(a) };
  }

  // the annotation as Zotero has it now (its version, to change it), if it is one on this paper's PDF
  async function current(key, id) {
    const att = attOf(key);
    if (!att || !KEY.test(id)) return null;
    let r; try { r = await api.get(`items/${id}?format=json`); } catch (e) { if (e.status === 404) return null; throw e; }
    const d = (r.data && r.data.data) || r.data;
    return d && d.itemType === 'annotation' && d.parentItem === att.key ? d : null;
  }

  async function update(d) {
    const key = String(d.key || ''), id = String(d.id || '');
    if (!api.canWrite()) return need;
    try {
      const z = await current(key, id);
      if (!z) return { ok: false, msg: '找不到这条批注（也许在 Zotero 里删掉了）' };
      const f = {};
      if (d.comment != null) f.annotationComment = String(d.comment).slice(0, 10000);
      if (d.color != null) { if (!COLORS.has(d.color)) return { ok: false, msg: '颜色不对' }; f.annotationColor = d.color; }
      if (d.type != null) {
        if (!/^(highlight|underline)$/.test(d.type) || !/^(highlight|underline)$/.test(z.annotationType)) return { ok: false, msg: '这条批注不能改成这种' };
        f.annotationType = d.type;
      }
      if (!Object.keys(f).length) return { ok: true };
      await api.patchItem(id, z.version, f);
      const a = { key: id, type: f.annotationType || z.annotationType, color: f.annotationColor || z.annotationColor, text: z.annotationText || '', comment: f.annotationComment != null ? f.annotationComment : z.annotationComment || '',
        page: z.annotationPageLabel || '', position: z.annotationPosition, attachment: z.parentItem };
      touched(key, id, a);
      return { ok: true, item: out(a) };
    } catch (e) { return fail(e); }
  }

  async function remove(d) {
    const key = String(d.key || ''), id = String(d.id || '');
    if (!api.canWrite()) return need;
    try {
      const z = await current(key, id);
      if (!z) { touched(key, id, null); return { ok: true }; }       // (gone already)
      await api.write('DELETE', `items/${id}`, null, { 'If-Unmodified-Since-Version': String(z.version) });
      touched(key, id, null);
      log(`文献：在 Zotero 里删了一条批注（${key} 第 ${z.annotationPageLabel || '?'} 页）`);
      return { ok: true };
    } catch (e) { return fail(e); }
  }

  async function handle(req, res, url, json, readBody) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/lit/annots') {
      const k = String(url.searchParams.get('key') || '');
      json(res, KEY.test(k) ? 200 : 404, KEY.test(k) ? list(k) : { error: 'not found' });
      return true;
    }
    const m = /^\/api\/lit\/annots\/(add|update|delete)$/.exec(p);
    if (req.method !== 'POST' || !m) return false;
    let d = {}; try { d = JSON.parse(await readBody(req, 2e6)); } catch {}
    if (!KEY.test(String(d.key || ''))) { json(res, 200, { ok: false, msg: '找不到这篇' }); return true; }
    json(res, 200, m[1] === 'add' ? await add(d) : m[1] === 'update' ? await update(d) : await remove(d));
    return true;
  }

  return { list, add, update, remove, handle };
}

module.exports = { createAnnots, sortIndex, cleanRects };
