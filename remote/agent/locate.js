// Where a file named in a conversation is (the dashboard's links to paths, public/js/apps/dash-paths.js). Claude writes
// paths from the folder it is in at that moment, which is often not the folder the session started in (it cd's into
// one branch of a project and back). Looked for, in this order:
//   1. from the folder the session was in when that message was written (every transcript line records it);
//   2. the full paths the session itself used that end in it (a Read / Write / Bash of /home/x/proj/docs/a.png);
//   3. from the other folders the session was in, and one or two folders above where it started;
//   4. still nothing: a bounded search below those folders (so many levels, so many folders, a few seconds).
// Only what files.js lets the dashboard see is ever given back; this reads the session's own transcript to find it.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');

const WIN = process.platform === 'win32';
const MAX_TRANSCRIPT = 400 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.cache', '.idea', '.vscode', '$RECYCLE.BIN', 'System Volume Information']);
const SEARCH = { depth: 6, dirs: 4000, ms: 4000, hits: 8 };

const key = (p) => (WIN ? p.toLowerCase() : p);
const isAbs = (p) => (WIN ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/'));

// the string values anywhere in a parsed transcript line
function strings(o, out, depth = 0) {
  if (typeof o === 'string') out.push(o);
  else if (o && typeof o === 'object' && depth < 12) for (const v of Array.isArray(o) ? o : Object.values(o)) strings(v, out, depth + 1);
  return out;
}

// one pass over the transcript: the folder at time `at`, every folder by how often, and full paths ending in `rel`
async function scan(file, rel, at) {
  const r = { cwdAt: '', cwds: new Map(), first: '', full: [] };
  let st; try { st = await fsp.stat(file); } catch { return r; }
  if (st.size > MAX_TRANSCRIPT) return r;
  const base = path.basename(rel);
  // a full path ending in rel, either separator; not glued to more name on either side
  const tail = rel.split(/[\\/]+/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
  const re = new RegExp(`(?:[A-Za-z]:[\\\\/]|/)(?:[^\\s"'<>|*?\\\\/:]+[\\\\/])*?${tail}(?![\\w.-])`, 'g');
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const c = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
    if (c) {
      let cwd; try { cwd = JSON.parse(`"${c[1]}"`); } catch { cwd = ''; }
      if (cwd) {
        if (!r.first) r.first = cwd;
        r.cwds.set(cwd, (r.cwds.get(cwd) || 0) + 1);
        const t = /"timestamp":"([^"]+)"/.exec(line);
        if (!at || !t || Date.parse(t[1]) <= at + 2000) r.cwdAt = cwd;
      }
    }
    if (line.includes(base)) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      for (const s of strings(o, [])) for (const m of s.matchAll(re)) r.full.push(m[0]);
    }
  }
  return r;
}

// a bounded walk below `dirs` for folders holding rel; onHit(full path)
async function search(dirs, rel, files, onHit) {
  const t0 = Date.now(), seen = new Set();
  let queue = dirs.map((d) => ({ d, n: 0 })), visited = 0, hits = 0;
  while (queue.length && visited < SEARCH.dirs && Date.now() - t0 < SEARCH.ms && hits < SEARCH.hits) {
    const { d, n } = queue.shift();
    if (seen.has(key(d))) continue;
    seen.add(key(d)); visited++;
    const p = path.join(d, rel);
    try { if ((await fsp.stat(p)).isFile() && await onHit(p)) hits++; } catch {}
    if (n >= SEARCH.depth) continue;
    let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) queue.push({ d: path.join(d, e.name), n: n + 1 });
  }
  return { visited, timedOut: Date.now() - t0 >= SEARCH.ms };
}

// -> { ok, found: [{ path, how: 'cwd'|'session'|'folder'|'search' }], cwd } or { ok:false, msg }
async function locate({ files, sessionFile }, { p, session, at }) {
  if (typeof p !== 'string' || !p || p.length > 4096) return { ok: false, msg: '路径不对' };
  const found = [], have = new Set();
  // (only files the dashboard may see, each once)
  const take = async (full, how) => {
    let real; try { real = await files.resolve(full); } catch { return false; }
    if (have.has(key(real))) return false;
    try { if (!(await fsp.stat(real)).isFile()) return false; } catch { return false; }
    have.add(key(real)); found.push({ path: real, how });
    return true;
  };
  if (isAbs(p)) {
    try { await files.resolve(p); } catch (e) { return { ok: false, msg: e.message }; }
    await take(p, 'abs');
    return found.length ? { ok: true, found } : { ok: false, msg: '这是文件夹' };
  }
  const rel = p.replace(/[\\/]+/g, path.sep).replace(/^\.[\\/]/, '');
  const f = session ? sessionFile(session) : null;
  if (!f) return { ok: false, msg: '这台电脑上找不到这个会话的记录' };
  const s = await scan(f.file, rel, Number.isFinite(at) ? at : 0);
  const start = s.first || f.cwd || '';
  // 1. where it was when it said it
  if (s.cwdAt && await take(path.join(s.cwdAt, rel), 'cwd')) return { ok: true, found, cwd: s.cwdAt };
  // 2. the full paths it used (the latest first)
  for (const full of [...s.full].reverse()) await take(full, 'session');
  if (found.length) return { ok: true, found, cwd: s.cwdAt };
  // 3. its other folders, the most used first; above where it started
  const folders = [...s.cwds.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  for (let d = start, k = 0; d && k < 2; k++) { const up = path.dirname(d); if (up === d) break; folders.push(up); d = up; }
  for (const d of folders) await take(path.join(d, rel), 'folder');
  if (found.length) return { ok: true, found, cwd: s.cwdAt };
  // 4. below where it started and where it was, and the folder above where it started (a session started inside one
  // branch of a project, naming a file of another) -- inside what may be browsed
  const roots = [];
  for (const d of [start, s.cwdAt, start && path.dirname(start)]) { if (!d) continue; try { roots.push(await files.resolve(d)); } catch {} }
  const r = roots.length ? await search(roots, rel, files, (full) => take(full, 'search')) : { visited: 0 };
  if (found.length) return { ok: true, found, cwd: s.cwdAt };
  return { ok: false, msg: `找不到 ${p}（找过：${s.cwdAt || start || '会话文件夹'}、会话里用过的路径${roots.length ? `，以及 ${roots[0]} 下面 ${r.visited} 个文件夹` : ''}${r.timedOut ? '，搜到时间上限' : ''}）` };
}

module.exports = { locate, scan, SEARCH };
