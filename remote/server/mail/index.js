// 邮件 on the Windose page: the mailboxes (accounts.js), each kept in step by its own connection (imap.js), the mail
// kept on the NAS (store.js), and the web API:
//   GET  /api/mail                         accounts (no passwords) with their status
//   GET  /api/mail/list?acc=&before=&n=    messages, newest first (no text)
//   GET  /api/mail/msg?key=                one message with its text
//   POST /api/mail/accounts/add | update | remove     (a code entered within the hour, like remote control)
//   POST /api/mail/sync { acc }            look for new mail now
//   POST /api/mail/seen { keys, seen }     mark read / unread in the mailboxes themselves (no code asked: harmless)
//   GET  /api/mail/alerts                  what the model found worth telling (triage.js); POST .../alerts/done
//                                          { id } (知道了), .../alerts/todo { id } (加入重要计划: with its deadline)
//   GET / POST /api/mail/interests         the research interests recommended papers are judged by (+ own words)
// onChange(what): 'accounts' (an account or its status changed), 'new' (mail arrived), 'seen' (read / unread
// changed) or 'alerts' -- the server tells open pages. ask: the model (summary's), null = no triage; onAlert(alert):
// a new alert, for the other ways of telling (Google Calendar, 糖糖).
// todos: 重要计划 (an alert's to-do can become one).
'use strict';
const { createAccounts } = require('./accounts');
const { createMailStore } = require('./store');
const { createSyncer } = require('./imap');
const { createTriage } = require('./triage');

