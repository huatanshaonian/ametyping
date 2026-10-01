// One mailbox's inbox, kept in step: a lasting IMAP connection (IDLE: the server says when mail arrives; a look every
// 10 minutes as well), the inbox opened read-only (EXAMINE: nothing is ever marked read, moved or deleted there).
//   - the first time: the last 30 days; after that what is new by UID; the mailbox's UIDVALIDITY changed: read again
//     (the same Message-ID is not stored twice)
//   - very large messages: their first 3 MB (the text is at the start; attachments are listed from the structure)
//   - lost connection: again after 5 s, doubling up to 10 minutes; a password refused: again only after 30 minutes
//     (repeated wrong logins could get the mailbox locked)
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
// onNew(heads): messages just stored; onStatus(): status changed. client(options): ImapFlow (tests: a stand-in)
function createSyncer({ account, state, setState, store, onNew = () => {}, onStatus = () => {}, log = () => {}, client: makeClient = (o) => new ImapFlow(o) }) {
  let st = { state: 'connecting', error: '', auth: false, lastSync: state().lastSync || 0 };
  let c = null, stopped = false, wait = 5e3, retryT = null, lookT = null, busy = null, again = false;
  const set = (patch) => { st = { ...st, ...patch }; onStatus(); };

  async function connect() {
    if (stopped) return;
    set({ state: 'connecting' });
    const cl = makeClient({ host: account.imap.host, port: account.imap.port, secure: true, auth: { user: account.address, pass: account.pass },
      logger: false, maxIdleTime: 9 * 60e3, autoIdleDelay: 3e3, connectionTimeout: 30e3, greetingTimeout: 30e3, socketTimeout: 15 * 60e3,
      clientInfo: { name: 'Windose', version: '1' } });
    c = cl;
    cl.on('error', (e) => log(`邮件 ${account.address}：连接出错 ${e.message}`));
    cl.on('close', () => { if (c === cl && !stopped) { c = null; set({ state: 'error', error: st.error || '连接断开了，稍后重连' }); later(wait); wait = Math.min(wait * 2, LOOK_MS); } });
    cl.on('exists', () => fetchNew());
    try {
      await cl.connect();
      await cl.mailboxOpen('INBOX', { readOnly: true });
      wait = 5e3;
      set({ state: 'ok', error: '', auth: false });
      await fetchNew();
    } catch (e) {
      const auth = e.authenticationFailed || /auth|login|password|密码/i.test(String(e.responseText || e.message));
      set({ state: 'error', auth: !!auth, error: auth ? '登录被拒：地址或客户端专用密码不对（可能已失效，请在网页邮箱重新生成；30 分钟后再试，改了密码会马上重试）' : '连不上邮件服务器：' + e.message });
      c = null;
      try { cl.close(); } catch {}
      later(auth ? 30 * 60e3 : wait); if (!auth) wait = Math.min(wait * 2, LOOK_MS);
    }
  }
  function later(ms) { clearTimeout(retryT); if (!stopped) { retryT = setTimeout(connect, ms); retryT.unref && retryT.unref(); } }

  // what is new in the inbox -> stored; one run at a time (another request while running: once more after)
  function fetchNew() {
    if (busy) { again = true; return busy; }
    busy = (async () => {
      try { await pull(); }
      catch (e) { log(`邮件 ${account.address}：取信失败 ${e.message}`); set({ error: '取信失败：' + e.message }); }
    })().finally(() => { busy = null; if (again && c) { again = false; fetchNew(); } });
    return busy;
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
    lookT = setInterval(() => { if (c) fetchNew(); }, LOOK_MS); lookT.unref && lookT.unref();
  }
  async function stop() {
    stopped = true; clearTimeout(retryT); clearInterval(lookT);
    const cl = c; c = null;
    if (cl) try { await cl.logout(); } catch { try { cl.close(); } catch {} }
  }
  // 「收信」: look now (or connect again now when it is waiting to)
  function now() { if (c) return fetchNew(); clearTimeout(retryT); return connect(); }

  return { start, stop, now, status: () => ({ ...st, count: store.count(account.id) }) };
}

module.exports = { createSyncer, FIRST_DAYS };
