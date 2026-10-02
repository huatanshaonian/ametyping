// e2e: 邮件把关 -- new mail read by the (fake, test/fake-codex.js) model through the real server: a notice to act on
// becomes an alert with its deadline, a journal its picked papers, anything else nothing; the same journal twice is
// asked about once; mail read before it was judged, and old mail with a passed deadline, raise nothing; the research
// interests (from the daily reports + own words) are in the question; 加入重要计划 takes the deadline; reading the
// mail settles its alert; the list carries the judgement.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createFakeImap } = require('./fake-imap');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-triage-'));
const PORT = 18850, IMAP = 18851;
const LOG = path.join(T, 'codex.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 700)}`); };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const DAY = 86400e3;

cp.execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(T, 'k.pem'), '-out', path.join(T, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const ME = 'me@test.ac.cn';
const imap = createFakeImap({ key: fs.readFileSync(path.join(T, 'k.pem')), cert: fs.readFileSync(path.join(T, 'c.pem')), users: { [ME]: 'pw' } });
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
let n = 0;
const mail = (from, subject, text, { ago = 0, seen = false, to = 'all@test.ac.cn' } = {}) => imap.add(`From: ${from}\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${b64(subject)}?=\r\nDate: ${new Date(Date.now() - ago).toUTCString()}\r\n` +
  `Message-ID: <m${++n}@t>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(text)}\r\n`, { date: Date.now() - ago, seen });
// kept before (the first sync): one deadline gone, one ahead
mail('财务处 <cw@test.ac.cn>', '关于九月报销的通知', `请于 ${ymd(Date.now() - 3 * DAY)} 前提交。`, { ago: 5 * DAY });
mail('研究生部 <yjs@test.ac.cn>', '学位论文提交通知', `请于 ${ymd(Date.now() + 20 * DAY)} 前提交论文电子版。`, { ago: 4 * DAY });

const req = (method, p, body, cookie) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, b, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.on('error', () => resolve({ status: 0 }));
  r.end(data);
});

