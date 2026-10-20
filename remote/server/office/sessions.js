// Files being edited in OnlyOffice, kept on disk (a restart of this server -- each update -- must not lose one that is
// open in an editor): <dir>/<id>/meta.json, src (the file as it was opened) and v1, v2, ... (each version the editor
// saved). Removed a while after the editor is closed, or after a few days whatever happens.
//   meta: { id, tok (in the URLs the container is given), machine, path, name, ext, size, at, last, v, sha, done }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID = /^[a-f0-9]{24}$/;
const KEEP_DONE_MS = 6 * 3600e3;          // a closed one: long enough for the page to write its last version back
const KEEP_MS = 4 * 24 * 3600e3;          // anything, however it went

function createSessions(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const folder = (id) => path.join(dir, id);

  function get(id) {
    if (!ID.test(String(id))) return null;
    try { return JSON.parse(fs.readFileSync(path.join(folder(id), 'meta.json'), 'utf8')); } catch { return null; }
  }
  function put(m) {
    const f = path.join(folder(m.id), 'meta.json'), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, f);
  }
  // a new one; the file itself is then written to file(m) (receive in index.js)
  function create({ machine, path: p, name, ext }) {
    const id = crypto.randomBytes(12).toString('hex');
    fs.mkdirSync(folder(id), { mode: 0o700 });
    const m = { id, tok: crypto.randomBytes(18).toString('base64url'), machine, path: p, name, ext, size: 0, at: Date.now(), last: Date.now(), v: 0, sha: '', done: 0 };
    put(m);
    return m;
  }
  // the file as opened (v 0) or a saved version
  const file = (m, v = 0) => path.join(folder(m.id), v ? 'v' + v : 'src');
  function remove(id) { if (ID.test(String(id))) fs.rmSync(folder(id), { recursive: true, force: true }); }
  const count = () => { try { return fs.readdirSync(dir).filter((n) => ID.test(n)).length; } catch { return 0; } };

  function sweep() {
    const now = Date.now();
    let names = []; try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) {
      if (!ID.test(n)) continue;
      const m = get(n);
      if (!m) { let t = 0; try { t = fs.statSync(folder(n)).mtimeMs; } catch {} if (now - t > 3600e3) remove(n); continue; }
      if ((m.done && now - m.done > KEEP_DONE_MS) || now - m.at > KEEP_MS) remove(n);
    }
  }
  sweep();
  setInterval(sweep, 3600e3).unref();

  return { get, put, create, file, remove, count, sweep };
}

module.exports = { createSessions, ID };
