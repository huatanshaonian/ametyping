// 画板's files on the NAS: <dataDir>/boards/
//   index.json      [{ id, title, created, updated, strokes (how many) }]
//   <id>.json       the drawing itself: { v: 1, strokes: [{ t: 'pencil' | 'marker', c: '#rrggbb', w, p: [x, y, pressure, ...] }] }
//   <id>.png        the picture last given to the model (the whole board or the part framed)
//   <id>.out.json   what the model made of it: { restore: { at, ... }, design: { at, html, note } }
// A save carries the version it was edited from: when the board changed elsewhere in the meantime, this drawing is
// kept as a separate 「冲突副本」 instead of overwriting either one (as 记事本 does).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID = /^[0-9a-f]{12}$/;
const MAX_STROKES = 20000, MAX_POINTS = 6000;        // per board / per stroke
const TOOLS = ['pencil', 'marker'];
const COLOR = /^#[0-9a-f]{6}$/i;

// a drawing as it came from a page -> what is kept: known tools, plain numbers, nothing else
function cleanDoc(doc) {
  const out = [];
  for (const s of (doc && Array.isArray(doc.strokes) ? doc.strokes : []).slice(0, MAX_STROKES)) {
    if (!s || !Array.isArray(s.p) || s.p.length < 3) continue;
    const p = s.p.slice(0, MAX_POINTS * 3).map((n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0));
    p.length -= p.length % 3;
    out.push({ t: TOOLS.includes(s.t) ? s.t : 'pencil', c: COLOR.test(s.c) ? s.c.toLowerCase() : '#222222', w: Math.min(80, Math.max(0.5, +s.w || 2)), p });
  }
  return { v: 1, strokes: out };
}

function createBoardStore({ dataDir, onChange = () => {} }) {
  const dir = path.join(dataDir, 'boards');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const indexFile = path.join(dir, 'index.json');
  let index = []; try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch {}
  const put = (file, text) => { fs.writeFileSync(file + '.tmp', text, { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  const saveIndex = () => { put(indexFile, JSON.stringify(index)); onChange(); };
  const file = (id, ext) => path.join(dir, id + ext);
  const entry = (id) => (ID.test(String(id)) ? index.find((x) => x.id === id) : null) || null;
  const name = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  const list = () => [...index].sort((a, b) => b.updated - a.updated);
  function get(id) {
    const e = entry(id);
    if (!e) return null;
    let doc = { v: 1, strokes: [] }; try { doc = JSON.parse(fs.readFileSync(file(id, '.json'), 'utf8')); } catch {}
    return { ...e, doc };
  }

  // { id?, title?, doc, base? } -> { ok, id, updated, title, conflict? }
  function save(d) {
    let e = d.id ? entry(d.id) : null;
    if (d.id && !e) return { ok: false, msg: '这块画板已经被删掉了' };
    let conflict = false, title = name(d.title) || (e ? e.title : '');
    if (e && Number.isFinite(d.base) && e.updated > d.base) { conflict = true; title = (e.title || '画板') + '（冲突副本）'; e = null; }
    if (!e) { e = { id: crypto.randomBytes(6).toString('hex'), created: Date.now(), updated: 0, title: '', strokes: 0 }; index.push(e); }
    const doc = cleanDoc(d.doc);
    put(file(e.id, '.json'), JSON.stringify(doc));
    Object.assign(e, { title: title || '画板', updated: Math.max(Date.now(), e.updated + 1), strokes: doc.strokes.length });
    saveIndex();
    return { ok: true, id: e.id, updated: e.updated, title: e.title, conflict };
  }
  function rename(id, title) {
    const e = entry(id);
    if (!e || !name(title)) return { ok: false, msg: e ? '名字不能是空的' : '这块画板已经被删掉了' };
    e.title = name(title);
    saveIndex();
    return { ok: true, title: e.title };
  }
  function remove(id) {
    if (!entry(id)) return { ok: false };
    index = index.filter((x) => x.id !== id);
    for (const ext of ['.json', '.png', '.out.json']) { try { fs.unlinkSync(file(id, ext)); } catch {} }
    saveIndex();
    return { ok: true };
  }

  // the picture given to the model, and what came back
  const shotFile = (id) => file(id, '.png');
  function out(id) { try { return JSON.parse(fs.readFileSync(file(id, '.out.json'), 'utf8')); } catch { return {}; } }
  function setOut(id, part) {
    if (!entry(id)) return;
    put(file(id, '.out.json'), JSON.stringify({ ...out(id), ...part }));
    onChange();
  }
  return { list, get, entry, save, rename, remove, shotFile, out, setOut };
}

module.exports = { createBoardStore, cleanDoc, ID };
