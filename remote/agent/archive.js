// Sessions outside the live window (no change for 30 minutes) whose transcript the server has not stored completely:
// they are streamed like live ones until the server has everything, so the server's archive (and the daily
// summary) covers the last `days` days, not only what happened while the agent was watching. Checked once a minute;
// a session the server already has up to the file's end costs a stat.
'use strict';
const fs = require('fs');
const path = require('path');

// deps: claudeFiles() -> [{ id, file, mtime }], codex (codex-records.js), projectOf(file), live(id) -> bool,
//       stored(id) -> the server's byte offset (undefined: nothing stored)
function createArchive({ days = 30, claudeFiles, codex, projectOf, live, stored, everyMs = 60e3 }) {
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
    return map;
  }
  // the reader of `id` reached the end of its file: nothing more to send
  const done = (id) => map.delete(id);
  const reset = () => { map.clear(); at = 0; };        // a new connection: the server's offsets come again
  return { scan, done, reset, map };
}

module.exports = { createArchive };
