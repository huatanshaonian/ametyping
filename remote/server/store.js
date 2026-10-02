// Conversation store: the slim records agents stream in (remote/agent/records.js) are kept on disk for good --
// the basis for later features such as a daily work summary. Memory only holds what is being looked at.
//   <dir>/<YYYY-MM-DD>/<machine>/<session>.jsonl   one record per line, filed under the day it was said (server time)
//   <dir>/state.json                               per machine / session: stored byte offset, project, title, cwd,
//                                                  days, first / last activity -- the dashboard lists every session from it
// Records are buffered and appended every FLUSH_MS; state.json is rewritten only after the appends, so after a
// crash the offsets never run ahead of the files and the agent simply sends the lost part again.
'use strict';
const fs = require('fs');
const path = require('path');

const FLUSH_MS = +process.env.AME_FLUSH_MS || 10e3;   // tests shorten it
const TAIL = 300;              // display messages kept per open conversation
const MAX_TAILS = 40;          // open conversations kept in memory

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || '_';
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(Number.isFinite(t) ? t : Date.now()); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// the panel's merge (app/transcript.js mergeRecords): a reply streamed in parts is one message, consecutive
// tool calls one group; title records are metadata
function merge(out, recs) {
  for (const r of recs) {
    if (r.role === 'title' || r.role === 'mode' || r.role === 'ctx') continue;
    const last = out[out.length - 1];
    if (r.role === 'assistant' && last && last.role === 'assistant' && last.mid && last.mid === r.mid) last.text += '\n\n' + r.text;
    else if (r.role === 'tool' && last && last.role === 'tool') { last.items = last.items.concat(r.items || []); last.t = r.t; }
    else out.push({ role: r.role, text: r.text, items: r.items ? [...r.items] : undefined, t: r.t, mid: r.mid });
  }
  if (out.length > TAIL) out.splice(0, out.length - TAIL);
}
const ROLES = new Set(['user', 'assistant', 'tool', 'sys', 'title', 'mode', 'ctx', 'btw']);
function clean(r) {
  if (!r || !ROLES.has(r.role)) return null;
  const o = { u: typeof r.u === 'string' ? r.u.slice(0, 64) : null, i: +r.i || 0, role: r.role, t: +r.t || Date.now() };
  if (typeof r.text === 'string') o.text = r.text.slice(0, 250e3);
  if (Array.isArray(r.items)) o.items = r.items.slice(0, 200).map((x) => String(x).slice(0, 300));
  if (typeof r.mid === 'string') o.mid = r.mid.slice(0, 64);
  const x = cleanX(r.x);
  if (x) o.x = x;
  return o;
}
// a tool record's detail (see app/transcript.js toolExtra), size-capped
const s = (v, n) => String(v == null ? '' : v).slice(0, n);
function cleanX(x) {
  if (!x || typeof x !== 'object' || typeof x.op !== 'string') return null;
  const o = { op: s(x.op, 8) };
  if (Array.isArray(x.p)) o.p = x.p.slice(0, 50).map((v) => s(v, 500)).filter(Boolean);
  if (typeof x.cmd === 'string') o.cmd = s(x.cmd, 1000);
  if (Array.isArray(x.todos)) o.todos = x.todos.slice(0, 50).map((t) => [s(t && t[0], 300), s(t && t[1], 20)]);
  if (Array.isArray(x.task)) o.task = [s(x.task[0], 300), s(x.task[1], 20)];
  if (typeof x.plan === 'string') o.plan = s(x.plan, 40000);
  return o;
}

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(dir, 'state.json');
  let state = {};                                    // machine -> id -> { off, project, title, cwd, days[], first, last }
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const pending = new Map();                         // file -> [lines]
  const tails = new Map();                           // "machine|id" -> { msgs, used }
  let dirty = false;

  const entry = (m, id) => ((state[m] = state[m] || {})[id] = state[m][id] || { off: 0, project: '', title: '', days: [], last: 0 });
  const fileOf = (day, m, id) => path.join(dir, day, safe(m), safe(id) + '.jsonl');

  // a batch from an agent; returns { ok } or { resync: offset } when it does not continue where we stand
  function accept(m, d) {
    if (typeof d.id !== 'string' || !d.id || !Number.isFinite(d.from) || !Number.isFinite(d.to) || d.to < d.from) return { ok: false };
    const e = entry(m, d.id);
    if (d.reset) e.off = d.from;
    if (d.from !== e.off) return { resync: e.off };
    const recs = (Array.isArray(d.recs) ? d.recs : []).map(clean).filter(Boolean);
    let modeChanged = false;
    for (const r of recs) {
      // how full the context is ("used/window", app/transcript.js): only the latest is kept, in the state, not the log;
      // a change of a whole percent is worth showing
      if (r.role === 'ctx') {
        const [used, win] = String(r.text || '').split('/').map(Number);
        if (!(used > 0) || !(win > 0)) continue;
        const pct = (c) => (c ? Math.floor((c.used / c.win) * 100) : -1);
        const next = { used: Math.round(used), win: Math.round(win), t: r.t };
        if (pct(next) !== pct(e.ctx)) modeChanged = true;
        e.ctx = next;
        continue;
      }
      // Claude Code writes the same title line again and again; only a change is worth keeping
      if (r.role === 'title' && (!r.text || r.text.slice(0, 80) === e.title)) continue;
      // the permission mode is written around every message: keep only changes
      if (r.role === 'mode') { if (!r.text || r.text === e.mode) continue; e.mode = r.text.slice(0, 24); modeChanged = true; }
      const day = dayOf(r.t);
      if (!e.days.includes(day)) { e.days.push(day); e.days.sort(); }
      const f = fileOf(day, m, d.id);
      if (!pending.has(f)) pending.set(f, []);
      pending.get(f).push(JSON.stringify(r));
      if (r.role === 'title' && r.text) e.title = r.text.slice(0, 80);
    }
    e.off = d.to;
    if (typeof d.project === 'string' && d.project) e.project = d.project.slice(0, 60);
    if (typeof d.title === 'string' && d.title) e.title = d.title.slice(0, 80);
    if (typeof d.cwd === 'string' && d.cwd) e.cwd = d.cwd.slice(0, 500);
    if (recs.length) {
      e.last = Math.max(e.last, recs[recs.length - 1].t);
      if (!e.first || recs[0].t < e.first) e.first = recs[0].t;
    }
    dirty = true;
    const tail = tails.get(`${m}|${d.id}`);
    if (tail) merge(tail.msgs, recs);
    return { ok: true, changed: recs.length > 0, modeChanged };
  }

  function flush() {
    for (const [f, lines] of pending) {
      try { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.appendFileSync(f, lines.join('\n') + '\n', { mode: 0o600 }); }
      catch (e) { console.error(`写入 ${f} 失败：${e.message}`); return; }  // keep pending; state stays behind the files
      pending.delete(f);
    }
    if (!dirty) return;
    try {
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(stateFile + '.tmp', stateFile);
      dirty = false;
    } catch (e) { console.error('写入 state.json 失败：' + e.message); }
  }
  const timer = setInterval(flush, FLUSH_MS);
  timer.unref();

  // the conversation as the dashboard shows it (last TAIL messages); loaded from disk on first look
  function tail(m, id) {
    const key = `${m}|${id}`;
    let t = tails.get(key);
    if (!t) {
      const e = state[m] && state[m][id];
      if (!e) return null;
      flush();                                        // what is still buffered belongs to the history too
      const chunks = [];
      let n = 0;
      for (const day of [...e.days].reverse()) {      // newest day first, until there is enough
        let lines = [];
        try { lines = fs.readFileSync(fileOf(day, m, id), 'utf8').split('\n'); } catch {}
        const recs = [];
        for (const l of lines) { if (!l) continue; try { recs.push(JSON.parse(l)); } catch {} }
        chunks.unshift(recs); n += recs.length;
        if (n > TAIL * 3) break;
      }
      t = { msgs: [], used: Date.now() };
      for (const recs of chunks) merge(t.msgs, recs);
      tails.set(key, t);
      if (tails.size > MAX_TAILS) {                   // forget the least recently looked-at ones
        const old = [...tails.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, tails.size - MAX_TAILS);
        for (const [k] of old) if (k !== key) tails.delete(k);
      }
    }
    t.used = Date.now();
    return t.msgs;
  }

  // project / title / cwd reported without new lines (a session that was already fully stored)
  function meta(m, id, d) {
    const e = state[m] && state[m][id];
    if (!e) return;
    let changed = false;
    for (const [k, n] of [['project', 60], ['title', 80], ['cwd', 500]]) {
      if (typeof d[k] === 'string' && d[k] && e[k] !== d[k].slice(0, n)) { e[k] = d[k].slice(0, n); changed = true; }
    }
    if (changed) dirty = true;
  }
  // every stored session that has said something: machine -> [{ id, project, title, cwd, first, last }]
  function sessions() {
    const out = {};
    for (const [m, ids] of Object.entries(state)) {
      out[m] = Object.entries(ids).filter(([, e]) => e.last > 0)
        .map(([id, e]) => ({ id, project: e.project, title: e.title, cwd: e.cwd || '', first: e.first || e.last, last: e.last, mode: e.mode || '', ctx: e.ctx || null }));
    }
    return out;
  }

  // the stored records of one session said in [from, to), oldest first (for the daily summary)
  function records(m, id, from, to) {
    const e = state[m] && state[m][id];
    if (!e || e.last < from || (e.first || e.last) >= to) return [];
    flush();
    const out = [];
    for (const day of e.days) {
      if (day < dayOf(from) || day > dayOf(to)) continue;
      let lines = [];
      try { lines = fs.readFileSync(fileOf(day, m, id), 'utf8').split('\n'); } catch {}
      for (const l of lines) {
        if (!l) continue;
        let r; try { r = JSON.parse(l); } catch { continue; }
        if (r.t >= from && r.t < to) out.push(r);
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }
  // the newest record time over every machine and session
  const lastActivity = () => Math.max(0, ...Object.values(state).flatMap((ids) => Object.values(ids).map((e) => e.last || 0)));

  const offsets = (m) => Object.fromEntries(Object.entries(state[m] || {}).map(([id, e]) => [id, e.off]));
  const has = (m, id) => !!(state[m] && state[m][id]);
  return { accept, meta, flush, tail, offsets, has, sessions, records, lastActivity };
}

module.exports = { createStore };
