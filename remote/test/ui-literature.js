// UI check (文献): a throwaway server with the literature module on the fakes of e2e-literature.js (Zotero, the paper
// sources, the model), the profile drafted and confirmed and the day's push run through the API; then headless Chrome
// over CDP (login cookie injected): the 文献 window's tabs (今日 with 收下, 文献库 with a card, 知识库, 画像, 产出),
// the 深读 window (the PDF drawn, 理解 -> the model's comparison, a question -> the answer with a page link), the phone
// layout; page errors collected. Shots in test/out/shots/8x-lit-*.png.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const { createFakeZotero, toWebdav } = require('./fake-zotero');
const { createFakeSources } = require('./fake-lit-sources');
const { makePdf } = require('./make-pdf');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uilit-'));
const PORT = 18873, CDP = 9353;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const WD = path.join(T, 'webdav'); fs.mkdirSync(WD);

const zot = createFakeZotero({ webdavDir: WD,
  collections: [{ key: 'QPUW2W6R', name: '气动隐身' }, { key: '4WQG3HZQ', name: '等离子体RCS', parent: 'QPUW2W6R' }, { key: 'JDF645IP', name: '每日文献' }],
  items: [
    { key: 'AAAAAAA1', itemType: 'journalArticle', title: 'Backward scattering of a reentry vehicle in plasma sheath', creators: [{ creatorType: 'author', lastName: 'Sun', firstName: 'Wei' }],
      publicationTitle: 'IEEE Transactions on Antennas and Propagation', ISSN: '0018-926X', DOI: '10.1109/tap.2018.1', date: '2018', abstractNote: 'plasma sheath electron density and backscattering', collections: ['QPUW2W6R'], citationKey: 'sun2018backward' },
    { key: 'ATTAAAA1', itemType: 'attachment', parentItem: 'AAAAAAA1', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'sun2018.pdf' },
    { key: 'ANNAAAA1', itemType: 'annotation', parentItem: 'ATTAAAA1', annotationType: 'highlight', annotationText: 'electron density', annotationComment: '关键', annotationPageLabel: '1', annotationSortIndex: '00001' },
    { key: 'AAAAAAA2', itemType: 'journalArticle', title: 'Radar cross section of cones', creators: [{ creatorType: 'author', lastName: 'Ross', firstName: 'R.' }], date: '1990', collections: ['4WQG3HZQ'] },
  ] });
toWebdav(WD, 'ATTAAAA1', 'sun2018.pdf', makePdf(['plasma sheath electron density profile page one', 'collision frequency model page two']));
const src = createFakeSources();

const getJSON = (url, method = 'GET') => new Promise((resolve, reject) => { const r = http.request(url, { method }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.end(); });
let cookie = '';
const api = (method, p, body) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(data), Cookie: cookie } },
    (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, h: res.headers }); }); });
  r.on('error', () => resolve({ status: 0 })); r.end(data);
});
async function until(fn, ms = 20000, step = 250) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; }

