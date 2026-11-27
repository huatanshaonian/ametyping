'use strict';
// Shared session-to-PID registry factory (~/.ametyping/<dirName>/<uuid>.json)
// used by app/codex-sessions.js, app/agy-sessions.js, and app/kiro-sessions.js.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function createSessionRegistry({
  dirName,
  prefix = '',
  caseInsensitiveUuid = true,
  requireProvider = '',
  requireIdentity = true,
  requireCwdString = true,
}) {
  const ID = new RegExp('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', caseInsensitiveUuid ? 'i' : '');
  const prefixRe = prefix ? new RegExp(`^${prefix}:`) : null;
  const stripPrefix = (v) => (prefixRe ? String(v || '').replace(prefixRe, '') : String(v || ''));
  const dirOf = (home = os.homedir()) => path.join(home, '.ametyping', dirName);
  const saved = new Map();

  function list(home = os.homedir()) {
    const out = [];
    const dir = dirOf(home);
    let names;
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const name of names) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (r.id !== name.slice(0, -5) || !Number.isSafeInteger(r.pid) || r.pid <= 0) continue;
        if (requireCwdString && typeof r.cwd !== 'string') continue;
        if (requireIdentity && (typeof r.identity !== 'string' || !r.identity)) continue;
        out.push(r);
      } catch {}
    }
    return out;
  }

  function forget(id, home = os.homedir()) {
    const rawId = stripPrefix(id);
    if (!ID.test(rawId)) return;
    const file = path.join(dirOf(home), rawId + '.json');
    saved.delete(file);
    try { fs.unlinkSync(file); } catch {}
  }

  function remember(s, home = os.homedir()) {
    if (!s || typeof s !== 'object' || s.headless) return;
    if (requireProvider && s.provider !== requireProvider) return;
    const id = stripPrefix(s.rawSession || s.id || '');
    const pid = Number(s.claudePid || s.pid);
    const identity = typeof s.processIdentity === 'string'
      ? s.processIdentity
      : (typeof s.identity === 'string' ? s.identity : '');
    if (!ID.test(id) || !Number.isSafeInteger(pid) || pid <= 0) return;
    if (requireIdentity && !identity) return;

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
      for (const r of list(home)) {
        if (r.pid === pid && r.id !== id) forget(r.id, home);
      }
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
      try {
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        fs.renameSync(tmp, file);
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
      saved.set(file, data);
    } catch {}
  }

  return { remember, list, forget, save: remember, remove: forget, load: list };
}

module.exports = { createSessionRegistry };
