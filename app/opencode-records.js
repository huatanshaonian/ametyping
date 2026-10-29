// OpenCode sessions as the same slim records as Claude Code's (app/transcript.js recordsOf) and Codex's
// (app/codex-records.js): the records themselves are written by the OpenCode plugin
// (../opencode-plugin/index.js) into ~/.ametyping/opencode/sessions/<id>.jsonl, one JSON object per line --
// what you and the model said in full, each tool call as one line, tool output and reasoning left out.
// This module only reads that mirror: it is the plugin's own append-only format, independent of OpenCode's
// internal database, so an OpenCode upgrade cannot change what the panel and the dashboard parse.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.OPENCODE_AME_HOME || path.join(os.homedir(), '.ametyping', 'opencode');
const SESSIONS = path.join(ROOT, 'sessions');
const META = 'meta';

// the mirror's records are already slim (protocol.js recordsForMessages); pass them through
function recordsOf(o) {
  if (!o || typeof o !== 'object' || o.type === META) return [];
  const t = o.timestamp ? Date.parse(o.timestamp) : Date.now();
  const r = { role: o.role, t: Number.isFinite(t) ? t : Date.now() };
  if (typeof o.uuid === 'string') { r.u = o.uuid; r.i = +o.i || 0; }   // (dedupe key for the panel's merge)
  if (typeof o.text === 'string') r.text = o.text;
  if (Array.isArray(o.items)) r.items = o.items;
  if (typeof o.mid === 'string') r.mid = o.mid;
  if (o.x && typeof o.x === 'object') r.x = o.x;
  return [r];
}

const metaCache = new Map();   // file -> { mtime, meta }
function metadataOf(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = metaCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.meta;
  let meta = null;
  try {
    const fd = fs.openSync(file, 'r');
    let buf;
    try { buf = Buffer.alloc(Math.min(st.size, 65536)); fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const line = buf.toString('utf8').split('\n').find((l) => l.trim());
    if (line) {
      const o = JSON.parse(line);
      if (o && o.type === META && typeof o.id === 'string' && o.id) meta = { id: o.id, cwd: typeof o.cwd === 'string' ? o.cwd : '', title: typeof o.title === 'string' ? o.title : '' };
    }
  } catch {}
  if (!meta) {                                  // a mirror whose first line is still being written: the file name is the id
    const id = path.basename(file).replace(/\.jsonl$/i, '');
    if (/^ses_[A-Za-z0-9]+$/.test(id)) meta = { id, cwd: '', title: '' };
  }
  metaCache.set(file, { mtime: st.mtimeMs, meta });
  return meta;
}
function metaOf(file) {
  const m = metadataOf(file);
  return m ? { id: m.id, cwd: m.cwd, title: m.title } : null;
}

// every mirror file, newest first
function allFiles() {
  let ents = [];
  try { ents = fs.readdirSync(SESSIONS, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const file = path.join(SESSIONS, e.name);
    let st; try { st = fs.statSync(file); } catch { continue; }
    out.push({ file, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function recentFiles(withinMs) {
  const now = Date.now();
  return allFiles().filter((f) => now - f.mtime <= withinMs);
}
function fileOf(id) {
  const raw = String(id || '').replace(/^opencode:/, '');
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const file = path.join(SESSIONS, `${raw}.jsonl`);
  return fs.existsSync(file) ? file : null;
}
function titleOf(id) {
  const file = fileOf(id);
  if (!file) return '';
  // renames are appended as title records; the first line keeps the title it started with
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 65536);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"role":"title"')) continue;
      try { const o = JSON.parse(lines[i]); if (o && o.role === 'title' && typeof o.text === 'string') return o.text; } catch {}
    }
  } catch {}
  const m = metaOf(file);
  return m && m.title ? m.title : '';
}

module.exports = { ROOT, SESSIONS, recordsOf, metadataOf, metaOf, allFiles, recentFiles, fileOf, titleOf, META };
