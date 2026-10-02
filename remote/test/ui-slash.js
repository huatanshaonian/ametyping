// UI check (看板 / 联想与 /btw): the machine's own commands reach the reply box's suggestions; keys choose and fill;
// a /btw answer written to the transcript pops up. Screenshots in test/out/shots.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uislash-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-demo');
fs.mkdirSync(PROJ, { recursive: true }); fs.mkdirSync(path.join(HOME, '.ametyping'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18838, PET = 18839, CDP = 9344, SID = 'eeeeeeee-1111-2222-3333-444444444444', SID2 = 'ffffffff-1111-2222-3333-444444444444';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const J = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(path.join(PROJ, SID + '.jsonl'), J({ type: 'permission-mode', permissionMode: 'plan', sessionId: SID }) +
  J({ type: 'user', uuid: 'u1', cwd: '/demo', timestamp: new Date(now - 60e3).toISOString(), message: { role: 'user', content: '先想想怎么改' } }) +
  J({ type: 'assistant', uuid: 'a1', cwd: '/demo', timestamp: new Date(now - 50e3).toISOString(), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '计划如下……' }] } }));
fs.writeFileSync(path.join(PROJ, SID2 + '.jsonl'), J({ type: 'user', uuid: 'v1', cwd: '/demo', timestamp: new Date(now - 40e3).toISOString(), message: { role: 'user', content: '另一个会话的问题' } }) +
  J({ type: 'assistant', uuid: 'v2', cwd: '/demo', timestamp: new Date(now - 30e3).toISOString(), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '另一个会话的回答' }] } }));
fs.mkdirSync(path.join(HOME, '.claude', 'commands'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'commands', 'mycmd.md'), '---\ndescription: 我的自定义命令\n---\n做点什么');
fs.mkdirSync(path.join(HOME, '.claude', 'skills', 'myskill'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'skills', 'myskill', 'SKILL.md'), '---\nname: myskill\ndescription: 我的技能\n---\n# x');
const sent = [];
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
    if (req.url === '/control/send') { sent.push(d.text); return res.end(JSON.stringify({ ok: true })); }
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

    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);
    await evalJs("(() => { const c = [...document.querySelectorAll('.dash .card')].find(x => x.textContent.includes('demo 会话')); c && c.click(); })()"); await sleep(800);
    await evalJs("document.querySelector('.dash .say').focus()");
    const type = async (t) => { await call('Input.insertText', { text: t }); await sleep(500); };
    const clearBox = () => evalJs("(() => { const s = document.querySelector('.dash .say'); s.value = ''; s.dispatchEvent(new Event('input')); })()");
    const sugg = () => evalJs("[...document.querySelectorAll('.dash .slash:not([hidden]) .sl')].map(e => e.textContent)");
    const box = () => evalJs("document.querySelector('.dash .say').value");
    await type('/');
    let s = await sugg();
    chk('"/" shows suggestions: own command first with its description, built-ins too', s.length === 8 && s[0].startsWith('/mycmd') && s[0].includes('我的自定义命令') && s.some((x) => x.startsWith('/myskill') && x.includes('技能')), s);
    await shot('a0-slash.png');
    await type('my');
    s = await sugg();
    chk('"/my": the two of this machine', s.length === 2 && s[0].startsWith('/mycmd') && s[1].startsWith('/myskill'), s);
    await key('ArrowDown', 40); await key('Tab', 9); await sleep(300);
    chk('↓ then Tab fills the second one', (await box()) === '/myskill ' && !(await sugg()).length, await box());
    await clearBox(); await type('/comp');
    chk('"/comp": compact suggested', (await sugg())[0].startsWith('/compact'), await sugg());
    await key('Enter', 13); await sleep(400);
    chk('Enter on a partly typed command fills it in, sends nothing', (await box()) === '/compact ' && sent.length === 0, [await box(), sent]);
    await clearBox(); await type('/context');
    await key('Enter', 13); await sleep(1500);
    chk('Enter on a command typed out sends it', sent.includes('/context'), sent);
    await type('/res'); await key('Escape', 27); await sleep(300);
    chk('Esc closes the suggestions (and is not sent to the terminal)', !(await sugg()).length && !keys.includes('esc') && (await box()) === '/res', [keys, await box()]);
    await clearBox(); await type('hello /my');
    chk('no suggestions after other text', !(await sugg()).length, await sugg());
    await clearBox();
    // /btw: the fork's output and, later, its answer as Claude Code writes them
    const T0 = new Date().toISOString();
    fs.appendFileSync(path.join(PROJ, SID + '.jsonl'), J({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>⑂ forked demo (beef)</local-command-stdout>', commandRun: { command: 'btw', args: '网格要加密到多少层？' }, timestamp: T0, uuid: 'b1' }) +
      J({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(Date.now() + 1000).toISOString(), content: '<task-notification>\n<task-id>ademo-0123456789abbeef</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>**两侧各加 5 层**就够了。\n\n再多收益很小。</result>\n</task-notification>' }));
    for (let i = 0; i < 30 && !(await evalJs("!document.querySelector('.dash .btwpop').hidden")); i++) await sleep(300);
    const pop = await evalJs("(() => { const p = document.querySelector('.dash .btwpop'); return { shown: !p.hidden, text: p.textContent }; })()");
    chk('/btw: the answer pops up with its question', pop.shown && pop.text.includes('网格要加密到多少层？') && pop.text.includes('两侧各加 5 层') && pop.text.includes('再多收益很小'), pop);
    chk('/btw: question and answer stay in the conversation', await evalJs("(() => { const c = document.querySelector('.dash .conv').textContent; return c.includes('/btw 网格要加密到多少层？') && !!document.querySelector('.dash .m.btw'); })()"), 0);
    await shot('a1-btw.png');
    const lay = await evalJs("(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); return { conv: r('.dash .conv').bottom, pop: r('.dash .btwpop').top, compose: r('.dash .compose').top, popB: r('.dash .btwpop').bottom }; })()");
    chk('/btw: the answer has its own room (covers neither the conversation nor the reply box)', lay.pop >= lay.conv - 1 && lay.popB <= lay.compose + 1, lay);
    const cardLine = await evalJs("[...document.querySelectorAll('.dash .card')].find(c => c.textContent.includes('demo 会话')).querySelector('.sm').textContent");
    chk('card line: no Markdown marks', !cardLine.includes('**'), cardLine);
    await evalJs("[...document.querySelectorAll('.dash .btwpop .btn')].find(b => b.textContent === '关闭').click()"); await sleep(200);
    chk('/btw: closed', await evalJs("document.querySelector('.dash .btwpop').hidden"), 0);
    await evalJs("document.querySelector('.dash .m.btw').click()"); await sleep(200);
    chk('/btw: a click on the answer opens it again', await evalJs("!document.querySelector('.dash .btwpop').hidden && document.querySelector('.dash .btwpop').textContent.includes('两侧各加 5 层')"), 0);
    // no pop-up for an old answer when the conversation is opened later
    await call('Page.reload'); await sleep(3500);
    await evalJs("(() => { const c = [...document.querySelectorAll('.dash .card')].find(x => x.textContent.includes('demo 会话')); c && c.click(); })()"); await sleep(1500);
    chk('reopened within two minutes: still pops up (it is fresh)', await evalJs("!document.querySelector('.dash .btwpop').hidden"), 0);
    await evalJs("document.documentElement.dataset.theme = 'win98'"); await sleep(200);
    await evalJs("document.querySelector('.dash .say').focus()"); await clearBox(); await type('/m');
    await shot('a2-win98.png');
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
