// UI check (通知 / 安装为应用): the manifest (behind the login), the service worker and app icons (public), the worker
// registered, 控制面板 → 通知, a notification's link opening that session. Screenshots in test/out/shots.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uinotify-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-demo');
fs.mkdirSync(PROJ, { recursive: true }); fs.mkdirSync(path.join(HOME, '.ametyping'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18848, PET = 18849, CDP = 9346, SID = 'eeeeeeee-1111-2222-3333-444444444444', SID2 = 'ffffffff-1111-2222-3333-444444444444';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const J = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(path.join(PROJ, SID + '.jsonl'), J({ type: 'permission-mode', permissionMode: 'plan', sessionId: SID }) +
  J({ type: 'user', uuid: 'u1', cwd: '/demo', timestamp: new Date(now - 60e3).toISOString(), message: { role: 'user', content: '先想想怎么改' } }) +
  J({ type: 'assistant', uuid: 'a1', cwd: '/demo', timestamp: new Date(now - 50e3).toISOString(), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '计划如下……' }] } }));
fs.writeFileSync(path.join(PROJ, SID2 + '.jsonl'), J({ type: 'user', uuid: 'v1', cwd: '/demo', timestamp: new Date(now - 40e3).toISOString(), message: { role: 'user', content: '另一个会话的问题' } }) +
  J({ type: 'assistant', uuid: 'v2', cwd: '/demo', timestamp: new Date(now - 30e3).toISOString(), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '另一个会话的回答' }] } }));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: true, petPort: PET, scanMs: 400 }));
