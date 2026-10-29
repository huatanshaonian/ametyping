// Sessions outside the live window (no change for 30 minutes) whose transcript the server has not stored completely:
// they are streamed like live ones until the server has everything, so the server's archive (and the daily
// summary) covers the last `days` days, not only what happened while the agent was watching. Checked once a minute;
// a session the server already has up to the file's end costs a stat.
'use strict';
const fs = require('fs');
const path = require('path');
const { aiOf } = require('../../app/ai-providers');

// deps: claudeFiles() -> [{ id, file, mtime }], codex (app/codex-records.js), opencode (app/opencode-records.js),
//       agy (app/agy-records.js), projectOf(file), live(id) -> bool, stored(id) -> the server's byte offset (undefined: nothing stored)
function createArchive({ days = 30, claudeFiles, codex, opencode, agy, projectOf, live, stored, everyMs = 60e3 }) {
  const map = new Map();                              // id -> { file, project, cwd?, title? }
  let at = 0;
  const behind = (id, file) => { let st; try { st = fs.statSync(file); } catch { return false; } return (stored(id) || 0) < st.size; };

  function scan(now = Date.now()) {
    if (!days || now - at < everyMs) return map;
    at = now;
    const since = now - days * 86400e3;
    for (const f of claudeFiles()) {
      if (f.mtime < since || live(f.id) || map.has(f.id)) continue;
      if (behind(f.id, f.file)) map.set(f.id, { file: f.file, project: projectOf(f.file) });
    }
    for (const file of codex.allFiles()) {
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < since) continue;
      const m = codex.metaOf(file);
      if (!m || m.sub) continue;                        // sub-threads are not sessions
      const id = 'codex:' + m.id;
      if (live(id) || map.has(id) || !behind(id, file)) continue;
      map.set(id, { file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: codex.titleOf(m.id) });
    }
    if (opencode) {
      for (const f of opencode.allFiles()) {
        if (f.mtime < since) continue;
        const m = opencode.metaOf(f.file);
        if (!m) continue;
        const id = 'opencode:' + m.id;
        if (live(id) || map.has(id) || !behind(id, f.file)) continue;
        map.set(id, { file: f.file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: opencode.titleOf(m.id) || m.title, model: m.model || null, ai: aiOf(m.model) });
      }
    }
    if (agy) {
      for (const f of agy.allFiles()) {
        const file = typeof f === 'string' ? f : f.file;
        let mtime = typeof f === 'object' && f ? f.mtime : 0;
        if (!mtime) { try { mtime = fs.statSync(file).mtimeMs; } catch { continue; } }
        if (mtime < since) continue;
        const m = agy.metaOf(file);
        if (!m || m.sub) continue;
        const id = 'agy:' + m.id;
        if (live(id) || map.has(id) || !behind(id, file)) continue;
        map.set(id, { file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: agy.titleOf(m.id) || m.title, model: m.model || null, ai: aiOf(m.model) });
      }
    }
    return map;
  }
  // the reader of `id` reached the end of its file: nothing more to send
  const done = (id) => map.delete(id);
  const reset = () => { map.clear(); at = 0; };        // a new connection: the server's offsets come again
  return { scan, done, reset, map };
}

module.exports = { createArchive };
