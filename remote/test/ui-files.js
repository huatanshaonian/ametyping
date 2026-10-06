// UI check: throwaway server + agent with fake sessions, headless Chrome over CDP (login cookie injected),
// screenshots at desktop and phone size, page errors collected.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const SP = __dirname, OUT = path.join(SP, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-ui-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-proj-demo');
fs.mkdirSync(PROJ, { recursive: true });
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18790, CDP = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
let n = 0;
const L = (o, t) => JSON.stringify({ uuid: 'u' + (++n), cwd: '/home/dell/demo', timestamp: new Date(t).toISOString(), ...o }) + '\n';
const now = Date.now();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'dell97']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const SHARE = path.join(T, 'share'); fs.mkdirSync(path.join(SHARE, 'docs', 'img'), { recursive: true });
fs.writeFileSync(path.join(SHARE, 'docs', 'README.md'), ["# 网格加密说明","","下面是**示意图**：","","![网格示意](img/mesh.png)","","| 参数 | 值 |","|---|---|","| dx | 1e-3 |","","外链图片：![x](https://example.com/a.png)","","[看笔记](notes.txt)",""].join(String.fromCharCode(10)));
fs.copyFileSync(R + '/public/wall/illust_bike_inaba.webp', path.join(SHARE, 'docs', 'img', 'mesh.png'));
fs.writeFileSync(path.join(SHARE, 'docs', 'notes.txt'), ['中文笔记', 'line 2', ''].join(String.fromCharCode(10)));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'dell97', control: false, scanMs: 500, files: { roots: [SHARE] } }));
// a second computer with files of its own (我的电脑's computer switch)
const tok2 = node([R + '/server/setup.js', 'add-agent', 'box2']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const SHARE2 = path.join(T, 'share2'); fs.mkdirSync(SHARE2); fs.writeFileSync(path.join(SHARE2, 'on-box2.txt'), 'box2\n');
const HOME2 = path.join(T, 'home2'); fs.mkdirSync(path.join(HOME2, '.claude', 'projects'), { recursive: true });
const ACFG2 = path.join(T, 'agent2.json');
fs.writeFileSync(ACFG2, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok2, name: 'box2', control: false, scanMs: 500, files: { roots: [SHARE2] } }));
fs.writeFileSync(path.join(PROJ, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
  L({ type: 'ai-title', aiTitle: 'FDTD 网格加密' }, now - 900e3) +
  L({ type: 'user', message: { role: 'user', content: '帮我把 FDTD 的网格在界面附近加密' } }, now - 800e3) +
  L({ type: 'assistant', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好的，先看一下现在的网格生成：\n\n```python\ndx = 1e-3\n```\n我会在 **界面两侧** 各加密 5 层。' }] } }, now - 790e3) +
  L({ type: 'assistant', message: { id: 'a2', role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/home/dell/demo/mesh.py' } }, { type: 'tool_use', name: 'Edit', input: { file_path: '/home/dell/demo/mesh.py' } }] } }, now - 780e3) +
  L({ type: 'assistant', message: { id: 'a3', role: 'assistant', content: [{ type: 'text', text: '改好了，网格数从 400 增加到 460。' }] } }, now - 60e3));
fs.writeFileSync(path.join(PROJ, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'),
  L({ type: 'user', message: { role: 'user', content: '跑一下测试' } }, now - 5e3));

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
  const errors = [];
  let chrome;
  try {
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' }); await sleep(3000);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }); await sleep(2500);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME2, HOME: HOME2, AME_AGENT_CONFIG: ACFG2 }); await sleep(1500);
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
      if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push('console: ' + o.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error') errors.push('log: ' + o.params.entry.text.slice(0, 300) + ' ' + (o.params.entry.url || ''));
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable');
    await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    const dbl = (sel) => evalJs(`(() => { const el = [...document.querySelectorAll('${sel.q}')].find(x => x.textContent.includes('${sel.t}')); if (!el) return false; el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    // (two computers now: dell97 picked in 网上邻居 first)
    await evalJs("[...document.querySelectorAll('.mach')].find(b => b.textContent.includes('dell97')).click()"); await sleep(500);
    console.log('open 我的电脑', await dbl({ q: '.dicon', t: '我的电脑' })); await sleep(1500);
    console.log('open root', await dbl({ q: '.xroot', t: 'share' })); await sleep(1200);
    console.log('open docs', await dbl({ q: '.xlist tr', t: 'docs' })); await sleep(1200);
    await shot('7-explorer.png');
    console.log('open README.md', await dbl({ q: '.xlist tr', t: 'README.md' })); await sleep(3000);
    console.log('md image loaded:', await evalJs("(() => { const i = document.querySelector('.md img'); return i ? i.naturalWidth + 'x' + i.naturalHeight : 'no img'; })()"));
    console.log('external image note:', await evalJs("(document.querySelector('.mdimg-note')||{}).textContent"));
    console.log('table rendered:', await evalJs("!!document.querySelector('.md table')"));
    await shot('8-markdown.png');
    await evalJs("document.querySelector('.md a').click()"); await sleep(1500);
    console.log('linked text file:', await evalJs("(document.querySelector('.vtext')||{}).textContent"));
    await shot('9-text.png');
    // 我的电脑's computer switch: the list of computers, this one shown; another one picked: its own window, the desktop follows
    const res = [];
    const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
    const wins = () => evalJs("[...document.querySelectorAll('.win')].filter(w => w.querySelector('.explorer')).map(w => ({ title: w.querySelector('.ttl, .title, .wt') ? w.querySelector('.ttl, .title, .wt').textContent : w.textContent.slice(0, 40), pc: w.querySelector('.xpc').value, opts: [...w.querySelectorAll('.xpc option')].map(o => o.value) }))");
    let w = await wins();
    chk('我的电脑: a computer list with both, this one shown', w.length === 1 && w[0].pc === 'dell97' && w[0].opts.join() === 'box2,dell97', w);
    await evalJs("(() => { const s = document.querySelector('.explorer .xpc'); s.value = 'box2'; s.dispatchEvent(new Event('change')); })()"); await sleep(1800);
    w = await wins();
    chk('switching to box2: its own 我的电脑 opens (the dell97 one stays as it was)', w.length === 2 && w.some((x) => x.pc === 'box2') && w.some((x) => x.pc === 'dell97'), w);
    chk('box2\'s files shown', await evalJs("[...document.querySelectorAll('.explorer')].some(e => e.querySelector('.xpc').value === 'box2' && e.textContent.includes('share2'))"), 0);
    chk('the desktop follows (as picking box2 in 网上邻居)', (await evalJs('localStorage.getItem("ame.machine")')) === '"box2"', await evalJs('localStorage.getItem("ame.machine")'));
    await shot('9b-explorer-switch.png');
    console.log(res.join('\n'));
    ws.close();
  } catch (e) { errors.push('script: ' + e.stack); }
  finally {
    try { chrome && chrome.kill(); } catch {}
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(800);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
    console.log('shots in', OUT);
    process.exit(0);
  }
})();
