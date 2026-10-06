// UI check (终端画面 as a card + 命令输出): server + agent + a fake pet whose terminal shows Claude Code's real menus
// (test/fixtures/screens/*.txt, captured from Claude Code 2.1.289) or a menu that answers keys; headless Chrome over CDP.
// Each menu is read, drawn as a card and photographed (test/out/shots/60-term-*.png); a click on a row walks the
// terminal's cursor there, the slider and the keys a menu names are buttons, text goes into a menu without Enter.
// Also: what a slash command printed (/context, /model) is part of the conversation, a long one folded.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const FIX = path.join(__dirname, 'fixtures', 'screens');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uiterm-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-demo');
fs.mkdirSync(PROJ, { recursive: true }); fs.mkdirSync(path.join(HOME, '.ametyping'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18844, PET = 18845, CDP = 9346, SID = 'eeeeeeee-1111-2222-3333-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const J = (o) => JSON.stringify(o) + '\n';
const at = (ms) => new Date(now - ms).toISOString();
const E = String.fromCharCode(27);
// /context the way Claude Code records it (a "system" record, the terminal's colours in it) and /model (a "user" one)
const CONTEXT = ` ${E}[1mContext Usage${E}[22m\n${E}[38;2;136;136;136m⛁ ⛁ ⛁ ${E}[39m  Opus 5.5\n` + Array.from({ length: 30 }, (_, i) => `${E}[38;2;153;153;153m├${E}[39m tool_${i}`).join('\n');
fs.writeFileSync(path.join(PROJ, SID + '.jsonl'), J({ type: 'permission-mode', permissionMode: 'auto', sessionId: SID }) +
  J({ type: 'user', uuid: 'u1', cwd: '/demo', timestamp: at(90e3), message: { role: 'user', content: '先想想怎么改' } }) +
  J({ type: 'assistant', uuid: 'a1', cwd: '/demo', timestamp: at(80e3), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '计划如下……' }] } }) +
  J({ type: 'system', subtype: 'local_command', uuid: 's1', isMeta: false, timestamp: at(70e3), content: '<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>' }) +
  J({ type: 'system', subtype: 'local_command', uuid: 's2', isMeta: false, timestamp: at(69e3), content: `<local-command-stdout>${CONTEXT}</local-command-stdout>` }) +
  J({ type: 'user', uuid: 's3', isMeta: true, timestamp: at(69e3), message: { role: 'user', content: '## Context Usage\n\n(for the model only)' } }) +
  J({ type: 'user', uuid: 'u4', timestamp: at(60e3), message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>' } }) +
  J({ type: 'user', uuid: 'u5', timestamp: at(59e3), message: { role: 'user', content: '<local-command-stdout>Set model to `Opus 5.5` and saved as your default for new sessions</local-command-stdout>' } }));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: true, petPort: PET, scanMs: 400 }));
const petToken = 'z'.repeat(64);
fs.writeFileSync(path.join(HOME, '.ametyping', `control-token-${PET}`), petToken);

// ---- the fake terminal ----
const RULE = '─'.repeat(100);
const keys = [], decisions = [];
let perms = [];                                     // permission cards the fake pet has open
const QS = { questions: [
  { question: '要哪些配菜', header: '配菜', multiSelect: true, options: [{ label: '青菜', description: '绿' }, { label: '鸡蛋', description: '黄' }, { label: '豆腐', description: '白' }] },
  { question: '喝什么', header: '饮料', multiSelect: false, options: [{ label: '茶', description: '热' }, { label: '水', description: '凉' }] }] };
