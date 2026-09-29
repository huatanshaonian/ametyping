// One session's stored records (store.records) -> what the daily summary needs from it:
//   facts  worked minutes, files written / edited (full paths), commands run, the last task list, plans written
//   text   a condensed transcript for the model: what you said in full, replies shortened (the last one kept
//          longer, it usually states the result), runs of tool calls folded into one line
'use strict';
const path = require('path');

const GAP_MS = 15 * 60e3;          // pauses longer than this do not count as working time
const USER_MAX = 1500, REPLY_MAX = 500, LAST_REPLY_MAX = 1500;

const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const short = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, Math.round(n * 0.7)) + ' … ' + s.slice(-Math.round(n * 0.3)) : s; };
const oneLine = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// a path as written by the tool, made absolute against the session's folder when it is relative
function absPath(p, cwd) {
  if (!p || !cwd || /^([A-Za-z]:[\\/]|\/|\\\\)/.test(p)) return p;
  return /^[A-Za-z]:[\\/]/.test(cwd) ? path.win32.join(cwd, p) : path.posix.join(cwd, p);
}

function activeMinutes(recs) {
  let ms = 0;
  for (let i = 1; i < recs.length; i++) { const d = recs[i].t - recs[i - 1].t; if (d > 0 && d <= GAP_MS) ms += d; }
  return Math.max(recs.length ? 1 : 0, Math.round(ms / 60e3));
}

// runs of tool records -> "运行 ×5：a；b · 修改 x.js、y.js"
function toolSummary(tools) {
  const lines = tools.flatMap((r) => r.items || []);
  const groups = new Map();
  for (const l of lines) { const [verb, ...rest] = l.split(' '); if (!groups.has(verb)) groups.set(verb, []); groups.get(verb).push(rest.join(' ')); }
  return [...groups].map(([verb, objs]) => {
    const uniq = [...new Set(objs.filter(Boolean))];
    const shown = uniq.slice(0, verb === '运行' ? 4 : 6).map((o) => oneLine(o, 60)).join('、');
    return `${verb}${objs.length > 1 ? ' ×' + objs.length : ''}${shown ? '：' + shown : ''}${uniq.length > 6 ? ' 等' : ''}`;
  }).join(' · ');
}

// s: { machine, id, title, project, cwd }, recs: records in the window (oldest first)
function digest(s, recs, opts = {}) {
  const userMax = opts.userMax || USER_MAX, replyMax = opts.replyMax || REPLY_MAX;
  const files = new Map(), cmds = [], plans = [];
  let todos = null; const tasks = [];
  let userMsgs = 0;
  for (const r of recs) {
    const x = r.x;
    if (!x) continue;
    if ((x.op === 'edit' || x.op === 'write') && x.p) for (const p of x.p) { const a = absPath(p, s.cwd); files.set(a, files.get(a) === 'write' ? 'write' : x.op); }
    else if (x.op === 'cmd' && x.cmd) cmds.push(x.cmd);
    else if (x.op === 'todo' && x.todos) todos = x.todos;
    else if (x.op === 'task' && x.task) {
      // TaskCreate numbers tasks 1, 2, ... in order; TaskUpdate names them "#n"
      const m = /^#(\d+)$/.exec(x.task[0]);
      if (m && tasks[m[1] - 1]) tasks[m[1] - 1][1] = x.task[1];
      else if (!m) tasks.push([x.task[0], x.task[1]]);
    } else if (x.op === 'plan' && x.plan) plans.push({ t: r.t, title: oneLine((/^#+\s*(.+)$/m.exec(x.plan) || [, x.plan])[1], 80), text: x.plan });
  }
  const lastReply = [...recs].reverse().find((r) => r.role === 'assistant');
  const out = [];
  let tools = [];
  const flushTools = () => { if (tools.length) { out.push(`  · ${toolSummary(tools)}`); tools = []; } };
  let lastMid = null;
  for (const r of recs) {
    if (r.role === 'tool') { tools.push(r); continue; }
    if (r.role === 'title') continue;
    flushTools();
    if (r.role === 'user') { userMsgs++; out.push(`[${hhmm(r.t)}] 我：${short(r.text, userMax)}`); lastMid = null; }
    else if (r.role === 'assistant') {
      const text = short(r.text, r === lastReply ? LAST_REPLY_MAX : replyMax);
      if (r.mid && r.mid === lastMid) out[out.length - 1] += ' ' + text;
      else out.push(`[${hhmm(r.t)}] 助手：${text}`);
      lastMid = r.mid || null;
    } else if (r.role === 'sys') out.push(`（${oneLine(r.text, 80)}）`);
  }
  flushTools();
  const todoList = todos || (tasks.length ? tasks : null);
  if (todoList) out.push('最后的任务列表：' + todoList.map(([c, st]) => `[${st === 'completed' ? 'x' : ' '}] ${oneLine(c, 100)}`).join('；'));
  for (const p of plans) out.push(`写了计划「${p.title}」：${short(p.text, 1200)}`);
  return {
    machine: s.machine, id: s.id, title: s.title || '', project: s.project || '', cwd: s.cwd || '',
    first: recs.length ? recs[0].t : 0, last: recs.length ? recs[recs.length - 1].t : 0,
    activeMin: activeMinutes(recs), userMsgs,
    files: [...files].map(([p, op]) => ({ path: p, op })),
    cmds: cmds.length, cmdSamples: [...new Set(cmds.map((c) => oneLine(c, 150)))].slice(0, 15),
    todos: todoList || [], plans: plans.map((p) => ({ title: p.title, t: p.t })),
    text: out.join('\n'),
  };
}

module.exports = { digest, activeMinutes, absPath };
