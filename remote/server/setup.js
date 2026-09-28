#!/usr/bin/env node
// Setup for the remote panel server. Writes config.json next to this file (or $AME_REMOTE_CONFIG).
//   node setup.js init                 account + password + TOTP (prints a QR code for the authenticator app)
//   node setup.js password             change the password
//   node setup.js totp                 new TOTP secret (re-scan the QR code)
//   node setup.js add-agent <name>     new machine token (shown once)
//   node setup.js remove-agent <name>
//   node setup.js production <domain> [vpn-ip]   public https site behind Caddy; agents only on the VPN address
//   node setup.js list
// Non-interactive (scripts / tests): AME_USER, AME_PASSWORD environment variables.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const auth = require('./auth');

const file = process.env.AME_REMOTE_CONFIG || path.join(__dirname, 'config.json');
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function save(c) {
  fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  console.log(`已保存 ${file}`);
}

function ask(q, hidden) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };   // no echo
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a); });
  });
}
async function newPassword() {
  if (process.env.AME_PASSWORD) return process.env.AME_PASSWORD;
  for (;;) {
    const a = await ask('新密码（至少 12 位）：', true);
    if (a.length < 12) { console.log('太短了'); continue; }
    if (a !== await ask('再输一次：', true)) { console.log('两次不一样'); continue; }
    return a;
  }
}
async function showTotp(c) {
  const uri = auth.otpauthUri(c.totpSecret, c.user);
  console.log('\n用验证器 App（Google Authenticator / 1Password / Authy…）扫这个二维码：\n');
  try { console.log(await require('qrcode').toString(uri, { type: 'terminal', small: true })); } catch { console.log('（装了 qrcode 包才能显示二维码）'); }
  console.log(`扫不了就手动输入密钥：${c.totpSecret}\n`);
  if (process.env.AME_PASSWORD) return;                          // scripted: skip the check
  for (;;) {
    const code = await ask('输入 App 上现在的 6 位数确认：');
    if (auth.verifyTotp(c.totpSecret, code)) { console.log('验证通过'); return; }
    console.log('不对，再试一次（注意电脑和手机的时间要准）');
  }
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  let c = load();
  if (cmd === 'init') {
    if (c && !process.env.AME_PASSWORD && (await ask('config.json 已存在，覆盖？(y/N) ')).toLowerCase() !== 'y') return;
    const user = process.env.AME_USER || (await ask('用户名：')).trim();
    c = {
      user, password: auth.hashPassword(await newPassword()), totpSecret: auth.newTotpSecret(),
      agents: (c && c.agents) || [],
      web: { host: '127.0.0.1', port: 8787 },              // behind Caddy in production
      agent: null,                                          // null = /agent on the web listener; production: { host: <VPN ip>, port: 8788 }
      origin: 'http://127.0.0.1:8787',                     // production: https://your.domain
      secureCookies: false,                                 // production: true (https; HSTS + __Host- cookie)
      trustProxy: false,                                    // production: true (client IP = the last X-Forwarded-For entry, set by Caddy)
      control: true,                                        // false = read-only dashboard
    };
    save(c);
    await showTotp(c);
  } else if (!c) {
    console.log('还没有 config.json，先运行 node setup.js init');
  } else if (cmd === 'password') {
    c.password = auth.hashPassword(await newPassword()); save(c);
  } else if (cmd === 'totp') {
    c.totpSecret = auth.newTotpSecret(); save(c); await showTotp(c);
  } else if (cmd === 'add-agent' && arg) {
    const t = auth.token();
    c.agents = (c.agents || []).filter((a) => a.name !== arg).concat({ name: arg, hash: auth.hashToken(t), added: new Date().toISOString() });
    save(c);
    console.log(`\n机器「${arg}」的令牌（只显示这一次，填进那台机器的 agent.json）：\n\n${t}\n`);
  } else if (cmd === 'remove-agent' && arg) {
    c.agents = (c.agents || []).filter((a) => a.name !== arg); save(c);
  } else if (cmd === 'production' && arg) {
    const vpn = process.argv[4];
    c.origin = `https://${arg.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
    c.web = { host: '127.0.0.1', port: (c.web && c.web.port) || 8787 };
    c.secureCookies = true; c.trustProxy = true;
    if (vpn) c.agent = { host: vpn, port: 8788 };
    save(c);
    console.log(`网页：${c.origin}（Caddy → 127.0.0.1:${c.web.port}）` + (vpn ? `\nagent 入口：ws://${vpn}:8788/agent（只在 VPN 上）` : '\n没给 VPN 地址：agent 仍走网页同一个入口'));
  } else if (cmd === 'list') {
    console.log(`用户：${c.user}\n机器：${(c.agents || []).map((a) => `${a.name}（${a.added || ''}）`).join('、') || '无'}`);
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
})();
