// 笔记: what the user writes beside a paper in 深读 -- typed (Markdown, LaTeX) or by hand (画板's strokes, kept to be
// edited again, and the picture of them) -- each with the page it was written at and the passage selected then. A note
// written by hand can be read into type by the model (认字, the litVision job), and any note can be put into 重要计划
// (a todo that remembers the paper and the page). The notes go into the knowledge base beside the card, so Obsidian
// shows them too, and into the cards' prompts (with the user's annotations from Zotero).
//   <dataDir>/literature/notes/<item key>.json        { items: [{ id, text, ocr, ink, img, w, h, page, sel, todo, at, updated }] }
//   <dataDir>/literature/notes/<item key>/<id>.png    the picture of a note written by hand
//   <kbDir>/notes/<citekey>.md, notes/<citekey>/<id>.png
// Web API (the reader's 笔记 column):
//   GET  /api/lit/notes?key=                 { items, reading: [ids being read] }
//   GET  /api/lit/notes/img?key=&id=         the picture
//   POST /api/lit/notes/save                 { key, id?, text, ink?, png?, page, sel } -> { ok, item }
//   POST /api/lit/notes/delete               { key, id }
//   POST /api/lit/notes/read                 { key, id }   认字: starts; the page hears notes:<key> when done
//   POST /api/lit/notes/todo                 { key, id }   into 重要计划 (read first when it has no text)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { NOTE_SCHEMA, notePrompt } = require('./prompts/notes');

const KEY = /^[A-Z0-9]{8}$/, ID = /^[a-f0-9]{12}$/;
const MAX_PNG = 6e6, MAX_NOTES = 500, MAX_STROKES = 4000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// "data:image/png;base64,..." -> { buf, w, h }, or null
function pngOf(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 33 || buf.length > MAX_PNG || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return w >= 16 && h >= 16 && w <= 6000 && h <= 6000 ? { buf, w, h } : null;
}
// 画板's strokes as sent ({ v, strokes: [{ t, c, w, p }] }), checked; null when there are none
function inkOf(d) {
  const list = d && Array.isArray(d.strokes) ? d.strokes : [];
  const out = [];
  for (const s of list.slice(0, MAX_STROKES)) {
    if (!s || !['pencil', 'marker'].includes(s.t) || !/^#[0-9a-f]{6}$/i.test(String(s.c)) || !(+s.w > 0 && +s.w < 100) || !Array.isArray(s.p) || s.p.length % 3 || s.p.length > 30000) continue;
    if (s.p.some((v) => typeof v !== 'number' || !Number.isFinite(v))) continue;
    out.push({ t: s.t, c: s.c, w: +s.w, p: s.p.map((v) => Math.round(v * 100) / 100) });
  }
  return out.length ? { v: 1, strokes: out } : null;
}
const str = (v, n) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, n) : '');
const stamp = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

