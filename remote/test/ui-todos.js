// UI check (重要计划 as an app): headless Chrome over CDP against the real server, starting from plans an older version
// wrote. The desktop icon opens it; a new list; a plan in it; steps 1 2 3 4 added, ticked, moved; ☆ and the 重要 view;
// the desktop panel showing 2/4 and opening the plan; renaming a list; a phone's width. Screenshots in test/out/shots.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uitodo-'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.join(T, 'srv', 'data'), { recursive: true });
const PORT = 18862, CDP = 9367;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
fs.writeFileSync(path.join(T, 'srv', 'data', 'todos.json'), JSON.stringify([
  { id: 'a1', text: '写完第三章', project: '论文', due: today, created: 1, from: null, done: false },
  { id: 'a2', text: '整理实验数据', project: '', due: '', created: 2, from: null, done: false },
]));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));

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
  let chrome, srv;
  try {
    srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
    for (let i = 0; i < 75 && !(await portUp()); i++) await sleep(200);
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
    const until = async (expr, ms = 4000) => { let v; for (let t = 0; t < ms; t += 100) { v = await evalJs(expr); if (v) return v; await sleep(100); } return v; };
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);
    // (the dashboard opens by itself: out of the way)
    await evalJs("document.querySelectorAll('.win .tbtn.close').forEach(b => b.click())"); await sleep(300);

    chk('the desktop panel shows the old plans', await until("(() => { const w = document.querySelector('#todowidget'); return w && w.textContent.includes('写完第三章') && w.textContent.includes('整理实验数据') && w.querySelector('.td-n').textContent === '（2）'; })()"), 0);
    chk('a desktop icon 重要计划', await evalJs("!!document.querySelector('.dicon[data-id=todo]')"), 0);
    await evalJs("document.querySelector('.dicon[data-id=todo]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    const title = () => evalJs("(() => { const t = document.querySelector('.tda .tda-title'); return t && t.textContent; })()");
    chk('it opens the app on the first list, the old plans in it', await until("(() => { const t = document.querySelector('.tda .tda-title'); return t && t.textContent === '重要计划 2 个未完成'; })()") &&
      await evalJs("[...document.querySelectorAll('.tda-plans .tda-pt')].map(e => e.textContent).join() === '写完第三章,整理实验数据'"), await title());
    chk('the left column: 重要, 计划内, then the lists', await evalJs("[...document.querySelectorAll('.tda-l .tda-ln')].map(e => e.textContent).join()") === '重要,计划内,重要计划',
      await evalJs("[...document.querySelectorAll('.tda-l .tda-ln')].map(e => e.textContent).join()"));
    chk('计划内 counts the plan with a due date', await evalJs("document.querySelector('.tda-l[data-id=\":due\"] .tda-lc').textContent") === '1', 0);

    // a new list
    await evalJs("document.querySelector('.tda-new').click()"); await sleep(300);
    await evalJs("(() => { const i = document.querySelector('.dlg input'); i.value = '实验'; i.form.requestSubmit(); })()");
    chk('新建分类 asks a name, then shows the new (empty) list', await until("(() => { const t = document.querySelector('.tda .tda-title'); return t && t.textContent === '实验'; })()") &&
      await evalJs("document.querySelector('.tda-l.on .tda-ln').textContent === '实验' && document.querySelector('.tda-plans .td-empty') !== null"), await title());

    // a plan in it, opened at once
    await evalJs("(() => { const i = document.querySelector('.tda-in'); i.value = '扫频仿真'; i.form.requestSubmit(); })()");
    chk('a plan added to the list, opened for its steps', await until("(() => { const p = document.querySelector('.tda-p.open'); return p && p.querySelector('.tda-pt').textContent === '扫频仿真' && !!p.querySelector('.tda-sin'); })()"), 0);

    // steps 1 2 3 4
    for (const s of ['建模', '划网格', '跑仿真', '画图']) {
      const n = await evalJs("document.querySelectorAll('.tda-p.open .tda-s').length");
      await evalJs(`(() => { const i = document.querySelector('.tda-p.open .tda-sin'); i.value = ${JSON.stringify(s)}; i.form.requestSubmit(); })()`);
      await until(`document.querySelectorAll('.tda-p.open .tda-s').length === ${n + 1}`);
    }
    const steps = () => evalJs("[...document.querySelectorAll('.tda-p.open .tda-s')].map(s => s.querySelector('.tda-sn').textContent + s.querySelector('.tda-st').textContent).join(' ')");
    chk('steps numbered 1. 2. 3. 4.', (await steps()) === '1.建模 2.划网格 3.跑仿真 4.画图', await steps());
    chk('the box to add the next keeps the focus, and says 第 5 条', await evalJs("document.activeElement && document.activeElement.classList.contains('tda-sin') && document.activeElement.placeholder === '添加第 5 条…'"),
      await evalJs("document.activeElement && document.activeElement.className"));
    await evalJs("document.querySelectorAll('.tda-p.open .tda-s input[type=checkbox]')[0].click()");
    await until("document.querySelectorAll('.tda-p.open .tda-s.done').length === 1");
    await evalJs("document.querySelectorAll('.tda-p.open .tda-s input[type=checkbox]')[1].click()");
    chk('two ticked: the plan says ☰ 2/4', await until("(() => { const b = document.querySelector('.tda-p.open .tda-prog'); return b && b.textContent === '☰ 2/4'; })()"),
      await evalJs("(() => { const b = document.querySelector('.tda-p.open .tda-prog'); return b && b.textContent; })()"));
    // 画图 up one
    await evalJs("[...document.querySelectorAll('.tda-p.open .tda-s')][3].querySelector('button[title=上移]').click()");
    chk('↑ moves a step up; numbers follow', await until("[...document.querySelectorAll('.tda-p.open .tda-s')].map(s => s.querySelector('.tda-sn').textContent + s.querySelector('.tda-st').textContent).join(' ') === '1.建模 2.划网格 3.画图 4.跑仿真'"), await steps());
    // edit a step by clicking it
    await evalJs("document.querySelectorAll('.tda-p.open .tda-st')[0].click()"); await sleep(150);
    await evalJs("(() => { const e = document.querySelector('.tda-p.open .tda-ed'); e.value = '建模（CST）'; e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
    chk('click a step to edit it', await until("document.querySelectorAll('.tda-p.open .tda-st')[0]?.textContent === '建模（CST）'"), await steps());
    // typing a step while another device changes something: the half-typed text and the focus stay
    await evalJs("(() => { const i = document.querySelector('.tda-p.open .tda-sin'); i.focus(); i.value = '打到一半'; })()");
    await evalJs("fetch('/api/todos/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'a2', text: '整理实验数据（别处改的）' }) })");
    await until("document.querySelector('#todowidget').textContent.includes('别处改的')");
    await sleep(400);
    chk('a change from elsewhere redraws, the half-typed step stays', await evalJs("(() => { const i = document.querySelector('.tda-p.open .tda-sin'); return i && i.value === '打到一半' && document.activeElement === i; })()"),
      await evalJs("(() => { const i = document.querySelector('.tda-p.open .tda-sin'); return [i && i.value, document.activeElement && document.activeElement.className]; })()"));
    await evalJs("document.querySelector('.tda-p.open .tda-sin').value = ''");
    await shot('70-todo-app.png');

    // the desktop panel
    chk('the panel shows the new plan with 2/4 and its list', await until("(() => { const li = [...document.querySelectorAll('#todowidget .td-i')].find(l => l.textContent.includes('扫频仿真')); return li && li.querySelector('.td-prog')?.textContent === '☰ 2/4' && li.textContent.includes('实验'); })()"),
      await evalJs("document.querySelector('#todowidget').textContent"));

    // ☆ and the 重要 view
    await evalJs("document.querySelector('.tda-p.open .tda-star').click()");
    await until("document.querySelector('.tda-l[data-id=\":star\"] .tda-lc').textContent === '1'");
    await evalJs("document.querySelector('.tda-l[data-id=\":star\"]').click()");
    chk('☆ puts it in 重要, shown with its list', await until("(() => { const t = document.querySelector('.tda .tda-title'); const p = document.querySelector('.tda-plans .tda-p'); return t && t.textContent.startsWith('重要') && p && p.textContent.includes('扫频仿真') && p.querySelector('.tda-pm').textContent.includes('实验'); })()"), await title());
    // back to the first list, plan closed; the panel's 2/4 opens it in its list
    await evalJs("document.querySelector('.tda-l[data-id=main]').click()"); await sleep(200);
    await evalJs("[...document.querySelectorAll('#todowidget .td-prog')][0].click()");
    chk('the panel\'s 2/4 opens the plan, in its list', await until("(() => { const t = document.querySelector('.tda .tda-title'); const p = document.querySelector('.tda-p.open'); return t && t.textContent.startsWith('实验') && p && p.textContent.includes('扫频仿真'); })()"), await title());

    // rename a list (double-click)
    await evalJs("document.querySelector('.tda-l.on').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"); await sleep(300);
    await evalJs("(() => { const i = document.querySelector('.dlg input'); i.value = '实验室'; i.form.requestSubmit(); })()");
    chk('double-click renames a list', await until("document.querySelector('.tda-l.on .tda-ln')?.textContent === '实验室'"), 0);
    // what is kept on the server
    const saved = await evalJs("fetch('/api/todos').then(r => r.json())");
    const p = saved.items.find((t) => t.text === '扫频仿真');
    chk('kept on the server: list, ☆, steps in order with ticks', p && p.star && p.list === saved.lists[1].id && saved.lists[1].name === '实验室' &&
      p.steps.map((s) => s.text + (s.done ? '✓' : '')).join() === '建模（CST）✓,划网格✓,画图,跑仿真', p);
    chk('the old plans still have no list (first list)', saved.items.filter((t) => t.id.startsWith('a')).every((t) => !t.list), saved.items);

    // a phone
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true }); await sleep(800);
    chk('phone width: nothing wider than the window', await evalJs("(() => { const a = document.querySelector('.tda'); return a.scrollWidth <= a.clientWidth + 1 && [...a.querySelectorAll('.tda-p')].every(p => p.scrollWidth <= p.clientWidth + 1); })()"), 0);
    await shot('71-todo-app-phone.png');
  } catch (e) { errors.push('script: ' + e.stack); }
  finally {
    console.log(res.join('\n'));
    try { chrome && chrome.kill(); } catch {}
    try { srv && srv.kill(); } catch {}
    const bad = res.filter((r) => r.startsWith('FAIL')).length + errors.length;
    if (errors.length) console.log('ERRORS\n' + errors.join('\n'));
    console.log(`\n${res.length - res.filter((r) => r.startsWith('FAIL')).length} passed, ${bad} failed`);
    await sleep(500); try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    process.exit(bad ? 1 : 0);
  }
})();
