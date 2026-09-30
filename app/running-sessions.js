// Claude Code sessions running right now, from Claude Code's own records: while a session runs it keeps
// ~/.claude/sessions/<pid>.json -- { pid, sessionId, cwd, kind, entrypoint, name, ... }. The pet and the Linux headless
// service read them when they start, so sessions that were already open show up at once instead of only after their
// next hook event (e.g. after a restart of the pet or the computer's sleep). Only these .json records are read; the
// *.key files next to them are never opened. Whether each pid is still that Claude process is for the caller to check.
'use strict';
const fs = require('fs');
const path = require('path');

// [{ pid, sessionId, cwd, name, kind, entrypoint }] -- interactive sessions only (not `claude -p` runs)
function listRunning(home) {
  const dir = path.join(home, '.claude', 'sessions');
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!r || !Number.isInteger(r.pid) || typeof r.sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(r.sessionId)) continue;
    if (r.kind && r.kind !== 'interactive') continue;
    out.push({ pid: r.pid, sessionId: r.sessionId, cwd: typeof r.cwd === 'string' ? r.cwd : '', name: typeof r.name === 'string' ? r.name.slice(0, 60) : '',
      kind: r.kind || '', entrypoint: r.entrypoint || '' });
  }
  return out;
}

// the transcript Claude Code writes for a session: ~/.claude/projects/<cwd with every other character as '-'>/<id>.jsonl
function transcriptOf(home, cwd, id) {
  if (!cwd) return '';
  const f = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), id + '.jsonl');
  return fs.existsSync(f) ? f : '';
}

// a short project name for the list (the folder's name; nothing for a drive root)
function projectOf(cwd) {
  const s = String(cwd || '').replace(/[\\/]+$/, '');
  return !s || /^[A-Za-z]:$/.test(s) ? '' : s.split(/[\\/]/).pop();
}

module.exports = { listRunning, transcriptOf, projectOf };