// ask(prompt, schema, { images }): the litVision job's model; todos: 重要计划 (server/todos.js), or null
function createNotes({ dir, kbDir, mirror, ask, todos = null, citekeyOf = (it) => it.citekey, log = () => {}, onChange = () => {} }) {
  const ndir = path.join(dir, 'notes');
  fs.mkdirSync(ndir, { recursive: true });
  const fileOf = (key) => path.join(ndir, key + '.json');
  const imgOf = (key, id) => path.join(ndir, key, id + '.png');
  const load = (key) => { try { return { items: [], ...JSON.parse(fs.readFileSync(fileOf(key), 'utf8')) }; } catch { return { items: [] }; } };
  const reading = new Map();                           // `${key}/${id}` -> promise of the text
  const changed = (key) => { try { onChange(key); } catch {} };
  function save(key, d) {
    fs.writeFileSync(fileOf(key) + '.tmp', JSON.stringify(d)); fs.renameSync(fileOf(key) + '.tmp', fileOf(key));
    toKb(key, d);
    changed(key);
  }

  // the notes as the reader shows them (the strokes stay: a note is edited where it was drawn)
  const list = (key) => ({ items: load(key).items, reading: [...reading.keys()].filter((k) => k.startsWith(key + '/')).map((k) => k.slice(9)) });

  function put(key, d) {
    if (!KEY.test(key) || !mirror.item(key)) return { ok: false, msg: '找不到这篇' };
    const all = load(key);
    const text = str(d.text, 20000), ink = inkOf(d.ink), png = ink ? pngOf(d.png) : null;
    if (ink && !png) return { ok: false, msg: '手写的图片不对' };
    if (!text && !ink) return { ok: false, msg: '笔记是空的' };
    let n = d.id ? all.items.find((x) => x.id === d.id) : null;
    if (d.id && !n) return { ok: false, msg: '这条笔记已经不在了' };
    if (!n) {
      if (all.items.length >= MAX_NOTES) return { ok: false, msg: `一篇最多 ${MAX_NOTES} 条笔记` };
      n = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), page: Math.max(0, Math.min(100000, Math.round(+d.page || 0))), sel: str(d.sel, 2000), todo: '' };
      all.items.push(n);
    }
    const inkChanged = JSON.stringify(n.ink || null) !== JSON.stringify(ink);
    Object.assign(n, { text, ink, img: !!ink, updated: Date.now() });
    if (ink) { fs.mkdirSync(path.join(ndir, key), { recursive: true }); fs.writeFileSync(imgOf(key, n.id), png.buf); n.w = png.w; n.h = png.h; }
    else { try { fs.unlinkSync(imgOf(key, n.id)); } catch {} delete n.w; delete n.h; }
    if (inkChanged || !ink) n.ocr = '';                // (what was read of the old strokes no longer says what they say)
    save(key, all);
    return { ok: true, item: n };
  }
  function remove(key, id) {
    const all = load(key), n = all.items.length;
    all.items = all.items.filter((x) => x.id !== id);
    if (all.items.length === n) return { ok: false, msg: '这条笔记已经不在了' };
    try { fs.unlinkSync(imgOf(key, id)); } catch {}
    save(key, all);
    return { ok: true };
  }
  const img = (key, id) => { if (!KEY.test(key) || !ID.test(id)) return null; try { return fs.readFileSync(imgOf(key, id)); } catch { return null; } };

  // 认字: a note written by hand into type (once per drawing; again after it is redrawn) -> the text
  function read(key, id) {
    const k = key + '/' + id;
    if (reading.has(k)) return reading.get(k);
    const p = (async () => {
      const it = mirror.item(key), n = load(key).items.find((x) => x.id === id);
      if (!it || !n) throw new Error('这条笔记已经不在了');
      if (!n.img) return n.text;
      if (n.ocr) return n.ocr;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-note-'));
      try {
        const f = path.join(tmp, 'note.png');
        fs.copyFileSync(imgOf(key, id), f);
        const a = await ask(notePrompt(it, n), NOTE_SCHEMA, { images: [f] });
        const text = str(a && a.transcript, 20000);
        if (!text) throw new Error('没认出字来');
        const all = load(key), m = all.items.find((x) => x.id === id);
        if (m && JSON.stringify(m.ink) === JSON.stringify(n.ink)) { m.ocr = text; save(key, all); }
        return text;
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    })().finally(() => { reading.delete(k); changed(key); });
    reading.set(k, p);
    changed(key);
    return p;
  }
  function startRead(key, id) {
    const n = KEY.test(key) && load(key).items.find((x) => x.id === id);
    if (!n) return { ok: false, msg: '这条笔记已经不在了' };
    if (!n.img) return { ok: false, msg: '这条是打字的，不用认' };
    read(key, id).catch((e) => log(`文献：${key} 笔记认字失败：${e.message}`));
    return { ok: true };
  }

  // into 重要计划: the note's text (a note by hand is read first), the paper's citekey after it; the todo remembers
  // the paper and the page, and the note the todo
  async function toTodo(key, id) {
    if (!todos) return { ok: false, msg: '重要计划没有开启' };
    const it = KEY.test(key) && mirror.item(key), n = it && load(key).items.find((x) => x.id === id);
    if (!n) return { ok: false, msg: '这条笔记已经不在了' };
    if (n.todo && todos.list().some((t) => t.id === n.todo)) return { ok: false, msg: '已经在重要计划里了' };
    let text = n.text;
    if (!text && n.img) { try { text = n.ocr || await read(key, id); } catch (e) { return { ok: false, msg: '手写的字没认出来：' + e.message }; } }
    text = String(text || '').replace(/\$\$?/g, '').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, msg: '笔记是空的' };
    const tail = `（${citekeyOf(it) || it.title.slice(0, 30)}${n.page ? ' p.' + n.page : ''}）`;
    const r = todos.add({ text: (text.length + tail.length > 300 ? text.slice(0, 296 - tail.length) + '…' : text) + tail, project: '文献', lit: { key, page: n.page || 0 } });
    if (!r.ok) return r;
    const all = load(key), m = all.items.find((x) => x.id === id);
    if (m) { m.todo = r.item ? r.item.id : ''; save(key, all); }
    return { ok: true, todo: r.item };
  }

  // the knowledge base's copy: notes/<citekey>.md (and the pictures beside it); none when there are no notes
  function toKb(key, d) {
    if (!kbDir) return;
    const it = mirror.item(key), name = it && citekeyOf(it);
    if (!name || !/^[\p{L}\p{N}_.-]{1,120}$/u.test(name)) return;
    const md = path.join(kbDir, 'notes', name + '.md'), pics = path.join(kbDir, 'notes', name);
    try {
      fs.rmSync(pics, { recursive: true, force: true });
      if (!d.items.length) { fs.rmSync(md, { force: true }); return; }
      fs.mkdirSync(path.dirname(md), { recursive: true });
      const out = ['---', `title: ${JSON.stringify(it.title)}`, `zotero: ${JSON.stringify(key)}`, `citekey: ${JSON.stringify(name)}`, `updated: ${JSON.stringify(stamp(Date.now()).slice(0, 10))}`, '---', '',
        `# 笔记：${it.title}`, '', `卡片：[[${name}]]`, ''];
      for (const n of [...d.items].sort((a, b) => (a.page || 1e9) - (b.page || 1e9) || a.at - b.at)) {
        out.push(`## ${n.page ? 'p.' + n.page + ' · ' : ''}${stamp(n.at)}`, '');
        if (n.sel) out.push(...n.sel.split('\n').map((l) => '> ' + l), '');
        if (n.img) {
          fs.mkdirSync(pics, { recursive: true });
          try { fs.copyFileSync(imgOf(key, n.id), path.join(pics, n.id + '.png')); out.push(`![手写](${name}/${n.id}.png)`, ''); } catch {}
          if (n.ocr && !n.text) out.push('（认字）' + n.ocr, '');
        }
        if (n.text) out.push(n.text, '');
      }
      fs.writeFileSync(md + '.tmp', out.join('\n')); fs.renameSync(md + '.tmp', md);
    } catch (e) { log(`文献：笔记没能放进知识库：${e.message}`); }
  }

  // for the cards' prompts: what the user wrote, one line each
  function lines(key) {
    return load(key).items.filter((n) => n.text || n.ocr).sort((a, b) => (a.page || 1e9) - (b.page || 1e9) || a.at - b.at)
      .map((n) => `我的笔记${n.page ? `（p.${n.page}）` : ''}：${(n.sel ? `针对“${n.sel.slice(0, 200)}” ` : '') + (n.text || n.ocr).replace(/\s+/g, ' ').slice(0, 800)}`);
  }

  // true when handled
  async function handle(req, res, url, json, readBody) {
    const p = url.pathname, qs = (k) => String(url.searchParams.get(k) || '');
    if (req.method === 'GET' && p === '/api/lit/notes') { const k = qs('key'); json(res, KEY.test(k) ? 200 : 404, KEY.test(k) ? list(k) : { error: 'not found' }); return true; }
    if (req.method === 'GET' && p === '/api/lit/notes/img') {
      const buf = img(qs('key'), qs('id'));
      if (!buf) { json(res, 404, { error: 'not found' }); return true; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(buf); return true;
    }
    if (req.method !== 'POST' || !/^\/api\/lit\/notes\/(save|delete|read|todo)$/.test(p)) return false;
    let d = {}; try { d = JSON.parse(await readBody(req, 9e6)); } catch {}
    const key = String(d.key || ''), id = String(d.id || ''), what = p.split('/').pop();
    if (!KEY.test(key) || (what !== 'save' && !ID.test(id)) || (what === 'save' && id && !ID.test(id))) { json(res, 200, { ok: false, msg: '找不到这条笔记' }); return true; }
    const r = what === 'save' ? put(key, { ...d, id }) : what === 'delete' ? remove(key, id) : what === 'read' ? startRead(key, id) : await toTodo(key, id);
    json(res, 200, r);
    return true;
  }

  return { list, put, remove, img, read, toTodo, lines, handle };
}

module.exports = { createNotes, pngOf, inkOf };
