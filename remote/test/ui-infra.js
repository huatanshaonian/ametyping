// UI check: 设备与算力 (4-Tab Hub), Docker compose upgrade & rollback pill, and quick jump to 算力画像 / Fleet.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uiinfra-'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18851, CDP = 9351;
const guiMerged = fs.existsSync(path.join(R, 'public', 'css', 'tokens.css'));
const pendingIconRe = /\/icons\/(catalog|network_three_pcs|network_drive_world|world|key_world|search_file_2|help_book_computer|script_file_teal|tools_gear|magnifying_glass|users|clock)(-16)?\.png(\?|$)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 700)}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box1']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const kids = [];
const post = (p, body, headers = {}) => new Promise((resolve) => {
  const b = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...headers } },
    (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => resolve({ status: res.statusCode, h: res.headers, body: s })); });
  r.on('error', () => resolve({ status: 0 })); r.end(b);
});
const getJSON = (url, method = 'GET') => new Promise((resolve, reject) => { const r = http.request(url, { method }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.end(); });

(async () => {
  const errors = [];
  let chrome;
  try {
    kids.push(cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' }));
    for (let i = 0; i < 60; i++) { await sleep(500); if (await new Promise((r) => http.get(`http://127.0.0.1:${PORT}/`, (res) => { res.resume(); r(true); }).on('error', () => r(false)))) break; }
    const rep = await post('/api/infra/report', { role: 'workstation', report: { uptimeSec: 100, containers: [
      { name: 'jupyter', state: 'running', status: 'Up 2 days', ports: '8888', compose: 'jupyter', upgrade: { state: 'rolledback', msg: '新版本启动失败，已回退到旧版本', from: 'aaa', to: 'bbb', at: Date.now() } },
      { name: 'scratch', state: 'stopped', status: 'Exited (0)' },
    ] } }, { Authorization: 'Bearer ' + tok });
    ok('probe report accepted', rep.status === 200, rep);
    const login = await post('/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) }, { Origin: `http://127.0.0.1:${PORT}` });
    const [cname, cval] = String(login.h['set-cookie'] || '').split(';')[0].split('=');

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
      if (o.method === 'Runtime.exceptionThrown') errors.push('exception: ' + JSON.stringify(o.params.exceptionDetails.exception && o.params.exceptionDetails.exception.description || o.params.exceptionDetails.text).slice(0, 400));
      if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push('console: ' + o.params.args.map((a) => a.value || a.description).join(' ').slice(0, 400));
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error') {
        const u = o.params.entry.url || '';
        if (!guiMerged && pendingIconRe.test(u)) return;
        errors.push('log: ' + o.params.entry.text.slice(0, 300) + ' ' + u);
      }
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    await evalJs("document.querySelector('.dicon[data-id=infra]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))"); await sleep(1500);
    const tabsTxt = await evalJs("[...document.querySelectorAll('.infra-hub .skp-tabs .skp-tab')].map(b => b.textContent).join('|')");
    ok('设备与算力 window opens with 4 unified tabs', tabsTxt === '拓扑与服务|算力与作业 (Mini-Slurm)|Agent 与 Harness (Fleet)|设备接入与令牌', tabsTxt);

    await evalJs("(() => { const n = [...document.querySelectorAll('.inf-node')].find((x) => x.textContent.includes('box1')); n && n.click(); })()"); await sleep(800);
    const rowOf = (name) => `[...document.querySelectorAll('.inf-row')].find((r) => r.textContent.includes('🐳 ${name}'))`;
    const btns = (name) => evalJs(`(() => { const r = ${rowOf(name)}; return r ? [...r.querySelectorAll('button')].map((b) => b.textContent).join(',') : null; })()`);
    const j = await btns('jupyter'), s = await btns('scratch');
    ok('both containers listed', j !== null && s !== null, [j, s, await evalJs("document.querySelector('.inf-det, .win') ? document.body.innerText.slice(0, 800) : ''")]);
    ok('compose container has 升级', /升级/.test(j || ''), j);
    ok('docker run container has no 升级', s !== null && !/升级/.test(s), s);
    ok('the rolled-back upgrade is shown red on its row', await evalJs(`(() => { const r = ${rowOf('jupyter')}; const p = r && [...r.querySelectorAll('.inf-pill')].find((x) => x.textContent.includes('升级失败·已回退')); return !!(p && p.classList.contains('err') && /新版本启动失败/.test(p.title)); })()`));
    await shot('31-infra-upgrade.png');

    // 升级: asks first; confirmed, the dashboard sends kind docker / op upgrade
    await evalJs(`(() => { window.__sent = []; const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes('/api/infra/control')) window.__sent.push(o && o.body); return f(u, o); }; })()`);
    await evalJs(`(() => { const r = ${rowOf('jupyter')}; [...r.querySelectorAll('button')].find((b) => b.textContent === '升级').click(); })()`); await sleep(600);
    const dlg = await evalJs("(() => { const d = [...document.querySelectorAll('.dlgbox')].reverse().find((x) => /升级容器 jupyter/.test(x.textContent)); return d ? d.textContent.slice(0, 200) : null; })()");
    ok('asks before upgrading', !!dlg, dlg);
    ok('nothing sent before confirming', (await evalJs('window.__sent.length')) === 0);
    await evalJs("(() => { const d = [...document.querySelectorAll('.dlgbox')].reverse().find((x) => /升级容器 jupyter/.test(x.textContent)); const b = d && [...d.querySelectorAll('.dlga button')].find((x) => x.textContent === '确定'); b && b.click(); })()"); await sleep(1200);
    const sent = await evalJs('window.__sent');
    ok('confirmed: sends the docker upgrade', sent.length === 1 && /"kind":"docker"/.test(sent[0]) && /"op":"upgrade"/.test(sent[0]) && /"target":"jupyter"/.test(sent[0]), sent);
    // Close any step-up gate if opened
    await evalJs("(() => { const g = document.querySelector('#gate [data-act=cancel]'); g && g.click(); })()");

    // Node detail quick-jump to 算力画像 (Mini-Slurm)
    await evalJs("(() => { const b = [...document.querySelectorAll('.inf-det-head .btn')].find(x => x.textContent.includes('算力画像')); b && b.click(); })()");
    await sleep(900);
    ok('node detail quick-jump switches to 算力与作业 tab with unified machine profile',
      await evalJs("document.querySelector('.infra-hub .skp-tab.sel')?.dataset.tab === 'compute' && !!document.querySelector('.infra-hub .inf-comp')"));
    await shot('32-infra-compute.png');
    ws.close();
  } catch (e) { errors.push('script: ' + e.stack); }
  finally {
    try { chrome && chrome.kill(); } catch {}
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(800);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
    console.log(`== ${pass} passed, ${fail} failed; shots in ${OUT}`);
    process.exit(fail || errors.length ? 1 : 0);
  }
})();
