// One mailbox's inbox, kept in step: a lasting IMAP connection (IDLE: the server says when mail arrives; a look every
// 10 minutes as well), the inbox opened read-only (EXAMINE: nothing is ever marked read, moved or deleted there).
//   - the first time: the last 30 days; after that what is new by UID; the mailbox's UIDVALIDITY changed: read again
//     (the same Message-ID is not stored twice)
//   - very large messages: their first 3 MB (the text is at the start; attachments are listed from the structure)
//   - lost connection: again after 5 s, doubling up to 10 minutes; a password refused: again only after 30 minutes
//     (repeated wrong logins could get the mailbox locked)
//   - read / unread follows the mailbox: refreshed on connecting, every 10 minutes and when the server says flags
//     changed (read in the webmail / on the phone); setSeen() marks read / unread there (「标为已读」) over a
//     connection of its own, opened read-write only for that and closed again
// status(): { state: 'connecting' | 'ok' | 'error', error, auth (the password was refused: the tray asks for a new
// 客户端专用密码), lastSync, count }
'use strict';
const { ImapFlow } = require('imapflow');
const { parse } = require('./parse');

const FIRST_DAYS = 30;
const LOOK_MS = 10 * 60e3;
const CUT = 3 * 1024 * 1024;
const BATCH = 20;

