// What is worth a phone notification, from what the dashboard already knows (server.js hands it in):
//   sessions(machine, sessions, control)  approval: a permission prompt appeared (only where it can be answered from
//                                         here); done: a session that worked at least DONE_MIN stopped
//   ctx(machine, id, ctx, label)          a session's context fell to CTX_LOW% (once, until it is above CTX_RESET% again)
//   mail(alert)                           a mail alert (something to do / papers)
// Each notification opens Windose on that session or message (the url).
'use strict';

const DONE_MIN = 2;                        // minutes of work before "finished" is worth telling
const PERM_GRACE_MS = Number.isFinite(+process.env.AME_PERM_GRACE_MS) ? Math.max(0, +process.env.AME_PERM_GRACE_MS) : 1500;
const CTX_LOW = 10, CTX_RESET = 30;
const WORKING = new Set(['message', 'thinking', 'reading', 'working', 'error']);
const STOPPED = new Set(['done', 'idle', 'ended']);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const at = (machine, id) => '/#s=' + encodeURIComponent(machine + '|' + id);

// a session's context left in percent (as the page computes it: js/util.js ctxLeft)
function ctxLeft(id, c) {
  if (!c || !(c.win > 0)) return null;
  const s = String(id || '');
  const left = s.startsWith('codex:') ? (c.win - c.used) / Math.max(1, c.win - 12000)
    : /^(opencode|agy|kiro):/.test(s) ? (c.win - c.used) / c.win
    : (c.win - 33000 - c.used) / Math.max(1, c.win - 33000);
  return Math.max(0, Math.min(100, Math.round(left * 100)));
}

function createPushEvents({ push, permGraceMs = PERM_GRACE_MS }) {
  const seenPerms = new Map();             // "machine|perm id" -> when seen (an approval is told once)
  const pendingPerms = new Map();          // "machine|perm id" -> { timer, machine } (grace window for auto-approved prompts)
  const work = new Map();                  // "machine|session" -> { since, working }
  const lowCtx = new Set();                // "machine|session" told about its context
  const prune = () => { const old = Date.now() - 86400e3; for (const [k, t] of seenPerms) if (t < old) seenPerms.delete(k); };
  const clearPendingFor = (machine, activeSet = null) => {
    const prefix = machine + '|';
    for (const [k, p] of pendingPerms) {
      if (!k.startsWith(prefix)) continue;
      if (!activeSet || !activeSet.has(k)) { clearTimeout(p.timer); pendingPerms.delete(k); }
    }
  };

  function sessions(machine, list, control) {
    const activePerms = new Set();
    for (const s of list) {
      const key = machine + '|' + s.id;
      // These are live, answerable cards, including on reconnect. Keep seen IDs across reconnects
      // so an already announced card is quiet, while one created during the outage is still delivered.
      for (const p of control ? s.perms || [] : []) {
        const k = machine + '|' + p.id;
        activePerms.add(k);
        if (seenPerms.has(k) || pendingPerms.has(k)) continue;
        let input = {}; try { input = JSON.parse(p.input || '{}'); } catch {}
        const what = input.command || input.CommandLine || input.file_path || input.notebook_path || input.Path || input.TargetFile || input.description || input.toolSummary || input.message || input.url
          || (Array.isArray(input.resources) ? input.resources.join(' · ') : '') || '';
        const payload = { title: `需要确认 · ${p.tool}`, body: clip(`${s.label}（${machine}）${what ? '：' + what : ''}`, 160), tag: 'perm-' + p.id, url: at(machine, s.id) };
        if (permGraceMs <= 0) {
          seenPerms.set(k, Date.now());
          push.notify('approval', payload);
        } else {
          const timer = setTimeout(() => {
            pendingPerms.delete(k);
            if (seenPerms.has(k)) return;
            seenPerms.set(k, Date.now());
            push.notify('approval', payload);
          }, permGraceMs);
          if (timer.unref) timer.unref();
          pendingPerms.set(k, { timer, machine });
        }
      }
      // done: from working to stopped, after a while of work (waiting for an approval/question does not reset the clock)
      const w = work.get(key), working = WORKING.has(s.state);
      if (working && !(w && w.working)) work.set(key, { since: Date.now(), working: true });
      else if (s.state === 'waiting' && w && w.working) { /* keep work.since while waiting for approval */ }
      else if (!working && w && w.working) {
        work.set(key, { working: false });
        if (STOPPED.has(s.state) && Date.now() - w.since >= DONE_MIN * 60e3) {
          const line = [...(s.lines || [])].reverse().find((l) => l && l.text);
          push.notify('done', { title: `完成 · ${s.label}`, body: clip(`${machine}${line ? '：' + line.text : ''}`, 160), tag: 'done-' + key, url: at(machine, s.id) });
        }
      } else if (!w) work.set(key, { working });
    }
    clearPendingFor(machine, activePerms);
    prune();
  }

  function ctx(machine, id, c, label) {
    const left = ctxLeft(id, c), key = machine + '|' + id;
    if (left == null) return;
    if (left > CTX_RESET) { lowCtx.delete(key); return; }
    if (left > CTX_LOW || lowCtx.has(key)) return;
    lowCtx.add(key);
    push.notify('ctx', { title: `上下文快满了 · ${label || '会话'}`, body: `${machine}：剩约 ${left}%，快要自动压缩了`, tag: 'ctx-' + key, url: at(machine, id) });
  }

  function mail(alert) {
    if (!alert) return;
    const todo = alert.kind === 'action';
    push.notify('mail', { title: todo ? `邮件待办 · ${clip(alert.subject, 40)}` : `推荐文献 · ${clip(alert.subject, 40)}`,
      body: clip(todo ? [alert.todo || alert.summary, alert.deadline && `截止 ${alert.deadline}`].filter(Boolean).join('，') : (alert.picks || []).map((p) => p.title).join('；') || alert.summary, 180),
      tag: 'mail-' + (alert.id || alert.key), url: '/#mail=' + encodeURIComponent(alert.key || '') });
  }

  // Start work-duration tracking afresh, but retain approval IDs to avoid duplicate notifications.
  const reset = (machine) => { clearPendingFor(machine); for (const k of work.keys()) if (k.startsWith(machine + '|')) work.delete(k); };
  return { sessions, ctx, mail, reset, ctxLeft };
}

module.exports = { createPushEvents, ctxLeft, DONE_MIN, PERM_GRACE_MS };
