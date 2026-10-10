// e2e: 写信 / 回复 / 转发 / 发送 -- the real server with a fake mailbox (fake-imap.js) and a fake SMTP server
// (fake-smtp.js): a reply filled in from the mail answered (who, Re:, the quote, In-Reply-To / References), reply-all
// without yourself, a forward with the original's attachment (from the mailbox), a file you attach, 「让 AI 起草」
// (fake-codex.js), the code asked before sending, the checks (addresses, recipients, subject), what goes out by SMTP
// (from the mailbox itself, the signature, the quote), the copy in the sent folder, the original marked answered,
// the draft gone afterwards, the audit log without the text.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { simpleParser } = require(R + '/node_modules/mailparser');
const { createFakeImap } = require('./fake-imap');
const { createFakeSmtp } = require('./fake-smtp');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-send-'));
const PORT = 18870, IMAP = 18871, SMTP = 18872;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 700)}`); };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; };

cp.execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(T, 'k.pem'), '-out', path.join(T, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const key = fs.readFileSync(path.join(T, 'k.pem')), cert = fs.readFileSync(path.join(T, 'c.pem'));
const ME = 'me@test.ac.cn';
const imap = createFakeImap({ key, cert, users: { [ME]: 'pw' } });
const smtpUsers = { [ME]: 'pw' };
const smtp = createFakeSmtp({ key, cert, users: smtpUsers });
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
imap.add(`From: "李老师" <li@test.ac.cn>\r\nTo: ${ME}, wang@test.ac.cn\r\nCc: zhao@test.ac.cn\r\nSubject: =?UTF-8?B?${b64('论文第三章的意见')}?=\r\nDate: ${new Date(Date.now() - 3600e3).toUTCString()}\r\n` +
  `Message-ID: <orig@test>\r\nReferences: <older@test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
  `${b64('第三章的图 3-4 坐标要改成对数。\n周五前改好发我。')}\r\n--b1\r\nContent-Type: application/pdf; name="comments.pdf"\r\nContent-Disposition: attachment; filename="comments.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64('%PDF-1.4 comments')}\r\n--b1--\r\n`);

const req = (method, p, body, cookie, raw) => new Promise((resolve) => {
  const data = raw || (body ? JSON.stringify(body) : '');
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, b, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.on('error', () => resolve({ status: 0 }));
  r.end(data);
});

