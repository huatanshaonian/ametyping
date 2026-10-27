// Codex has no Claude-style live-process registry. Keep only the session/process association learned from hooks,
// so a pet/service restart can reconnect to an idle CLI. No prompts, tool input, or environment are stored here.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dirOf = (home) => path.join(home, '.ametyping', 'codex-sessions');
const saved = new Map();

function remember(s, home = os.homedir()) {
  if (s.provider !== 'codex' || !ID.test(s.rawSession) || !s.claudePid || !s.processIdentity || s.headless) return;
  try {
    const dir = dirOf(home);
    const file = path.join(dir, s.rawSession + '.json'), data = JSON.stringify({
      id: s.rawSession, pid: s.claudePid, cwd: s.cwd || '', transcript: s.transcript || '', title: s.title || '',
      identity: s.processIdentity,
    });
    if (saved.get(file) === data && fs.existsSync(file)) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const r of list(home)) if (r.pid === s.claudePid && r.id !== s.rawSession) forget(r.id, home);
    fs.writeFileSync(file, data, { mode: 0o600 });
    saved.set(file, data);
  } catch {} // Monitoring must never prevent Codex from continuing.
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
  if (!ID.test(id)) return;
  const file = path.join(dirOf(home), id + '.json');
  saved.delete(file);
  try { fs.unlinkSync(file); } catch {}
}
module.exports = { remember, list, forget };
