// 邮箱账号 (中国科技网 / any IMAP + SMTP mailbox): <dataDir>/mail.json, mode 600 --
//   { accounts: [{ id, address, name, imap: { host, port }, smtp: { host, port }, pass, added }],
//     state: { <id>: { uv, lastUid, lastSync } } }
// pass is the mailbox's 客户端专用密码 (a password for mail clients only, made in the webmail's settings); it never
// leaves this file (the web API gets the accounts without it).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEF = { imap: { host: 'mail.cstnet.cn', port: 993 }, smtp: { host: 'mail.cstnet.cn', port: 465 } };
const ADDRESS = /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const MAX = 10;

function createAccounts({ dataDir }) {
  const file = path.join(dataDir, 'mail.json');
  let st = { accounts: [], state: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };

  const pub = (a) => ({ id: a.id, address: a.address, name: a.name, imap: a.imap, smtp: a.smtp, added: a.added });
  const list = () => st.accounts.map(pub);
  const get = (id) => st.accounts.find((a) => a.id === id) || null;      // (with the password: for the mail modules only)
  const all = () => st.accounts.slice();

  // the form's fields -> an account's settings, or an error message
  function settings(d, old) {
    const address = String(d.address != null ? d.address : old ? old.address : '').trim().toLowerCase();
    if (!ADDRESS.test(address)) return { msg: '邮箱地址不对' };
    const server = (k, def) => {
      const host = String(d[k + 'Host'] != null ? d[k + 'Host'] : old ? old[k].host : def.host).trim().toLowerCase() || def.host;
      const port = +(d[k + 'Port'] != null ? d[k + 'Port'] : old ? old[k].port : def.port) || def.port;
      return HOST.test(host) && port > 0 && port < 65536 ? { host, port } : null;
    };
    const imap = server('imap', DEF.imap), smtp = server('smtp', DEF.smtp);
    if (!imap || !smtp) return { msg: '服务器地址或端口不对' };
    const pass = d.pass != null && String(d.pass) !== '' ? String(d.pass) : old ? old.pass : '';
    if (!pass || pass.length > 200) return { msg: '请填客户端专用密码' };
    const name = String(d.name != null ? d.name : old ? old.name : '').trim().slice(0, 40) || address.split('@')[0];
    return { address, name, imap, smtp, pass };
  }

  function add(d) {
    if (st.accounts.length >= MAX) return { ok: false, msg: '邮箱太多了' };
    const s = settings(d);
    if (s.msg) return { ok: false, msg: s.msg };
    if (st.accounts.some((a) => a.address === s.address)) return { ok: false, msg: '这个邮箱已经加过了' };
    const a = { id: crypto.randomBytes(4).toString('hex'), ...s, added: Date.now() };
    st.accounts.push(a); save();
    return { ok: true, account: pub(a) };
  }
  // the password may be left empty: keep the old one
  function update(id, d) {
    const a = get(id);
    if (!a) return { ok: false, msg: '找不到这个邮箱' };
    const s = settings(d, a);
    if (s.msg) return { ok: false, msg: s.msg };
    if (s.address !== a.address && st.accounts.some((x) => x.address === s.address)) return { ok: false, msg: '这个邮箱已经加过了' };
    const moved = s.address !== a.address || s.imap.host !== a.imap.host || s.imap.port !== a.imap.port;
    Object.assign(a, s);
    if (moved) delete st.state[id];                   // another mailbox: read it from the start
    save();
    return { ok: true, account: pub(a) };
  }
  function remove(id) {
    const n = st.accounts.length;
    st.accounts = st.accounts.filter((a) => a.id !== id);
    delete st.state[id];
    if (st.accounts.length !== n) save();
    return { ok: st.accounts.length !== n };
  }

  const state = (id) => st.state[id] || {};
  const setState = (id, patch) => { st.state[id] = { ...state(id), ...patch }; save(); };

  return { list, get, all, add, update, remove, state, setState, DEF };
}

module.exports = { createAccounts, DEF };
