// UI check (工作日报): throwaway server + agent with fake sessions, headless Chrome over CDP (login cookie injected),
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
const PORT = 18800, CDP = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
let n = 0;
const L = (o, t) => JSON.stringify({ uuid: 'u' + (++n), cwd: '/home/dell/demo', timestamp: new Date(t).toISOString(), ...o }) + '\n';
const now = Date.now();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; cfg.summary = { codex: [process.execPath, path.join(__dirname, 'fake-codex.js')], proxies: [], categories: [{ match: '/home/dell/demo', cat: 'research' }] }; cfg.summary.at = (() => { const d = new Date(Date.now() - 6 * 3600e3); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); })(); fs.writeFileSync(CFG, JSON.stringify(cfg));   // (day boundary 6 h ago: independent of the clock)
const RDIR = path.join(T, 'srv', 'data', 'reports'); fs.mkdirSync(RDIR, { recursive: true });
// a mail about the mesh, archived on the NAS: found by the search, opened in 邮件
{ const MD = path.join(T, 'srv', 'data', 'mail', 'acc1'); fs.mkdirSync(MD, { recursive: true });
  fs.writeFileSync(path.join(MD, '2026-09.jsonl'), JSON.stringify({ key: 'acc1:1:5', acc: 'acc1', uid: 5, mid: '<m5@x>', date: Date.parse('2026-09-28T09:00:00'), from: { name: '导师', address: 'prof@example.edu.cn' }, to: [], subject: '网格加密的参考', text: '请看附件里的网格划分说明。', att: [] }) + '\n'); }
fs.writeFileSync(path.join(RDIR, '2026-09-28.json'), JSON.stringify({ date: '2026-09-28', headline: '整理论文图表，顺手修了糖糖的提示音', from: now - 2 * 86400e3, to: now - 86400e3, stats: { minutes: 185, sessions: 4, machines: 2 }, sessions: [],
  projects: [{ name: 'RCS 论文', category: 'research', summary: '重画了第三章的 RCS 对比图', done: ['图 3-4 改成双对数坐标'], decisions: [], unfinished: [], sessions: [], minutes: 120, files: [] },
    { name: '配置 git 代理', category: 'chore', summary: '给 git 配了 HTTP 代理', done: [], decisions: [], unfinished: [], sessions: [], minutes: 5, files: [] }],
  open: [{ text: '整理参考文献', project: 'RCS 论文', status: 'open', since: '2026-09-27' }], plans: [], keywords: ['RCS', 'matplotlib'] }));