function createMail({ dataDir, onChange = () => {}, log = console.log, audit = () => {}, client, ask = null, reports = () => null, todos = null, onAlert = () => {}, triageWaitMs }) {
  const accounts = createAccounts({ dataDir });
  const store = createMailStore({ dataDir });
  const triage = createTriage({ dataDir, store, accounts, ask, reports, log, waitMs: triageWaitMs, onChange: () => onChange('alerts'),
    onAlert: (a) => { try { onAlert(a); } catch (e) { log('邮件提醒：' + e.message); } } });
  const syncers = new Map();                          // account id -> syncer
  const listeners = new Set();                        // (heads) => {}: other modules told about new mail

  function startOne(a) {
    const s = createSyncer({ account: a, state: () => accounts.state(a.id), setState: accounts.setState, store, log, client,
      // (read here or elsewhere: its alert has been seen to)
      onSeen: (keys) => {
        onChange('seen');
        const read = keys.map((k) => store.copiesOf(k).find((h) => h.key === k)).filter((h) => h && h.seen);
        triage.seen(new Set(read.map((h) => h.dup)));
      },
      onNew: (heads, info = {}) => {
        triage.add(heads, { old: !!info.initial }); onChange('new'); for (const fn of listeners) try { fn(heads, a); } catch (e) { log('邮件：' + e.message); } },
      onStatus: () => onChange('accounts') });
    syncers.set(a.id, s);
    s.start();
  }
  async function restart(id) {
    const old = syncers.get(id);
    syncers.delete(id);
    if (old) await old.stop();
    const a = accounts.get(id);
    if (a) startOne(a);
  }
  for (const a of accounts.all()) startOne(a);
  const backT = setTimeout(() => triage.backlog(), 20e3); backT.unref && backT.unref();       // (mail kept but not judged yet)
  // the model's judgement for the list: { kind, important, summary, todo, deadline }
  const brief = (dup) => { const r = triage.result(dup); return r ? { kind: r.kind, important: r.important, summary: r.summary, todo: r.todo, deadline: r.deadline } : null; };

  const status = () => accounts.list().map((a) => ({ ...a, ...(syncers.get(a.id) ? syncers.get(a.id).status() : { state: 'error', error: '没有在同步' }) }));

  async function handle(req, res, url, ip, json, readBody, fresh) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/mail') { json(res, 200, { accounts: status() }); return true; }
    if (req.method === 'GET' && p === '/api/mail/list') {
      const before = +url.searchParams.get('before') || Infinity, n = Math.min(+url.searchParams.get('n') || 50, 200);
      json(res, 200, { items: store.list({ acc: String(url.searchParams.get('acc') || ''), before, limit: n }).map((m) => ({ ...m, t: brief(m.dup) })) });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mail/msg') {
      const m = store.get(String(url.searchParams.get('key') || ''));
      json(res, m ? 200 : 404, m ? { ...m, t: triage.result(m.dup) } : { error: 'not found' });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mail/alerts') {
      const all = triage.alerts();
      json(res, 200, { enabled: triage.enabled, open: all.filter((a) => !a.done), done: all.filter((a) => a.done).slice(0, 20) });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mail/interests') { json(res, 200, triage.interests()); return true; }
    if (req.method !== 'POST' || !p.startsWith('/api/mail/')) return false;
    let d = {}; try { d = JSON.parse(await readBody(req, 8192)); } catch {}
    const what = p.slice('/api/mail/'.length);
    let r;
    if (what.startsWith('accounts/')) {
      if (!fresh()) { json(res, 200, { ok: false, need: 'totp', msg: '需要再输一次验证码' }); return true; }
      const op = what.slice('accounts/'.length);
      if (op === 'add') { r = accounts.add(d); if (r.ok) startOne(accounts.get(r.account.id)); }
      else if (op === 'update') { r = accounts.update(String(d.id || ''), d); if (r.ok) await restart(r.account.id); }
      else if (op === 'remove') {
        const id = String(d.id || '');
        r = accounts.remove(id);
        if (r.ok) { const s = syncers.get(id); syncers.delete(id); if (s) await s.stop(); if (d.purge) store.removeAccount(id); }
      } else { json(res, 404, { ok: false }); return true; }
      if (r.ok) { audit('mail-' + op, ip, r.account ? r.account.address : ''); onChange('accounts'); }
    } else if (what === 'alerts/done') {
      r = triage.done(String(d.id || '')) ? { ok: true } : { ok: false, msg: '找不到这条提醒' };
    } else if (what === 'alerts/todo') {
      const a = triage.alerts().find((x) => x.id === String(d.id || ''));
      if (!a || !todos) r = { ok: false, msg: a ? '重要计划没有开启' : '找不到这条提醒' };
      else {
        const t = todos.add({ text: a.todo || a.summary || a.subject, due: a.deadline, project: '邮件' });
        r = t.ok ? { ok: true } : t;
        if (t.ok) { triage.done(a.id, { todoId: t.item ? t.item.id : '' }); audit('mail-todo', ip); }
      }
    } else if (what === 'interests') {
      r = triage.setInterests(d.text);
    } else if (what === 'seen') {
      // the keys may be copies in different mailboxes: each mailbox is asked for its own
      const byAcc = new Map();
      for (const k of (Array.isArray(d.keys) ? d.keys : []).slice(0, 500).map(String)) {
        const acc = k.split(':')[0];
        if (!byAcc.has(acc)) byAcc.set(acc, []);
        byAcc.get(acc).push(k);
      }
      const errs = [];
      for (const [acc, keys] of byAcc) {
        const s = syncers.get(acc);
        const x = s ? await s.setSeen(keys, !!d.seen) : { ok: false, msg: '找不到这个邮箱' };
        if (!x.ok) errs.push(((accounts.get(acc) || {}).name || acc) + '：' + x.msg);
      }
      r = errs.length ? { ok: false, msg: errs.join('；') } : { ok: byAcc.size > 0, msg: byAcc.size ? '' : '没有选中邮件' };
    } else if (what === 'sync') {
      const s = syncers.get(String(d.acc || ''));
      if (s) { s.now(); r = { ok: true }; } else r = { ok: false, msg: '找不到这个邮箱' };
    } else { json(res, 404, { ok: false }); return true; }
    json(res, 200, r);
    return true;
  }

  // 糖糖's morning bubble: what the open mail alerts come to -- { todo: things to do / notices, reading: papers,
  // top: [up to 3 lines, things to do first], due: the nearest deadline }
  function morning() {
    const open = triage.alerts().filter((a) => !a.done);
    const todo = open.filter((a) => a.kind !== 'reading'), reading = open.filter((a) => a.kind === 'reading');
    const dues = todo.map((a) => a.deadline).filter(Boolean).sort();
    return { todo: todo.length, reading: reading.length, top: [...todo, ...reading].slice(0, 3).map((a) => String(a.summary || a.subject).slice(0, 40)), due: dues[0] || '' };
  }

  return { handle, status, store, accounts, morning, onNew: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    triage, async stop() { clearTimeout(backT); triage.stop(); for (const s of syncers.values()) await s.stop(); } };
}

module.exports = { createMail };