const petToken = 'z'.repeat(64);
fs.writeFileSync(path.join(HOME, '.ametyping', `control-token-${PET}`), petToken);
const CYCLE = ['auto', 'manual', 'acceptEdits', 'plan'];
let mode = 'plan', perms = [];
const keys = [], decisions = [];
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-ame-control'] !== petToken) { res.statusCode = 403; return res.end('{}'); }
    const d = b ? JSON.parse(b) : {};
    if (req.url === '/control/state') return res.end(JSON.stringify({ control: true, sessions: [{ id: SID, label: 'demo 会话', project: 'demo', state: perms.length ? 'waiting' : 'idle', via: 'terminal', t0: now, last: now, lines: [], perms },
      { id: SID2, label: '第二个会话', project: 'demo', state: 'idle', via: 'terminal', t0: now, last: now - 1000, lines: [], perms: [] }] }));
    if (req.url === '/control/key') {
      keys.push(d.key);
      if (d.key === 'btab') { mode = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]; return res.end(JSON.stringify({ ok: true, mode })); }
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === '/control/decide') { decisions.push(d); perms = perms.filter((p) => p.id !== d.id); return res.end(JSON.stringify({ ok: true })); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(PET, '127.0.0.1');

const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0].split('=')); });
    req.end(body);
  });
}
const getJSON = (url, method = 'GET') => new Promise((resolve, reject) => { const r = http.request(url, { method }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.end(); });

(async () => {
  const errors = [], res = [];
  const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
  let chrome;
  try {
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' }); await sleep(800);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }); await sleep(3000);
    const [cname, cval] = await login();
    chrome = cp.spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${path.join(T, 'chrome')}`, '--no-first-run', '--no-proxy-server', 'about:blank'], { stdio: 'ignore' });
    await sleep(2000);
    const tab = await getJSON(`http://127.0.0.1:${CDP}/json/new?about:blank`, 'PUT');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r) => ws.on('open', r));
    let id = 0; const pending = new Map();
    ws.on('message', (m) => {
      const o = JSON.parse(m);
      if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); }
      if (o.method === 'Runtime.exceptionThrown') errors.push('exception: ' + JSON.stringify(o.params.exceptionDetails.exception && o.params.exceptionDetails.exception.description || o.params.exceptionDetails.text).slice(0, 300));
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error') errors.push('log: ' + o.params.entry.text.slice(0, 300));
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    const key = async (k, vk, modifiers = 0) => {
      await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, modifiers });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, modifiers });
    };

    const get = (p, withCookie) => new Promise((r) => http.get({ host: '127.0.0.1', port: PORT, path: p, headers: withCookie ? { Cookie: cname + '=' + cval } : {} }, (x) => { let b = ''; x.on('data', (c) => b += c); x.on('end', () => r({ s: x.statusCode, t: x.headers['content-type'] || '', b })); }));
    const mf = await get('/manifest.webmanifest', true), mf0 = await get('/manifest.webmanifest', false);
    let man = {}; try { man = JSON.parse(mf.b); } catch {}
    chk('manifest: with the login, an app description with icons (maskable too)', mf.s === 200 && /manifest\+json/.test(mf.t) && man.display === 'standalone' && man.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'), mf);
    chk('manifest: without the login, nothing', mf0.s === 302 || mf0.s === 401, mf0.s);
    const sw = await get('/sw.js', false), ic = await get('/app/icon-192.png', false), bad = await get('/app/../server/config.json', false);
    chk('service worker and app icons: public', sw.s === 200 && /javascript/.test(sw.t) && sw.b.includes('notificationclick') && ic.s === 200 && /png/.test(ic.t) && bad.s !== 200, [sw.s, ic.s, bad.s]);
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);
    const swOk = await evalJs("navigator.serviceWorker.getRegistration().then(r => !!(r && (r.active || r.installing || r.waiting)) && r.scope)");
    chk('the page registers the service worker for the whole site', swOk === `http://127.0.0.1:${PORT}/`, swOk);
    chk('the page links the manifest (with credentials) and a theme colour', await evalJs("(() => { const l = document.querySelector('link[rel=manifest]'); return !!l && l.crossOrigin === 'use-credentials' && !!document.querySelector('meta[name=theme-color]'); })()"), 0);
    // 控制面板 → 通知
    await evalJs("import('/js/apps/control.js').then(m => m.open('notify'))"); await sleep(1200);
    const pane = await evalJs("(document.querySelector('.nt') || {}).textContent || ''");
    chk('控制面板 → 通知: this device, installing, the devices', pane.includes('这台设备') && pane.includes('安装为应用') && pane.includes('收通知的设备') && pane.includes('还没有设备开启通知'), pane.slice(0, 300));
    chk('控制面板: 通知 listed', await evalJs("[...document.querySelectorAll('.cp-item')].some(b => b.textContent.includes('通知'))"), 0);
    await shot('b0-notify.png');
    // a device turned on elsewhere: listed with its kinds; this browser can switch its own after enabling (not here: no push service offline)
    await evalJs(`fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/fake1', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }, name: '安卓 Chrome' }) }).then(r => r.json())`);
    await evalJs("import('/js/apps/control.js').then(m => { m.open('display'); m.open('notify'); })"); await sleep(1200);
    const pane2 = await evalJs("document.querySelector('.nt').textContent");
    chk('a device turned on: listed with test / remove', pane2.includes('安卓 Chrome') && pane2.includes('测试') && pane2.includes('删除'), pane2.slice(0, 400));
    await shot('b1-notify-device.png');
    // a notification's link: #s=<machine|session> opens that session in 糖糖看板
    await evalJs(`location.hash = '#s=' + encodeURIComponent('box|${SID}')`); await sleep(1500);
    const opened = await evalJs("(() => { const w = [...document.querySelectorAll('.win')].find(x => x.textContent.includes('糖糖看板')); return w ? (w.querySelector('.dash .head b') || {}).textContent : null; })()");
    chk('a notification\'s link opens that session', opened === 'demo 会话' && (await evalJs('location.hash')) === '', [opened, await evalJs('location.hash')]);
    // the device list API with its key
    const info = await evalJs("fetch('/api/push').then(r => r.json())");
    chk('/api/push: the key for subscribing, the kinds, the device', info.key && info.key.length > 80 && info.kinds.join() === 'approval,done,ctx,mail' && info.devices.length === 1, info);
  } catch (e) { errors.push('script: ' + e.stack); }
  finally {
    console.log(res.join('\n'));
    try { chrome && chrome.kill(); } catch {}
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(800);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
    process.exit(0);
  }
})();
