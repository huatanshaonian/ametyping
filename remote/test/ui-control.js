// UI check (控制面板): one window for every setting -- the items with their icons, each page inside it, the old ways in
// (start menu, the calendar's 「连接 Google 日历」, 邮件's 设置) landing on the right page, AI 模型 (models from a fake
// Codex cache, a change saved), the phone (icons first, then the page, and back). Shots in test/out/shots/8x-control-*.png.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uictl-'));
const PORT = 18890, CDP = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const HOME = path.join(T, 'codexhome'); fs.mkdirSync(HOME);
const lv = (...e) => e.map((x) => ({ effort: x }));
fs.writeFileSync(path.join(HOME, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier intelligence', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), default_reasoning_level: 'low', visibility: 'list' },
  { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', description: 'Previous generation workhorse', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), default_reasoning_level: 'medium', visibility: 'list' },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Fast and affordable', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max'), default_reasoning_level: 'medium', visibility: 'list' }] }));
fs.writeFileSync(path.join(HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'SECRET' }, last_refresh: '2026-09-28T20:01:56Z' }));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000' };
cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')], codexHome: HOME };
fs.writeFileSync(CFG, JSON.stringify(cfg));
fs.mkdirSync(path.join(T, 'srv', 'data'), { recursive: true });
fs.writeFileSync(path.join(T, 'srv', 'data', 'codex-check.json'), JSON.stringify({ version: '0.160.0', at: Date.now() - 2 * 86400e3, error: '' }));

const getJSON = (url, method = 'GET') => new Promise((resolve, reject) => { const r = http.request(url, { method }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.end(); });
function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0].split('=')); });
    req.end(body);
  });
}

