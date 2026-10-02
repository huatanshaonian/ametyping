// e2e: 早安日报. (1) the pet's morning logic (app/morning.js with stand-ins for Electron): a new note shows once, on
// the first key; the next note shows again; off in the tray = never; remembered across restarts. (2) the note's way
// there: server -> agent -> pet (/control/report), the latest real report as the agent connects. (3) the window's
// page rendered in headless Chrome for a look (test/out/shots/60-morning.png).
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..'), APP = path.resolve(R, '..', 'app');
const WebSocket = require(R + '/node_modules/ws');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-morning-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 500)}`); };

function unit() {
  const { createMorning } = require(path.join(APP, 'morning.js'));
  const windows = [];
  class FakeWin {
    constructor() { this.shown = 0; this.sent = []; windows.push(this); this.webContents = { once: () => {}, send: (c, d) => this.sent.push(d) }; }
    setAlwaysOnTop() {} loadFile() {} on() {} isVisible() { return true; } hide() {} setBounds(b) { this.bounds = b; } showInactive() { this.shown++; }
  }
  let enabled = true;
  const deps = () => ({ app: { getPath: () => T }, BrowserWindow: FakeWin, ipcMain: { on: () => {} }, anchor: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    enabled: () => enabled, dashboardUrl: () => 'https://x', openExternal: () => {} });
  let m = createMorning(deps());
  const note = { date: '2026-09-29', headline: '改了日报', projects: ['Windose'], open: 3, chores: 1 };
  m.onKey();
  ok('no note yet: nothing shown', windows.length === 0);
  ok('bad notes refused', m.setNote({ date: 'yesterday' }) === false && m.setNote(null) === false);
  const w0 = Date.now(); while (Date.now() - w0 < 2100) {}                   // (keys are looked at every 2 s)
  m.setNote(note); m.onKey();
  ok('a new note shows on the first key', windows.length === 1);
  const t0 = Date.now(); while (Date.now() - t0 < 2100) {}                   // (keys are looked at every 2 s)
  m.onKey();
  ok('only once', windows.length === 1 && windows[0].shown === 0);           // (the fake never "finishes loading")
  m = createMorning(deps()); m.onKey();
  ok('remembered across a restart', windows.length === 1);
  m.setNote({ ...note, date: '2026-09-30' }); enabled = false; m.onKey();
  ok('tray option off: not shown', windows.length === 1);
  enabled = true; while (Date.now() - t0 < 4300) {} m.onKey();
  ok('turned on again: the new note shows', windows.length === 2);
  m.setNote({ ...note, date: '2026-09-30', week: { start: '2026-09-21', end: '2026-09-27', headline: '周' } });
  while (Date.now() - t0 < 6500) {} m.onKey();
  ok('the same day with its week is news again (the window is reused)', windows.length === 2 && windows[1].shown === 1, windows.map((w) => w.shown));
  // today's agenda: kept with the note; the same report again only refreshes it (not shown again)
  const pad = (n) => String(n).padStart(2, '0'), d = new Date(), today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const n2 = { ...note, date: '2026-10-01', today: { date: today, google: true, events: [{ time: '10:00', title: '组会' }, { time: 'bad', title: '全天的' }, { title: '' }], tasks: ['买菜'], todos: ['交报告'] } };
  m.setNote(n2);
  const kept = m.note().today || {};
  ok('the note keeps today\'s agenda (cleaned: a bad time dropped, empty titles out)', kept.date === today && kept.events.length === 2 && kept.events[0].time === '10:00' &&
    kept.events[1].time === '' && kept.tasks[0] === '买菜' && kept.todos[0] === '交报告', kept);
  while (Date.now() - t0 < 9000) {} m.onKey();
  ok('with an agenda for today the bubble is taller (two more lines)', windows[1].shown === 2 && windows[1].bounds && windows[1].bounds.height === 170 + 2 * 19, windows[1].bounds);
  m.setNote({ ...n2, today: { ...n2.today, events: [{ time: '15:00', title: '改了时间的会' }] } });
  while (Date.now() - t0 < 11500) {} m.onKey();
  ok('the same report sent again (agent reconnects): agenda refreshed, not shown again', windows[1].shown === 2 && m.note().today.events[0].title === '改了时间的会', m.note());
  m.setNote({ ...note, date: '2026-10-02', today: { date: '2020-01-01', google: true, events: [{ time: '09:00', title: '旧的' }], tasks: [], todos: [] } });
  while (Date.now() - t0 < 14000) {} m.onKey();
  ok('an agenda that is not today\'s: no extra lines', windows[1].bounds.height === 170, windows[1].bounds);
  // the mail alerts still open: one more line
  m.setNote({ ...note, date: '2026-10-03', today: { date: today, google: false, events: [], tasks: [], todos: [], mail: { todo: 2, reading: 1, top: ['年度报销截止', '论文提交'], due: '2026-10-12' } } });
  while (Date.now() - t0 < 16500) {} m.onKey();
  ok('mail alerts still open: kept with the agenda, one more line', m.note().today.mail.todo === 2 && m.note().today.mail.top.length === 2 && windows[1].bounds.height === 170 + 19, [m.note().today, windows[1].bounds]);

  // 邮件提醒气泡: at once; several -> the newest and how many more; not seen to -> once more on a key; a click opens the mail
  const { createMailNotice } = require(path.join(APP, 'mail-notice.js'));
  const wins = [], ipc = {};
  class W2 extends FakeWin { constructor() { super(); wins.push(this); } }
  const opened = [];
  let on = true;
  const mn = createMailNotice({ BrowserWindow: W2, ipcMain: { on: (ch, fn) => { ipc[ch] = fn; } }, screen: deps().screen, anchor: deps().anchor,
    enabled: () => on, dashboardUrl: () => 'https://win98.example', openExternal: (u) => opened.push(u) });
  ok('mail bubble: a bad alert refused', mn.add({ id: 1 }) === false && mn.add(null) === false);
  mn.add({ id: 'a1', key: 'acc:7:3', kind: 'action', summary: '年度报销截止', todo: '提交报销单', deadline: '2026-10-12' });
  ok('mail bubble: shown at once (no key needed)', wins.length === 1);
  mn.add({ id: 'a2', key: 'acc:7:4', kind: 'reading', summary: '院刊第 9 期', picks: [{ title: '电磁超表面' }] });
  mn.add({ id: 'a2', key: 'acc:7:4', kind: 'reading', summary: '院刊第 9 期' });
  ok('mail bubble: the newest first, the same alert once', mn.waiting().length === 2 && mn.waiting()[0].id === 'a2' && mn.waiting()[0].picks[0] === '电磁超表面');
  ipc['mail-notice-open']({ sender: wins[0].webContents });
  ok('mail bubble: a click opens that mail in Windose, and they are seen to', opened[0] === 'https://win98.example/#mail=acc%3A7%3A4' && mn.waiting().length === 0, opened);
  on = false;
  mn.add({ id: 'a3', key: 'k', kind: 'notice', summary: 'x' });
  ok('mail bubble: switched off in the tray -> not shown (kept)', wins[0].shown === 1 && mn.waiting().length === 1, wins[0].shown);
}

async function chain() {
  const auth = require(R + '/server/auth');
  const HOME = path.join(T, 'home'); fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true }); fs.mkdirSync(path.join(HOME, '.ametyping'));
  const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
  const PORT = 18810, PET = 18811;
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
  const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
  node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')] };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
  const RDIR = path.join(T, 'srv', 'data', 'reports'); fs.mkdirSync(RDIR, { recursive: true });
  fs.writeFileSync(path.join(RDIR, '2026-09-28.json'), JSON.stringify({ date: '2026-09-28', headline: '整理论文图表', stats: {},
    projects: [{ name: 'RCS 论文', category: 'research' }, { name: '配代理', category: 'chore' }], open: [{ text: 'a', status: 'open' }, { text: 'b', status: 'done' }] }));
  fs.writeFileSync(path.join(RDIR, '2026-09-29.json'), JSON.stringify({ date: '2026-09-29', brief: true, headline: '补录的', projects: [], open: [] }));
  // a 重要计划 due today, one due tomorrow
  const pad = (n) => String(n).padStart(2, '0'), ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const today = ymd(Date.now());
  fs.writeFileSync(path.join(T, 'srv', 'data', 'todos.json'), JSON.stringify([{ id: 'a1', text: '交报告', due: today, created: Date.now(), done: false },
    { id: 'a2', text: '明天的', due: ymd(Date.now() + 86400e3), created: Date.now(), done: false }]));
  const ACFG = path.join(T, 'agent.json');
  fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, petPort: PET }));
  const petToken = 'm'.repeat(64);
  fs.writeFileSync(path.join(HOME, '.ametyping', `control-token-${PET}`), petToken);
  const notes = [];
  const pet = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-ame-control'] !== petToken) { res.statusCode = 403; return res.end('{}'); }
      if (req.url === '/control/report') { notes.push(JSON.parse(b)); return res.end('{"ok":true}'); }
      if (req.url === '/control/state') return res.end(JSON.stringify({ control: false, sessions: [] }));
      res.statusCode = 404; res.end('{}');
    });
  }).listen(PET, '127.0.0.1');
  const kids = [];
  const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
  try {
    spawn([R + '/server/server.js']); await sleep(900);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG });
    for (let i = 0; i < 40 && !notes.length; i++) await sleep(250);
    const n = notes[0] || {};
    ok('the agent passes the latest real report to the pet as it connects (not a backfill, even with "control" off)', n.date === '2026-09-28' && n.headline === '整理论文图表', notes);
    ok('the note: projects without chores, open important items and chore counts', JSON.stringify(n.projects) === '["RCS 论文"]' && n.open === 2 && n.chores === 1, n);
    ok('the note carries today\'s agenda: the 重要计划 due today (Google not connected: no events)', n.today && n.today.date === today && JSON.stringify(n.today.todos) === '["交报告"]' &&
      n.today.google === false && n.today.events.length === 0, n.today);
    ok('... and the mail alerts still open (none here)', n.today.mail && n.today.mail.todo === 0 && n.today.mail.reading === 0, n.today.mail);
  } catch (e) { fail++; console.log('ERROR', e); }
  finally { for (const k of kids) try { k.kill(); } catch {} pet.close(); await sleep(500); }
}

async function look() {
  const CDP = 9338;
  const chrome = cp.spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${path.join(T, 'chrome')}`, '--no-first-run', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  try {
    await sleep(2000);
    const tab = await new Promise((resolve, reject) => { const r = http.request(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(JSON.parse(b))); }); r.on('error', reject); r.end(); });
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
    let id = 0; const pending = new Map();
    ws.on('message', (m) => { const o = JSON.parse(m); if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); } });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 300, height: 170, deviceScaleFactor: 2, mobile: false });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: "window.morning = { onNote: (fn) => { window.__note = fn; }, open: () => {}, close: () => {} };" });
    await call('Page.navigate', { url: 'file:///' + path.join(APP, 'morning.html').replace(/\\/g, '/') });
    await sleep(1200);
    await call('Runtime.evaluate', { expression: "window.__note({ date: '2026-09-29', headline: '给 Windose 加了工作日报、产出物索引和搜索', projects: ['Windose', 'RCS 论文'], open: 3, chores: 2, week: { start: '2026-09-21', end: '2026-09-27', headline: '推进日报系统与 RCS 图' } })" });
    await sleep(500);
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.join(__dirname, 'out', 'shots'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'out', 'shots', '60-morning.png'), Buffer.from(shot.result.data, 'base64'));
    const txt = (await call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })).result.result.value;
    ok('the window shows the day, projects, open count and the week', /9月29日/.test(txt) && /Windose、RCS 论文/.test(txt) && /重要计划还剩 3 件/.test(txt) && /上周周报/.test(txt), txt);
    // with today's agenda (two more lines)
    await call('Emulation.setDeviceMetricsOverride', { width: 300, height: 170 + 2 * 19, deviceScaleFactor: 2, mobile: false });
    const pad = (n) => String(n).padStart(2, '0'), d = new Date(), today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    await call('Runtime.evaluate', { expression: `window.__note({ date: '2026-10-01', headline: '接上 Google 日历和任务', projects: ['Windose'], open: 2, chores: 1, today: { date: '${today}', google: true, events: [{ time: '', title: '国庆' }, { time: '10:00', title: '组会' }, { time: '14:30', title: '和导师讨论 RCS 图' }], tasks: ['买菜'], todos: ['交报告'] } })` });
    await sleep(400);
    const shot2 = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'out', 'shots', '61-morning-agenda.png'), Buffer.from(shot2.result.data, 'base64'));
    const txt2 = (await call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })).result.result.value;
    await call('Emulation.setDeviceMetricsOverride', { width: 300, height: 170 + 3 * 19, deviceScaleFactor: 2, mobile: false });
    await call('Runtime.evaluate', { expression: `window.__note({ date: '2026-10-01', headline: '接上 Google 日历和任务', projects: ['Windose'], open: 2, chores: 1, today: { date: '${today}', google: true, events: [{ time: '10:00', title: '组会' }], tasks: [], todos: ['交报告'], mail: { todo: 2, reading: 1, top: ['年度报销 10/12 截止', '论文提交'], due: '2026-10-12' } } })` });
    await sleep(400);
    const shot3 = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'out', 'shots', '62-morning-mail.png'), Buffer.from(shot3.result.data, 'base64'));
    const txt3 = (await call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })).result.result.value;
    ok('the morning bubble\'s mail line: to do (nearest deadline), papers, the first ones', /邮件：2 件要办（10月12日截止）、1 篇推荐/.test(txt3), txt3);
    // the mail bubble
    await call('Emulation.setDeviceMetricsOverride', { width: 300, height: 150, deviceScaleFactor: 2, mobile: false });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: "window.mailNotice = { onAlert: (fn) => { window.__alert = fn; }, open: () => {}, close: () => {} };" });
    await call('Page.navigate', { url: 'file:///' + path.join(APP, 'mail-notice.html').replace(/\\/g, '/') });
    await sleep(1000);
    await call('Runtime.evaluate', { expression: "window.__alert({ id: 'a', key: 'k', kind: 'action', summary: '年度经费报销截止，请提交报销单', todo: '在 ARP 系统提交报销单', deadline: '2026-10-12', more: 1 })" });
    await sleep(400);
    const shot4 = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'out', 'shots', '63-mail-bubble.png'), Buffer.from(shot4.result.data, 'base64'));
    const txt4 = (await call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })).result.result.value;
    ok('the mail bubble: kind, what it is, what to do, the deadline, how many more', /要办/.test(txt4) && /年度经费报销截止/.test(txt4) && /要做：在 ARP/.test(txt4) && /截止：10月12日/.test(txt4) && /还有 1 条提醒/.test(txt4), txt4);
    await call('Page.navigate', { url: 'file:///' + path.join(APP, 'morning.html').replace(/\\/g, '/') });
    await sleep(600);
    ok('today\'s agenda: the events (times first) and what is due', /今天 3 个日程：国庆、10:00 组会、14:30 和导师讨论/.test(txt2) && /今天到期：交报告、买菜/.test(txt2) && !/上周周报/.test(txt2), txt2);
    ws.close();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally { try { chrome.kill(); } catch {} await sleep(500); }
}

(async () => {
  try { unit(); await chain(); await look(); } catch (e) { fail++; console.log('ERROR', e); }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