// account: accounts.get(id) (with the password); st / setState: its { uv, lastUid, lastSync };
// onNew(heads): messages just stored; onSeen(keys): read / unread changed; onStatus(): status changed.
// client(options): ImapFlow (tests: a stand-in)
function createSyncer({ account, state, setState, store, onNew = () => {}, onSeen = () => {}, onStatus = () => {}, log = () => {}, client: makeClient = (o) => new ImapFlow(o) }) {
  let st = { state: 'connecting', error: '', auth: false, lastSync: state().lastSync || 0 };
  let c = null, stopped = false, wait = 5e3, retryT = null, lookT = null, busy = null, again = false, wantFlags = false, flagsT = null;
  const options = () => ({ host: account.imap.host, port: account.imap.port, secure: true, auth: { user: account.address, pass: account.pass },
    logger: false, connectionTimeout: 30e3, greetingTimeout: 30e3, clientInfo: { name: 'Windose', version: '1' } });
  const set = (patch) => { st = { ...st, ...patch }; onStatus(); };

  async function connect() {
    if (stopped) return;
    set({ state: 'connecting' });
    const cl = makeClient({ ...options(), maxIdleTime: 9 * 60e3, autoIdleDelay: 3e3, socketTimeout: 15 * 60e3 });
    c = cl;
    cl.on('error', (e) => log(`邮件 ${account.address}：连接出错 ${e.message}`));
    cl.on('close', () => { if (c === cl && !stopped) { c = null; set({ state: 'error', error: st.error || '连接断开了，稍后重连' }); later(wait); wait = Math.min(wait * 2, LOOK_MS); } });
    cl.on('exists', () => fetchNew());
    // read / unread changed elsewhere (servers often name the message by number only): look again shortly
    cl.on('flags', () => { clearTimeout(flagsT); flagsT = setTimeout(() => fetchNew(true), 1500); });
    try {
      await cl.connect();
      await cl.mailboxOpen('INBOX', { readOnly: true });
      wait = 5e3;
      set({ state: 'ok', error: '', auth: false });
      await fetchNew(true);
    } catch (e) {
      const auth = e.authenticationFailed || /auth|login|password|密码/i.test(String(e.responseText || e.message));
      set({ state: 'error', auth: !!auth, error: auth ? '登录被拒：地址或客户端专用密码不对（可能已失效，请在网页邮箱重新生成；30 分钟后再试，改了密码会马上重试）' : '连不上邮件服务器：' + e.message });
      c = null;
      try { cl.close(); } catch {}
      later(auth ? 30 * 60e3 : wait); if (!auth) wait = Math.min(wait * 2, LOOK_MS);
    }
  }
  function later(ms) { clearTimeout(retryT); if (!stopped) { retryT = setTimeout(connect, ms); retryT.unref && retryT.unref(); } }

  // what is new in the inbox -> stored (flags: and read / unread refreshed); one run at a time (another request
  // while running: once more after)
  function fetchNew(flags) {
    if (flags) wantFlags = true;
    if (busy) { again = true; return busy; }
    busy = (async () => {
      const f = wantFlags; wantFlags = false;
      try { await pull(); if (f) await refreshSeen(); }
      catch (e) { log(`邮件 ${account.address}：取信失败 ${e.message}`); set({ error: '取信失败：' + e.message }); }
    })().finally(() => { busy = null; if ((again || wantFlags) && c) { again = false; fetchNew(); } });
    return busy;
  }

  // read / unread of the kept messages, as the mailbox has it now
  async function refreshSeen() {
    const cl = c;
    if (!cl || !cl.mailbox) return;
    const uv = String(cl.mailbox.uidValidity), kept = store.uidsOf(account.id, uv);
    const uids = Object.keys(kept).map(Number);
    if (!uids.length) return;
    const map = {};
    for await (const m of cl.fetch(`${Math.min(...uids)}:*`, { uid: true, flags: true }, { uid: true })) {
      const key = kept[String(m.uid)];
      if (key) map[key] = !!(m.flags && m.flags.has('\\Seen'));
    }
    const changed = store.setSeen(account.id, map);
    if (changed.length) onSeen(changed);
  }

  // 「标为已读 / 未读」: in the mailbox itself, over a short read-write connection of its own
  async function setSeen(keys, seen) {
    const s = state(), pre = `${account.id}:${s.uv}:`;
    const uids = keys.filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length));
    if (!uids.length) return { ok: false, msg: '这些邮件在邮箱里已经变了，请先收一次信' };
    const cl = makeClient(options());
    try {
      await cl.connect();
      await cl.mailboxOpen('INBOX');
      if (String(cl.mailbox.uidValidity) !== s.uv) return { ok: false, msg: '邮箱刚有变动，请先收一次信' };
      if (seen) await cl.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
      else await cl.messageFlagsRemove(uids.join(','), ['\\Seen'], { uid: true });
      // read back: a server that does not allow it is skipped quietly by imapflow -- say so instead of pretending
      let wrong = 0;
      for await (const m of cl.fetch(uids.join(','), { uid: true, flags: true }, { uid: true })) if ((m.flags && m.flags.has('\\Seen')) !== !!seen) wrong++;
      if (wrong) return { ok: false, msg: `邮箱没有接受修改（${wrong} 封）` };
    } catch (e) {
      return { ok: false, msg: '没能改：' + (e.responseText || e.message) };
    } finally { try { await cl.logout(); } catch { try { cl.close(); } catch {} } }
    const changed = store.setSeen(account.id, Object.fromEntries(keys.map((k) => [k, !!seen])));
    if (changed.length) onSeen(changed);
    return { ok: true };
  }

  async function pull() {
    const cl = c;
    if (!cl || !cl.mailbox) return;
    const uv = String(cl.mailbox.uidValidity);
    let s = state();
    if (s.uv !== uv) { s = { uv, lastUid: 0 }; setState(account.id, s); }
    let uids;
    if (!s.lastUid) uids = (await cl.search({ since: new Date(Date.now() - FIRST_DAYS * 86400e3) }, { uid: true })) || [];
    else uids = ((await cl.search({ uid: `${s.lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > s.lastUid);
    uids = uids.map(Number).sort((a, b) => a - b);
    const got = [];
    for (let i = 0; i < uids.length; i += BATCH) {
      const part = uids.slice(i, i + BATCH);
      const msgs = [];
      for await (const m of cl.fetch(part.join(','), { uid: true, flags: true, internalDate: true, size: true, bodyStructure: true, source: { maxLength: CUT } }, { uid: true })) msgs.push(m);
      for (const m of msgs) {
        const key = `${account.id}:${uv}:${m.uid}`;
        if (store.has(key)) continue;
        try {
          const r = await parse({ ...m, cut: (m.size || 0) > CUT }, account.address);
          const rec = { key, acc: account.id, uid: Number(m.uid), ...r };
          if (store.add(rec)) { const { text, ...h } = rec; got.push(h); }
        } catch (e) { log(`邮件 ${account.address}：第 ${m.uid} 封解析失败 ${e.message}`); }
      }
      const top = Math.max(s.lastUid || 0, ...part);
      s = { uv, lastUid: top }; setState(account.id, { uv, lastUid: top });
    }
    set({ lastSync: Date.now(), error: '' });
    setState(account.id, { lastSync: Date.now() });
    if (got.length) { log(`邮件 ${account.address}：收到 ${got.length} 封`); onNew(got); }
  }

  function start() {
    connect();
    lookT = setInterval(() => { if (c) fetchNew(true); }, LOOK_MS); lookT.unref && lookT.unref();
  }
  async function stop() {
    stopped = true; clearTimeout(retryT); clearInterval(lookT); clearTimeout(flagsT);
    const cl = c; c = null;
    if (cl) try { await cl.logout(); } catch { try { cl.close(); } catch {} }
  }
  // 「收信」: look now (or connect again now when it is waiting to)
  function now() { if (c) return fetchNew(true); clearTimeout(retryT); return connect(); }

  return { start, stop, now, setSeen, status: () => ({ ...st, count: store.count(account.id), unread: store.unread(account.id) }) };
}

module.exports = { createSyncer, FIRST_DAYS };
