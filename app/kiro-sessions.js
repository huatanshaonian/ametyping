// Kiro CLI session-to-PID registry (~/.ametyping/kiro-sessions/<id>.json). Modeled after app/codex-sessions.js and
// app/agy-sessions.js: Kiro has no live-process registry, so the association the pet learns from hooks is kept here,
// letting a pet/service restart reconnect to an idle CLI. No prompts, tool input or environment are stored.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dirOf = (home = os.homedir()) => path.join(home, '.ametyping', 'kiro-sessions');
const saved = new Map();

function remember(s, home = os.homedir()) {
  if (!s || typeof s !== 'object' || s.provider !== 'kiro' || s.headless) return;
  const id = String(s.rawSession || s.id || '').replace(/^kiro:/, '');
  const pid = Number(s.claudePid || s.pid);
  if (!ID.test(id) || !Number.isSafeInteger(pid) || pid <= 0 || !s.processIdentity) return;
  try {
    const dir = dirOf(home);
    const file = path.join(dir, id + '.json');
    const data = JSON.stringify({ id, pid, cwd: s.cwd || '', transcript: s.transcript || '', title: s.title || '', identity: s.processIdentity });
    if (saved.get(file) === data && fs.existsSync(file)) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const r of list(home)) if (r.pid === pid && r.id !== id) forget(r.id, home);
    fs.writeFileSync(file, data, { mode: 0o600 });
    saved.set(file, data);
  } catch {} // Monitoring must never prevent Kiro from continuing.
}
function list(home = os.homedir()) {
  const out = [], dir = dirOf(home);
  let names; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (r.id !== name.slice(0, -5) || !Number.isSafeInteger(r.pid) || r.pid <= 0 || typeof r.cwd !== 'string' || typeof r.identity !== 'string' || !r.identity) continue;
      out.push(r);
    } catch {}
  }
  return out;
}
function forget(id, home = os.homedir()) {
  const raw = String(id || '').replace(/^kiro:/, '');
  if (!ID.test(raw)) return;
  const file = path.join(dirOf(home), raw + '.json');
  saved.delete(file);
  try { fs.unlinkSync(file); } catch {}
}
module.exports = { remember, list, forget, save: remember, remove: forget, load: list };
