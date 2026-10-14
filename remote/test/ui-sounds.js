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
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'dell97', control: false, scanMs: 500 }));
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
    const [cname, cval] = await login();
    chrome = cp.spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${path.join(T, 'chrome')}`, '--no-first-run', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
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

    await call('Page.addScriptToEvaluateOnNewDocument', { source: "window.__played=[];const __p=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){window.__played.push(this.src.split('/').pop());return __p.call(this)};" });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(2500);
    const played = async () => JSON.parse(await evalJs('JSON.stringify(window.__played)'));
    const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
    chk('plain load: no start-up sound', !(await played()).includes('startup.wav'), await played());
    await evalJs("sessionStorage.setItem('ame.fresh','1')");
    await call('Page.reload'); await sleep(2500);
    chk('after login: start-up sound once', (await played()).filter((x) => x === 'startup.wav').length === 1, await played());
    await call('Page.reload'); await sleep(2500);
    chk('refresh: no second start-up', !(await played()).includes('startup.wav'), await played());
    // a second Windose page in the same browser (the login cookie is the browser's): what the server tells both sounds
    // in one of them only; muting in one shows in the other
    const tab2 = await getJSON(`http://127.0.0.1:${CDP}/json/new?about:blank`, 'PUT');
    const ws2 = new WebSocket(tab2.webSocketDebuggerUrl);
    await new Promise((r) => ws2.on('open', r));
    let id2 = 0; const pending2 = new Map();
    ws2.on('message', (m) => { const o = JSON.parse(m); if (o.id && pending2.has(o.id)) { pending2.get(o.id)(o); pending2.delete(o.id); } });
    const call2 = (method, params = {}) => new Promise((r) => { const i = ++id2; pending2.set(i, r); ws2.send(JSON.stringify({ id: i, method, params })); });
    const evalJs2 = async (expr) => (await call2('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    await call2('Page.enable');
    await call2('Page.addScriptToEvaluateOnNewDocument', { source: "window.__played=[];const __p=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){window.__played.push(this.src.split('/').pop());return __p.call(this)};" });
    await call2('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(3000);
    const played2 = async () => JSON.parse(await evalJs2('JSON.stringify(window.__played)'));
    // a working session finishes -> chimes (the demo session "bbbb" is working: its last line is the user's)
    fs.appendFileSync(path.join(PROJ, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'), L({ type: 'assistant', message: { id: 'z1', role: 'assistant', content: [{ type: 'text', text: '测试都过了' }] } }, Date.now()));
    await sleep(3000);
    const chimes = [(await played()).filter((x) => x === 'chimes.wav').length, (await played2()).filter((x) => x === 'chimes.wav').length];
    chk('session finished: chimes -- once, in one of the two pages open', chimes[0] + chimes[1] === 1, chimes);
    // (the same sound from the same page again is news of its own: it still sounds; once the other page's has passed)
    await sleep(3500);
    const again = await evalJs("import('/js/sound.js').then(async (s) => { const n = () => window.__played.filter((x) => x === 'chimes.wav').length, a = n(); await s.play('done'); await s.play('done'); return n() - a; })");
    chk('... but this page twice in a row: twice (only the same sound from another page just now is left out)', again === 2, again);
    const before2 = (await played2()).filter((x) => x === 'chimes.wav').length;
    await evalJs2("import('/js/sound.js').then((s) => s.play('done'))"); await sleep(300);
    chk('... and the other page, right after: left out', (await played2()).filter((x) => x === 'chimes.wav').length === before2, await played2());
    await sleep(3200);
    await evalJs2("import('/js/sound.js').then((s) => s.play('done'))"); await sleep(300);
    chk('... a few seconds later the other page sounds again', (await played2()).filter((x) => x === 'chimes.wav').length === before2 + 1, await played2());
    const icon2 = () => evalJs2("document.querySelector('#soundbtn img').src");
    // tray speaker mutes; the settings window can still try a sound
    await evalJs("document.getElementById('soundbtn').click()"); await evalJs("document.querySelector('#volpop .vmute input').click()");
    chk('tray click mutes (icon)', (await evalJs("document.querySelector('#soundbtn img').src")).includes('loudspeaker_muted'), await evalJs("document.querySelector('#soundbtn img').src"));
    await sleep(300);
    chk('... the other page shows it muted too', (await icon2()).includes('loudspeaker_muted') && (await evalJs2("document.querySelector('#volpop .vmute input').checked")), await icon2());
    await evalJs("document.getElementById('startbtn').click()"); await sleep(200);
    await evalJs("[...document.querySelectorAll('.smi')].find(b=>b.textContent.includes('控制面板')).click()"); await sleep(400);
    await evalJs("document.querySelector('.cp-item[data-id=sounds]').click()"); await sleep(600);
    await shot('10-sounds.png');
    await evalJs("[...document.querySelectorAll('.sounds label')].find(l=>l.textContent.includes('操作失败')).querySelector('button').click()"); await sleep(300);
    chk('try-out plays even when muted', (await played()).includes('chord.wav'), await played());
    await evalJs("document.querySelector('#volpop .vmute input').click()");
    chk('tray click unmutes', (await evalJs("document.querySelector('#soundbtn img').src")).includes('loudspeaker_rays'), 0);
    await sleep(300);
    chk('... in the other page too', (await icon2()).includes('loudspeaker_rays'), await icon2());
    ws2.close();
    // logout: shut-down sound, then the login page
    await evalJs("document.getElementById('startbtn').click()"); await sleep(200);
    await evalJs("[...document.querySelectorAll('.smi')].find(b=>b.textContent.includes('注销')).click()"); await sleep(600);
    chk('logout plays shut-down', (await played()).includes('shutdown.wav'), await played());
    await sleep(5000);
    chk('then the login page', (await evalJs('location.pathname')) === '/login', await evalJs('location.pathname'));
    console.log(res.join(String.fromCharCode(10)));
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
