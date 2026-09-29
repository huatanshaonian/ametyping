// Read-only file access for the dashboard's file explorer. Only what agent.json allows is reachable:
//   "files": { "roots": ["/home/dell"] }                     folders that can be browsed
//   "files": { "roots": ["*"], "exclude": ["C:"] }           Windows: every drive except the excluded ones
// Every path is resolved to its real location first (symlinks, "..", letter case) and must lie inside a root.
// Secrets are never listed or read, wherever they are (keys, tokens, credentials, this agent's own config).
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const WIN = process.platform === 'win32';
const MAX = 100 * 1024 * 1024;            // larger files cannot be opened from the dashboard
const MAX_ENTRIES = 5000;
const DENY_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.ametyping', '.password-store']);
const DENY_FILE = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.env(\..*)?|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|\.credentials\.json|agent\.json|control-token-.*|.*\.(pem|key|p12|pfx|kdbx|keystore|jks))$/i;

const denied = (name) => DENY_DIRS.has(WIN ? name.toLowerCase() : name) || DENY_FILE.test(name);

function createFiles(cfg) {
  const enabled = !!(cfg && Array.isArray(cfg.roots) && cfg.roots.length);
  const exclude = new Set(((cfg && cfg.exclude) || []).map((x) => String(x).replace(/[\\/:]+$/, '').toUpperCase()));
  let realRoots = null;                    // [{ name, path }] resolved once

  async function roots() {
    if (realRoots) return realRoots;
    const out = [];
    for (const r of cfg.roots) {
      if (r === '*' && WIN) {              // every drive letter that exists, minus the excluded ones
        for (let c = 65; c <= 90; c++) {
          const L = String.fromCharCode(c);
          if (exclude.has(L)) continue;
          try { await fsp.access(L + ':\\'); out.push({ name: L + ':', path: L + ':\\' }); } catch {}
        }
      } else if (typeof r === 'string' && path.isAbsolute(r)) {
        try { const p = await fsp.realpath(r); out.push({ name: p, path: p }); } catch {}
      }
    }
    realRoots = out;
    return out;
  }

  // the real path of p, if it is inside a root and not a secret; throws with a message for the user otherwise
  async function resolve(p) {
    if (typeof p !== 'string' || !p || p.length > 4096 || !path.isAbsolute(p)) throw new Error('路径不对');
    let real;
    try { real = await fsp.realpath(p); } catch { throw new Error('找不到这个文件或文件夹'); }
    for (const r of await roots()) {
      const rel = path.relative(r.path, real);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        if (rel.split(path.sep).some((seg) => seg && denied(seg))) throw new Error('这个文件受保护，不能查看');
        return real;
      }
    }
    throw new Error('不在允许浏览的范围内');
  }
  const isRoot = async (real) => (await roots()).some((r) => path.relative(r.path, real) === '');

  async function list(p) {
    const real = await resolve(p);
    let ents;
    try { ents = await fsp.readdir(real, { withFileTypes: true }); } catch (e) { throw new Error(e.code === 'EPERM' || e.code === 'EACCES' ? '没有权限打开这个文件夹' : '打不开这个文件夹'); }
    const entries = [];
    for (const e of ents) {
      if (denied(e.name)) continue;
      if (entries.length >= MAX_ENTRIES) break;
      let st = null;
      try { st = await fsp.stat(path.join(real, e.name)); } catch { continue; }   // broken links, locked system files
      entries.push({ name: e.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'));
    return { path: real, parent: (await isRoot(real)) ? null : path.dirname(real), entries, truncated: ents.length > MAX_ENTRIES, sep: path.sep };
  }

  // { path, size, stream } for reading a file in chunks
  async function open(p, chunk) {
    const real = await resolve(p);
    const st = await fsp.stat(real);
    if (st.isDirectory()) throw new Error('这是文件夹');
    if (st.size > MAX) throw new Error('文件过大（超过 100 MB），无法打开');
    return { path: real, size: st.size, stream: fs.createReadStream(real, { highWaterMark: chunk }) };
  }

  return { enabled, roots, list, open };
}

module.exports = { createFiles, denied, MAX };
