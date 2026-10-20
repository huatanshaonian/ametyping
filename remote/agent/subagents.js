// The subagents a Claude Code session started (its Agent / Task tool, forks, workflow agents), read from their own
// transcripts: Claude Code writes each one next to the session's, as
//   ~/.claude/projects/<dir>/<session id>/subagents/agent-<agent id>.jsonl   (+ .meta.json: type, description...)
// Read-only, and only the head and the tail of each file; re-read only when the file changed.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX = 12;                       // agents listed per session: the running ones, then the newest
const RECENT_MS = 6 * 3600e3;         // finished agents are listed this long after their last line
const STALE_MS = 15 * 60e3;           // not finished and silent this long: stopped (a crash, a killed terminal)
const TAIL = 128 * 1024;

const cache = new Map();              // agent transcript -> { sig, row }

function readSlice(file, from, len) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, from); return b.toString('utf8', 0, n); }
  finally { fs.closeSync(fd); }
}
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// what a tool call is doing, in a few words
function actOf(tu) {
  const i = tu.input || {};
  const what = i.description || i.command || i.file_path || i.notebook_path || i.pattern || i.url || i.query || i.prompt || i.skill || '';
  return short(tu.name + (what ? '：' + (i.file_path ? path.basename(String(what)) : what) : ''), 120);
}

// -> { state: 'run' | 'done' | 'stop', act, end } from the last lines of an agent's transcript
function stateOf(lines, mtime, meta, now) {
  let act = '', toolOpen = false;
  for (let k = lines.length - 1; k >= 0; k--) {
    const o = lines[k];
    if (!o || (o.type !== 'user' && o.type !== 'assistant') || !o.message) continue;
    const c = o.message.content;
    const parts = Array.isArray(c) ? c : [{ type: 'text', text: String(c || '') }];
    if (o.type === 'user') {
      const tx = parts.find((p) => p.type === 'text' && /^\[Request interrupted/.test(p.text || ''));
      if (tx) return { state: 'stop', act: '被打断', end: Date.parse(o.timestamp) || mtime };
      if (!act && parts.some((p) => p.type === 'tool_result')) act = '思考中';
      continue;
    }
    const tu = parts.filter((p) => p.type === 'tool_use');
    if (tu.some((p) => p.name === 'SubagentHandback')) return { state: 'done', act: '', end: Date.parse(o.timestamp) || mtime };
    if (o.message.stop_reason === 'end_turn' && !tu.length && !act) return { state: 'done', act: '', end: Date.parse(o.timestamp) || mtime };
    if (tu.length && !act) { act = actOf(tu[tu.length - 1]); toolOpen = true; }
    if (act) break;
  }
  if (meta.finished) return { state: 'done', act: '', end: mtime };
  // (one long command can keep the file still for minutes: the bound is generous)
  if (now - mtime > STALE_MS) return { state: 'stop', act: '没有动静', end: mtime };
  return { state: 'run', act: act || (toolOpen ? '' : '思考中'), end: 0 };
}

function rowOf(file, st, now) {
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(file.slice(0, -6) + '.meta.json', 'utf8')); } catch {}
  const head = parse(readSlice(file, 0, Math.min(st.size, 64 * 1024)).split('\n')[0]) || {};
  const from = Math.max(0, st.size - TAIL);
  const tail = readSlice(file, from, st.size - from).split('\n');
  if (from > 0) tail.shift();                                        // (cut mid-line)
  const s = stateOf(tail.map(parse), st.mtimeMs, meta, now);
  return {
    id: path.basename(file).replace(/^agent-/, '').slice(0, -6).slice(0, 64),
    type: short(meta.agentType || 'agent', 40),
    name: meta.name ? short(meta.name, 40) : undefined,
    desc: short(meta.description, 120),
    bg: meta.requestShape === 'background' || undefined,
    state: s.state, act: s.act || undefined,
    t0: Date.parse(head.timestamp) || st.birthtimeMs || st.mtimeMs,
    last: st.mtimeMs, end: s.end || undefined,
  };
}

// the agents of the session whose transcript is `sessionFile` (<dir>/<id>.jsonl): running, or active in the last
// hours; running first, then newest first
function agentsOf(sessionFile, now = Date.now()) {
  const dir = path.join(sessionFile.slice(0, -6), 'subagents');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const rows = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const file = path.join(dir, n);
    let st; try { st = fs.statSync(file); } catch { continue; }
    // (an unfinished agent also turns stale with time alone, without its file changing)
    const sig = `${st.size}|${st.mtimeMs}|${now - st.mtimeMs > STALE_MS}`;
    let c = cache.get(file);
    if (!c || c.sig !== sig) {
      let row; try { row = rowOf(file, st, now); } catch { continue; }
      c = { sig, row }; cache.set(file, c);
    }
    c.seen = now;
    rows.push(c.row);
  }
  for (const [f, c] of cache) if (now - c.seen > 3600e3) cache.delete(f);
  return rows.filter((r) => r.state === 'run' || now - r.last < RECENT_MS)
    .sort((a, b) => (b.state === 'run') - (a.state === 'run') || b.t0 - a.t0).slice(0, MAX);
}

module.exports = { agentsOf, stateOf };
