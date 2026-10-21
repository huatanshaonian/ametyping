// UI check (子 agent): a session with subagents (their own transcripts under <session>/subagents), server + agent,
// headless Chrome over CDP. The card's tag, the line over the conversation, the rows, a finish arriving live.
// Screenshots in test/out/shots.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uisub-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-demo');
const SID = 'ffffffff-1111-2222-3333-444444444444', SUB = path.join(PROJ, SID, 'subagents');
fs.mkdirSync(SUB, { recursive: true });
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18854, CDP = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const J = (o) => JSON.stringify(o) + '\n';
const user = (t, content) => J({ type: 'user', timestamp: iso(t), message: { role: 'user', content } });
const asst = (t, content, stop = null) => J({ type: 'assistant', timestamp: iso(t), message: { role: 'assistant', content, stop_reason: stop } });
const tool = (name, input) => ({ type: 'tool_use', id: 'tu' + Math.random(), name, input });
const result = { type: 'tool_result', tool_use_id: 'x', content: 'ok' };
function agent(id, meta, text) {
  fs.writeFileSync(path.join(SUB, `agent-${id}.jsonl`), text);
  fs.writeFileSync(path.join(SUB, `agent-${id}.meta.json`), JSON.stringify(meta));
  return path.join(SUB, `agent-${id}.jsonl`);
}
fs.writeFileSync(path.join(PROJ, SID + '.jsonl'),
  J({ type: 'user', uuid: 'u1', cwd: '/demo', timestamp: iso(now - 300e3), message: { role: 'user', content: '三块板子分别仿真一下' } }) +
  J({ type: 'assistant', uuid: 'a1', cwd: '/demo', timestamp: iso(now - 290e3), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '开三个 agent 并行仿真。' }] } }));
const RUN1 = agent('r1', { agentType: 'general-purpose', description: 'Simulate HV-UNI boost board' },
  user(now - 280e3, 'q') + asst(now - 20e3, [tool('Bash', { command: 'ngspice -b boost.cir', description: '跑升压板瞬态仿真' })]));
agent('r2', { agentType: 'general-purpose', description: 'Simulate 6E2 grid driver' }, user(now - 200e3, 'q') + asst(now - 30e3, [tool('Read', { file_path: '/sim/grid.cir' })]) + user(now - 25e3, [result]));
agent('d1', { agentType: 'Explore', description: 'Research Geiger board design', requestShape: 'background' },
  user(now - 3600e3, 'q') + asst(now - 3000e3, [tool('SubagentHandback', { message: 'r' })]) + user(now - 3000e3, [result]));
agent('s1', { agentType: 'fork', isFork: true, name: 'wiring', description: '每块板能不能单独上电测试' },
  user(now - 7000e3, 'q') + asst(now - 6900e3, [tool('WebSearch', { query: 'x' })]) + user(now - 6800e3, [{ type: 'text', text: '[Request interrupted by user for tool use]' }]));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, scanMs: 400 }));

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
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);
    const tag = () => evalJs("(() => { const c = [...document.querySelectorAll('.dash .card')].find(x => x.textContent.includes('三块板子') || x.textContent.includes('demo')); const t = c && c.querySelector('.agb'); return t ? [t.textContent, t.title] : null; })()");
    const t1 = await tag();
    chk('the card says how many subagents are running, the title lists them', t1 && t1[0] === 'agent 2' && /Simulate HV-UNI/.test(t1[1]) && /6E2/.test(t1[1]) && !/Geiger/.test(t1[1]), t1);
    await evalJs("(() => { const c = [...document.querySelectorAll('.dash .card')].find(x => x.querySelector('.agb')); c && c.click(); })()"); await sleep(800);
    const sum = () => evalJs("(() => { const a = document.querySelector('.dash .agents'); return a && !a.hidden ? a.querySelector('.ag-sum').textContent : null; })()");
    chk('the line over the conversation: counts by state, folded', (await sum()) === '▸ 子 agent · 2 个运行中 · 1 个已完成 · 1 个已中断', await sum());
    await evalJs("document.querySelector('.dash .agents .ag-sum').click()"); await sleep(300);
    const rows = () => evalJs("[...document.querySelectorAll('.dash .agents .ag')].map(r => [r.className, r.querySelector('.ag-l1 b').textContent, r.querySelector('.ag-l2').textContent])");
    const r1 = await rows();
    chk('opened: one row per agent, running first, with what it is doing', r1.length === 4 && r1[0][0] === 'ag run' && r1[1][0] === 'ag run' &&
      r1.some((r) => r[1] === 'Simulate HV-UNI boost board' && /Bash：跑升压板瞬态仿真/.test(r[2]) && /已运行 4分/.test(r[2])) &&
      r1.some((r) => r[1] === 'Simulate 6E2 grid driver' && /思考中/.test(r[2])), r1);
    chk('finished and interrupted rows: how long they took, when; the fork by its name', r1.some((r) => r[0] === 'ag done' && /已完成 · 用时 10分 · 50分前/.test(r[2])) &&
      r1.some((r) => r[0] === 'ag stop' && /fork · wiring · 被打断 · 已中断/.test(r[2])), r1);
    chk('background agent marked', await evalJs("[...document.querySelectorAll('.dash .agents .ag')].some(r => r.querySelector('.ag-bg'))"), 0);
    await shot('60-subagents.png');
    // one of them hands back: the line and the card follow without a reload
    fs.appendFileSync(RUN1, user(Date.now(), [result]) + asst(Date.now(), [tool('SubagentHandback', { message: 'ok' })]) + user(Date.now(), [result]));
    let s2 = ''; for (let i = 0; i < 40 && !/1 个运行中/.test(s2); i++) { await sleep(250); s2 = await sum() || ''; }
    chk('a finish arrives live: the line and the card change', s2 === '▾ 子 agent · 1 个运行中 · 2 个已完成 · 1 个已中断' && ((await tag()) || [])[0] === 'agent 1', [s2, await tag()]);
    await evalJs("document.querySelector('.dash .agents .ag-sum').click()"); await sleep(300);
    chk('folds again (remembered in this browser)', await evalJs("document.querySelector('.dash .agents .ag-rows').hidden && localStorage.getItem('ame.dash.agentsOpen') === 'false'"), 0);
    // narrow layout (a phone)
    await evalJs("document.querySelector('.dash .agents .ag-sum').click()");
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true }); await sleep(800);
    chk('phone width: no row wider than the pane', await evalJs("[...document.querySelectorAll('.dash .agents .ag')].every(r => r.scrollWidth <= r.clientWidth + 1)"), 0);
    await shot('61-subagents-phone.png');
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
