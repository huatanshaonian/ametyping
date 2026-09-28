// Streams a session transcript to the dashboard server as slim records (../../app/transcript.js recordsOf:
// user / assistant text in full, tool calls as one line, tool output left out -- it never leaves this machine).
// Reading starts at the byte offset the server says it has stored, so neither side losing its state
// (restart, reconnect) loses or duplicates anything. Only complete lines are sent.
'use strict';
const fs = require('fs');
const { recordsOf } = require('../../app/transcript');

const MAX_READ = 4e6;          // bytes of transcript read per call
const MAX_BATCH = 800e3;       // approx. JSON size of one message to the server
const MAX_TEXT = 200e3;        // one record's text is cut beyond this (a huge paste)

function createReader(file, offset) {
  return { file, offset, skipping: false };
}

function slim(o) {
  return recordsOf(o).map((r, i) => {
    const rec = { u: o.uuid || null, i, role: r.role, t: r.t };
    if (r.text != null) rec.text = r.text.length > MAX_TEXT ? r.text.slice(0, MAX_TEXT) + '\n…（过长，已截断）' : r.text;
    if (r.items) rec.items = r.items;
    if (r.mid) rec.mid = r.mid;
    return rec;
  });
}

// the next batch after r.offset: { from, to, reset, recs } -- or null when nothing complete is new.
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
  for (;;) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    if (r.skipping) { r.skipping = false; pos = nl + 1; continue; }   // tail of a line too long to hold
    const line = buf.toString('utf8', pos, nl);
    let o = null;
    if (line.trim()) try { o = JSON.parse(line); } catch {}
    const add = o ? slim(o) : [];
    const addSize = add.length ? JSON.stringify(add).length : 0;
    if (recs.length && size + addSize > MAX_BATCH) break;             // the rest goes in the next batch
    recs.push(...add); size += addSize; pos = nl + 1;
  }
  if (pos === 0 && n === MAX_READ && buf.indexOf(10) < 0) {           // one line longer than MAX_READ: skip it
    r.skipping = true;
    return { from, to: from + n, reset, recs: [] };
  }
  if (pos === 0 && !reset) return null;                               // only an unfinished line so far
  return { from, to: from + pos, reset, recs };
}

module.exports = { createReader, readNext };