const askPerm = (id) => ({ id, provider: 'claude', tool: 'AskUserQuestion', ask: true, cwd: '/demo', input: JSON.stringify(QS, null, 2) });
let show = 'idle';                                   // a fixture's name, or 'mcp' / 'effort': menus that answer keys
// a list with headings (as /mcp draws it): the arrows move ❯ over the servers only
const SERVERS = [{ h: 'User MCPs (~/.claude.json)' }, { n: 'alpha', s: '✔', t: '2 tools' }, { n: 'beta', s: '✘', t: '' }, { h: 'claude.ai' }, { n: 'gamma', s: '⚠', t: 'needs authentication' }, { n: 'delta', s: '✔', t: '9 tools' }];
const items = SERVERS.filter((x) => x.n);
let mcpAt = 0, picked = '';
const mcpScreen = () => ['❯ /mcp', RULE, '', RULE, '  Manage MCP servers', `  ${items.length} servers`, '',
  ...SERVERS.flatMap((x, i) => (x.h ? [...(i ? [''] : []), '    ' + x.h] : [`  ${items[mcpAt] === x ? '❯' : ' '} ${x.s} ${x.n.padEnd(12)}${x.t}`])), '',
  ' ↑/↓ to navigate · Enter to confirm · Esc to cancel'].join('\n');
