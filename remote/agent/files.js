// Read-only file access for the dashboard's file explorer. Only what agent.json allows is reachable:
//   "files": { "roots": ["/home/dell"] }                     folders that can be browsed
//   "files": { "roots": ["*"], "exclude": ["C:"] }           Windows: every drive except the excluded ones
//   a root may also be { "path": "C:\\Users\\me", "hideDot": true, "deny": ["AppData"] }: a folder with rules of its
//   own -- hideDot: nothing in it whose name starts with "." (.claude, .codex, .gitconfig: tools keep their logins
//   and histories there); deny: folders in it, by their path from the root, that are left out with all they hold
//   (AppData: browsers' saved passwords and cookies, every program's tokens). Where roots overlap, the innermost one's
//   rules count. A path may be "~" (or start with "~/"): the folder of the user the agent runs as, whatever its name
//   on that machine -- the same line then works on every computer. "@claude-temp" is Claude Code's temporary folder
//   (its sessions' scratchpads), inside AppData on Windows: { "path": "@claude-temp", "readOnly": true } opens just
//   that, and, being the innermost root, its own rules count there. readOnly: nothing may be uploaded into it.
// Which drives "*" stands for is looked up when it is asked: when the explorer asks for the list of roots, and when a
// path is on a drive not known yet (a USB stick put in since). Nothing watches or polls for drives.
// Every path is resolved to its real location first (symlinks, "..", letter case) and must lie inside a root.
// Secrets are never listed or read, wherever they are (keys, tokens, credentials, this agent's own config).
//   "files": { ..., "upload": true }   files may also be uploaded into these folders (fs-upload.js); off unless set.
//   Only where browsing may go, never under a secret's name or a hidden one.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const WIN = process.platform === 'win32';
const MAX = 100 * 1024 * 1024;            // larger files cannot be opened from the dashboard
const MAX_ENTRIES = 5000;
const DENY_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.ametyping', '.password-store', '.codex']);   // (.codex: its auth.json is the login)
const DENY_FILE = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.env(\..*)?|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|\.credentials\.json|agent\.json|control-token-.*|ntuser.(dat|ini|pol)(..*)?|.*\.(pem|key|p12|pfx|kdbx|keystore|jks))$/i;
// bloated build/dependency directories skipped when building a shallow VFS structure tree
const SKIP_TREE_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.tox', 'dist', 'build', 'target', '.next', '.nuxt', '.idea', '.vscode']);

const denied = (name) => DENY_DIRS.has(WIN ? name.toLowerCase() : name) || DENY_FILE.test(name);
const norm = (p) => (WIN ? p.toLowerCase() : p);                // (Windows names: the case does not matter)
// "~" and "~/x": in the home folder of the user the agent runs as. "@claude-temp": Claude Code's temporary folder on
// this computer, where it keeps each session's scratchpad (Windows %TEMP%\claude, elsewhere /tmp/claude-<uid>)
const claudeTemp = () => path.join(os.tmpdir(), WIN || typeof process.getuid !== 'function' ? 'claude' : `claude-${process.getuid()}`);
const expand = (p) => (p === '~' ? os.homedir() : /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p === '@claude-temp' ? claudeTemp() : p);

