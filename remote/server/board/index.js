// 画板: boards drawn by hand in the browser, kept on the NAS (store.js), and read by a model (prompts.js): the page
// 誊清 into type where it was written (还原稿) with a text档, then -- when asked -- a designed page made from that.
// The model takes a minute or more: a request only starts the work; open pages hear `boards` when it is done (and
// may ask /api/board/out meanwhile).
//   GET  /api/boards                 the boards, newest first (each: has a 还原稿 / 设计稿, what the model is doing now)
//   GET  /api/board?id=              one board with its strokes
//   POST /api/boards/save            { id?, title?, doc, base? } -> { ok, id, updated, title, conflict? }
//   POST /api/boards/rename          { id, title }
//   POST /api/boards/delete          { id }
//   POST /api/boards/read            { id, png: "data:image/png;base64,...", note? }   start 誊清 of that picture
//   POST /api/boards/design          { id, note? }                                     start a designed page from the 还原稿
//   GET  /api/board/out?id=          { restore, design, job: { kind, since } | null, error: { kind, msg, at } | null }
//   GET  /api/board/shot?id=         the picture the 还原稿 was made from
'use strict';
const fs = require('fs');
const { createBoardStore } = require('./store');
const { RESTORE_SCHEMA, DESIGN_SCHEMA, restorePrompt, designPrompt, cleanRestore, cleanDesign } = require('./prompts');

const MAX_PNG = 8e6;                              // bytes
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// "data:image/png;base64,..." -> { buf, w, h } (the size from the file's own header), or null
function pngOf(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 33 || buf.length > MAX_PNG || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return w >= 16 && h >= 16 && w <= 8000 && h <= 8000 ? { buf, w, h } : null;
}

// ask(prompt, schema, task, { images }): the AI jobs' one way to a model (ai/ask.js); null = no model here
function createBoards({ dataDir, ask = null, onChange = () => {}, audit = () => {}, log = () => {} }) {
  const store = createBoardStore({ dataDir, onChange });
  const jobs = new Map();                         // id -> { kind: 'restore' | 'design', since }

  const outOf = (id) => { const o = store.out(id); return { restore: o.restore || null, design: o.design || null, error: o.error || null, job: jobs.get(id) || null }; };
  const list = () => store.list().map((e) => { const o = store.out(e.id); return { ...e, restore: o.restore ? o.restore.at : 0, design: o.design ? o.design.at : 0, job: jobs.get(e.id) || null }; });

  // one piece of work for a board at a time; what it gives is kept, what goes wrong is kept as the error
  function start(id, kind, work) {
    if (!ask) return { ok: false, msg: '工作日报没有开启，没有模型可以用' };
    if (jobs.has(id)) return { ok: false, msg: '这块画板还在处理上一次的请求' };
    jobs.set(id, { kind, since: Date.now() });
    onChange();
    work().then((part) => { jobs.delete(id); store.setOut(id, { ...part, error: null }); },
      (e) => { jobs.delete(id); log(`画板：${kind === 'restore' ? '誊清' : '设计'}失败 ${e.message}`); store.setOut(id, { error: { kind, msg: String(e.message).slice(0, 400), at: Date.now() } }); });
    return { ok: true };
  }

  function read(d) {
    const e = store.entry(String(d.id || ''));
    if (!e) return { ok: false, msg: '这块画板已经被删掉了' };
    const png = pngOf(d.png);
    if (!png) return { ok: false, msg: '画板的图片不对（太大或不是 PNG）' };
    const note = String(d.note || '').slice(0, 1000);
    return start(e.id, 'restore', async () => {
      fs.writeFileSync(store.shotFile(e.id), png.buf, { mode: 0o600 });
      const a = await ask(restorePrompt({ w: png.w, h: png.h, note }), RESTORE_SCHEMA, 'board', { images: [store.shotFile(e.id)] });
      const r = cleanRestore(a, png);
      if (!r.items.length && !r.markdown.trim()) throw new Error('模型没有从这一页里认出内容');
      // a new 还原稿: the designed page made from the old one no longer belongs to it
      return { restore: { ...r, at: Date.now(), px: { w: png.w, h: png.h }, note }, design: null };
    });
  }
  function design(d) {
    const e = store.entry(String(d.id || ''));
    if (!e) return { ok: false, msg: '这块画板已经被删掉了' };
    const r = store.out(e.id).restore;
    if (!r) return { ok: false, msg: '先让 AI 誊清这一页，再做设计稿' };
    const note = String(d.note || '').slice(0, 1000);
    return start(e.id, 'design', async () => {
      const images = fs.existsSync(store.shotFile(e.id)) ? [store.shotFile(e.id)] : [];
      const a = cleanDesign(await ask(designPrompt({ r, note }), DESIGN_SCHEMA, 'boardDesign', { images }));
      return { design: { ...a, at: Date.now(), from: r.at, ask: note } };
    });
  }

  // sendPng(res, buf): the server's way to answer with a picture
  async function handle(req, res, url, ip, json, readBody, sendPng) {
    const p = url.pathname, id = String(url.searchParams.get('id') || '');
    if (req.method === 'GET') {
      if (p === '/api/boards') { json(res, 200, { items: list(), ai: !!ask }); return true; }
      if (p === '/api/board') { const b = store.get(id); json(res, b ? 200 : 404, b || { error: 'not found' }); return true; }
      if (p === '/api/board/out') { if (!store.entry(id)) json(res, 404, { error: 'not found' }); else json(res, 200, outOf(id)); return true; }
      if (p === '/api/board/shot') {
        let buf = null; if (store.entry(id)) { try { buf = fs.readFileSync(store.shotFile(id)); } catch {} }
        if (buf) sendPng(res, buf); else json(res, 404, { error: 'not found' });
        return true;
      }
      return false;
    }
    const what = (/^\/api\/boards\/(save|rename|delete|read|design)$/.exec(p) || [])[1];
    if (req.method !== 'POST' || !what) return false;
    let d = null; try { d = JSON.parse(await readBody(req, 40e6)); } catch {}
    if (!d || typeof d !== 'object') { json(res, 400, { ok: false, msg: '内容太大了' }); return true; }
    const r = what === 'save' ? store.save(d) : what === 'rename' ? store.rename(String(d.id || ''), d.title) : what === 'delete' ? store.remove(String(d.id || ''))
      : what === 'read' ? read(d) : design(d);
    if (what === 'delete' && r.ok) jobs.delete(String(d.id));
    if (r.ok && what !== 'save') audit('board-' + what, ip, String(d.id || '').slice(0, 12));
    json(res, 200, r);
    return true;
  }
  return { handle, store, list, read, design, out: outOf };
}

module.exports = { createBoards, pngOf };