// the effort slider: ▲ over one of five names
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'], COLS = [29, 37, 48, 57, 68];
let level = 2;
const effortScreen = () => {
  const tr = Array.from('─'.repeat(43)); tr[Math.round(COLS[level] + LEVELS[level].length / 2) - 29] = '▲';
  let labels = ' '.repeat(80);
  LEVELS.forEach((l, i) => { labels = labels.slice(0, COLS[i]) + l + labels.slice(COLS[i] + l.length); });
  return ['❯ /effort', '', RULE, '  Effort', '', ' '.repeat(29) + 'Faster' + ' '.repeat(29) + 'Smarter', ' '.repeat(29) + tr.join('') + '      Ultracode  off',
    labels.trimEnd().padEnd(78) + 'Tab to toggle', '', '', '  ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel'].join('\n');
};
const screen = () => (show === 'mcp' ? mcpScreen() : show === 'effort' ? effortScreen() : fs.readFileSync(path.join(FIX, show + '.txt'), 'utf8'));
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-ame-control'] !== petToken) { res.statusCode = 403; return res.end('{}'); }
    const d = b ? JSON.parse(b) : {};
    if (req.url === '/control/state') return res.end(JSON.stringify({ control: true, sessions: [{ id: SID, label: 'demo 会话', project: 'demo', state: perms.length ? 'waiting' : 'idle', via: 'terminal', t0: now, last: now, lines: [], perms }] }));
    if (req.url === '/control/key') {
      keys.push(d.key);
      if (show === 'mcp') {
        if (d.key === 'down') mcpAt = Math.min(items.length - 1, mcpAt + 1);
        if (d.key === 'up') mcpAt = Math.max(0, mcpAt - 1);
        if (d.key === 'enter') { picked = items[mcpAt].n; show = 'idle'; }
      } else if (show === 'effort') {
        if (d.key === 'right') level = Math.min(4, level + 1);
        if (d.key === 'left') level = Math.max(0, level - 1);
      }
      return res.end(JSON.stringify({ ok: true, screen: d.screen === true ? screen() : undefined }));
    }
    if (req.url === '/control/screen') return res.end(JSON.stringify({ ok: true, screen: screen() }));
    if (req.url === '/control/decide') { decisions.push(d); perms = perms.filter((x) => x.id !== d.id); return res.end(JSON.stringify({ ok: true })); }
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
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' }); await sleep(3000);
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
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);
    await evalJs("(() => { const c = [...document.querySelectorAll('.dash .card')].find(x => x.textContent.includes('demo')); c && c.click(); })()"); await sleep(800);
    // the dashboard's window as large as the page: the card has room
    await evalJs("(() => { const w = [...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent === '糖糖看板'); const b = w && w.querySelector('.tbtn[title=最大化]'); b && b.click(); })()"); await sleep(400);

    // ---- what slash commands printed is in the conversation ----
    const conv = () => evalJs("[...document.querySelectorAll('.dash .conv .m')].map(m => m.className.replace('m ', '') + ':' + m.textContent.slice(0, 60).replace(/\\s+/g, ' ')).join(' || ')");
    const c0 = await conv();
    chk('/context and /model are in the conversation as you typed them, each with what it printed', /user:\/context/.test(c0) && /cmd:命令输出.*Context Usage/.test(c0) && /user:\/model/.test(c0) && /cmd:命令输出.*Set model to `Opus 5\.5`/.test(c0), c0);
    chk('not the copy meant for the model, no colour codes', !/for the model only/.test(c0) && !(await evalJs("document.querySelector('.dash .conv').textContent.includes(String.fromCharCode(27))")), c0);
    const fold = () => evalJs("(() => { const m = [...document.querySelectorAll('.dash .conv .m.cmd')].find(x => x.textContent.includes('Context Usage')); return [m.querySelector('pre').textContent.split('\\n').length, (m.querySelector('.cmore') || {}).textContent || '']; })()");
    const f0 = await fold();
    chk('a long output is folded, with how long it is', f0[0] === 12 && /展开全部（共 32 行）/.test(f0[1]), f0);
    await shot('60-cmd-output.png');
    await evalJs("[...document.querySelectorAll('.dash .conv .m.cmd .cmore')][0].click()"); await sleep(200);
    const f1 = await fold();
    chk('展开: all of it, and 收起', f1[0] === 32 && f1[1] === '收起', f1);

    // ---- 终端画面 as a card ----
    const card = () => evalJs("(() => { const t = document.querySelector('.dash .term'); if (!t || t.hidden) return null; const c = t.querySelector('.tcard'); return { head: (c.querySelector('.thead b') || {}).textContent || '', tabs: [...c.querySelectorAll('.ttab')].map(x => x.textContent), rows: [...c.querySelectorAll('.trow')].map(r => (r.classList.contains('cur') ? '>' : r.classList.contains('hd') ? '#' : r.classList.contains('mo') ? '~' : ' ') + (r.querySelector('.tl') || r).textContent), acts: [...c.querySelectorAll('.tact button')].map(b => b.textContent + (b.disabled ? '(x)' : '')), text: c.textContent, raw: !t.querySelector('.tscr').hidden }; })()");
    await evalJs("(() => { const k = document.querySelector('.dash .keys'); if (k.hidden) document.querySelector('.dash .kbd').click(); })()"); await sleep(300);
    await evalJs("[...document.querySelectorAll('.dash .keys .btn')].find(b => b.textContent === '画面').click()"); await sleep(1300);
    let c = await card();
    chk('no menu open: the card says so and shows the end of the terminal', c && /没有打开菜单/.test(c.text) && /Kept model as Opus 5\.5/.test(c.text) && /auto mode on/.test(c.text), c);
    await shot('60-term-idle.png');
    const refresh = async (name) => { show = name; await evalJs("[...document.querySelectorAll('.dash .term .tbar .btn')].find(b => b.textContent === '刷新').click()"); await sleep(1300); return card(); };

    c = await refresh('model');
    chk('/model: title, the models as rows, ❯ and 当前 on Opus 5.5, what is below the window', c.head === 'Select model' && c.rows.join('|') === ' Default (recommended)|>Opus 5.5| Fable 5.1| Sonnet 5.5| Haiku 4.5| Sonnet 5|~… +6 models' && /当前/.test(c.text), c);
    chk('/model: the keys the menu names are buttons', c.acts.join('|') === '回车 设为默认|s 只用于本会话|Esc 取消', c.acts);
    await shot('60-term-model.png');
    c = await refresh('config');
    chk('/config: tabs, the search box, settings with their values', c.head === 'Settings' && c.tabs.join() === 'Status,Config,Usage,Stats' && c.rows[0] === '>Auto-compact' && /Search settings…/.test(c.text) && c.rows[c.rows.length - 1] === '~↓ 31 more', c);
    await shot('60-term-config.png');
    c = await refresh('status');
    chk('/status: name / value lines', c.head === 'Settings' && /Version2\.1\.289/.test(c.text) && /Modelopus \(claude-opus-5-5\)/.test(c.text) && c.acts.join() === 'Esc 取消', c);
    await shot('60-term-status.png');
    c = await refresh('usage');
    chk('/usage: the bar', /31% used/.test(c.text) && c.acts.join('|') === 'd 按天|w 按周|Esc 取消' && (await evalJs("document.querySelector('.dash .term .tprog .bar i').style.width")) === '31%', c);
    await shot('60-term-usage.png');
    c = await refresh('mcp-real');
    chk('/mcp: the groups are headings, the servers rows with their marks', c.head === 'Manage MCP servers' && c.rows[0].startsWith('#User MCPs') && c.rows[1] === '>notebooklm-mcp' && c.rows.includes('#claude.ai') && c.rows.includes(' claude.ai Notion'), c);
    await shot('60-term-mcp-real.png');
    for (const [name, title] of [['permissions', 'Permissions'], ['hooks', 'Hooks'], ['hooks-enter', 'Command hook'], ['plugin-tab', 'Plugins'], ['memory', 'Memory'], ['theme', 'Theme'], ['export', 'Export conversation'],
      ['add-dir', 'Add directory to workspace'], ['resume', 'Resume session'], ['resume-list', 'Resume session (1 of 40)'], ['resume-nocursor', 'Resume session'], ['help', 'Help'], ['help-commands', 'Browse default commands'], ['tasks', 'Background'], ['ide', 'Select IDE'], ['rewind', 'Rewind'], ['mcp-enter', 'Notebooklm-mcp MCP Server']]) {
      c = await refresh(name);
      chk(`/${name}: read as a menu titled "${title}"`, c && c.head === title && !c.raw, c && [c.head, c.rows.slice(0, 3)]);
      await shot(`60-term-${name}.png`);
    }
    c = await refresh('hooks');
    chk('/hooks: the events are headings, the hooks rows', c.rows[0] === '#PreToolUse' && c.rows[1].startsWith('>[User]') && c.rows[2] === '#PostToolUse', c.rows.slice(0, 4));
    c = await refresh('resume');
    chk('/resume: Ctrl+A / Ctrl+B as buttons, the box to type into asked for', c.acts.join('|') === 'Ctrl+A 显示所有项目|Ctrl+B 只看当前分支|Esc 取消' && (await evalJs("document.querySelector('.dash .term .ttyper').classList.contains('want')")), c.acts);
    keys.length = 0;
    await evalJs("[...document.querySelectorAll('.dash .term .tact button')].find(b => b.textContent.startsWith('Ctrl+A')).click()"); await sleep(1200);
    await evalJs("(() => { const i = document.querySelector('.dash .term .ttype'); i.value = 'D:\\\\proj 中文'; i.dispatchEvent(new Event('input')); [...document.querySelectorAll('.dash .term .ttyper .btn')].find(b => b.textContent === '输入').click(); })()"); await sleep(1200);
    await evalJs("[...document.querySelectorAll('.dash .term .ttyper .btn')].find(b => b.textContent === '⌫').click()"); await sleep(1200);
    chk('Ctrl+A, text typed without Enter, Backspace reach the terminal', keys.join('|') === 'ctrla|c:D:\\proj 中文|bksp', keys);

    // a row clicked: the terminal's cursor is walked there, past the headings; clicked again: Enter
    c = await refresh('mcp');
    chk('/mcp: headings and servers told apart', c.rows.join('|') === '#User MCPs (~/.claude.json)|>alpha| beta|#claude.ai| gamma| delta', c.rows);
    await shot('60-term-mcp.png');
    keys.length = 0;
    await evalJs("[...document.querySelectorAll('.dash .term .trow')].find(r => r.querySelector('.tl') && r.querySelector('.tl').textContent === 'delta').click()");
    for (let i = 0; i < 40 && mcpAt !== 3; i++) await sleep(200);
    await sleep(900);
    c = await card();
    chk('a click on "delta": three ↓, the cursor is there', keys.join() === 'down,down,down' && c.rows.join('|').includes('>delta'), [keys, c.rows]);
    await evalJs("[...document.querySelectorAll('.dash .term .trow')].find(r => r.querySelector('.tl') && r.querySelector('.tl').textContent === 'beta').click()");
    for (let i = 0; i < 40 && mcpAt !== 1; i++) await sleep(200);
    await sleep(900);
    chk('a click on "beta" above: two ↑', keys.join() === 'down,down,down,up,up' && mcpAt === 1, keys);
    await evalJs("document.querySelector('.dash .term .trow.cur').click()"); await sleep(1300);
    c = await card();
    chk('the row under the cursor clicked: Enter', keys[keys.length - 1] === 'enter' && picked === 'beta' && /没有打开菜单/.test(c.text), [keys, picked]);

    // the slider
    c = await refresh('effort');
    const seg = () => evalJs("[...document.querySelectorAll('.dash .term .tslide .seg')].map(b => (b.classList.contains('on') ? '>' : '') + b.textContent).join()");
    chk('/effort: the levels as buttons, the one ▲ is over marked; Tab for Ultracode among the keys', (await seg()) === 'low,medium,>high,xhigh,max' && c.acts.includes('Tab 切换（Ultracode）') && /Ultracode off/.test(c.text), [await seg(), c.acts]);
    await shot('60-term-effort.png');
    keys.length = 0;
    await evalJs("[...document.querySelectorAll('.dash .term .tslide .seg')].find(b => b.textContent === 'max').click()");
    for (let i = 0; i < 40 && level !== 4; i++) await sleep(200);
    await sleep(900);
    chk('a click on "max": two →', keys.join() === 'right,right' && (await seg()) === 'low,medium,high,xhigh,>max', [keys, await seg()]);
    c = await refresh('effort-real');
    chk('/effort as Claude Code really draws it', c.head === 'Effort' && (await seg()) === 'low,medium,>high,xhigh,max', [c && c.head, await seg()]);

    // the tab a menu is on: read with the terminal's highlights; another tab clicked: ← / → as the menu says
    c = await refresh('permissions-hl');
    const tabs = () => evalJs("[...document.querySelectorAll('.dash .term .ttab')].map(t => (t.classList.contains('on') ? '>' : '') + t.textContent).join('|')");
    chk('/permissions: the current tab marked', (await tabs()) === 'Recently denied|>Allow|Ask|Deny|Auto mode|Workspace', await tabs());
    await shot('60-term-tabs.png');
    keys.length = 0;
    await evalJs("[...document.querySelectorAll('.dash .term .ttab')].find(t => t.textContent === 'Deny').click()"); await sleep(3200);
    chk('a click on "Deny", two tabs to the right: two →', keys.join() === 'right,right', keys);
    c = await refresh('config-hl');
    keys.length = 0;
    await evalJs("[...document.querySelectorAll('.dash .term .ttab')].find(t => t.textContent === 'Usage').click()"); await sleep(900);
    chk('/config with the cursor in its list (the menu does not offer ← / → there): the tab is marked, a click presses nothing', (await tabs()) === 'Status|>Config|Usage|Stats' && keys.length === 0, [await tabs(), keys]);
    c = await refresh('ask-multi');
    chk('Claude\'s questions as the terminal draws them: tabs, boxes to tick', c.tabs.join('|') === '☒ 配菜|☐ 饮料|✔ Submit' && c.rows.length === 5 && c.rows[0] === '>青菜绿' && c.rows[1] === ' 鸡蛋黄' && c.rows[4] === ' Chat about this' && c.text.includes('Tab/Arrow keys to navigate'), c);
    await shot('60-term-ask-screen.png');

    // 原文: the screen as the text it is
    await evalJs("[...document.querySelectorAll('.dash .term .tbar .btn')].find(b => b.textContent === '原文').click()"); await sleep(200);
    const rawText = await evalJs("(() => { const t = document.querySelector('.dash .term'); return [t.querySelector('.tcard').hidden, t.querySelector('.tscr').hidden, t.querySelector('.tscr').textContent.includes('5. Chat about this'), /[\\uE000\\uE001]/.test(t.querySelector('.tscr').textContent)]; })()");
    chk('原文: the whole screen as text instead of the card (without the highlight marks)', rawText.join() === 'true,false,true,false', rawText);
    await shot('60-term-raw.png');
    await evalJs("[...document.querySelectorAll('.dash .term .tbar .btn')].find(b => b.textContent === '×').click()"); await sleep(300);

    // ---- Claude asking you something: a card with the questions, answered there ----
    perms = [askPerm('q1')];
    for (let i = 0; i < 40 && !(await evalJs("!!document.querySelector('.dash .perm.ask')")); i++) await sleep(150);
    const ask = () => evalJs("(() => { const c = document.querySelector('.dash .perm.ask'); if (!c) return null; return { title: c.querySelector('.pt').textContent, qs: [...c.querySelectorAll('.aq')].map(q => q.querySelector('.aqh').textContent + ':' + [...q.querySelectorAll('.aopt')].map(o => (o.classList.contains('on') ? '>' : '') + o.querySelector('b').textContent).join(',')), btns: [...c.querySelectorAll('.pa button')].map(b => b.textContent + (b.disabled ? '(x)' : '')) }; })()");
    let a = await ask();
    chk('the questions as a card: each with its options; no 允许; nothing to submit yet', a && a.title === 'Claude 在问你 · 2 个问题' && a.qs.join(' | ') === '配菜要哪些配菜可多选:青菜,鸡蛋,豆腐 | 饮料喝什么:茶,水' && a.btns.join() === '提交回答(x),先聊聊,不回答', a);
    const pick = (label) => evalJs(`[...document.querySelectorAll('.dash .perm.ask .aopt')].find(o => o.querySelector('b').textContent === ${JSON.stringify(label)}).click()`);
    await pick('青菜'); await pick('豆腐'); await pick('鸡蛋'); await pick('鸡蛋');                // (ticked and unticked again)
    a = await ask();
    chk('several answers to the first; the second still open', a.qs[0].endsWith(':>青菜,鸡蛋,>豆腐') && a.btns[0] === '提交回答(x)', a);
    await pick('茶'); await pick('水');
    a = await ask();
    chk('one answer to the second (the later click), now it can be submitted', a.qs[1].endsWith(':茶,>水') && a.btns[0] === '提交回答', a);
    await evalJs("(() => { const i = document.querySelectorAll('.dash .perm.ask .aown')[0]; i.value = '再加点辣椒'; i.dispatchEvent(new Event('input')); })()");
    await shot('61-ask-card.png');
    await evalJs("document.querySelector('.dash .perm.ask .pa .btn.go').click()");
    for (let i = 0; i < 30 && !decisions.length; i++) await sleep(150);
    chk('submitted: the pet gets the answers by question -- labels joined, your own words after them', decisions.length === 1 && decisions[0].id === 'q1' && decisions[0].choice === 'answer' && JSON.stringify(decisions[0].answers) === JSON.stringify({ 要哪些配菜: '青菜, 豆腐, 再加点辣椒', 喝什么: '水' }), decisions);
    for (let i = 0; i < 30 && (await evalJs("!!document.querySelector('.dash .perm.ask')")); i++) await sleep(150);
    // your own words instead of an option; then 先聊聊
    perms = [askPerm('q2')];
    for (let i = 0; i < 40 && !(await evalJs("!!document.querySelector('.dash .perm.ask')")); i++) await sleep(150);
    await pick('青菜'); await pick('茶');
    await evalJs("(() => { const i = document.querySelectorAll('.dash .perm.ask .aown')[1]; i.value = '可乐，要冰的'; i.dispatchEvent(new Event('input')); })()");
    a = await ask();
    chk('own words for a question with one answer take the option\'s place', a.qs[1].endsWith(':茶,水') && a.btns[0] === '提交回答', a);
    await evalJs("document.querySelector('.dash .perm.ask .pa .btn.go').click()");
    for (let i = 0; i < 30 && decisions.length < 2; i++) await sleep(150);
    chk('submitted with them', decisions[1] && JSON.stringify(decisions[1].answers) === JSON.stringify({ 要哪些配菜: '青菜', 喝什么: '可乐，要冰的' }), decisions[1]);
    for (let i = 0; i < 30 && (await evalJs("!!document.querySelector('.dash .perm.ask')")); i++) await sleep(150);
    perms = [askPerm('q3')];
    for (let i = 0; i < 40 && !(await evalJs("!!document.querySelector('.dash .perm.ask')")); i++) await sleep(150);
    await evalJs("[...document.querySelectorAll('.dash .perm.ask .pa button')].find(b => b.textContent === '先聊聊').click()");
    for (let i = 0; i < 30 && decisions.length < 3; i++) await sleep(150);
    chk('先聊聊 goes as its own choice, without answers', decisions[2] && decisions[2].id === 'q3' && decisions[2].choice === 'chat' && decisions[2].answers === undefined, decisions[2]);
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
