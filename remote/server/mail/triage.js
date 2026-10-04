// New mail read by the model (triage-prompt.js), so nothing that needs the user is missed:
//   - an action / notice that matters -> an alert (what it is, what to do, by when); a journal / ResearchGate mail
//     with papers worth a look -> an alert recommending them; anything else is only labelled in the list
//   - mail arriving within a minute is asked about together (8 at most per question); the same mail in both
//     mailboxes once (store.js's dup fingerprint)
//   - alerts only for mail still unread; for mail from before (the first sync, or kept before triage existed) only
//     when its deadline has not passed yet
//   - the model unreachable: tried again in 30 minutes; at start, mail of the last 30 days not judged yet is
// Kept in <dataDir>/mail-triage.json: { interests (the user's own words), results: { dup: {...} }, alerts: [...] }.
// onAlert(alert): a new alert (the server passes it on: the tray, Google Calendar, 糖糖).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TRIAGE_SCHEMA, KINDS, triagePrompt, interestsOf, ymd } = require('./triage-prompt');

const WAIT_MS = 60e3, BATCH = 8, RETRY_MS = 30 * 60e3, BACK_DAYS = 30, KEEP_ALERTS = 300;

function createTriage({ dataDir, store, accounts, ask, reports = () => null, onAlert = () => {}, onChange = () => {}, log = () => {}, waitMs = WAIT_MS }) {
  const file = path.join(dataDir, 'mail-triage.json');
  let st = { interests: '', results: {}, alerts: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };

  const queue = new Map();                            // dup -> { key, old } waiting to be asked about
  let timer = null, running = false;

  // heads: messages just stored (old: from the first sync / from before -- alerts only for deadlines still ahead)
  function add(heads, { old = false } = {}) {
    if (!ask) return;
    for (const h of heads) if (h.dup && !st.results[h.dup] && !queue.has(h.dup)) queue.set(h.dup, { key: h.key, old });
    schedule(waitMs);
  }
  function schedule(ms) { if (!queue.size || !ask) return; clearTimeout(timer); timer = setTimeout(run, ms); timer.unref && timer.unref(); }

  const who = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');
  async function run() {
    if (running) return schedule(5e3);
    running = true;
    try {
      while (queue.size) {
        const batch = [...queue].slice(0, BATCH);
        const mails = [];
        for (const [dup, q] of batch) {
          const m = store.get(q.key);
          if (!m) { queue.delete(dup); continue; }
          mails.push({ ref: 'M' + (mails.length + 1), dup, old: q.old, m, from: who(m.from), to: (m.to || []).map(who).join('，'), cc: (m.cc || []).map(who).join('，'),
            toMe: !!(m.direct || m.copy), date: m.date, subject: m.subject, text: m.text || '' });
        }
        if (!mails.length) continue;
        let ans;
        try { ans = await ask(triagePrompt(mails, interestsOf(reports(), st.interests)), TRIAGE_SCHEMA, 'mailTriage'); }
        catch (e) { log('邮件把关：问模型失败，30 分钟后再试：' + e.message); schedule(RETRY_MS); return; }
        const byRef = new Map(((ans && ans.items) || []).map((x) => [String(x.ref || '').replace(/[^\dM]/gi, '').toUpperCase(), x]));
        for (const x of mails) {
          queue.delete(x.dup);
          const a = byRef.get(x.ref);
          if (!a) continue;                                // (not answered: asked again with the next new mail)
          record(x, a);
        }
        save(); onChange();
      }
    } finally { running = false; }
  }

  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  function record(x, a) {
    const kind = KINDS.includes(a.kind) ? a.kind : 'other';
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(a.deadline) ? a.deadline : '';
    const picks = kind === 'reading' ? (a.picks || []).slice(0, 5).map((p) => ({ title: clean(p.title, 200), url: /^https?:\/\//.test(p.url) ? String(p.url).slice(0, 500) : '', why: clean(p.why, 120), fun: !!p.fun })).filter((p) => p.title) : [];
    const r = { kind, important: !!a.important && (kind === 'action' || kind === 'notice'), summary: clean(a.summary, 80), todo: kind === 'action' ? clean(a.todo, 120) : '',
      deadline, deadlineText: clean(a.deadlineText, 200), picks, at: Date.now() };
    st.results[x.dup] = r;
    // an alert: still unread; from before only with a deadline still ahead
    const unread = store.copiesOf(x.m.key).some((c) => !c.seen);
    const ahead = deadline && deadline >= ymd(Date.now());
    const worth = r.important || picks.length;
    if (!worth || !unread || (x.old && !ahead)) return;
    const alert = { id: crypto.randomBytes(5).toString('hex'), dup: x.dup, key: x.m.key, acc: x.m.acc, kind: r.important ? kind : 'reading',
      subject: clean(x.m.subject, 200), from: x.from, date: x.m.date, summary: r.summary, todo: r.todo, deadline, deadlineText: r.deadlineText, picks, at: Date.now(), done: false };
    st.alerts.unshift(alert);
    st.alerts = st.alerts.slice(0, KEEP_ALERTS);
    log(`邮件把关：${alert.kind === 'reading' ? '推荐文献' : '重要'}「${alert.subject}」`);
    try { onAlert(alert); } catch (e) { log('邮件把关：' + e.message); }
  }

  // at start: what was kept without a judgement (the last 30 days)
  function backlog() {
    const since = Date.now() - BACK_DAYS * 86400e3;
    add(store.list({ limit: 2000 }).filter((h) => h.date >= since), { old: true });
  }

  const result = (dup) => st.results[dup] || null;
  const alerts = () => st.alerts;
  function done(id, patch = {}) {
    const a = st.alerts.find((x) => x.id === id);
    if (!a) return null;
    Object.assign(a, { done: true, doneAt: Date.now() }, patch); save(); onChange();
    return a;
  }
  // a message marked read: its alert has been seen to (a reading one stays until dismissed: the papers are the point)
  function seen(dups) {
    let n = 0;
    for (const a of st.alerts) if (!a.done && a.kind !== 'reading' && dups.has(a.dup)) { a.done = true; a.doneAt = Date.now(); a.doneBy = 'read'; n++; }
    if (n) { save(); onChange(); }
  }
  function setInterests(text) { st.interests = String(text || '').slice(0, 1000); save(); return { ok: true }; }
  const interests = () => ({ ...interestsOf(reports(), ''), extra: st.interests });

  return { add, backlog, result, alerts, done, seen, setInterests, interests, run, enabled: !!ask, stop: () => clearTimeout(timer) };
}

module.exports = { createTriage };