fs.writeFileSync(path.join(RDIR, 'week-2026-09-22.json'), JSON.stringify({ start: '2026-09-22', end: '2026-09-28', headline: '这周主要在重画论文的 RCS 图', highlights: ['第三章图表全部改成双对数坐标'],
  projects: [{ name: 'RCS 论文', category: 'research', summary: '第三章图表重画完成', progress: ['图 3-4 双对数', '图 3-5 加误差棒'] }], days: [{ date: '2026-09-28', headline: '整理论文图表', minutes: 185 }],
  open: [{ text: '整理参考文献', project: 'RCS 论文' }], artifacts: [], stats: { minutes: 600, byCat: { research: 480, personal: 60, chore: 60 }, days: 4, sessions: 9, chores: 3, artifacts: 0 } }));
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

    const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
    await evalJs("[...document.querySelectorAll('.dicon')].find(b => b.textContent.includes('工作日报')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"); await sleep(1500);
    chk('reports window lists the earlier report', (await evalJs("(document.querySelector('.rl')||{}).textContent||''")).includes('9月28日'), await evalJs("(document.querySelector('.rl')||{}).textContent"));
    chk('it is shown', (await evalJs("(document.querySelector('.rv')||{}).textContent||''")).includes('RCS 论文'), 0);
    await shot('30-reports-list.png');
    await evalJs("[...document.querySelectorAll('.rbar .btn')].find(b => b.textContent === '总结到现在').click()");
    for (let i = 0; i < 40; i++) { await sleep(500); if ((await evalJs("(document.querySelector('.rv')||{}).textContent||''")).includes('给 FDTD 加密了网格')) break; }
    chk('draft written and shown', (await evalJs("document.querySelector('.rv').textContent")).includes('给 FDTD 加密了网格'), await evalJs("document.querySelector('.rs').textContent"));
    await evalJs("document.querySelector('.rp-files') && (document.querySelector('.rp-files').open = true)");
    // 重要计划: ☆ a loose end of the report, it shows on the desktop widget; add one there, tick one off
    chk('the desktop widget is there, empty at first', await evalJs("!!document.getElementById('todowidget') && document.querySelector('#todowidget .td-empty') !== null"), 0);
    await evalJs("[...document.querySelectorAll('.rp-open li')].find(li => li.textContent.includes('验证网格收敛')).querySelector('.rp-star').click()"); await sleep(1500);
    chk('☆ makes it an important item (★, on the widget)', (await evalJs("[...document.querySelectorAll('.rp-open li')].find(li => li.textContent.includes('验证网格收敛')).querySelector('.rp-star').textContent")) === '★' &&
      (await evalJs("document.getElementById('todowidget').textContent")).includes('验证网格收敛'), await evalJs("document.getElementById('todowidget').textContent"));
    await evalJs("(() => { const i = document.querySelector('#todowidget .td-in'); i.value = '把第四章图重画'; document.querySelector('#todowidget .td-add').requestSubmit(); })()"); await sleep(1500);
    chk('added from the widget', (await evalJs("document.querySelectorAll('#todowidget .td-list:not(.td-done) .td-i').length")) === 2, await evalJs("document.getElementById('todowidget').textContent"));
    await evalJs("document.querySelectorAll('.win .tbtn[title=最小化]').forEach(b => b.click())"); await sleep(400);
    await shot('37-todo-widget.png');
    await evalJs("document.querySelectorAll('#dock .dockbtn').forEach(b => b.click())"); await sleep(400);
    await evalJs("[...document.querySelectorAll('#todowidget .td-i')].find(li => li.textContent.includes('把第四章图重画')).querySelector('input[type=checkbox]').click()"); await sleep(1500);
    chk('ticked off: moves to 已完成', (await evalJs("document.querySelectorAll('#todowidget .td-list:not(.td-done) .td-i').length")) === 1 && (await evalJs("document.querySelector('#todowidget .td-more').textContent")).includes('已完成（1）'),
      await evalJs("document.getElementById('todowidget').textContent"));
    await shot('31-reports-draft.png');
    // a session link opens it in 糖糖看板
    await evalJs("document.querySelector('.rp-sess').click()"); await sleep(1200);
    chk('session link opens the dashboard on it', (await evalJs("(document.querySelector('.dash .head b')||{}).textContent||''")).length > 0 && await evalJs("!!document.querySelector('.dash .card.sel')"), await evalJs("(document.querySelector('.dash .head b')||{}).textContent"));
    // 记事本: new note, type, it saves itself and shows in the list
    await evalJs("(async () => (await import('/js/apps/notepad.js')).open())()"); await sleep(800);
    await evalJs("[...document.querySelectorAll('.np-bar .btn')].find(b => b.textContent === '新建').click()"); await sleep(300);
    await evalJs("(() => { const t = document.querySelector('.np-text'); t.value = 'RCS 画图笔记\\nloglog + errorbar，图例放右上'; t.dispatchEvent(new Event('input')); })()");
    await sleep(2200);
    chk('notepad: typed text saves itself and lists under its first line', (await evalJs("document.querySelector('.np-list').textContent")).includes('RCS 画图笔记') &&
      /已保存/.test(await evalJs("document.querySelector('.np-st').textContent")), await evalJs("[document.querySelector('.np-list').textContent, document.querySelector('.np-st').textContent]"));
    await shot('38-notepad.png');
    await evalJs("[...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent === '记事本').querySelector('.tbtn.close').click()"); await sleep(300);
    // 日历: the month of the earlier report; a day's details
    await evalJs("(async () => (await import('/js/apps/calendar.js')).open())()"); await sleep(600);
    await evalJs("(async () => { const cal = document.querySelector('.calendar'); for (let i = 0; i < 24 && !cal.querySelector('.cal-d:not(.out)[data-date=\\'2026-09-28\\']'); i++) { [...cal.querySelectorAll('.cal-bar .btn')].find(b => b.textContent === '‹').click(); await new Promise(r => setTimeout(r, 300)); } })()");
    await sleep(800);
    await evalJs("document.querySelector('.cal-d[data-date=\\'2026-09-28\\']') && document.querySelector('.cal-d[data-date=\\'2026-09-28\\']').click()"); await sleep(300);
    chk('calendar: the day shows its report, the details open', (await evalJs("(document.querySelector('.cal-d[data-date=\\'2026-09-28\\']')||{}).textContent||''")).includes('整理论文图表') &&
      (await evalJs("document.querySelector('.cal-detail').textContent")).includes('整理论文图表'), await evalJs("document.querySelector('.cal-detail').textContent"));
    await shot('39-calendar.png');
    await evalJs("[...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent === '日历').querySelector('.tbtn.close').click()"); await sleep(200);
    await evalJs("(async () => (await import('/js/apps/google.js')).open())()"); await sleep(1000);
    chk('Google account: the setup steps and the redirect address', (await evalJs("document.querySelector('.gacc').textContent")).includes('/api/google/callback'), await evalJs("document.querySelector('.gacc').textContent.slice(0, 200)"));
    await shot('41-google-setup.png');
    await evalJs("[...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent === 'Google 账户').querySelector('.tbtn.close').click()"); await sleep(200);
    // the weekly report: a row before its week's days, its own view
    await evalJs("[...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent === '工作日报').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    await evalJs("[...document.querySelectorAll('.ri')].find(x => x.dataset.date === 'week-2026-09-22').click()"); await sleep(800);
    chk('weekly report listed and shown', (await evalJs("document.querySelector('.rv').textContent")).includes('这周最值得记住的'), await evalJs("document.querySelector('.rv').textContent.slice(0, 200)"));
    await shot('36-reports-week.png');
    // search and 问一问 in the report window
    await evalJs("[...document.querySelectorAll('.win')].find(w => w.querySelector('.title').textContent === '工作日报').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    await evalJs("(() => { const q = document.querySelector('.rq'); q.value = '网格'; [...document.querySelectorAll('.rbar .btn')].find(b => b.textContent === '搜索').click(); })()"); await sleep(1500);
    chk('search shows conversations found', (await evalJs("document.querySelector('.rv').textContent")).includes('对话（'), await evalJs("document.querySelector('.rv').textContent.slice(0, 200)"));
    chk('search shows mail found, with its sender', (await evalJs("document.querySelector('.rv').textContent")).includes('邮件（1）') && (await evalJs("document.querySelector('.rv').textContent")).includes('导师'), await evalJs("document.querySelector('.rv').textContent.slice(0, 400)"));
    await shot('34-reports-search.png');
    await evalJs("[...document.querySelectorAll('.rv .rs-link')].find(b => b.textContent === '网格加密的参考').click()"); await sleep(1500);
    chk('a mail result opens 邮件 on that message', await evalJs("[...document.querySelectorAll('.win')].some(w => !w.classList.contains('minimized') && w.textContent.includes('邮件') && w.textContent.includes('请看附件里的网格划分说明'))"), 0);
    await shot('34b-reports-search-mail.png');
    await evalJs("[...document.querySelectorAll('.rbar .btn')].find(b => b.textContent === '问一问').click()");
    for (let i = 0; i < 40; i++) { await sleep(500); if ((await evalJs("document.querySelector('.rv').textContent")).includes('出处')) break; }
    chk('问一问 answers with sources', (await evalJs("document.querySelector('.rv').textContent")).includes('出处'), await evalJs("document.querySelector('.rv').textContent.slice(0, 300)"));
    await shot('35-reports-ask.png');
    // a link from the pet's morning bubble opens that report
    await call('Page.navigate', { url: 'about:blank' }); await sleep(300);
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/#report=2026-09-28` }); await sleep(3500);
    chk('#report= link opens that report (and the link is forgotten)', (await evalJs("(document.querySelector('.rv')||{}).textContent||''")).includes('9月28日') && (await evalJs("location.hash")) === '', await evalJs("[location.hash, (document.querySelector('.rv')||{}).textContent]"));
    await evalJs("localStorage.setItem('ame.theme', JSON.stringify('win98')); localStorage.setItem('ame.wall', JSON.stringify('teal'))");
    await call('Page.reload'); await sleep(3000);
    await evalJs("[...document.querySelectorAll('.dicon')].find(b => b.textContent.includes('工作日报')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"); await sleep(1500);
    await evalJs("document.querySelector('.ri.draft') && document.querySelector('.ri.draft').click()"); await sleep(800);
    await shot('32-reports-win98.png');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(800);
    await shot('33-reports-phone.png');
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
