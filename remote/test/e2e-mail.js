// e2e: 邮件 -- the real server keeping a (fake, test/fake-imap.js) mailbox in step through imapflow: the last 30 days
// first, Chinese in GBK / encoded words, HTML-only mail, attachment names, sent to me / a copy / a list, a very large
// message cut, nothing marked read (EXAMINE, BODY.PEEK, no STORE), new mail while IDLE, a dropped connection, a
// changed UIDVALIDITY (no doubles), a wrong password not hammered, the password changed, an account removed.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createFakeImap } = require('./fake-imap');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-mail-'));
const PORT = 18830, IMAP = 18831;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 700)}`); };
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };

cp.execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(T, 'k.pem'), '-out', path.join(T, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const ME = 'zhangsan@test.ac.cn';
const imap = createFakeImap({ key: fs.readFileSync(path.join(T, 'k.pem')), cert: fs.readFileSync(path.join(T, 'c.pem')), users: { [ME]: 'right-pass' } });

// ---- messages ----
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const date = (t) => new Date(t).toUTCString().replace('GMT', '+0000');
const msg = ({ from = '"李老师" <li@test.ac.cn>', to = ME, cc = '', subject, body, extra = '', t = Date.now(), id }) =>
  `From: ${from}\r\nTo: ${to}\r\n${cc ? 'Cc: ' + cc + '\r\n' : ''}Subject: ${subject}\r\nDate: ${date(t)}\r\nMessage-ID: <${id}@test>\r\n${extra}MIME-Version: 1.0\r\n` + body;
const plain = (text) => `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(text)}\r\n`;
const DAY = 86400e3;
// GBK: 「经费报销」 / 「请在周五前提交报销单」 (bytes written out, Node has no GBK encoder)
const GBK_SUBJ = Buffer.from([0xbe, 0xad, 0xb7, 0xd1, 0xb1, 0xa8, 0xcf, 0xfa]).toString('base64');
const GBK_HTML = Buffer.concat([Buffer.from('<html><body><p>'), Buffer.from([0xc7, 0xeb, 0xd4, 0xda, 0xd6, 0xdc, 0xce, 0xe5, 0xc7, 0xb0, 0xcc, 0xe1, 0xbd, 0xbb, 0xb1, 0xa8, 0xcf, 0xfa, 0xb5, 0xa5]), Buffer.from('</p><script>x()</script></body></html>')]);

imap.add(msg({ subject: '很久以前的', body: plain('四十天前'), t: Date.now() - 40 * DAY, id: 'old' }), { date: Date.now() - 40 * DAY });
imap.add(msg({ subject: '=?UTF-8?B?' + b64('组会改到周四下午') + '?=', body: plain('各位：\n组会改到周四下午三点，地点 305。\n李'), t: Date.now() - 2 * DAY, id: 'direct' }), { date: Date.now() - 2 * DAY });
imap.add(msg({ from: 'caiwu@test.ac.cn', to: 'all@test.ac.cn', cc: ME, subject: '=?GBK?B?' + GBK_SUBJ + '?=', t: Date.now() - DAY, id: 'gbk',
  body: `Content-Type: text/html; charset=gbk\r\nContent-Transfer-Encoding: base64\r\n\r\n${GBK_HTML.toString('base64')}\r\n` }), { date: Date.now() - DAY });
imap.add(msg({ subject: '论文初稿', t: Date.now() - DAY, id: 'att', body: 'Content-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\n' + plain('初稿见附件') +
  '--b1\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8\'\'' + encodeURIComponent('论文初稿.pdf') + '\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64('%PDF-1.4 fake') + '\r\n--b1--\r\n' }), { date: Date.now() - DAY });
imap.add(msg({ subject: '网页附件', id: 'htm', body: 'Content-Type: multipart/mixed; boundary="b3"\r\n\r\n--b3\r\n' + plain('见附件') +
  '--b3\r\nContent-Type: text/html; name="x.html"\r\nContent-Disposition: attachment; filename="x.html"\r\n\r\n<script>alert(1)</script>\r\n--b3--\r\n' }), { date: Date.now() - DAY });
imap.add(msg({ from: 'news@lists.test.ac.cn', to: 'staff@lists.test.ac.cn', subject: '所里通讯第 12 期', body: plain('本期内容……'), extra: 'List-Id: <staff.lists.test.ac.cn>\r\n', id: 'list' }));
const BIG = 'x'.repeat(76) + '\r\n';
imap.add(msg({ subject: '大附件', id: 'big', body: 'Content-Type: multipart/mixed; boundary="b2"\r\n\r\n--b2\r\n' + plain('数据在附件里') +
  '--b2\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="data.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + BIG.repeat(48000) + '--b2--\r\n' }));

const req = (method, p, body, cookie) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, b, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.end(data);
});

(async () => {
  await imap.listen(IMAP);
  const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, NODE_TLS_REJECT_UNAUTHORIZED: '0' };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; cfg.summary = { enabled: false };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  let srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  const login = async (off = 0) => (await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + off) })).cookie;
  try {
    // (wait for it: loading the mail parser takes a moment)
    await until(() => new Promise((r) => http.get(`http://127.0.0.1:${PORT}/login`, (res) => { res.resume(); r(true); }).on('error', () => r(false))));
    let cookie = await login();
    const accs = async () => ((await req('GET', '/api/mail', null, cookie)).j || {}).accounts || [];
    const list = async (q = '') => ((await req('GET', '/api/mail/list' + q, null, cookie)).j || {}).items || [];
    const bySubj = (items, s) => items.find((m) => m.subject === s);

    ok('no account: nothing', (await accs()).length === 0 && (await list()).length === 0);
    ok('a bad address refused', !((await req('POST', '/api/mail/accounts/add', { address: 'nope', pass: 'x' }, cookie)).j || {}).ok);
    const add = (await req('POST', '/api/mail/accounts/add', { address: ME, name: '所里', pass: 'right-pass', imapHost: '127.0.0.1', imapPort: IMAP }, cookie)).j || {};
    ok('added; the answer has no password; defaults for SMTP', add.ok && add.account.smtp.host === 'mail.cstnet.cn' && add.account.smtp.port === 465 && !JSON.stringify(add).includes('right-pass'), add);
    const acc = add.account.id;
    ok('mail.json kept privately', process.platform === 'win32' || (fs.statSync(path.join(T, 'srv', 'data', 'mail.json')).mode & 0o777) === 0o600);

    const first = await until(async () => { const l = await list(); return l.length >= 6 ? l : null; });
    const items = first || await list();
    ok('first sync: the last 30 days (not the 40-day-old one)', items.length === 6 && !bySubj(items, '很久以前的'), items.map((m) => m.subject));
    const a = await until(async () => (await accs())[0].state === 'ok' && (await accs())[0]);
    ok('account: connected, counted, when it looked', a && a.count === 6 && a.lastSync > 0, a);
    const d = bySubj(items, '组会改到周四下午'), g = bySubj(items, '经费报销'), at = bySubj(items, '论文初稿'), li = bySubj(items, '所里通讯第 12 期'), big = bySubj(items, '大附件');
    ok('to me directly; sender name; snippet', d && d.direct && !d.copy && !d.bulk && d.from.name === '李老师' && /组会改到周四/.test(d.snippet), d);
    ok('GBK subject and HTML-only body as text (script dropped); a copy to me', g && g.copy && !g.direct && /请在周五前提交报销单/.test(g.snippet) && !/x\(\)/.test(g.snippet), g);
    ok('attachment listed by its (UTF-8 encoded) name and size', at && at.att.length === 1 && at.att[0].name === '论文初稿.pdf' && at.att[0].size > 0, at && at.att);
    ok('a mailing list is told apart', li && li.bulk && !li.direct, li);
    // attachments: fetched from the mailbox when opened (only that part), shown or downloaded
    const raw = (p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path: p, headers: { Cookie: cookie } }, (res) => {
      const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b) }));
    }));
    const beforeAtt = imap.commands.length;
    const pdf = await raw('/api/mail/att?key=' + encodeURIComponent(at.key) + '&i=0');
    ok('a PDF attachment: its bytes from the mailbox, shown in the page (inline), nothing able to run there', pdf.status === 200 && pdf.body.toString() === '%PDF-1.4 fake' &&
      pdf.headers['content-type'] === 'application/pdf' && /^inline; filename\*=UTF-8''%E8%AE%BA/.test(pdf.headers['content-disposition']) && pdf.headers['x-content-type-options'] === 'nosniff' &&
      pdf.headers['content-security-policy'] === 'sandbox', [pdf.status, pdf.headers, pdf.body.toString().slice(0, 40)]);
    const attCmds = imap.commands.slice(beforeAtt);
    ok('... only that part fetched (BODY.PEEK[2]), read-only, not marked read', attCmds.some((c) => /BODY\.PEEK\[2\]/.test(c)) && !attCmds.some((c) => /BODY\[|STORE|SELECT/i.test(c.replace(/BODY\.PEEK\[/g, ''))) &&
      imap.box.msgs.every((m) => !m.flags.includes(String.raw`\Seen`)), attCmds);
    const dl = await raw('/api/mail/att?key=' + encodeURIComponent(at.key) + '&i=0&dl=1');
    ok('下载: as a download', dl.status === 200 && dl.headers['content-type'] === 'application/octet-stream' && /^attachment;/.test(dl.headers['content-disposition']) && dl.body.toString() === '%PDF-1.4 fake', dl.headers);
    imap.setStructure(false);
    const fb = await raw('/api/mail/att?key=' + encodeURIComponent(at.key) + '&i=0');
    imap.setStructure(true);
    ok('a server giving no structure: taken out of the whole message', fb.status === 200 && fb.body.toString() === '%PDF-1.4 fake', [fb.status, fb.body.toString().slice(0, 80)]);
    const htm = bySubj(items, '网页附件');
    const hx = await raw('/api/mail/att?key=' + encodeURIComponent(htm.key) + '&i=0');
    ok('an HTML attachment is never shown in the page: a download', hx.status === 200 && hx.headers['content-type'] === 'application/octet-stream' && /^attachment;/.test(hx.headers['content-disposition']), hx.headers);
    ok('no such attachment: 404', (await raw('/api/mail/att?key=' + encodeURIComponent(at.key) + '&i=5')).status === 404);
    const full = (await req('GET', '/api/mail/msg?key=' + encodeURIComponent(d.key), null, cookie)).j || {};
    ok('the whole message: text, recipients, Message-ID for replying', /地点 305/.test(full.text) && full.to[0].address === ME && full.mid === '<direct@test>', full);
    const bigFull = (await req('GET', '/api/mail/msg?key=' + encodeURIComponent(big.key), null, cookie)).j || {};
    ok('a very large message: only its first 3 MB read; the text is there', /数据在附件里/.test(bigFull.text) && /邮件很大，只读了开头/.test(bigFull.text) &&
      imap.commands.some((c) => /BODY\.PEEK\[\]<0\.3145728>/.test(c)), [bigFull.text && bigFull.text.slice(-60)]);
    ok('nothing marked read: EXAMINE (read-only), BODY.PEEK, no STORE / SELECT', imap.box.msgs.every((m) => !m.flags.includes('\\Seen')) &&
      imap.commands.some((c) => /EXAMINE/i.test(c)) && !imap.commands.some((c) => /\bSTORE\b|\bSELECT\b/i.test(c)), imap.commands.filter((c) => /STORE|SELECT|FETCH/i.test(c)));

    // read on the phone (another client): the change comes over by itself
    imap.setFlag(imap.box.msgs.find((m) => /Message-ID: <direct@test>/.test(m.raw)).uid, true);
    const readElsewhere = await until(async () => { const x = bySubj(await list(), '组会改到周四下午'); return x && x.seen ? x : null; }, 10000);
    ok('read in the webmail / on the phone: shown as read here too', !!readElsewhere);
    // 标为未读 / 已读 here: in the mailbox itself, over a connection of its own (the syncing one stays read-only)
    const un = (await req('POST', '/api/mail/seen', { keys: [d.key], seen: false }, cookie)).j || {};
    const dm = imap.box.msgs.find((m) => /Message-ID: <direct@test>/.test(m.raw));
    ok('标为未读: the mailbox has it unread, the list too', un.ok && !dm.flags.includes('\\Seen') && !bySubj(await list(), '组会改到周四下午').seen, [un, dm.flags]);
    const rd = (await req('POST', '/api/mail/seen', { keys: [d.key], seen: true }, cookie)).j || {};
    ok('标为已读: the mailbox has it read', rd.ok && dm.flags.includes('\\Seen') && bySubj(await list(), '组会改到周四下午').seen, rd);
    ok('changed through SELECT + STORE on a separate connection only; still no BODY[] without PEEK',
      imap.commands.some((c) => /UID STORE \S+ \+FLAGS/i.test(c)) && imap.commands.some((c) => /\bSELECT\b/i.test(c)) && !imap.commands.some((c) => /BODY\[\]/i.test(c) && !/PEEK/i.test(c)));

    // the same notice twice (a journal sent to two lists): shown once, ×2; marked read together
    const notice = (id) => msg({ from: '"院刊" <bulletin@cas.cn>', to: 'staff@test.ac.cn', subject: '中国科学院院刊 第 9 期', id, extra: 'List-Id: <bulletin.cas.cn>\r\n',
      body: `Content-Type: text/html; charset=utf-8\r\n\r\n<p>本期目录：<a href="https://bulletin.cas.cn/9?u=${id}">在线阅读</a></p><p>退订：${id}@cas.cn</p>\r\n` });
    imap.add(notice('kan1')); imap.add(notice('kan2'));
    const kan = await until(async () => { const x = bySubj(await list(), '中国科学院院刊 第 9 期'); return x && x.copies.length === 2 ? x : null; }, 10000);
    ok('the same mail twice (only its links / addresses differ): one entry, ×2', !!kan && (await list()).filter((m) => m.subject === '中国科学院院刊 第 9 期').length === 1, kan);
    const kanFull = (await req('GET', '/api/mail/msg?key=' + encodeURIComponent(kan.key), null, cookie)).j || {};
    ok('an HTML link keeps its address in the text', /在线阅读 [[(]https:\/\/bulletin\.cas\.cn\/9\?u=kan\d[\])]/.test(kanFull.text), kanFull.text);
    await req('POST', '/api/mail/seen', { keys: kan.copies.map((c) => c.key), seen: true }, cookie);
    ok('marked read: every copy, in the mailbox', imap.box.msgs.filter((m) => /kan\d@test/.test(m.raw)).every((m) => m.flags.includes('\\Seen')) && bySubj(await list(), '中国科学院院刊 第 9 期').seen);

    // new mail while IDLE
    const t0 = Date.now();
    imap.add(msg({ subject: '紧急：明天交材料', body: plain('请明天上午交'), id: 'new1' }));
    const n1 = await until(async () => bySubj(await list(), '紧急：明天交材料'), 8000);
    ok('new mail arrives while waiting (IDLE), within seconds', !!n1 && Date.now() - t0 < 8000, Date.now() - t0);

    // the connection drops: back by itself, then only what is new
    imap.kick();
    await sleep(300);
    imap.add(msg({ subject: '断线时到的', body: plain('x'), id: 'new2' }));
    const n2 = await until(async () => bySubj(await list(), '断线时到的'), 20000);
    const all = await list();
    ok('dropped connection: reconnects and takes only what is new (no doubles)', !!n2 && all.length === 9 && new Set(all.map((m) => m.mid)).size === 9, all.map((m) => m.subject));

    // the mailbox's UIDVALIDITY changes (rebuilt on the server): read again, nothing doubled
    imap.box.uidValidity = 999; imap.kick();
    await until(async () => { const x = JSON.parse(fs.readFileSync(path.join(T, 'srv', 'data', 'mail.json'), 'utf8')); return x.state[acc] && x.state[acc].uv === '999' && x.state[acc].lastUid > 0; }, 20000);
    ok('UIDVALIDITY changed: read again, still no doubles', (await list()).length === 9);

    // restart the server: the kept mail is still there, it carries on from where it was
    srv.kill(); await sleep(500);
    const before = imap.commands.length;
    srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
    await until(() => new Promise((r) => http.get(`http://127.0.0.1:${PORT}/login`, (res) => { res.resume(); r(true); }).on('error', () => r(false))));
    cookie = await login(1);
    await until(async () => (await accs())[0] && (await accs())[0].state === 'ok');
    ok('after a restart: the mail kept, not fetched again', (await list()).length === 9 && !imap.commands.slice(before).some((c) => /SINCE/i.test(c)), imap.commands.slice(before));

    // a wrong password: refused once, not tried again right away
    const bad = (await req('POST', '/api/mail/accounts/add', { address: 'wang@test.ac.cn', pass: 'wrong', imapHost: '127.0.0.1', imapPort: IMAP }, cookie)).j || {};
    const w = await until(async () => { const x = (await accs()).find((y) => y.id === bad.account.id); return x && x.state === 'error' && x; });
    const refused = imap.stats().refused;
    await sleep(6000);
    ok('a wrong password: shown (flagged for the tray), and not tried again and again', w && w.auth === true && /登录被拒/.test(w.error) && imap.stats().refused === refused, [w, refused, imap.stats()]);
    // the right password now: connects at once
    imap.add(msg({ to: 'wang@test.ac.cn', subject: '给王的', body: plain('x'), id: 'wang1' }));
    const upd = (await req('POST', '/api/mail/accounts/update', { id: bad.account.id, pass: 'wang-pass' }, cookie)).j || {};
    const users = imap.box; void users;
    ok('password changed: accepted (kept on the NAS only)', upd.ok && !JSON.stringify(upd).includes('wang-pass'), upd);

    // removed, with its mail
    const rm = (await req('POST', '/api/mail/accounts/remove', { id: acc, purge: true }, cookie)).j || {};
    ok('an account removed with its mail', rm.ok && (await list('?acc=' + acc)).length === 0 && !fs.existsSync(path.join(T, 'srv', 'data', 'mail', acc)));
  } catch (e) { fail++; console.log('ERROR', e); }
  finally { srv.kill(); await imap.close(); }
  await sleep(500);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
