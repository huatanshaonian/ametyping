// UI check (Word / Excel / PowerPoint on the desktop): their icons; the start box; 新建 -- the save dialog over a computer's
// folders, a blank document put there and the editor opened on it, a name already there refused, a read-only place
// refused; 打开 -- only that kind of file listed, the one picked opened; 最近的文档 per kind; the blank documents served.
// Server + agent (files and uploads on) + a stand-in for the OnlyOffice container whose editor script only notes what it
// was given + headless Chrome. Screenshots in test/out/shots.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process'), crypto = require('crypto');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uioffice-')));
const HOME = path.join(T, 'home'), SHARE = path.join(T, 'share'), RO = path.join(T, 'ro');
for (const d of [HOME, path.join(SHARE, 'docs'), RO]) fs.mkdirSync(d, { recursive: true });
const TPL = path.join(R, 'public', 'tpl');
fs.copyFileSync(path.join(TPL, 'blank.docx'), path.join(SHARE, 'docs', '旧报告.docx'));
fs.copyFileSync(path.join(TPL, 'blank.xlsx'), path.join(SHARE, 'docs', '预算.xlsx'));
fs.writeFileSync(path.join(SHARE, 'docs', 'notes.txt'), 'x');
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18864, CDP = 9369, SECRET = crypto.randomBytes(24).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000' };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
// the stand-in container: healthy, and an editor script that shows the title it was given
const STUB = "window.DocsAPI={DocEditor:function(id,c){(window.__oo=window.__oo||[]).push(c.document.title);document.getElementById(id).textContent='STUB '+c.document.title;this.destroyEditor=function(){};setTimeout(function(){c.events.onAppReady()},10);}};";
const fake = http.createServer((q, s) => {
  if (q.url === '/healthcheck') return s.end('true');
  if (q.url.startsWith('/web-apps/apps/api/documents/api.js')) { s.writeHead(200, { 'Content-Type': 'text/javascript' }); return s.end(STUB); }
  s.writeHead(404); s.end();
});

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
const get = (p, cookie) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path: p, headers: cookie ? { Cookie: cookie } : {} }, (res) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(b) })); }).on('error', () => resolve({ status: 0 })));
const portUp = () => new Promise((r) => http.get(`http://127.0.0.1:${PORT}/login`, (res) => { res.resume(); r(true); }).on('error', () => r(false)));

