// A small SMTP server for the mail tests: TLS from the start (like 中国科技网's 465 / 994), EHLO, AUTH PLAIN / LOGIN,
// MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT. What arrives is kept: { user, from, rcpt: [], data (Buffer) }.
'use strict';
const tls = require('tls');

function createFakeSmtp({ key, cert, users }) {
  const got = [];
  let refused = 0;
  const server = tls.createServer({ key, cert }, (sock) => {
    const say = (s) => { try { sock.write(s + '\r\n'); } catch {} };
    let st = { user: null, from: null, rcpt: [] }, data = null, authLogin = null, buf = Buffer.alloc(0);
    say('220 fake.smtp ESMTP ready');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (data) {                                          // the message, up to <CRLF>.<CRLF> (which may come split)
          const all = Buffer.concat([data, buf]);
          const end = all.indexOf('\r\n.\r\n');
          if (end < 0) { data = all; buf = Buffer.alloc(0); return; }
          buf = all.subarray(end + 5);
          const body = all.subarray(0, end).toString('latin1').replace(/^\.\./gm, '.');
          got.push({ user: st.user, from: st.from, rcpt: st.rcpt, data: Buffer.from(body, 'latin1') });
          data = null; st = { user: st.user, from: null, rcpt: [] };
          say('250 2.0.0 queued');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.subarray(0, i).toString('latin1'); buf = buf.subarray(i + 2);
        handle(line);
      }
    });
    const login = (u, p) => { if (users[u] && users[u] === p) { st.user = u; say('235 2.7.0 ok'); } else { refused++; say('535 5.7.8 authentication failed'); } };
    function handle(line) {
      if (authLogin) {                                       // AUTH LOGIN: user, then password, each base64
        const v = Buffer.from(line, 'base64').toString();
        if (authLogin.u == null) { authLogin.u = v; return say('334 UGFzc3dvcmQ6'); }
        const u = authLogin.u; authLogin = null; return login(u, v);
      }
      const [cmd, ...rest] = line.split(' '), arg = rest.join(' ');
      switch (cmd.toUpperCase()) {
        case 'EHLO': return say('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 52428800');
        case 'HELO': return say('250 fake.smtp');
        case 'AUTH': {
          const [mech, init] = arg.split(' ');
          if (/^PLAIN$/i.test(mech)) { const [, u, p] = Buffer.from(init || '', 'base64').toString().split('\0'); return login(u, p); }
          if (/^LOGIN$/i.test(mech)) { authLogin = { u: init ? Buffer.from(init, 'base64').toString() : null }; return say(init ? '334 UGFzc3dvcmQ6' : '334 VXNlcm5hbWU6'); }
          return say('504 unknown mechanism');
        }
        case 'MAIL': if (!st.user) return say('530 5.7.0 authentication required'); st.from = (/<([^>]*)>/.exec(arg) || [])[1]; return say('250 ok');
        case 'RCPT': st.rcpt.push((/<([^>]*)>/.exec(arg) || [])[1]); return say('250 ok');
        case 'DATA': data = Buffer.alloc(0); return say('354 end with <CRLF>.<CRLF>');
        case 'RSET': st = { user: st.user, from: null, rcpt: [] }; return say('250 ok');
        case 'NOOP': return say('250 ok');
        case 'QUIT': say('221 bye'); return sock.end();
        default: return say('502 unknown');
      }
    }
  });
  return { got, stats: () => ({ refused }), listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)), close: () => new Promise((r) => server.close(() => r())) };
}

module.exports = { createFakeSmtp };
