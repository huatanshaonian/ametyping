// Codex child threads use their own rollouts. Present them in the same dashboard rows as Claude's subagents.
'use strict';
const fs = require('fs');
const codex = require('../../app/codex-records');
const cache = new Map();
const STALE = 15 * 60e3, RECENT = 6 * 3600e3;
const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function read(file, mtime, now) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const sig = `${st.size}|${mtime}|${now - mtime > STALE}`;
  const old = cache.get(file);
  if (old && old.sig === sig) { old.seen = now; return old.row; }
  const meta = codex.metadataOf(file);
  if (!meta) return null;
  const spawn = meta.source && meta.source.subagent && meta.source.subagent.spawn || {};
  const parent = meta.parent_thread_id || spawn.parent_thread_id;
  if (!parent) return null;
  const from = Math.max(0, st.size - 128 * 1024), buf = Buffer.alloc(st.size - from), fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (from) lines.shift();
  let state = now - mtime > STALE ? 'stop' : 'run', act = '思考中', t0 = mtime;
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {}, t = Date.parse(o.timestamp);
    if (Number.isFinite(t)) t0 = Math.min(t0, t);
    if (o.type === 'event_msg') {
      if (p.type === 'task_started' || p.type === 'turn_started' || p.type === 'user_message') { state = 'run'; act = '思考中'; }
      if (p.type === 'task_complete' || p.type === 'turn_complete') { state = 'done'; act = ''; }
      if (p.type === 'turn_aborted') { state = 'stop'; act = '被打断'; }
    }
    if (o.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
      act = (codex.recordsOf(o)[0] || {}).items?.[0] || '工作中';
    }
    if (o.type === 'response_item' && p.type === 'message' && p.role === 'assistant' && p.phase === 'final_answer') { state = 'done'; act = ''; }
  }
  if (state === 'run' && now - mtime > STALE) { state = 'stop'; act = '没有动静'; }
  const row = { parent, id: String(meta.id).slice(0, 64), type: short(meta.agent_role || spawn.agent_role || 'agent', 40),
    name: short(meta.agent_nickname || spawn.agent_nickname, 40) || undefined, desc: '', state,
    act: short(act, 120) || undefined, t0, last: mtime, end: state === 'run' ? undefined : mtime };
  cache.set(file, { sig, row, seen: now });
  return row;
}
function scan(files, now = Date.now()) {
  const groups = new Map();
  for (const { file, mtime } of files) {
    let row; try { row = read(file, mtime, now); } catch { continue; }
    if (!row || (row.state !== 'run' && now - row.last >= RECENT)) continue;
    const id = 'codex:' + row.parent;
    if (!groups.has(id)) groups.set(id, []);
    const { parent, ...data } = row;
    groups.get(id).push(data);
  }
  for (const [id, rows] of groups) groups.set(id, rows.sort((a, b) => (b.state === 'run') - (a.state === 'run') || b.t0 - a.t0).slice(0, 12));
  for (const [file, c] of cache) if (now - c.seen > 3600e3) cache.delete(file);
  return groups;
}
module.exports = { scan };