function createFiles(cfg) {
  const enabled = !!(cfg && Array.isArray(cfg.roots) && cfg.roots.length);
  const exclude = new Set(((cfg && cfg.exclude) || []).map((x) => String(x).replace(/[\\/:]+$/, '').toUpperCase()));
  let realRoots = null;                    // [{ name, path }] as last looked up
  const anyDrive = WIN && enabled && cfg.roots.includes('*');

  // fresh: look again (the drives there are now)
  async function roots(fresh = false) {
    if (realRoots && !fresh) return realRoots;
    const out = [];
    for (let r of cfg.roots) {
      const tmp = r && r.path === '@claude-temp';            // (shown under its own name in 我的电脑)
      if (typeof r === 'string') r = expand(r); else if (r && typeof r === 'object' && typeof r.path === 'string') r = { ...r, path: expand(r.path) };
      if (r === '*' && WIN) {              // every drive letter that exists, minus the excluded ones
        for (let c = 65; c <= 90; c++) {
          const L = String.fromCharCode(c);
          if (exclude.has(L)) continue;
          try { await fsp.access(L + ':\\'); out.push({ name: L + ':', path: L + ':\\' }); } catch {}
        }
      } else if (typeof r === 'string' && path.isAbsolute(r)) {
        try { const p = await fsp.realpath(r); out.push({ name: p, path: p }); } catch {}
      } else if (r && typeof r === 'object' && typeof r.path === 'string' && path.isAbsolute(r.path)) {
        const deny = (Array.isArray(r.deny) ? r.deny : []).filter((x) => typeof x === 'string' && x).map((x) => norm(x.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+|[\\/]+$/g, '')));
        try { const p = await fsp.realpath(r.path); out.push({ name: tmp ? 'Claude 临时文件夹' : p, path: p, hideDot: r.hideDot === true, deny, readOnly: r.readOnly === true || undefined }); } catch {}
      }
    }
    realRoots = out;
    return out;
  }

  // the root a real path is under: the innermost one (its rules count), or null
  async function rootOf(real, again = false) {
    let best = null;
    for (const r of await roots()) {
      const rel = path.relative(r.path, real);
      if ((rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) && (!best || r.path.length > best.r.path.length)) best = { r, rel };
    }
    // on a drive that was not there when the drives were last looked up (and is not an excluded one): look again, once
    if (!best && anyDrive && !again && /^[A-Za-z]:/.test(real) && !exclude.has(real[0].toUpperCase()) &&
      !(await roots()).some((r) => r.name === real[0].toUpperCase() + ':')) { await roots(true); return rootOf(real, true); }
    return best;
  }
  // is this path (from its root) kept out by the root's own rules or by being a secret?
  function hidden(r, rel) {
    const segs = rel.split(path.sep).filter(Boolean);
    if (segs.some((seg) => denied(seg) || (r.hideDot && seg.startsWith('.')))) return true;
    const n = norm(segs.join(path.sep));
    return (r.deny || []).some((d) => n === d || n.startsWith(d + path.sep));
  }
  // the real path of p, if it is inside a root and not a secret; throws with a message for the user otherwise
  async function resolve(p) {
    if (typeof p !== 'string' || !p || p.length > 4096 || !path.isAbsolute(p)) throw new Error('路径不对');
    let real;
    try { real = await fsp.realpath(p); } catch { throw new Error('找不到这个文件或文件夹'); }
    const at = await rootOf(real);
    if (!at) throw new Error('不在允许浏览的范围内');
    if (hidden(at.r, at.rel)) throw new Error('这个文件受保护，不能查看');
    return real;
  }
  const isRoot = async (real) => (await roots()).some((r) => path.relative(r.path, real) === '');

  async function list(p) {
    const real = await resolve(p);
    let ents;
    try { ents = await fsp.readdir(real, { withFileTypes: true }); } catch (e) { throw new Error(e.code === 'EPERM' || e.code === 'EACCES' ? '没有权限打开这个文件夹' : '打不开这个文件夹'); }
    const entries = [];
    const at = await rootOf(real);
    for (const e of ents) {
      if (denied(e.name) || (at && hidden(at.r, path.join(at.rel, e.name)))) continue;
      // a link (Windows: the old "Application Data", "Local Settings", "Cookies" ... junctions of a home folder):
      // shown only when what it leads to may be seen
      if (e.isSymbolicLink()) {
        let to = null; try { to = await fsp.realpath(path.join(real, e.name)); } catch { continue; }
        const t = await rootOf(to);
        if (!t || hidden(t.r, t.rel)) continue;
      }
      if (entries.length >= MAX_ENTRIES) break;
      let st = null;
      try { st = await fsp.stat(path.join(real, e.name)); } catch { continue; }   // broken links, locked system files
      entries.push({ name: e.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'));
    return { path: real, parent: (await isRoot(real)) ? null : path.dirname(real), entries, truncated: ents.length > MAX_ENTRIES, sep: path.sep };
  }

  // { path, size, mtime, from, stream } for reading a file in chunks. big: for a download written straight to disk
  // (no size limit: nothing holds the whole file); from: carry on at that byte (a download resumed after a cut)
  async function open(p, chunk, { big = false, from = 0 } = {}) {
    const real = await resolve(p);
    const st = await fsp.stat(real);
    if (st.isDirectory()) throw new Error('这是文件夹');
    if (!big && st.size > MAX) throw new Error('文件过大（超过 100 MB），无法打开');
    const start = Number.isSafeInteger(from) && from > 0 && from <= st.size ? from : 0;
    return { path: real, size: st.size, mtime: st.mtimeMs, from: start, stream: fs.createReadStream(real, { highWaterMark: chunk, start }) };
  }

  // the real path of a folder inside the roots (where the dashboard may start Claude Code)
  async function folder(p) {
    const real = await resolve(p);
    if (!(await fsp.stat(real)).isDirectory()) throw new Error('这不是文件夹');
    return real;
  }

  // where an upload named name into the folder dir goes (fs-upload.js): { dir, path, exists } -- under the same rules
  // as what may be seen (inside a root, nothing hidden or secret), and a plain file name, not a path
  async function target(dir, name) {
    if (!canUpload) throw new Error('这台电脑没开放上传（agent.json 的 "files" 里设 "upload": true）');
    if (typeof name !== 'string' || !name || name.length > 255 || /[\\/\u0000]/.test(name) || name === '.' || name === '..' ||
      (WIN && (/[<>:"|?*\u0001-\u001f]/.test(name) || /[. ]$/.test(name))) || /\.ame-upload$/.test(name)) throw new Error('文件名不能用');
    const real = await folder(dir);
    const at = await rootOf(real);
    if (at.r.readOnly) throw new Error('这个位置只读，不能上传');
    if (denied(name) || hidden(at.r, path.join(at.rel, name))) throw new Error('这个文件名受保护，不能上传');
    const p = path.join(real, name);
    let st = null; try { st = await fsp.stat(p); } catch {}
    if (st && st.isDirectory()) throw new Error('那里已经有同名的文件夹');
    return { dir: real, path: p, exists: !!st };
  }

  const canUpload = enabled && cfg.upload === true;
  async function writableFolder(p) {
    const dir=await folder(p),at=await rootOf(dir);
    if(at.r.readOnly)throw new Error('这个位置只读');
    return dir;
  }

  // Shallow directory structure snapshot for the NAS VFS catalog (no file contents read).
  // Returns { path, sep, freeBytes, totalBytes, gitBranch, tree, count, truncated, scannedAt }.
  async function tree(p, { maxDepth = 3, maxNodes = 400 } = {}) {
    const real = await folder(p);
    const at = await rootOf(real);
    const depthCap = Math.max(1, Math.min(5, +maxDepth || 3));
    const nodeCap = Math.max(20, Math.min(1500, +maxNodes || 400));
    let count = 0, truncated = false;

    let freeBytes = null, totalBytes = null;
    if (typeof fsp.statfs === 'function') {
      try {
        const sf = await fsp.statfs(real);
        if (sf && Number.isFinite(sf.bavail) && Number.isFinite(sf.bsize)) {
          freeBytes = sf.bavail * sf.bsize;
          totalBytes = sf.blocks * sf.bsize;
        }
      } catch {}
    }
    let gitBranch = null;
    try {
      const head = await fsp.readFile(path.join(real, '.git', 'HEAD'), 'utf8');
      const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
      gitBranch = m ? m[1].trim().slice(0, 80) : head.trim().slice(0, 12);
    } catch {}

    async function walk(dir, relFromRoot, depth) {
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
      const items = [];
      for (const e of ents) {
        const rel = relFromRoot ? path.join(relFromRoot, e.name) : e.name;
        if (denied(e.name) || (at && hidden(at.r, rel))) continue;
        if (e.isSymbolicLink()) continue;
        let st;
        try { st = await fsp.stat(path.join(dir, e.name)); } catch { continue; }
        items.push({ name: e.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: Math.round(st.mtimeMs), rel });
      }
      items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'));
      const out = [];
      for (const it of items) {
        if (count >= nodeCap) { truncated = true; break; }
        count++;
        const node = { name: it.name, dir: it.dir, size: it.size, mtime: it.mtime };
        if (it.dir) {
          const skip = SKIP_TREE_DIRS.has(WIN ? it.name.toLowerCase() : it.name);
          if (skip) node.skipped = true;
          else if (depth < depthCap) node.children = await walk(path.join(dir, it.name), it.rel, depth + 1);
        }
        out.push(node);
      }
      return out;
    }

    const children = await walk(real, at ? at.rel : '', 1);
    return { path: real, sep: path.sep, freeBytes, totalBytes, gitBranch, tree: children, count, truncated, scannedAt: Date.now() };
  }

  return { enabled, canUpload, roots, list, open, folder, writableFolder, target, resolve, tree };
}

module.exports = { createFiles, denied, MAX };
