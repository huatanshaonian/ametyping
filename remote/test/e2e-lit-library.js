// e2e: 文献 › 图书馆通道. A throwaway server with the literature module on a fake Zotero and a fake browser
// (fake-browser.js: the DevTools port over a small model of the publishers):
//   off until the port is set; a paper's PDF through the browser into Zotero (the upload flow), its tab closed;
//   补齐: every paper of 每日文献 / 调研工作 without a PDF queued, one at a time; a page without a PDF link and a PDF
//   link that answers with a page = not subscribed (failed, not tried again); "are you a robot" stops the whole site
//   (its tab left open for the user, nothing clicked, nothing retried) until 继续; IEEE without an account = a sign-in
//   the user has to do; with one: the account typed, the password left to the browser (not saved for it = stop, the
//   button not pressed), 登录 pressed once, the PDF taken out of the viewer's frame; the institution's session still
//   good = no form; a login form with a captcha box = stop; 重试 / 不下了; the daily cap; the browser gone = paused.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createFakeZotero } = require('./fake-zotero');
const { createFakeBrowser } = require('./fake-browser');
const { makePdf } = require('./make-pdf');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-litlib-'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const WD = path.join(T, 'webdav'); fs.mkdirSync(WD);
const PORT = 18877;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 900)}`); };
const req = (method, p, body, cookie) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    const cs = []; res.on('data', (c) => cs.push(c));
    res.on('end', () => { const b = Buffer.concat(cs); let j = null; try { j = JSON.parse(b.toString('utf8')); } catch {} resolve({ status: res.statusCode, j, body: b, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.on('error', () => resolve({ status: 0, j: null, body: Buffer.alloc(0), cookie: '' }));
  r.end(data);
});
async function until(fn, ms = 15000, step = 100) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; }

const PDF = makePdf(['a paper fetched through the library access', 'its second page']);
const art = (key, title, DOI, col) => ({ key, itemType: 'journalArticle', title, creators: [{ creatorType: 'author', lastName: 'Li', firstName: 'A.' }], date: '2025', ...(DOI ? { DOI } : {}), collections: [col] });
const zot = createFakeZotero({ webdavDir: WD,
  collections: [{ key: 'JDF645IP', name: '每日文献' }, { key: 'SURVEY01', name: '调研工作' }, { key: 'SURVEY02', name: '优化', parent: 'SURVEY01' }, { key: 'OTHER001', name: '别的' }],
  items: [art('PAPEROK1', 'Stealth design by adjoint method', '10.1016/ok', 'SURVEY01'), art('PAPERCHK', 'Checked by a robot test', '10.1016/check', 'SURVEY02'),
    art('PAPERNON', 'Not subscribed at all', '10.1016/none', 'JDF645IP'), art('PAPERIE1', 'Polarization scattering of a plasma sheath', '10.1109/55', 'SURVEY01'),
    art('PAPERDEN', 'Waverider trajectories', '10.2514/denied', 'JDF645IP'), art('PAPERNOD', 'No DOI here', '', 'SURVEY01'),
    art('PAPERIE2', 'A second IEEE paper', '10.1109/77', 'OTHER001'), art('PAPERIE3', 'A third IEEE paper', '10.1109/88', 'OTHER001'), art('PAPEROTH', 'Elsewhere', '10.1016/ok2', 'OTHER001')] });
const br = createFakeBrowser({ pdf: PDF });

(async () => {
  const zp = await zot.listen(), bp = await br.listen();
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex-lit.js')] };
  cfg.literature = { zotero: `http://127.0.0.1:${zp}`, webdavDir: WD, kbDir: path.join(T, 'kb'), refreshMs: 300, feed: false, review: false, pdfGapSec: 0.15,
    browser: { loadMs: 3000, settleMs: 10, stepMs: 20, quietMs: 300, checkMs: 20, pdfMs: 5000 }, pdfQueue: { tickMs: 40 } };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  try {
    await until(async () => (await req('GET', '/login')).status === 200, 15000, 150);
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const G = async (p) => (await req('GET', p, null, cookie)).j;
    const P = async (p, b) => (await req('POST', p, b || {}, cookie)).j;
    const Q = () => G('/api/lit/pdfq');
    const item = (key) => G('/api/lit/item?key=' + key);
    const row = async (key) => ((await Q()).items || []).find((x) => x.key === key) || {};
    const quiet = () => until(async () => { const s = await Q(); return !s.running && !s.items.some((x) => x.state === 'waiting' && !s.blocks.some((b) => b.name === x.site)) && s; });
    await until(async () => ((await G('/api/lit/library')).items || []).length === 9);
    ok('not logged in: refused', (await req('GET', '/api/lit/pdfq')).status === 401 && (await req('POST', '/api/lit/pdfq/fill', {})).status === 401);

    // ---- off until the port is set ----
    let s = await Q();
    const a0 = await P('/api/lit/pdfq/add', { key: 'PAPEROK1' }), t0 = await P('/api/lit/pdfq/test');
    ok('off by default: no queue, a paper is not taken, the test says so', s.enabled === false && !a0.ok && /没有开启/.test(a0.msg) && !t0.ok && (await item('PAPEROK1')).pdfVia === false, { s, a0, t0 });
    const bad = await P('/api/lit/settings', { ieeeAccount: 'not an address', pdfGapSec: 5 });
    ok('settings: an account that is no address and a gap too short are refused', !bad.ok && /邮箱/.test(bad.msg) && /pdfGapSec/.test(bad.msg) && bad.ieeeAccount === '', bad);
    const set = await P('/api/lit/settings', { browserPort: bp });
    const t1 = await P('/api/lit/pdfq/test');
    ok('the port set (no restart): the browser answers', set.ok && set.browserPort === bp && /passport\.escience\.cn/.test(set.ieeeIdp) && t1.ok && /FakeChrome/.test(t1.msg) && (await Q()).enabled && (await G('/api/lit')).pdfq.enabled, { set, t1 });

    // ---- one paper ----
    await P('/api/lit/zotero/authorize');
    await until(async () => (await G('/api/lit')).zotero.canWrite);
    const a1 = await P('/api/lit/pdfq/add', { key: 'PAPEROK1' });
    const d1 = await until(async () => { const d = await item('PAPEROK1'); return d.pdf && d; });
    const f1 = await req('GET', '/api/lit/pdf?key=PAPEROK1', null, cookie);
    ok('a paper of the library: its page opened by DOI, the PDF taken off the answer and handed to Zotero', a1.ok && d1 && d1.pdf && f1.status === 200 && f1.body.equals(PDF) && zot.writes.some((w) => w.kind === 'file') &&
      br.log[0] === 'https://doi.org/10.1016/ok' && /pdfft/.test(br.log[1]), { d1, log: br.log });
    s = await quiet();
    ok('done, said where it came from; the tab closed again', s.done === 1 && s.items[0].state === 'done' && /ScienceDirect/.test(s.items[0].why) && br.opened === 1 && br.closed === 1 && !d1.pdfNote, s);
    const a2 = await P('/api/lit/pdfq/add', { key: 'PAPEROK1' }), a3 = await P('/api/lit/pdfq/add', { key: 'PAPERNOD' });
    ok('with a PDF already, or without a DOI: not taken', !a2.ok && /已经有/.test(a2.msg) && !a3.ok && /DOI/.test(a3.msg), { a2, a3 });

    // ---- 补齐: 每日文献 and 调研工作 (with their folders), what stops and what goes on ----
    const fl = await P('/api/lit/pdfq/fill');
    ok('补齐: the four without a PDF in the two collections (not the one elsewhere, not the one without a DOI)', fl.ok && fl.n === 4, fl);
    s = await quiet();
    const st = Object.fromEntries(s.items.map((x) => [x.key, x]));
    ok('no PDF link on the page, and a PDF link that answers with a page: not subscribed -- failed, said so', st.PAPERNON.state === 'failed' && /没有 PDF 入口/.test(st.PAPERNON.why) && st.PAPERDEN.state === 'failed' && /没有权限/.test(st.PAPERDEN.why) && /AIAA/.test(st.PAPERDEN.site), st);
    const bSd = s.blocks.find((b) => b.site === 'sciencedirect'), bIe = s.blocks.find((b) => b.site === 'ieee');
    ok('"are you a robot": ScienceDirect stops for the user, the paper keeps waiting, the tab stays open for them', bSd && bSd.need === 'verify' && /人机验证/.test(bSd.msg) && bSd.waiting === 1 && st.PAPERCHK.state === 'waiting' && br.opened - br.closed === 1, { bSd, o: br.opened, c: br.closed });
    ok('IEEE without access and no account set: a sign-in the user has to do', bIe && bIe.need === 'signin' && /机构/.test(bIe.msg) && st.PAPERIE1.state === 'waiting' && br.logins === 0, bIe);
    ok('a paper says where its PDF stands; the desktop knows something waits', /人机验证/.test((await item('PAPERCHK')).pdfNote) && /没拿到/.test((await item('PAPERNON')).pdfNote) && (await G('/api/lit')).pdfq.blocks === 2);
    const n0 = br.log.length; await sleep(700);
    ok('nothing is tried again on its own', br.log.length === n0 && br.log.filter((u) => /10\.1016\/check/.test(u)).length === 1 && br.log.filter((u) => /10\.1016\/none/.test(u)).length === 1, br.log);
    const more = await P('/api/lit/pdfq/add', { key: 'PAPEROTH' });
    await sleep(500);
    ok('another paper of a stopped site waits with it (the site is not asked)', more.ok && (await row('PAPEROTH')).state === 'waiting' && br.log.length === n0);

    // the user answered the check
    br.passed = true;
    ok('继续', (await P('/api/lit/pdfq/continue', { site: 'sciencedirect' })).ok);
    await until(async () => (await item('PAPERCHK')).pdf && (await item('PAPEROTH')).pdf);
    s = await quiet();
    ok('after the check: both of the site fetched, one after the other; the tab left open is closed', (await row('PAPERCHK')).state === 'done' && (await row('PAPEROTH')).state === 'done' && !s.blocks.some((b) => b.site === 'sciencedirect') && br.opened === br.closed, { s, o: br.opened, c: br.closed });

    // ---- IEEE: the institution's sign-in ----
    ok('the account set', (await P('/api/lit/settings', { ieeeAccount: 'me@mails.test' })).ieeeAccount === 'me@mails.test');
    br.saved = 'someone-else@x.test';
    await P('/api/lit/pdfq/continue', { site: 'ieee' });
    s = await until(async () => { const q = await Q(); return !q.running && q.blocks.find((b) => b.site === 'ieee' && /没有存/.test(b.msg)) && q; });
    ok('the browser has no password saved for that account: stop -- the account was typed, 登录 was not pressed', !!s && br.typed === 'me@mails.test' && br.logins === 0 && (await row('PAPERIE1')).state === 'waiting', { s, typed: br.typed });
    br.saved = 'me@mails.test';
    await P('/api/lit/pdfq/continue', { site: 'ieee' });
    await until(async () => (await item('PAPERIE1')).pdf);
    const wayf = br.log.filter((u) => /wayf\.jsp/.test(u)).pop() || '';
    ok('saved for it: signed in through the institution (登录 pressed once), back on the paper, the PDF out of the viewer frame', (await item('PAPERIE1')).pdf && br.logins === 1 && br.signedIn &&
      /entityId=https%3A%2F%2Fpassport\.escience\.cn%2Fidp%2Fshibboleth/.test(wayf) && /url=https%3A%2F%2Fieeexplore\.ieee\.org%2Fdocument%2F55/.test(wayf) && br.log.filter((u) => /getPDF\.jsp.*=55/.test(u)).length === 3 /* once without access before; now in the frame, then as the page */, { wayf, logins: br.logins, si: br.signedIn, n: br.log.filter((u) => /getPDF.jsp.*=55/.test(u)).length });
    // IEEE forgot the browser, the institution has not
    br.signedIn = false;
    await P('/api/lit/pdfq/add', { key: 'PAPERIE2' });
    await until(async () => (await item('PAPERIE2')).pdf);
    ok('IEEE signed out, the institution still signed in: through without a form', (await item('PAPERIE2')).pdf && br.logins === 1 && br.signedIn);
    br.signedIn = false; br.idpSession = false; br.captchaBox = true;
    await P('/api/lit/pdfq/add', { key: 'PAPERIE3' });
    s = await until(async () => { const q = await Q(); return !q.running && q.blocks.find((b) => b.site === 'ieee') && q; });
    ok('a login form asking for more than account and password: stop, nothing typed or pressed', !!s && /验证码/.test(s.blocks[0].msg) && br.logins === 1 && br.typed === '' && (await row('PAPERIE3')).state === 'waiting', s && s.blocks);

    // ---- 重试 / 不下了 / the day's cap / the browser gone ----
    const lg = br.log.length;
    ok('重试 a failed one: asked once more, failed again', (await P('/api/lit/pdfq/retry', { key: 'PAPERNON' })).ok && !!(await until(async () => br.log.length > lg && (await row('PAPERNON')).state === 'failed')));
    ok('不下了: out of the queue', (await P('/api/lit/pdfq/drop', { key: 'PAPERNON' })).ok && !(await row('PAPERNON')).key && !(await item('PAPERNON')).pdfNote);
    s = await Q();
    await P('/api/lit/settings', { pdfPerDay: s.today });
    const lg2 = br.log.length;
    await P('/api/lit/pdfq/retry', { key: 'PAPERDEN' }); await sleep(600);
    s = await Q();
    ok('the day’s cap reached: the rest waits for tomorrow', s.limit === true && s.waiting >= 1 && br.log.length === lg2 && (await row('PAPERDEN')).state === 'waiting', s);
    await P('/api/lit/settings', { pdfPerDay: 100 });
    await until(async () => (await row('PAPERDEN')).state === 'failed');
    br.extOn = false; const lg3 = br.log.length;
    await P('/api/lit/pdfq/retry', { key: 'PAPERDEN' });
    s = await until(async () => { const q = await Q(); return q.browser && q; });
    ok('the library’s extension signed out, its website too: asked first, the publisher is not -- everything pauses and says so', !!s && /MyLOFT 掉线/.test(s.browser) && br.log.length === lg3 && br.extAsked > 0 && br.homeOpened === 1 && (await row('PAPERDEN')).state === 'waiting' && br.opened === br.closed, s);
    br.webSession = true;
    ok('its website still signed in: opening it brings the extension back, and on it goes (继续 only ends the pause early)', (await P('/api/lit/pdfq/continue', { site: 'aiaa' })).ok && !!(await until(async () => br.log.length > lg3 && (await row('PAPERDEN')).state === 'failed')) && br.extOn && br.homeOpened === 2);
    br.close(); await sleep(100);
    await P('/api/lit/pdfq/retry', { key: 'PAPERDEN' });
    s = await until(async () => { const q = await Q(); return q.browser && q; });
    ok('the browser is not there: everything pauses and says so; the paper keeps waiting', !!s && /连不上/.test(s.browser) && (await row('PAPERDEN')).state === 'waiting' && /暂停/.test((await item('PAPERDEN')).pdfNote) && !(await P('/api/lit/pdfq/test')).ok, s);
    const saved = JSON.parse(fs.readFileSync(path.join(T, 'srv', 'data', 'literature', 'pdf-queue.json'), 'utf8')), sets = fs.readFileSync(path.join(T, 'srv', 'data', 'literature', 'settings.json'), 'utf8');
    ok('kept on disk: the queue and what waits; the settings hold the account, never a password', saved.items.PAPERDEN.state === 'waiting' && saved.blocks.ieee && /me@mails\.test/.test(sets) && !/password/i.test(sets + JSON.stringify(saved)));
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    srv.kill(); zot.close(); try { br.close(); } catch {} await sleep(300);
    if (fail) console.log('--- server output ---\n' + out.slice(-3000));
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