(async () => {
  const zp = await zot.listen(), sp = await src.listen();
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000' };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex-lit.js')] };
  const base = `http://127.0.0.1:${sp}`;
  cfg.literature = { zotero: `http://127.0.0.1:${zp}`, webdavDir: WD, kbDir: path.join(T, 'kb'), refreshMs: 400, pdfWaitMs: 1500, pollMs: 250, at: '23:59', daily: 4,
    endpoints: { openalex: base + '/oa', crossref: base + '/cr', arxiv: base + '/arxiv', aiaa: base + '/aiaa', ntrs: base + '/ntrs' } };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  const errors = [], res = [];
  const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x).slice(0, 600)));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  let chrome;
  try {
    await until(async () => (await api('GET', '/login')).status === 200, 15000);
    const lg = await api('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    cookie = String(lg.h['set-cookie'] || '').split(';')[0];
    const [cname, cval] = cookie.split('=');
    // the state the window shows: library mirrored, profile confirmed, write access, the day's push, one paper kept
    await until(async () => ((await api('GET', '/api/lit')).j || { zotero: {} }).zotero.items === 2);
    await api('POST', '/api/lit/profile/save', { story: '再入飞行器气动隐身：我在算等离子体鞘套对 RCS 的影响，卡在电子密度剖面怎么取，也缺验证数据。' });
    await api('POST', '/api/lit/profile/organize');
    await until(async () => { const r = (await api('GET', '/api/lit/profile')).j; return r.profile && r.profile.organizedAt && !r.state.running; }, 30000);
    await api('POST', '/api/lit/profile/fill');
    const prof = await until(async () => { const r = (await api('GET', '/api/lit/profile')).j; return r.profile && r.profile.filledAt && !r.state.running && r.profile; }, 30000);
    await api('POST', '/api/lit/profile/save', { questions: prof.questions, confirm: true });
    await api('POST', '/api/lit/zotero/authorize');
    await until(async () => (await api('GET', '/api/lit')).j.zotero.canWrite);
    await api('POST', '/api/lit/feed/run');
    await until(async () => { const f = (await api('GET', '/api/lit/feed')).j; return !f.status.running && f.items.length && f; }, 30000);

    chrome = cp.spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${path.join(T, 'chrome')}`, '--no-first-run', '--no-proxy-server', 'about:blank'], { stdio: 'ignore' });
    await sleep(2000);
    const tab = await getJSON(`http://127.0.0.1:${CDP}/json/new?about:blank`, 'PUT');
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
    let id = 0; const pending = new Map();
    ws.on('message', (m) => {
      const o = JSON.parse(m);
      if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); }
      if (o.method === 'Runtime.exceptionThrown') errors.push('exception: ' + JSON.stringify(o.params.exceptionDetails.exception && o.params.exceptionDetails.exception.description || o.params.exceptionDetails.text).slice(0, 300));
      if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push('console: ' + o.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error' && !/favicon/.test(o.params.entry.url || '')) errors.push('log: ' + o.params.entry.text.slice(0, 300) + ' ' + (o.params.entry.url || ''));
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    const waitFor = async (expr, ms = 15000) => { for (let i = 0; i < ms / 300; i++) { if (await evalJs(expr)) return true; await sleep(300); } return false; };
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3000);
    await evalJs("document.querySelectorAll('.win .tbtn.close').forEach(b => b.click())");

    // 今日
    chk('the desktop has a 文献 icon', await evalJs("[...document.querySelectorAll('.dicon')].some(b => b.textContent.includes('文献'))"), 0);
    await evalJs("[...document.querySelectorAll('.dicon')].find(b => b.textContent.includes('文献')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    chk('今日: the picks with why and question, the review with its recall questions', await waitFor("document.querySelectorAll('.lf-i').length >= 3") &&
      /Q1：鞘套电子密度剖面/.test(await evalJs("document.querySelector('.lf-list').textContent")) && await evalJs("document.querySelectorAll('.lf-ans').length === 2"), await evalJs("(document.querySelector('.lf-list')||{}).textContent"));
    chk('the yield of each way of finding is shown', await evalJs("!document.querySelector('.lf-yield').hidden && /期刊/.test(document.querySelector('.lf-yield').textContent) && /够格 1/.test(document.querySelector('.lf-yield').textContent)"),
      await evalJs("(document.querySelector('.lf-yield')||{}).textContent"));
    chk('no stray "null" text in the list', !(await evalJs("/null/.test(document.querySelector('.lf-list').textContent)")), 0);
    await shot('80-lit-feed.png');
    await evalJs("[...document.querySelectorAll('.lf-i')].find(i => i.textContent.includes('RAM C-II')).querySelector('.btn.go').click()");
    chk('收下 -> the stages shown, then the card is ready', await waitFor("[...document.querySelectorAll('.lf-i')].some(i => i.textContent.includes('RAM C-II') && i.textContent.includes('速读卡好了'))", 25000),
      await evalJs("document.querySelector('.lf-list').textContent"));
    await shot('81-lit-kept.png');

    // 文献库: a paper's card
    await evalJs("[...document.querySelectorAll('.lit-tab')].find(b => b.textContent === '文献库').click()");
    await waitFor("document.querySelectorAll('.lb-i').length >= 3");
    await evalJs("[...document.querySelectorAll('.lb-i')].find(i => i.textContent.includes('RAM C-II')).click()");
    chk('文献库: the card rendered (sections, question, page links)', await waitFor("!!document.querySelector('.lb-card h2')") && /与我的关系/.test(await evalJs("document.querySelector('.lb-card').textContent")) &&
      await evalJs("!!document.querySelector('.lb-card .plink')"), await evalJs("(document.querySelector('.lb-view')||{}).textContent"));
    chk('no stray "null" text in the paper', !(await evalJs("/null/.test(document.querySelector('.lb-view').textContent)")), 0);
    await shot('82-lit-library.png');

    // 深读
    await evalJs("[...document.querySelectorAll('.lb-i')].find(i => i.textContent.includes('Backward scattering')).click()"); await sleep(800);
    await evalJs("[...document.querySelectorAll('.lb-acts .btn')].find(b => b.textContent === '深读').click()");
    chk('深读: the PDF drawn on the left, 理解 first on the right', await waitFor("!!document.querySelector('.lr-pdf .pdf-page canvas') && !!document.querySelector('.lr-pane textarea')", 20000) &&
      await evalJs("document.querySelector('.lr-side .lit-tab.on').textContent === '理解'"), await evalJs("(document.querySelector('.lr')||{}).textContent"));
    await evalJs("(() => { const t = document.querySelector('.lr-pane textarea'); t.value = '它测了鞘套电子密度'; t.dispatchEvent(new Event('input')); })()");
    await evalJs("[...document.querySelectorAll('.lr-pane .btn.go')].find(b => b.textContent.includes('对照原文')).click()");
    chk('理解 -> the comparison with the paper and a question back', await waitFor("!!document.querySelector('.lr-fb') && document.querySelector('.lr-fb').textContent.includes('反问')", 25000), await evalJs("document.querySelector('.lr-pane').textContent"));
    await shot('83-lit-understand.png');
    await evalJs("[...document.querySelectorAll('.lr-side .lit-tab')].find(b => b.textContent === '对话').click()"); await sleep(300);
    await evalJs("(() => { const t = document.querySelector('.lr-q'); t.value = 'collision frequency 怎么取？'; t.dispatchEvent(new Event('input')); })()");
    await evalJs("[...document.querySelectorAll('.lr-box .btn.go')].find(b => b.textContent === '问').click()");
    chk('对话: the answer with a clickable page reference', await waitFor("!!document.querySelector('.lr-ai .plink')", 25000), await evalJs("document.querySelector('.lr-pane').textContent"));
    await evalJs("document.querySelector('.lr-ai .plink').click()"); await sleep(600);
    chk('the page link moves the PDF', (await evalJs("document.querySelector('.pdf-no').value")) === '1', await evalJs("document.querySelector('.pdf-no').value"));
    await shot('84-lit-reader.png');
    await evalJs("[...document.querySelectorAll('.lr-box .btn')].find(b => b.textContent === '沉淀到卡片').click()");
    await sleep(2500);

    // 知识库: the proposals from 沉淀
    await evalJs("[...document.querySelectorAll('.win')].forEach(w => { const t = w.querySelector('.title'); if (t && t.textContent.startsWith('深读')) w.querySelector('.tbtn.close').click(); })");
    await evalJs("[...document.querySelectorAll('.lit-tab')].find(b => b.textContent.startsWith('知识库')).click()");
    chk('知识库: the proposals listed; one opened shows the change line by line', await waitFor("[...document.querySelectorAll('.lk-left .lb-i')].some(i => i.textContent.includes('沉淀'))") &&
      (await evalJs("[...document.querySelectorAll('.lk-left .lb-i')].find(i => i.textContent.includes('沉淀')).click(), true")) && await waitFor("!!document.querySelector('.lk-diff .d.add')"), await evalJs("document.querySelector('.lk-left').textContent"));
    await shot('85-lit-kb.png');
    await evalJs("[...document.querySelectorAll('.lk-view .btn.go')].find(b => b.textContent === '接受').click()");
    chk('接受 -> written', await waitFor("document.querySelector('.lk-view').textContent.includes('已写入')"), await evalJs("document.querySelector('.lk-view').textContent"));

    // 画像 and 产出
    await evalJs("[...document.querySelectorAll('.lit-tab')].find(b => b.textContent === '画像').click()");
    chk('画像: the main line, the branches with coverage and their papers by title, a suggestion to take or drop', await waitFor("!!document.querySelector('.lp-t')") &&
      /再入飞行器气动隐身/.test(await evalJs("document.querySelector('.lp textarea').value")) && /总目标/.test(await evalJs("document.querySelectorAll('.lp textarea')[1].value")) && await evalJs("!!document.querySelector('.lp-unclear li')") && await evalJs("[...document.querySelectorAll('.lp-papers a')].some(a => a.textContent.startsWith('Backward scattering'))") &&
      await evalJs("!!document.querySelector('.tag.cov.thin')") && await evalJs("document.querySelectorAll('.lp-sug').length === 1") && !(await evalJs("/[A-Z0-9]{8}/.test(document.querySelector('.lp-ts').textContent)")),
      await evalJs("(document.querySelector('.lp')||{}).textContent"));
    chk('画像: each question with its dimension, where the field stands, and its papers (the library\x27s open in 文献库, new ones by link)',
      await evalJs("[...document.querySelectorAll('.lp-dim')].map(x => x.value).join() === '贴合工作,领域前沿,方法与验证'") && /领域现状/.test(await evalJs("document.querySelector('.lp-qd').textContent")) &&
      await evalJs("!!document.querySelector('.lp-qd a[href^=\"http\"]') && [...document.querySelectorAll('.lp-qd a')].some(a => a.textContent.startsWith('Backward scattering'))"),
      await evalJs("(document.querySelector('.lp-qs')||{}).textContent"));
    chk('no stray "null" text on the profile page', !(await evalJs("/null/.test(document.querySelector('.lp').textContent)")), 0);
    chk('画像: the questions editable, the follow lists', await waitFor("document.querySelectorAll('.lp-q').length === 3") && /0018-926X/.test(await evalJs("[...document.querySelectorAll('.lp textarea')].map(t => t.value).join(' ')")), await evalJs("document.querySelector('.lp').textContent"));
    await shot('86-lit-profile.png');
    await evalJs("[...document.querySelectorAll('.lit-tab')].find(b => b.textContent === '产出').click()");
    chk('产出: the verdict and the counts', await waitFor("!!document.querySelector('.ls-v')") && /写下自己的理解/.test(await evalJs("document.querySelectorAll('.lp')[1].textContent")), await evalJs("document.body.textContent.slice(-400)"));
    await shot('87-lit-stats.png');

    // 控制面板 › 文献, from the 文献 window's 设置
    await evalJs("[...document.querySelectorAll('.lit-tab')].find(b => b.textContent === '设置').click()");
    chk('设置 opens 控制面板 › 文献: the keys (not shown whole), the contact address, the push numbers', await waitFor("!!document.querySelector('.lset input[type=password]')") &&
      /Semantic Scholar/.test(await evalJs("document.querySelector('.lset').textContent")) && /每天最多/.test(await evalJs("document.querySelector('.lset').textContent")) &&
      await evalJs("document.querySelectorAll('.lset input[type=password]').length === 2 && [...document.querySelectorAll('.lset input[type=password]')].every(i => i.value === '')"), await evalJs("(document.querySelector('.lset')||{}).textContent"));
    await evalJs("(() => { const b = document.querySelectorAll('.lset input[type=password]')[0]; b.value = 'S2UIKEY99999'; })()");
    await evalJs("[...document.querySelectorAll('.lset .btn.go')].find(b => b.textContent === '保存').click()");
    chk('a key saved from the page shows as set, its end only', await waitFor("/已填写（末 4 位 9999/.test(document.querySelectorAll('.lset input[type=password]')[0].placeholder)"), await evalJs("document.querySelectorAll('.lset input[type=password]')[0].placeholder"));
    await shot('89-lit-settings.png');
    await evalJs("[...document.querySelectorAll('.win')].forEach(w => { const t = w.querySelector('.title'); if (t && t.textContent.startsWith('控制面板')) w.querySelector('.tbtn.close').click(); })");
    // phone
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
    await sleep(800);
    await evalJs("[...document.querySelectorAll('.lit-tab')].find(b => b.textContent === '文献库').click()"); await sleep(600);
    chk('phone: the list first, a paper replaces it with a way back', await evalJs("document.querySelector('.lit').classList.contains('narrow')") &&
      (await evalJs("[...document.querySelectorAll('.lb-i')][0].click(), true")) && await waitFor("getComputedStyle(document.querySelector('.lit-pane:not([hidden]) .lb-back')).display !== 'none'"), 0);
    await shot('88-lit-phone.png');
    ws.close();
  } catch (e) { errors.push('test: ' + e.stack); }
  finally { try { chrome && chrome.kill(); } catch {} srv.kill(); zot.close(); src.close(); }
  for (const r of res) console.log(r);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  await sleep(800);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  const failed = res.filter((r) => r.startsWith('FAIL')).length + (errors.length ? 1 : 0);
  console.log(`\n${res.length - res.filter((r) => r.startsWith('FAIL')).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
