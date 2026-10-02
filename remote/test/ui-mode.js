// UI check (权限模式 + 回车允许): server + agent + a fake pet (one terminal session, a Shift+Tab that cycles modes,
// a permission card), headless Chrome over CDP with real key events. Screenshots in test/out/shots.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uimode-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-demo');
fs.mkdirSync(PROJ, { recursive: true }); fs.mkdirSync(path.join(HOME, '.ametyping'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18804, PET = 18805, CDP = 9337, SID = 'eeeeeeee-1111-2222-3333-444444444444';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const J = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(path.join(PROJ, SID + '.jsonl'), J({ type: 'permission-mode', permissionMode: 'plan', sessionId: SID }) +
  J({ type: 'user', uuid: 'u1', cwd: '/demo', timestamp: new Date(now - 60e3).toISOString(), message: { role: 'user', content: '先想想怎么改' } }) +
  J({ type: 'assistant', uuid: 'a1', cwd: '/demo', timestamp: new Date(now - 50e3).toISOString(), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '计划如下……' }] } }));
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
    if (req.url === '/control/state') return res.end(JSON.stringify({ control: true, sessions: [{ id: SID, label: 'demo 会话', project: 'demo', state: perms.length ? 'waiting' : 'idle', via: 'terminal', t0: now, last: now, lines: [], perms }] }));
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
    const modeText = () => evalJs("(document.querySelector('.dash .compose .mode')||{}).textContent||''");
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);
    await evalJs("(() => { const c = [...document.querySelectorAll('.dash .card')].find(x => x.textContent.includes('demo')); c && c.click(); })()"); await sleep(800);
    chk('mode button shows the recorded mode (计划)', (await modeText()) === '计划', await modeText());
    await shot('50-mode-plan.png');
    await evalJs("document.querySelector('.dash .compose .mode').click()"); await sleep(1200);
    chk('clicking it presses Shift+Tab and shows the new mode', keys.join() === 'btab' && (await modeText()) === '自动', [keys, await modeText()]);
    await evalJs("document.querySelector('.dash .say').focus()");
    await key('Tab', 9, 8); await sleep(1200);                          // Shift+Tab in the empty reply box
    chk('Shift+Tab in the empty reply box cycles too', keys.join() === 'btab,btab' && (await modeText()) === '手动', [keys, await modeText()]);
    await key('Tab', 9); await sleep(800);
    chk('plain Tab still goes as tab', keys[2] === 'tab', keys);
    await shot('51-mode-manual.png');
    // a permission card: an Enter right away does nothing, one after the grace time allows it
    perms = [{ id: 'p1', provider: 'claude', tool: 'Bash', cwd: '/demo', input: JSON.stringify({ command: 'rm -rf build', description: '清理构建目录' }, null, 2) }];
    let seen = false;
    for (let i = 0; i < 30 && !seen; i++) { await sleep(100); seen = await evalJs("!!document.querySelector('.dash .perm')"); }
    await key('Enter', 13);
    await sleep(700);
    chk('an Enter as the card appears does not allow it', seen && decisions.length === 0, decisions);
    await shot('52-perm-card.png');
    // another window in front: Enter is not for the dashboard
    await evalJs("(async () => (await import('/js/wallpaper.js')).openSettings())()"); await sleep(600);
    await evalJs("document.activeElement && document.activeElement.blur()");
    await key('Enter', 13); await sleep(700);
    chk('dashboard not the active window: Enter ignored', decisions.length === 0, decisions);
    await evalJs("document.querySelector('.win .tbtn.close') && [...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent === '显示属性').querySelector('.tbtn.close').click()"); await sleep(300);
    await evalJs("[...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent === '糖糖看板').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))"); await sleep(200);
    await evalJs("document.activeElement && document.activeElement.blur()");
    await key('Enter', 13); await sleep(1500);
    chk('Enter allows the card', decisions.length === 1 && decisions[0].choice === 'allow' && decisions[0].id === 'p1', decisions);
    await sleep(1500);
    chk('card gone after the decision', !(await evalJs("!!document.querySelector('.dash .perm')")), 0);
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
