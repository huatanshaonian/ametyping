// Streams a session transcript to the dashboard server as slim records (../../app/transcript.js recordsOf:
// user / assistant text in full, tool calls as one line, tool output left out -- it never leaves this machine).
// Reading starts at the byte offset the server says it has stored, so neither side losing its state
// (restart, reconnect) loses or duplicates anything. Only complete lines are sent.
'use strict';
const fs = require('fs');
const { recordsOf, forkLookup } = require('../../app/transcript');

const MAX_READ = 4e6;          // bytes of transcript read per call
const MAX_BATCH = 800e3;       // approx. JSON size of one message to the server
const MAX_TEXT = 200e3;        // one record's text is cut beyond this (a huge paste)

const NL = String.fromCharCode(10);
const cwdOf = (l) => { try { const o = JSON.parse(l); return o && typeof o.cwd === 'string' && o.cwd ? o.cwd : null; } catch { return null; } };
// the working directory a transcript starts in: the first line that carries one. Most lines do, but a session copied
// from another (a background session, a fork) can begin with hundreds of kilobytes of lines that do not (file-history
// snapshots) -- so it is read on, a piece at a time, until one is found (4 MB at most).
function firstCwd(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(262144); let rest = '', pos = 0;
    while (pos < 4e6) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos); if (n <= 0) break;
      pos += n;
      const ls = (rest + buf.toString('latin1', 0, n)).split(NL);
      rest = ls.pop();                                              // (a line still going on in the next piece)
      for (const l of ls) { const c = cwdOf(Buffer.from(l, 'latin1').toString('utf8')); if (c) return c; }
    }
    return cwdOf(Buffer.from(rest, 'latin1').toString('utf8'));
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}
// the working directory a transcript ends in (a session can move: /cd, a worktree) -- where to open it again
function lastCwd(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 1048576), buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, size - len);
    const ls = buf.toString('latin1', 0, n).split(NL);
    for (let i = ls.length - 1; i >= (size > len ? 1 : 0); i--) { const c = cwdOf(Buffer.from(ls[i], 'latin1').toString('utf8')); if (c) return c; }
  } catch {} finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  return firstCwd(file);
}

// parse: one parsed line -> records (Claude Code's recordsOf by default; codex-records.js for Codex sessions)
function createReader(file, offset, parse = recordsOf) {
  // (forkLookup: a /btw answer whose question was before the offset this reader started at -- see app/transcript.js)
  return { file, offset, skipping: false, parse, cwd: parse === recordsOf ? firstCwd(file) : null, forkLookup: parse === recordsOf ? forkLookup(file) : null };
}

// t0: for a line without its own timestamp (title, permission mode), the time of the line before it in the file --
// not "now", which would make an old session look active when its history is streamed later
function slim(o, parse, t0, st) {
  return parse(o, st).map((r, i) => {
    const rec = { u: o.uuid || (o.payload && (o.payload.id || o.payload.call_id)) || null, i, role: r.role, t: o.timestamp || !t0 ? r.t : t0 };
    if (r.text != null) rec.text = r.text.length > MAX_TEXT ? r.text.slice(0, MAX_TEXT) + '\n…（过长，已截断）' : r.text;
    if (r.items) rec.items = r.items;
    if (r.mid) rec.mid = r.mid;
    if (r.x) rec.x = r.x;
    return rec;
  });
}

// the next batch after r.offset: { from, to, reset, recs, cwd } -- or null when nothing complete is new.
// cwd: the directory the session was started in (how to resume it later).
// The caller advances r.offset = to once it has sent the batch.
function readNext(r) {
  let st; try { st = fs.statSync(r.file); } catch { return null; }
  let reset = false;
  if (st.size < r.offset) { r.offset = 0; r.skipping = false; reset = true; }   // the file was rewritten
  if (st.size === r.offset) return reset ? { from: 0, to: 0, reset, recs: [] } : null;
  const n = Math.min(st.size - r.offset, MAX_READ);
  const buf = Buffer.alloc(n);
  const fd = fs.openSync(r.file, 'r');
  try { fs.readSync(fd, buf, 0, n, r.offset); } finally { fs.closeSync(fd); }
  const from = r.offset;
  let pos = 0, size = 0;
  const recs = [];
  // lines before the first timestamped one (a transcript starts with its permission mode) take that first timestamp
  if (!r.lastT) { const m = /"timestamp":"([^"]+)"/.exec(buf.toString('utf8', 0, Math.min(n, 1e6))); if (m && Number.isFinite(Date.parse(m[1]))) r.lastT = Date.parse(m[1]); }
  for (;;) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    if (r.skipping) { r.skipping = false; pos = nl + 1; continue; }   // tail of a line too long to hold
    const line = buf.toString('utf8', pos, nl);
    let o = null;
    if (line.trim()) try { o = JSON.parse(line); } catch {}
    // the directory the session was started in (later lines follow any cd): `claude --resume` looks it up from there
    if (!r.cwd && o && typeof o.cwd === 'string' && o.cwd) r.cwd = o.cwd;
    if (o && o.timestamp) { const t = Date.parse(o.timestamp); if (Number.isFinite(t)) r.lastT = t; }
    const add = o ? slim(o, r.parse || recordsOf, r.lastT, r) : [];   // (the reader keeps the /btw pairing)
    for (const a of add) if (a.role === 'ctx' && a.text.endsWith('/0')) a.text = a.text.split('/')[0] + '/' + CLAUDE_WINDOW;
    const addSize = add.length ? JSON.stringify(add).length : 0;
    if (recs.length && size + addSize > MAX_BATCH) break;             // the rest goes in the next batch
    recs.push(...add); size += addSize; pos = nl + 1;
  }
  if (pos === 0 && n === MAX_READ && buf.indexOf(10) < 0) {           // one line longer than MAX_READ: skip it
    r.skipping = true;
    return { from, to: from + n, reset, recs: [], cwd: r.cwd };
  }
  if (pos === 0 && !reset) return null;                               // only an unfinished line so far
  return { from, to: from + pos, reset, recs, cwd: r.cwd };
}

// a Claude Code session's context window, which its transcript does not record: 1M, as the current models have (all
// but Haiku, which the transcript reader marks itself: app/transcript.js)
const CLAUDE_WINDOW = 1e6;

module.exports = { createReader, readNext, firstCwd, lastCwd };
