// Antigravity (agy) session-to-PID registry (~/.ametyping/agy-sessions/<id>.json).
// Modeled after app/codex-sessions.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dirOf = (home = os.homedir()) => path.join(home, '.ametyping', 'agy-sessions');
const saved = new Map();

function save(s, home = os.homedir()) {
  if (!s || typeof s !== 'object') return;
  const id = String(s.rawSession || s.id || '').replace(/^agy:/, '');
  const pid = Number(s.claudePid || s.pid);
  if (!ID.test(id) || !Number.isSafeInteger(pid) || pid <= 0 || s.headless) return;
  const identity = typeof s.processIdentity === 'string' ? s.processIdentity : (typeof s.identity === 'string' ? s.identity : '');

  try {
    const dir = dirOf(home);
    const file = path.join(dir, id + '.json');
    const data = JSON.stringify({
      id,
      pid,
      cwd: s.cwd || '',
      transcript: s.transcript || '',
      title: s.title || '',
      identity,
    });
    if (saved.get(file) === data && fs.existsSync(file)) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const r of load(home)) {
      if (r.pid === pid && r.id !== id) remove(r.id, home);
    }
    fs.writeFileSync(file, data, { mode: 0o600 });
    saved.set(file, data);
  } catch {}
}

function remove(id, home = os.homedir()) {
  const rawId = String(id || '').replace(/^agy:/, '');
  if (!ID.test(rawId)) return;
  const file = path.join(dirOf(home), rawId + '.json');
  saved.delete(file);
  try {
    fs.unlinkSync(file);
  } catch {}
}

function load(home = os.homedir()) {
  const out = [], dir = dirOf(home);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (r.id !== name.slice(0, -5) || !Number.isSafeInteger(r.pid) || r.pid <= 0) continue;
      out.push(r);
    } catch {}
  }
  return out;
}

module.exports = {
  save,
  remove,
  load,
  remember: save,
  forget: remove,
  list: load,
};
