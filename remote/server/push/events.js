// What is worth a phone notification, from what the dashboard already knows (server.js hands it in):
//   sessions(machine, sessions, control)  approval: a permission prompt appeared (only where it can be answered from
//                                         here); done: a session that worked at least DONE_MIN stopped
//   ctx(machine, id, ctx, label)          a session's context fell to CTX_LOW% (once, until it is above CTX_RESET% again)
//   mail(alert)                           a mail alert (something to do / papers)
// Each notification opens Windose on that session or message (the url).
'use strict';

const DONE_MIN = 2;                        // minutes of work before "finished" is worth telling
const CTX_LOW = 10, CTX_RESET = 30;
const WORKING = new Set(['message', 'thinking', 'reading', 'working', 'error']);
const STOPPED = new Set(['done', 'idle', 'ended']);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const at = (machine, id) => '/#s=' + encodeURIComponent(machine + '|' + id);

// a session's context left in percent (as the page computes it: js/util.js ctxLeft)
function ctxLeft(id, c) {
  if (!c || !(c.win > 0)) return null;
  const left = String(id).startsWith('codex:') ? (c.win - c.used) / (c.win - 12000) : (c.win - 33000 - c.used) / (c.win - 33000);
  return Math.max(0, Math.min(100, Math.round(left * 100)));
}

function createPushEvents({ push }) {
  const seenPerms = new Map();             // "machine|perm id" -> when seen (an approval is told once)
  const work = new Map();                  // "machine|session" -> { since, state }
  const lowCtx = new Set();                // "machine|session" told about its context
  const primed = new Set();                // machines whose first report after connecting was taken in (not told)
  const prune = () => { const old = Date.now() - 86400e3; for (const [k, t] of seenPerms) if (t < old) seenPerms.delete(k); };

  function sessions(machine, list, control) {
    const first = !primed.has(machine);
    primed.add(machine);
    for (const s of list) {
      const key = machine + '|' + s.id;
      // approval: new prompts (on the first report after a connection they are only noted: told before, or stale)
      for (const p of control ? s.perms || [] : []) {
        const k = machine + '|' + p.id;
        if (seenPerms.has(k)) continue;
        seenPerms.set(k, Date.now());
        if (first) continue;
        let input = {}; try { input = JSON.parse(p.input || '{}'); } catch {}
        const what = input.command || input.file_path || input.notebook_path || input.description || input.url || '';
        push.notify('approval', { title: `需要确认 · ${p.tool}`, body: clip(`${s.label}（${machine}）${what ? '：' + what : ''}`, 160), tag: 'perm-' + p.id, url: at(machine, s.id) });
      }
      // done: from working to stopped, after a while of work
      const w = work.get(key), working = WORKING.has(s.state);
      if (working && !(w && w.working)) work.set(key, { since: Date.now(), working: true });
      else if (!working && w && w.working) {
        work.set(key, { working: false });
        if (STOPPED.has(s.state) && Date.now() - w.since >= DONE_MIN * 60e3) {
          const line = [...(s.lines || [])].reverse().find((l) => l && l.text);
          push.notify('done', { title: `完成 · ${s.label}`, body: clip(`${machine}${line ? '：' + line.text : ''}`, 160), tag: 'done-' + key, url: at(machine, s.id) });
        }
      } else if (!w) work.set(key, { working });
    }
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

  // a machine disconnected: its next report is a fresh start
  const reset = (machine) => primed.delete(machine);
  return { sessions, ctx, mail, reset, ctxLeft };
}

module.exports = { createPushEvents, ctxLeft, DONE_MIN };