(async () => {
  await imap.listen(IMAP); await smtp.listen(SMTP);
  const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, NODE_TLS_REJECT_UNAUTHORIZED: '0', AME_MAIL_TRIAGE_MS: '600000', AME_SUMMARY_TICK_MS: '600000' };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')] };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  fs.mkdirSync(path.join(T, 'srv', 'data'), { recursive: true });
  fs.writeFileSync(path.join(T, 'srv', 'data', 'mail.json'), JSON.stringify({ accounts: [{ id: 'a1', address: ME, name: '张三', imap: { host: '127.0.0.1', port: IMAP },
    smtp: { host: '127.0.0.1', port: SMTP }, pass: 'pw', signature: '张三\n力学研究所', added: Date.now() }], state: {} }));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  const totp = (off = 0) => auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + off);
  try {
    await until(async () => (await req('GET', '/login')).status === 200);
    // logged in: a code counts as entered just now
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: totp() });
    const list = async () => ((await req('GET', '/api/mail/list', null, cookie)).j || {}).items || [];
    const orig = await until(async () => (await list()).find((m) => m.subject === '论文第三章的意见'));

    // 回复 / 回复全部 / 转发: filled in from the mail
    const rep = ((await req('POST', '/api/mail/compose/start', { mode: 'reply', key: orig.key }, cookie)).j || {}).draft || {};
    ok('回复: to the sender, Re:, the original quoted, the thread headers, the signature shown', rep.to === '李老师 <li@test.ac.cn>' && !rep.cc && rep.subject === 'Re: 论文第三章的意见' &&
      /写道：\n> 第三章的图 3-4/.test(rep.quote) && rep.inReplyTo === '<orig@test>' && JSON.stringify(rep.references) === '["<older@test>","<orig@test>"]' && rep.signature === '张三\n力学研究所' && rep.from === '张三 <me@test.ac.cn>', rep);
    const all = ((await req('POST', '/api/mail/compose/start', { mode: 'all', key: orig.key }, cookie)).j || {}).draft || {};
    ok('回复全部: the others in to / cc, not yourself', all.to === '李老师 <li@test.ac.cn>' && all.cc === 'wang@test.ac.cn, zhao@test.ac.cn', [all.to, all.cc]);
    const fw = ((await req('POST', '/api/mail/compose/start', { mode: 'forward', key: orig.key }, cookie)).j || {}).draft || {};
    ok('转发: Fwd:, the original under it, its attachment along', fw.subject === 'Fwd: 论文第三章的意见' && /转发的邮件/.test(fw.quote) && /周五前改好发我/.test(fw.quote) &&
      fw.atts.length === 1 && fw.atts[0].name === 'comments.pdf' && fw.atts[0].src === 'orig', fw);
    const drafts = ((await req('GET', '/api/mail/drafts', null, cookie)).j || {}).items || [];
    ok('the drafts are kept (on the NAS)', drafts.length === 3);

    // 让 AI 起草 (only the editor's text; nothing sent)
    const ai = (await req('POST', '/api/mail/compose/ai', { id: rep.id, points: '图已经改好，附上新版本', tone: 'formal' }, cookie)).j || {};
    ok('让 AI 起草: subject and text from the points and the original; nothing sent', ai.ok && ai.subject === 'Re: 论文第三章的意见' && /图已经改好，附上新版本/.test(ai.text) && smtp.got.length === 0, ai);
    await req('POST', '/api/mail/drafts/save', { id: rep.id, text: ai.text }, cookie);
    // a file of your own
    const up = (await req('POST', `/api/mail/upload?draft=${rep.id}&name=${encodeURIComponent('图3-4（改）.png')}&type=image%2Fpng`, null, cookie, Buffer.from('PNGDATA'))).j || {};
    ok('a file attached (kept with the draft)', up.ok && up.att.name === '图3-4（改）.png' && up.att.size === 7, up);
    const big = (await req('POST', `/api/mail/upload?draft=${rep.id}&name=big.bin`, null, cookie, Buffer.alloc(21 * 1024 * 1024))).j || {};
    ok('a file over 20 MB refused', big.ok === false && /20 MB/.test(big.msg), big);

    // checks before anything goes out
    const bad = ((await req('POST', '/api/mail/compose/start', { mode: 'new' }, cookie)).j || {}).draft;
    await req('POST', '/api/mail/drafts/save', { id: bad.id, to: 'nobody, 王 <wang@test.ac.cn>', subject: 'x', text: 'y' }, cookie);
    const s1 = (await req('POST', '/api/mail/send', { id: bad.id }, cookie)).j || {};
    await req('POST', '/api/mail/drafts/save', { id: bad.id, to: 'wang@test.ac.cn', subject: '' }, cookie);
    const s2 = (await req('POST', '/api/mail/send', { id: bad.id }, cookie)).j || {};
    await req('POST', '/api/mail/drafts/save', { id: bad.id, to: Array.from({ length: 51 }, (_, i) => `u${i}@test.ac.cn`).join(','), subject: 'x' }, cookie);
    const s3 = (await req('POST', '/api/mail/send', { id: bad.id }, cookie)).j || {};
    ok('checked before sending: a bad address, no subject, more than 50 recipients -- nothing sent', /地址不对：nobody/.test(s1.msg) && /主题/.test(s2.msg) && /最多 50/.test(s3.msg) && smtp.got.length === 0, [s1, s2, s3]);


    // 发送 the reply
    const sent = (await req('POST', '/api/mail/send', { id: rep.id }, cookie)).j || {};
    ok('sent; the copy in the sent folder; the original marked answered', sent.ok && sent.saved && sent.answered && imap.box.sent.length === 1 &&
      imap.box.msgs[0].flags.includes(String.raw`\Answered`) && !imap.box.msgs[0].flags.includes(String.raw`\Seen`), [sent, imap.box.sent.length, imap.box.msgs[0].flags]);
    const out = smtp.got[0] || {};
    const pm = out.data ? await simpleParser(out.data) : {};
    ok('by SMTP: logged in as the mailbox, from it, to the recipient', out.user === ME && out.from === ME && JSON.stringify(out.rcpt) === '["li@test.ac.cn"]', out);
    ok('the mail: Re: subject, thread headers, the text, the signature, the quote, both attachments in order', pm.subject === 'Re: 论文第三章的意见' && pm.inReplyTo === '<orig@test>' &&
      /图已经改好，附上新版本[\s\S]*-- \n张三\n力学研究所[\s\S]*写道：\n> 第三章的图 3-4/.test(pm.text) && pm.attachments.length === 1 && pm.attachments[0].filename === '图3-4（改）.png' &&
      pm.attachments[0].content.toString() === 'PNGDATA', [pm.subject, pm.inReplyTo, pm.text, (pm.attachments || []).map((a) => a.filename)]);
    const kept = imap.box.sent[0] || {};
    ok('the sent folder has the very same bytes that went out, marked read', kept.raw && kept.raw.toString('latin1').replace(/\r\n$/, '') === out.data.toString('latin1').replace(/\r\n$/, '') &&
      kept.box === 'Sent' && kept.flags.includes(String.raw`\Seen`), [kept.box, kept.flags, kept.raw && kept.raw.length, out.data && out.data.length]);
    ok('the draft is gone after sending', !(((await req('GET', '/api/mail/drafts', null, cookie)).j || {}).items || []).some((x) => x.id === rep.id));

    // 转发, with the original's attachment from the mailbox
    await req('POST', '/api/mail/drafts/save', { id: fw.id, to: '赵 <zhao@test.ac.cn>', text: '转给你看看' }, cookie);
    const s4 = (await req('POST', '/api/mail/send', { id: fw.id }, cookie)).j || {};
    const pf = smtp.got[1] ? await simpleParser(smtp.got[1].data) : {};
    ok('转发: sent with the original attachment taken from the mailbox, not marked answered', s4.ok && pf.subject === 'Fwd: 论文第三章的意见' && pf.attachments.length === 1 &&
      pf.attachments[0].content.toString() === '%PDF-1.4 comments' && /转给你看看[\s\S]*转发的邮件/.test(pf.text) && !s4.answered, [s4, pf.subject, (pf.attachments || []).length]);

    // the audit log: who to and the subject, not the text
    const aud = fs.readFileSync(path.join(T, 'srv', 'audit.log'), 'utf8').split('\n').filter((l) => /mail-send/.test(l));
    ok('the audit log: who to and the subject, not the text', aud.length === 2 && /li@test\.ac\.cn \| Re: 论文第三章的意见/.test(aud[0]) && !aud.some((l) => /附上新版本|转给你看看/.test(l)), aud);

    // the SMTP password refused: said so, the draft kept
    const d5 = ((await req('POST', '/api/mail/compose/start', { mode: 'new' }, cookie)).j || {}).draft;
    await req('POST', '/api/mail/drafts/save', { id: d5.id, to: 'x@test.ac.cn', subject: '测试', text: 'hi' }, cookie);
    smtpUsers[ME] = 'changed';                                    // (the 客户端专用密码 replaced in the webmail)
    const s5 = (await req('POST', '/api/mail/send', { id: d5.id }, cookie)).j || {};
    ok('the SMTP password refused: said so, the draft kept', s5.ok === false && /没有发出去/.test(s5.msg) && (((await req('GET', '/api/mail/drafts', null, cookie)).j || {}).items || []).some((x) => x.id === d5.id), s5);

    // without a code entered within the hour: asked for one, nothing sent (compose.js on its own)
    const { createCompose } = require(R + '/server/mail/compose');
    const c = createCompose({ dataDir: T, accounts: { get: () => null, all: () => [] }, store: { get: () => null } });
    let answer = null;
    await c.handle({ method: 'POST' }, null, new URL('http://x/api/mail/send'), '1', (res, code, o) => { answer = o; }, async () => JSON.stringify({ id: 'x' }), () => false);
    ok('发送 needs a code entered within the hour (asked for one)', answer && answer.need === 'totp' && answer.ok === false, answer);
  } catch (e) { fail++; console.log('ERROR', e); }
  finally { srv.kill(); await imap.close(); await smtp.close(); }
  await sleep(500);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
