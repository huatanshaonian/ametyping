// Files a session wrote, checked for the daily summary's list of things made outside a tracked repository (the
// server asks; nothing here runs on its own). For each { id: session, path }:
//   - the path must be one this session wrote or edited, per its own transcript -- the server cannot name any other
//     file on this machine -- and not a secret (files.js rules)
//   - exists / size / mtime; the git repository around it (walking up to .git): its remote, and whether git tracks
//     the file or ignores it
//   - with `backup`, a file of at most maxBytes is sent along in chunks (art-chunk), content hashed (sha256)
// Off with agent.json "artifacts": false.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const transcript = require('../../app/transcript');
const codex = require('./codex-records');
const { denied } = require('./files');

const CHUNK = 256 * 1024;
const WIN = process.platform === 'win32';
const norm = (p) => (WIN ? path.win32.normalize(p).toLowerCase() : path.posix.normalize(p));

function git(cwd, args) {
  return new Promise((resolve) => execFile('git', ['-C', cwd, ...args], { timeout: 5000, windowsHide: true },
    (err, out) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(out || '').trim() })));
}

// deps: sessionFile(id) -> { file, codex: bool, cwd } | null, send(obj)
function createArtifacts({ sessionFile, send }) {
  const written = new Map();                          // session id -> { size, paths: Set }

  // every path the session wrote or edited, from its transcript (re-read when the file grew)
  function pathsOf(id) {
    const sf = sessionFile(id);
    if (!sf) return null;
    let st; try { st = fs.statSync(sf.file); } catch { return null; }
    const c = written.get(id);
    if (c && c.size === st.size) return c.paths;
    const parse = sf.codex ? codex.recordsOf : transcript.recordsOf;
    const paths = new Set();
    let cwd = sf.cwd || '';
    for (const line of fs.readFileSync(sf.file, 'utf8').split('\n')) {
      if (!line.includes('"file_path"') && !line.includes('File:') && !line.includes('notebook_path')) { if (!cwd && line.includes('"cwd"')) { try { cwd = JSON.parse(line).cwd || ''; } catch {} } continue; }
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!cwd && o.cwd) cwd = o.cwd;
      for (const r of parse(o)) {
        if (!r.x || !r.x.p || (r.x.op !== 'write' && r.x.op !== 'edit')) continue;
        for (const p of r.x.p) paths.add(norm(path.isAbsolute(p) || !cwd ? p : path.join(cwd, p)));
      }
    }
    written.set(id, { size: st.size, paths });
    return paths;
  }

  const repoCache = new Map();                        // dir -> { root, remote } | null
  function repoOf(file) {
    let dir = path.dirname(file);
    const seen = [];
    for (;;) {
      if (repoCache.has(dir)) { const r = repoCache.get(dir); for (const d of seen) repoCache.set(d, r); return r; }
      seen.push(dir);
      if (fs.existsSync(path.join(dir, '.git'))) {
        let remote = '';
        try {
          const conf = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
          const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(conf) || /\[remote "[^"]+"\][^[]*?url\s*=\s*(\S+)/.exec(conf);
          if (m) remote = m[1];
        } catch {}                                     // a worktree / submodule (.git is a file): remote unknown
        const r = { root: dir, remote };
        for (const d of seen) repoCache.set(d, r);
        return r;
      }
      const up = path.dirname(dir);
      if (up === dir) { for (const d of seen) repoCache.set(d, null); return null; }
      dir = up;
    }
  }

  async function checkOne(it, backup) {
    const out = { id: it.id, path: it.path };
    if (typeof it.path !== 'string' || !path.isAbsolute(it.path)) return { ...out, ok: false, why: 'bad path' };
    const paths = pathsOf(it.id);
    if (!paths) return { ...out, ok: false, why: 'unknown session' };
    if (!paths.has(norm(it.path))) return { ...out, ok: false, why: 'not written by this session' };
    if (it.path.split(/[\\/]/).some((seg) => seg && denied(seg))) return { ...out, ok: false, why: 'secret' };
    let st; try { st = fs.statSync(it.path); } catch { return { ...out, ok: true, exists: false }; }
    if (!st.isFile()) return { ...out, ok: true, exists: false };
    Object.assign(out, { ok: true, exists: true, size: st.size, mtime: st.mtimeMs });
    const repo = repoOf(it.path);
    if (repo) {
      const rel = path.relative(repo.root, it.path);
      const tracked = await git(repo.root, ['ls-files', '--error-unmatch', '--', rel]);
      const ignored = tracked.code === 0 ? { code: 1 } : await git(repo.root, ['check-ignore', '-q', '--', rel]);
      out.repo = { root: repo.root, remote: repo.remote, tracked: tracked.code === 0 ? true : tracked.code === 1 ? false : null, ignored: ignored.code === 0 };
    }
    if (backup && st.size <= backup.maxBytes && !(out.repo && out.repo.remote && out.repo.tracked)) {
      try { out.buf = fs.readFileSync(it.path); out.sha = crypto.createHash('sha256').update(out.buf).digest('hex'); } catch {}
    }
    return out;
  }

  // d: { rid, items: [{ id, path }], backup?: { maxBytes } }
  async function handle(d) {
    const items = Array.isArray(d.items) ? d.items.slice(0, 300) : [];
    const backup = d.backup && +d.backup.maxBytes > 0 ? { maxBytes: Math.min(+d.backup.maxBytes, 20e6) } : null;
    const res = [];
    for (const it of items) res.push(await checkOne(it, backup));
    send({ t: 'art-res', rid: d.rid, items: res.map(({ buf, ...r }) => ({ ...r, backed: !!buf })) });
    for (const r of res) {
      if (!r.buf) continue;
      for (let off = 0, seq = 0; off < r.buf.length || seq === 0; off += CHUNK, seq++) {
        send({ t: 'art-chunk', rid: d.rid, sha: r.sha, seq, data: r.buf.subarray(off, off + CHUNK).toString('base64'), last: off + CHUNK >= r.buf.length });
        await new Promise((ok) => setImmediate(ok));
      }
    }
  }
  return { handle, pathsOf };
}

module.exports = { createArtifacts };