(async () => {
  const errors = [], res = [];
  const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  let chrome;
  try {
    await sleep(2500);
    const [cname, cval] = await login();
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
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error') errors.push('log: ' + o.params.entry.text.slice(0, 300) + ' ' + (o.params.entry.url || ''));
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    const winTitle = () => evalJs("[...document.querySelectorAll('.win .title')].map(t => t.textContent).join('|')");
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    const desk = await evalJs("[...document.querySelectorAll('.dicon')].map(b => b.textContent).join('|')");
    const menu = await evalJs("[...document.querySelectorAll('#startmenu .smi')].map(b => b.textContent).join('|')");
    chk('desktop and start menu: 控制面板 in, the separate settings out', /控制面板/.test(desk) && !/显示属性/.test(desk) && /控制面板/.test(menu) &&
      !/添加电脑|Google 账户|声音/.test(menu) && /重要计划/.test(menu) && /网上邻居/.test(menu), [desk, menu]);
    await evalJs("[...document.querySelectorAll('.dicon')].find(b => b.textContent.includes('控制面板')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"); await sleep(1500);
    const items = await evalJs("[...document.querySelectorAll('.cp-item .cp-l')].map(b => b.textContent).join('|')");
    chk('控制面板: the seven items with their icons; the first one open beside them', items === '显示属性|声音|通知|电脑|Google 账户|邮箱|AI 模型' &&
      (await evalJs("document.querySelectorAll('.cp-item img').length")) === 7 && (await evalJs("!!document.querySelector('.cp-pane .walls')")), items);
    await shot('80-control-display.png');
    for (const [label, sel, txt] of [['声音', '.sounds', '全部静音'], ['通知', '.nt', '收通知的设备'], ['电脑', '.computers', '已登记的电脑'], ['Google 账户', '.gacc', '授权客户端'], ['邮箱', '.mla', '添加邮箱'], ['AI 模型', '.aim', '默认']]) {
      await evalJs(`[...document.querySelectorAll('.cp-item')].find(b => b.textContent.includes('${label}')).click()`); await sleep(900);
      chk(`控制面板 → ${label}: the page inside, the title says so`, (await evalJs(`(document.querySelector('.cp-pane ${sel}') || {}).textContent || ''`)).includes(txt) && (await winTitle()).includes('控制面板 - ' + label),
        [await winTitle(), await evalJs("document.querySelector('.cp-pane').textContent.slice(0, 120)")]);
    }
    // AI 模型: the models of the account, efforts per model, a change saved; Codex's state
    await sleep(800);
    const ai = await evalJs("(() => { const s = [...document.querySelectorAll('.aim-row select')]; return { rows: document.querySelectorAll('.aim-row').length, models: [...s[0].options].map(o => o.value).join(), codex: document.querySelector('.aim-codex').textContent }; })()");
    chk('AI 模型: a default row + six jobs, the account\'s models, Codex version / newest / login', ai.rows === 7 && ai.models === ',gpt-6-astra,gpt-6-sol,gpt-6-luna' &&
      /0\.158\.0/.test(ai.codex) && /0\.160\.0（有新版本）/.test(ai.codex) && /已登录（ChatGPT 账号）/.test(ai.codex) && !/SECRET/.test(ai.codex), ai);
    await evalJs("(() => { const row = [...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')); const [m] = row.querySelectorAll('select'); m.value = 'gpt-6-astra'; m.dispatchEvent(new Event('change')); })()"); await sleep(300);
    const efforts = await evalJs("[...[...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')).querySelectorAll('select')[1].options].map(o => o.value).join()");
    await evalJs("(() => { const row = [...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')); const e = row.querySelectorAll('select')[1]; e.value = 'xhigh'; e.dispatchEvent(new Event('change')); })()");
    await sleep(1500);
    const saved = await evalJs("fetch('/api/ai').then(r => r.json()).then(v => JSON.stringify(v.tasks.find(t => t.id === 'ask').set))");
    const uses = await evalJs("[...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')).querySelector('.aim-uses').textContent");
    chk('a job set on its own: the efforts that model has, saved, what it will use shown', efforts === ',low,medium,high,xhigh,max,ultra' && /GPT-6-Astra · 很高/.test(uses) && saved === '{"model":"gpt-6-astra","effort":"xhigh"}', [efforts, uses, saved]);
    await shot('81-control-ai.png');
    // the old ways in land on their page
    await evalJs("(async () => (await import('/js/apps/calendar.js')).open())()"); await sleep(1500);
    await evalJs("[...document.querySelectorAll('.cal-g .rs-link')].find(b => b.textContent.includes('连接 Google')).click()"); await sleep(1200);
    chk('the calendar\'s 「连接 Google 日历」 opens 控制面板 → Google 账户', (await winTitle()).includes('控制面板 - Google 账户'), await winTitle());
    await evalJs("(async () => (await import('/js/apps/mail.js')).open())()"); await sleep(1200);
    await evalJs("[...document.querySelectorAll('.ml-bar .btn')].find(b => b.textContent === '设置').click()"); await sleep(1200);
    chk('邮件\'s 设置 opens 控制面板 → 邮箱 (one 控制面板 window)', (await winTitle()).includes('控制面板 - 邮箱') && (await evalJs("document.querySelectorAll('.cp').length")) === 1, await winTitle());
    // phone: icons first, then the page with a way back
    await evalJs("[...document.querySelectorAll('.win')].forEach(w => { const t = w.querySelector('.title'); if (t && !t.textContent.startsWith('控制面板')) w.querySelector('.tbtn.close').click(); })"); await sleep(300);
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
    await sleep(1000);
    await evalJs("document.querySelector('.cp-back').click()"); await sleep(500);
    chk('phone: the icons first', await evalJs("getComputedStyle(document.querySelector('.cp-nav')).display !== 'none' && getComputedStyle(document.querySelector('.cp-main')).display === 'none'"), 0);
    await shot('82-control-phone.png');
    await evalJs("[...document.querySelectorAll('.cp-item')].find(b => b.textContent.includes('AI 模型')).click()"); await sleep(1200);
    chk('phone: an item fills the window, with ‹ 控制面板 to go back', await evalJs("getComputedStyle(document.querySelector('.cp-nav')).display === 'none' && getComputedStyle(document.querySelector('.cp-back')).display !== 'none' && !!document.querySelector('.cp-pane .aim')"), 0);
    await shot('83-control-phone-ai.png');
    ws.close();
  } catch (e) { errors.push('test: ' + e.stack); }
  finally { try { chrome && chrome.kill(); } catch {} srv.kill(); }
  for (const r of res) console.log(r);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  await sleep(800);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(res.some((r) => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})();
