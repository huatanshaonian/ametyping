// Antigravity (agy) subagent scanner.
// Scans <root>/brain/<parentId>/.system_generated/subagents/<subId>.json and
// tails <root>/brain/<subId>/.system_generated/logs/transcript.jsonl.
// Modeled after remote/agent/codex-subagents.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const agy = require('../../app/agy-records');
const { describeTool, parseArgs } = require('../../agy-hook');

const cache = new Map();
const STALE = 15 * 60e3, RECENT = 6 * 3600e3;
const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function readSubagent(descPath, parentId, subId, brainDir, now) {
  let descSt;
  try { descSt = fs.statSync(descPath); } catch { return null; }
  let descData;
  try { descData = JSON.parse(fs.readFileSync(descPath, 'utf8')); } catch { return null; }
  const subDesc = descData.subagentDescriptor || {};
  const descState = descData.state || '';

  const transPath = path.join(brainDir, subId, '.system_generated', 'logs', 'transcript.jsonl');
  let st;
  try { st = fs.statSync(transPath); } catch {
    // If no transcript yet, use descriptor info
    const t0 = descSt.mtimeMs;
    const isStop = descState === 'SUBAGENT_STATE_KILLED' || descState === 'KILLED';
    const isDone = descState === 'SUBAGENT_STATE_COMPLETED' || descState === 'COMPLETED';
    const state = isStop ? 'stop' : (isDone ? 'done' : (now - t0 > STALE ? 'stop' : 'run'));
    return {
      id: subId,
      type: short(subDesc.typeName || 'subagent', 40),
      name: short(subDesc.role || '', 40) || undefined,
      desc: '',
      state,
      act: state === 'run' ? '启动中' : undefined,
      t0,
      last: t0,
      end: state === 'run' ? undefined : t0,
    };
  }

  const sig = `${st.size}|${st.mtimeMs}|${now - st.mtimeMs > STALE}|${descState}`;
  const old = cache.get(transPath);
  if (old && old.sig === sig) {
    old.seen = now;
    return old.row;
  }

  const from = Math.max(0, st.size - 128 * 1024);
  const buf = Buffer.alloc(st.size - from);
  const fd = fs.openSync(transPath, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (from) lines.shift();

  const mtime = st.mtimeMs;
  let t0 = mtime, last = mtime;
  let isDone = descState === 'SUBAGENT_STATE_COMPLETED' || descState === 'COMPLETED';
  let isStop = descState === 'SUBAGENT_STATE_KILLED' || descState === 'KILLED';
  let state = isStop ? 'stop' : (isDone ? 'done' : (now - mtime > STALE ? 'stop' : 'run'));
  let act = state === 'run' ? '思考中' : (isStop ? '已停止' : '');

  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = o.created_at ? Date.parse(o.created_at) : (o.timestamp ? Date.parse(o.timestamp) : NaN);
    if (Number.isFinite(t)) {
      t0 = Math.min(t0, t);
      last = Math.max(last, t);
    }
    if (o.type === 'USER_INPUT') {
      state = 'run';
      act = '思考中';
    } else if (o.type === 'PLANNER_RESPONSE') {
      if (Array.isArray(o.tool_calls) && o.tool_calls.length) {
        const tc = o.tool_calls[o.tool_calls.length - 1];
        const args = parseArgs(tc.args || tc.input || tc.arguments);
        act = describeTool(tc.name, args);
        state = 'run';
      }
      if (o.status === 'ERROR') {
        state = 'stop';
        act = '出错了';
      } else if (o.status === 'DONE' && (!o.tool_calls || !o.tool_calls.length)) {
        if (!isStop) {
          state = 'done';
          act = '';
        }
      }
    } else if (o.status === 'ABORTED' || o.status === 'USER_CANCELED') {
      state = 'stop';
      act = '被打断';
    }
  }

  if (state === 'run' && now - mtime > STALE) {
    state = 'stop';
    act = '没有动静';
  }

  const row = {
    id: subId,
    type: short(subDesc.typeName || 'subagent', 40),
    name: short(subDesc.role || '', 40) || undefined,
    desc: '',
    state,
    act: short(act, 120) || undefined,
    t0,
    last,
    end: state === 'run' ? undefined : last,
  };

  cache.set(transPath, { sig, row, seen: now });
  return row;
}

function scan(files, now = Date.now(), home = os.homedir()) {
  if (typeof files === 'string') {
    home = files;
    files = null;
  } else if (typeof files === 'number') {
    now = files;
    files = null;
  }
  const groups = new Map();
  const roots = agy.agyRoots(home);

  for (const root of roots) {
    const brainDir = path.join(root, 'brain');
    let parentEntries = [];
    try { parentEntries = fs.readdirSync(brainDir, { withFileTypes: true }); } catch { continue; }

    for (const pEnt of parentEntries) {
      if (!pEnt.isDirectory()) continue;
      const parentId = pEnt.name;
      const subagentsDir = path.join(brainDir, parentId, '.system_generated', 'subagents');
      let subFiles = [];
      try { subFiles = fs.readdirSync(subagentsDir, { withFileTypes: true }); } catch { continue; }

      for (const sEnt of subFiles) {
        if (!sEnt.isFile() || !sEnt.name.endsWith('.json')) continue;
        const subId = sEnt.name.slice(0, -5);
        const descPath = path.join(subagentsDir, sEnt.name);

        let row;
        try { row = readSubagent(descPath, parentId, subId, brainDir, now); } catch { continue; }
        if (!row || (row.state !== 'run' && now - row.last >= RECENT)) continue;

        const gid = 'agy:' + parentId;
        if (!groups.has(gid)) groups.set(gid, []);
        groups.get(gid).push(row);
      }
    }
  }

  for (const [id, rows] of groups) {
    groups.set(id, rows.sort((a, b) => (b.state === 'run') - (a.state === 'run') || b.t0 - a.t0).slice(0, 12));
  }

  for (const [transPath, c] of cache) {
    if (now - c.seen > 3600e3) cache.delete(transPath);
  }

  return groups;
}

module.exports = { scan };
