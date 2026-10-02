// 邮件 on the Windose page: the mailboxes (accounts.js), each kept in step by its own connection (imap.js), the mail
// kept on the NAS (store.js), and the web API:
//   GET  /api/mail                         accounts (no passwords) with their status
//   GET  /api/mail/list?acc=&before=&n=    messages, newest first (no text)
//   GET  /api/mail/msg?key=                one message with its text
//   POST /api/mail/accounts/add | update | remove     (a code entered within the hour, like remote control)
//   POST /api/mail/sync { acc }            look for new mail now
//   POST /api/mail/seen { keys, seen }     mark read / unread in the mailboxes themselves (no code asked: harmless)
// onChange(what): 'accounts' (an account or its status changed), 'new' (mail arrived) or 'seen' (read / unread
// changed) -- the server tells open pages.
'use strict';
const { createAccounts } = require('./accounts');
const { createMailStore } = require('./store');
const { createSyncer } = require('./imap');

function createMail({ dataDir, onChange = () => {}, log = console.log, audit = () => {}, client }) {
  const accounts = createAccounts({ dataDir });
  const store = createMailStore({ dataDir });
  const syncers = new Map();                          // account id -> syncer
  const listeners = new Set();                        // (heads) => {}: other modules told about new mail

  function startOne(a) {
    const s = createSyncer({ account: a, state: () => accounts.state(a.id), setState: accounts.setState, store, log, client,
      onSeen: () => onChange('seen'),
      onNew: (heads) => { onChange('new'); for (const fn of listeners) try { fn(heads, a); } catch (e) { log('邮件：' + e.message); } },
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

  const status = () => accounts.list().map((a) => ({ ...a, ...(syncers.get(a.id) ? syncers.get(a.id).status() : { state: 'error', error: '没有在同步' }) }));

  async function handle(req, res, url, ip, json, readBody, fresh) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/mail') { json(res, 200, { accounts: status() }); return true; }
    if (req.method === 'GET' && p === '/api/mail/list') {
      const before = +url.searchParams.get('before') || Infinity, n = Math.min(+url.searchParams.get('n') || 50, 200);
      json(res, 200, { items: store.list({ acc: String(url.searchParams.get('acc') || ''), before, limit: n }) });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mail/msg') {
      const m = store.get(String(url.searchParams.get('key') || ''));
      json(res, m ? 200 : 404, m || { error: 'not found' });
      return true;
    }
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

  return { handle, status, store, accounts, onNew: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    async stop() { for (const s of syncers.values()) await s.stop(); } };
}

module.exports = { createMail };
