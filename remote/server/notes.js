// 记事本: plain-text notes kept on the NAS (<dataDir>/notes/<id>.txt, titles and times in notes/index.json). The
// first line is the title. A save carries the version it was edited from: when the note changed elsewhere in the
// meantime, this text is kept as a separate 「冲突副本」 instead of overwriting either one.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX = 1e6;                                     // characters per note
const ID = /^[0-9a-f]{12}$/;

function createNotes({ dataDir, onChange = () => {}, audit = () => {} }) {
  const dir = path.join(dataDir, 'notes');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const indexFile = path.join(dir, 'index.json');
  let index = []; try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch {}   // [{ id, title, created, updated, drive? }]
  const saveIndex = () => { fs.writeFileSync(indexFile + '.tmp', JSON.stringify(index), { mode: 0o600 }); fs.renameSync(indexFile + '.tmp', indexFile); onChange(); };
  const fileOf = (id) => path.join(dir, id + '.txt');
  const titleOf = (text) => (String(text).split('\n').map((l) => l.trim()).find(Boolean) || '无标题').slice(0, 60);

  const list = () => [...index].sort((a, b) => b.updated - a.updated);
  function get(id) {
    const e = ID.test(id) && index.find((x) => x.id === id);
    if (!e) return null;
    let text = ''; try { text = fs.readFileSync(fileOf(id), 'utf8'); } catch {}
    return { ...e, text };
  }
  function write(e, text) { fs.writeFileSync(fileOf(e.id), text, { mode: 0o600 }); e.title = titleOf(text); e.updated = Date.now(); }

  // { id?, text, base? } -> { ok, id, updated, conflict? }
  function save(d) {
    const text = typeof d.text === 'string' ? d.text.slice(0, MAX) : '';
    let e = d.id ? index.find((x) => x.id === d.id) : null;
    if (d.id && !e) return { ok: false, msg: '这篇笔记已经被删掉了' };
    let conflict = false;
    if (e && Number.isFinite(d.base) && e.updated > d.base) {                  // edited elsewhere since: keep both
      conflict = true;
      e = null;
    }
    if (!e) {
      e = { id: crypto.randomBytes(6).toString('hex'), created: Date.now(), updated: 0, title: '' };
      index.push(e);
    }
    write(e, conflict ? text.replace(/^([^\n]*)/, (l) => `${l || '无标题'}（冲突副本）`) : text);
    saveIndex();
    return { ok: true, id: e.id, updated: e.updated, conflict };
  }
  function remove(id) {
    const n = index.length;
    index = index.filter((x) => x.id !== id);
    if (index.length === n) return { ok: false };
    try { fs.unlinkSync(fileOf(id)); } catch {}
    saveIndex();
    return { ok: true };
  }
  function setDrive(id, drive) { const e = index.find((x) => x.id === id); if (e) { e.drive = drive; saveIndex(); } }

  async function handle(req, res, url, ip, json, readBody) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/notes') { json(res, 200, { items: list() }); return true; }
    if (req.method === 'GET' && p === '/api/note') { const n = get(String(url.searchParams.get('id') || '')); json(res, n ? 200 : 404, n || { error: 'not found' }); return true; }
    if (req.method === 'POST' && (p === '/api/notes/save' || p === '/api/notes/delete')) {
      let d = {}; try { d = JSON.parse(await readBody(req, 4.5e6)); } catch { json(res, 400, { ok: false, msg: '内容太长' }); return true; }
      const r = p.endsWith('/save') ? save(d) : remove(String(d.id || ''));
      if (r.ok) audit('note-' + p.split('/').pop(), ip, r.id || String(d.id || '').slice(0, 12));
      json(res, 200, r);
      return true;
    }
    return false;
  }
  return { list, get, save, remove, setDrive, handle };
}

module.exports = { createNotes };