(async () => {
  const errors = [], res = [];
  const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
  let chrome;
  try {
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(T, 'jwt.env'), `JWT_ENABLED=true\nJWT_SECRET=${SECRET}\nJWT_HEADER=AuthorizationJwt\n`);
    node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
    const cfg = JSON.parse(fs.readFileSync(CFG));
    Object.assign(cfg, { summary: { enabled: false }, office: { url: `http://127.0.0.1:${fake.address().port}`, jwtEnv: path.join(T, 'jwt.env'), hook: { host: '127.0.0.1', port: 0 }, hookUrl: 'http://127.0.0.1:1' } });
    cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
    const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
    const ACFG = path.join(T, 'agent.json');
    fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, scanMs: 400,
      files: { roots: [SHARE, { path: RO, readOnly: true }], upload: true } }));
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' });
    for (let i = 0; i < 75 && !(await portUp()); i++) await sleep(200);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }); await sleep(3000);
    const [cname, cval] = await login();

    const t1 = await get('/tpl/blank.docx', `${cname}=${cval}`), t2 = await get('/tpl/other.docx', `${cname}=${cval}`), t3 = await get('/tpl/blank.docx');
    chk('the blank documents are served (to a logged-in browser), nothing else there', t1.status === 200 && /wordprocessingml/.test(t1.type) && t1.body.slice(0, 2).toString() === 'PK' && t2.status === 404 && t3.status !== 200, [t1.status, t1.type, t2.status, t3.status]);

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
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);
    await evalJs("document.querySelectorAll('.win .tbtn.close').forEach(b => b.click())");

    const icons = await evalJs("['word','excel','powerpoint'].map(k => { const b = document.querySelector(`.dicon[data-id=\"${k}\"]`); return b && [b.textContent, b.querySelector('img').getAttribute('src'), b.querySelector('img').naturalWidth]; })");
    chk('Word / Excel / PowerPoint on the desktop, with their own icons', JSON.stringify(icons) === JSON.stringify([['Word', '/icons/word.png', 32], ['Excel', '/icons/excel.png', 32], ['PowerPoint', '/icons/powerpoint.png', 32]]), icons);
    const dbl = (k) => evalJs(`document.querySelector('.dicon[data-id="${k}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const app = (k) => `[...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent === ${JSON.stringify(k)})`;
    await dbl('word');
    const box = await until(`(() => { const w = ${app('Word')}; return w && w.querySelector('.office-app') ? [...w.querySelectorAll('.oa-big b')].map(b => b.textContent).concat(w.querySelector('.oa-none') ? w.querySelector('.oa-none').textContent : '') : null; })()`);
    chk('Word opens its start box: 新建 / 打开, no recent documents yet', box && box[0] === '新建空白文档' && box[1] === '打开文档…' && /还没有编辑过文档/.test(box[2]), box);
    await shot('80-office-start.png');

    // 新建: the save dialog -- the computer's places, one read-only
    const dlg = "document.querySelector('.filedlg')";
    const rows = () => evalJs(`[...${dlg}.querySelectorAll('.fd-row')].map(r => r.querySelector('.fd-n').textContent)`);
    const dblRow = (name) => evalJs(`(() => { const r = [...${dlg}.querySelectorAll('.fd-row')].find(r => r.querySelector('.fd-n').textContent === ${JSON.stringify(name)}); r && r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return !!r; })()`);
    const clickRow = (name) => evalJs(`(() => { const r = [...${dlg}.querySelectorAll('.fd-row')].find(r => r.querySelector('.fd-n').textContent === ${JSON.stringify(name)}); r && r.click(); return !!r; })()`);
    const msg = () => evalJs(`${dlg}.querySelector('.fd-msg').textContent`);
    await evalJs(`${app('Word')}.querySelectorAll('.oa-big')[0].click()`);
    const places = await until(`(() => { const d = ${dlg}; const r = d && [...d.querySelectorAll('.fd-row')]; return r && r.length === 2 ? [d.closest('.win').querySelector('.title').textContent, d.querySelector('.fd-name').value, d.querySelector('.fd-pc').value, ...r.map(x => x.textContent)] : null; })()`);
    chk('新建: a save dialog over the computer\'s places, the name offered; the read-only one marked', places && places[0] === '新建文档 — 存到哪里' && places[1] === '新建文档.docx' && places[2] === 'box' && places.some((x) => x.includes(RO) && x.includes('只读')), places);
    await dblRow(RO);
    await until(`${dlg}.querySelector('.fd-where').value === ${JSON.stringify(RO)}`);
    await evalJs(`${dlg}.querySelector('.btn.go').click()`);
    chk('a read-only place: refused', /只读/.test(await until(`/只读/.test(${dlg}.querySelector('.fd-msg').textContent) && ${dlg}.querySelector('.fd-msg').textContent`)), await msg());
    await evalJs(`${dlg}.querySelector('.fd-bar .btn').click()`);                      // ↑ back to the places
    await until(`${dlg}.querySelectorAll('.fd-row').length === 2 && ${dlg}.querySelector('.fd-where').value === ''`);
    await dblRow(SHARE);
    await until(`${dlg}.querySelector('.fd-where').value === ${JSON.stringify(SHARE)}`);
    await dblRow('docs');
    const inDocs = await until(`${dlg}.querySelector('.fd-where').value === ${JSON.stringify(path.join(SHARE, 'docs'))} && [...${dlg}.querySelectorAll('.fd-row')].map(r => r.querySelector('.fd-n').textContent)`);
    chk('the save dialog lists only that kind of file (and folders)', JSON.stringify(inDocs) === JSON.stringify(['旧报告.docx']), inDocs);
    await shot('81-office-save.png');
    // a name already there: refused
    await evalJs(`(() => { const n = ${dlg}.querySelector('.fd-name'); n.value = '旧报告'; ${dlg}.querySelector('.btn.go').click(); })()`);
    chk('a name already there: refused', await until(`/已经有「旧报告\\.docx」/.test(${dlg}.querySelector('.fd-msg').textContent)`), await msg());
    await evalJs(`(() => { const n = ${dlg}.querySelector('.fd-name'); n.value = '周报'; ${dlg}.querySelector('.btn.go').click(); })()`);
    const made = path.join(SHARE, 'docs', '周报.docx');
    const edited = await until(`(() => { const w = [...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent === '编辑 周报.docx — box'); return w && /STUB 周报\\.docx/.test(w.textContent) && w.querySelector('.titlebar img').getAttribute('src'); })()`, 12000);
    chk('saved: the blank document is on the computer, the editor opened on it', fs.existsSync(made) && fs.readFileSync(made).equals(fs.readFileSync(path.join(TPL, 'blank.docx'))) && edited === '/icons/word-16.png', [fs.existsSync(made), edited]);
    await shot('82-office-editor.png');

    // 打开: only Word documents, the one picked opened
    await evalJs(`${app('Word')}.querySelectorAll('.oa-big')[1].click()`);
    const opened = await until(`(() => { const d = ${dlg}; return d && d.querySelector('.fd-where').value === ${JSON.stringify(path.join(SHARE, 'docs'))} && [...d.querySelectorAll('.fd-row')].map(r => r.querySelector('.fd-n').textContent); })()`);
    chk('打开: starts where the last dialog was; only .docx listed', JSON.stringify(opened) === JSON.stringify(['旧报告.docx', '周报.docx']), opened);
    await clickRow('旧报告.docx');
    await evalJs(`${dlg}.querySelector('.btn.go').click()`);
    chk('the one picked opens in the editor', await until("[...document.querySelectorAll('.win')].some(w => w.querySelector('.title').textContent === '编辑 旧报告.docx — box' && /STUB 旧报告/.test(w.textContent))", 12000), 0);
    const rec = await until(`(() => { const w = ${app('Word')}; const r = [...w.querySelectorAll('.oa-row .oa-n b')].map(b => b.textContent); return r.length === 2 && r; })()`);
    chk('最近的文档: newest first', JSON.stringify(rec) === JSON.stringify(['旧报告.docx', '周报.docx']), rec);
    await shot('83-office-recent.png');

    // Excel: its own recent list (none), only .xlsx to open
    await dbl('excel');
    const ex = await until(`(() => { const w = ${app('Excel')}; return w && w.querySelector('.oa-none') && w.querySelector('.oa-none').textContent; })()`);
    chk('Excel: Word documents are not in its recent list', /还没有编辑过工作簿/.test(ex || ''), ex);
    await evalJs(`${app('Excel')}.querySelectorAll('.oa-big')[1].click()`);
    const xl = await until(`(() => { const d = ${dlg}; return d && d.closest('.win').querySelector('.title').textContent === '打开工作簿' && d.querySelector('.fd-where').value && [...d.querySelectorAll('.fd-row')].map(r => r.querySelector('.fd-n').textContent); })()`);
    chk('Excel\'s 打开 lists only spreadsheets', JSON.stringify(xl) === JSON.stringify(['预算.xlsx']), xl);
    await evalJs(`${dlg}.querySelectorAll('.fd-foot .btn')[1].click()`);              // 取消
    chk('取消 closes the dialog', await until(`!${dlg}`), 0);
    // 我的电脑: the documents with their icons
    const xicons = await evalJs("(async () => { const { iconOf } = await import('/js/filetypes.js'); return ['a.docx', 'b.xlsx', 'c.pptx', 'd.txt'].map(n => iconOf({ name: n })); })()");
    chk('我的电脑 shows the documents with these icons', JSON.stringify(xicons) === JSON.stringify(['word-doc', 'excel-doc', 'powerpoint-doc', 'notepad_file']), xicons);
    // reloaded: the recent list kept
    await call('Page.reload'); await sleep(3500);
    await evalJs("document.querySelectorAll('.win .tbtn.close').forEach(b => b.click())");
    await dbl('word');
    chk('after a reload the recent documents are still there', await until(`(() => { const w = ${app('Word')}; return w && w.querySelectorAll('.oa-row').length === 2; })()`), 0);
  } catch (e) { errors.push('script: ' + e.stack); }
  finally {
    console.log(res.join('\n'));
    try { chrome && chrome.kill(); } catch {}
    for (const k of kids) try { k.kill(); } catch {}
    fake.close();
    await sleep(800);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
    process.exit(0);
  }
})();
