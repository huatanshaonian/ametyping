// UI check (文件路径链接): paths in what Claude said become links in the dashboard; a click opens the file on that
// computer (relative ones from the session's folder, or a folder or two up), a text file at the line named; the
// right-click menu shows it in its folder. Server + agent (files on) + headless Chrome. Screenshots in test/out/shots.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uipaths-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-demo');
const SHARE = path.join(T, 'share'), WORK = path.join(SHARE, 'proj');
fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(path.join(WORK, 'docs', 'figures', 'fdtd'), { recursive: true }); fs.mkdirSync(path.join(WORK, 'src')); fs.mkdirSync(path.join(WORK, 'remote'));
fs.writeFileSync(path.join(WORK, 'docs', 'figures', 'fdtd', 'vvd_plasma_position.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
fs.writeFileSync(path.join(WORK, 'src', 'main.py'), Array.from({ length: 60 }, (_, i) => `print("line ${i + 1}")`).join('\n') + '\n');
fs.writeFileSync(path.join(WORK, 'docs', '报告.md'), '# 报告\n');
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18856, CDP = 9363, SID = 'abababab-1111-2222-3333-444444444444';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const J = (o) => JSON.stringify(o) + '\n';
// Claude Code moved into a subfolder (remote): the paths it writes are from the project's folder
const CWD = path.join(WORK, 'remote');
const SAID = [
  '图在 docs/figures/fdtd/vvd_plasma_position.png 这样的，代码见 `src/main.py:30`。',
  `绝对路径 ${path.join(WORK, 'src', 'main.py')}:40-42，中文名 docs/报告.md，还有 docs/nope.png。`,
  '网址 https://example.com/a/b.png 不算。',
].join('\n\n');
fs.writeFileSync(path.join(PROJ, SID + '.jsonl'),
  J({ type: 'user', uuid: 'u1', cwd: CWD, timestamp: new Date(now - 60e3).toISOString(), message: { role: 'user', content: '图放哪了？' } }) +
  J({ type: 'assistant', uuid: 'a1', cwd: CWD, timestamp: new Date(now - 50e3).toISOString(), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: SAID }] } }));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, scanMs: 400, files: { roots: [SHARE] } }));

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
const portUp = () => new Promise((r) => http.get(`http://127.0.0.1:${PORT}/login`, (res) => { res.resume(); r(true); }).on('error', () => r(false)));

(async () => {
  const errors = [], res = [];
  const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
  let chrome;
  try {
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' });
    for (let i = 0; i < 75 && !(await portUp()); i++) await sleep(200);
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
    const until = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { const v = await evalJs(expr); if (v) return v; await sleep(200); } return evalJs(expr); };
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);
    await evalJs("(() => { const c = document.querySelector('.dash .card'); c && c.click(); })()");
    const links = await until("(() => { const l = [...document.querySelectorAll('.dash .conv a.fp')]; return l.length ? l.map(a => [a.dataset.p, a.dataset.l || '', a.dataset.l2 || '', a.textContent]) : null; })()");
    chk('paths in the answer are links (with their lines); the URL is not', links && links.length === 5 &&
      links[0][0] === 'docs/figures/fdtd/vvd_plasma_position.png' && links[1][0] === 'src/main.py' && links[1][1] === '30' &&
      links[2][1] === '40' && links[2][2] === '42' && links[3][0] === 'docs/报告.md' && links[4][0] === 'docs/nope.png' &&
      !(await evalJs("[...document.querySelectorAll('.dash .conv a.fp')].some(a => a.dataset.p.includes('example'))")), links);
    await shot('70-paths-links.png');
    const click = (i) => evalJs(`document.querySelectorAll('.dash .conv a.fp')[${i}].click()`);
    const win = (name) => `[...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent.startsWith(${JSON.stringify(name)}))`;
    // the picture, found one folder up from where the session is now
    await click(0);
    chk('a picture opens in a viewer (found one folder up from the session\'s folder)', await until(`(() => { const w = ${win('vvd_plasma_position.png')}; return !!(w && w.querySelector('.vimg')); })()`), 0);
    await shot('71-paths-image.png');
    await click(1);
    const m30 = await until(`(() => { const w = ${win('main.py')}; const m = w && w.querySelector('mark.vline'); return m ? [m.textContent, w.querySelector('.vinfo').textContent] : null; })()`);
    chk('a code file opens at the line named, marked', m30 && m30[0] === 'print("line 30")' && m30[1] === '第 30 行', m30);
    const inView = await evalJs(`(() => { const w = ${win('main.py')}; const m = w.querySelector('mark.vline').getBoundingClientRect(), b = w.querySelector('.vbody').getBoundingClientRect(); return m.top >= b.top && m.bottom <= b.bottom; })()`);
    chk('the marked line is in view', inView, 0);
    await shot('72-paths-line.png');
    await click(2);
    const m40 = await until(`(() => { const w = ${win('main.py')}; const m = w && w.querySelector('mark.vline'); return m && m.textContent.startsWith('print("line 40")') ? [m.textContent, w.querySelector('.vinfo').textContent, document.querySelectorAll('.win').length] : null; })()`);
    chk('the same file at other lines (absolute path): the open window moves there', m40 && m40[0] === 'print("line 40")\nprint("line 41")\nprint("line 42")' && m40[1] === '第 40–42 行', m40);
    await click(3);
    chk('a Chinese file name opens', await until(`!!${win('报告.md')}`), 0);
    await click(4);
    const nf = await until("(() => { const n = document.querySelector('.dash .note'); return n && /找不到/.test(n.textContent) ? n.textContent : null; })()");
    chk('a file that is not there: said so', nf && /docs\/nope\.png/.test(nf), nf);
    // right-click: 在文件夹中显示
    await evalJs("(() => { const a = document.querySelectorAll('.dash .conv a.fp')[0]; const r = a.getBoundingClientRect(); a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 })); })()");
    await sleep(400);
    const items = await evalJs("[...document.querySelectorAll('.ctxm .ctxi .lb')].map(x => x.textContent)");
    await evalJs("(() => { const it = [...document.querySelectorAll('.ctxm .ctxi')].find(x => x.querySelector('.lb').textContent === '在文件夹中显示'); it && it.click(); return !!it; })()");
    const ex = await until("(() => { const w = [...document.querySelectorAll('.win')].find(w => w.querySelector('.explorer')); const s = w && w.querySelector('.xlist tr.sel'); return s ? [w.querySelector('.addr').value, s.textContent] : null; })()");
    chk('right-click menu: 打开 / 在文件夹中显示 / 复制路径', items.join() === '打开,在文件夹中显示,复制路径', items);
    chk('「在文件夹中显示」: 我的电脑 at its folder, the file picked', ex && /docs[\\/]figures[\\/]fdtd$/.test(ex[0]) && ex[1].startsWith('vvd_plasma_position.png'), [ex, items]);
    await shot('73-paths-folder.png');
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