(async () => {
  await imap.listen(IMAP);
  const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, NODE_TLS_REJECT_UNAUTHORIZED: '0', AME_MAIL_TRIAGE_MS: '800', FAKE_CODEX_LOG: LOG, AME_SUMMARY_TICK_MS: '600000' };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')] };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  // a daily report: the research interests come from it
  const RD = path.join(T, 'srv', 'data', 'reports'); fs.mkdirSync(RD, { recursive: true });
  fs.writeFileSync(path.join(RD, ymd(Date.now() - DAY) + '.json'), JSON.stringify({ date: ymd(Date.now() - DAY), headline: 'x', keywords: ['RCS', '超表面'], stats: {},
    projects: [{ name: 'RCS 论文', category: 'research' }, { name: '配代理', category: 'chore' }] }));
  fs.writeFileSync(path.join(RD, 'state.json'), JSON.stringify({ lastTo: Date.now() }));
  // the mailbox already set up
  fs.writeFileSync(path.join(T, 'srv', 'data', 'mail.json'), JSON.stringify({ accounts: [{ id: 'a1', address: ME, name: '所里', imap: { host: '127.0.0.1', port: IMAP }, smtp: { host: 'x', port: 465 }, pass: 'pw', added: Date.now() }], state: {} }));
  // a machine with a pet: the alert should reach it (/control/mail)
  const PET = 18852, HOME = path.join(T, 'home');
  fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true }); fs.mkdirSync(path.join(HOME, '.ametyping'));
  const tok = cp.execFileSync(process.execPath, [R + '/server/setup.js', 'add-agent', 'box'], { env }).toString().split('\n').map((x) => x.trim()).find((x) => /^[A-Za-z0-9_-]{30,}$/.test(x));
  const ACFG = path.join(T, 'agent.json');
  fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, petPort: PET }));
  fs.writeFileSync(path.join(HOME, '.ametyping', `control-token-${PET}`), 'p'.repeat(64));
  const petGot = [];
  const pet = http.createServer((q, s2) => { let b = ''; q.on('data', (c) => b += c); q.on('end', () => {
    s2.setHeader('Content-Type', 'application/json');
    if (q.url === '/control/mail') petGot.push(JSON.parse(b));
    if (q.url === '/control/state') return s2.end(JSON.stringify({ control: false, sessions: [] }));
    s2.end('{"ok":true}');
  }); }).listen(PET, '127.0.0.1');
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  let agent = null;
  try {
    await until(async () => (await req('GET', '/login')).status === 200);
    agent = cp.spawn(process.execPath, [R + '/agent/agent.js'], { env: { ...env, USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }, stdio: 'ignore' });
    await until(async () => (await req('GET', '/login')).status === 200);
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const alerts = async () => (await req('GET', '/api/mail/alerts', null, cookie)).j || {};
    const list = async () => ((await req('GET', '/api/mail/list', null, cookie)).j || {}).items || [];
    const bySubj = (l, s) => l.find((m) => m.subject === s);

    // own words for the interests (before the new mail arrives)
    ok('interests: inferred from the daily reports (research projects, keywords)', ((await req('GET', '/api/mail/interests', null, cookie)).j || {}).projects.includes('RCS 论文'));
    await req('POST', '/api/mail/interests', { text: '也想看机器学习反演' }, cookie);

    // the first sync's two: judged; only the one with a deadline ahead is an alert
    const first = await until(async () => { const l = await list(); return l.length === 2 && l.every((m) => m.t) ? l : null; });
    let a = await alerts();
    ok('kept from before: judged; an alert only for the deadline still ahead', first && a.open.length === 1 && a.open[0].subject === '学位论文提交通知' && a.open[0].deadline === ymd(Date.now() + 20 * DAY), [first, a]);

    // new mail: a notice to act on, a journal (twice: two lists), an ad, and one already read on the phone
    mail('财务处 <cw@test.ac.cn>', '年度经费报销截止提醒', `各课题组：今年的报销请于 ${ymd(Date.now() + 10 * DAY)} 前提交到 ARP 系统。`);
    for (const l of ['l1', 'l2']) mail('院刊 <bulletin@cas.cn>', '中国科学院院刊 第 9 期', `本期推荐：\n1. 面向 6G 的电磁超表面：https://bulletin.cas.cn/a1?u=${l}\n2. 冰川变化的新证据：https://bulletin.cas.cn/a2?u=${l}\n退订：${l}@cas.cn`, { to: l + '@test.ac.cn' });
    mail('某公司 <ad@spam.cn>', '双十一大促', '全场五折');
    mail('研究生部 <yjs@test.ac.cn>', '奖学金报名通知', `请于 ${ymd(Date.now() + 5 * DAY)} 前报名。`, { seen: true });
    const got = await until(async () => { const x = await alerts(); return x.open.length >= 3 ? x : null; });
    a = got || await alerts();
    const act = a.open.find((x) => x.subject === '年度经费报销截止提醒'), rd = a.open.find((x) => x.kind === 'reading');
    ok('a notice to act on: an alert with what to do and its deadline', act && act.kind === 'action' && act.todo && act.deadline === ymd(Date.now() + 10 * DAY) && /前完成/.test(act.deadlineText), act);
    ok('the journal: one alert with the papers picked (links, a fun one marked)', rd && rd.picks.length === 2 && rd.picks[0].url.startsWith('https://bulletin.cas.cn/a1') && rd.picks[1].fun === true &&
      a.open.filter((x) => x.kind === 'reading').length === 1, [rd, a.open.map((x) => x.subject)]);
    const pg = await until(async () => (petGot.length >= 3 ? petGot : null), 8000) || petGot;
    ok('the pet hears of each new alert (for its bubble): what, to do, deadline, the mail\'s key', pg.some((x) => x.summary && x.todo && x.deadline === ymd(Date.now() + 10 * DAY) && x.key) &&
      pg.some((x) => x.kind === 'reading' && x.picks.length === 2), pg);
    ok('the ad and the mail already read: no alert', a.open.length === 3 && !a.open.some((x) => /双十一|奖学金/.test(x.subject)), a.open.map((x) => x.subject));
    const log = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => /新邮件/.test(x.prompt));
    const asked = log.map((x) => (x.prompt.match(/^### M\d+/gm) || []).length).reduce((s, k) => s + k, 0);
    ok('the same journal asked about once (2 old + 4 new = 6 questions about mails)', asked === 6, log.map((x) => (x.prompt.match(/^主题：.*$/gm) || [])));
    ok('the question carries the interests: the reports\' and the user\'s own words; deadlines asked for in the text', /RCS 论文/.test(log[log.length - 1].prompt) && /也想看机器学习反演/.test(log[log.length - 1].prompt) && /仔细看正文里出现的截止/.test(log[log.length - 1].prompt));
    const l = await list();
    ok('the list carries the judgement (label, one line, deadline; the ad: other)', bySubj(l, '年度经费报销截止提醒').t.kind === 'action' && bySubj(l, '年度经费报销截止提醒').t.deadline &&
      bySubj(l, '双十一大促').t.kind === 'other' && !bySubj(l, '双十一大促').t.important, l.map((m) => [m.subject, m.t]));
    const msgJ = (await req('GET', '/api/mail/msg?key=' + encodeURIComponent(bySubj(l, '中国科学院院刊 第 9 期').key), null, cookie)).j || {};
    ok('a message carries the full judgement (the picks)', msgJ.t && msgJ.t.picks.length === 2, msgJ.t);

    // 加入重要计划: with the deadline; the alert settled
    const t1 = (await req('POST', '/api/mail/alerts/todo', { id: act.id }, cookie)).j || {};
    const todos = ((await req('GET', '/api/todos', null, cookie)).j || {}).items || [];
    ok('加入重要计划: the to-do with its deadline, the alert settled', t1.ok && todos.some((x) => x.text === act.todo && x.due === act.deadline && x.project === '邮件') &&
      (await alerts()).done.some((x) => x.id === act.id && x.todoId), [t1, todos]);
    // reading the thesis mail settles its alert (not the journal's: the papers are the point)
    const thesis = bySubj(l, '学位论文提交通知');
    await req('POST', '/api/mail/seen', { keys: [thesis.key], seen: true }, cookie);
    const after = await until(async () => { const x = await alerts(); return x.open.every((y) => y.subject !== '学位论文提交通知') ? x : null; }, 8000);
    ok('the mail read: its alert settled', !!after && after.done.some((x) => x.subject === '学位论文提交通知' && x.doneBy === 'read'), after);
    // 知道了
    await req('POST', '/api/mail/alerts/done', { id: rd.id }, cookie);
    ok('知道了: no alert left open', (await alerts()).open.length === 0);
  } catch (e) { fail++; console.log('ERROR', e); }
  finally { srv.kill(); if (agent) agent.kill(); pet.close(); await imap.close(); }
  await sleep(500);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
