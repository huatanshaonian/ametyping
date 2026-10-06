// UI check (看板右键菜单): 置顶 / 星标 / 隐藏 / 群组 on the session list, the marks kept on the server, the long press
// on a phone, the reply box hints. Screenshots in test/out/shots.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uimarks-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-demo');
fs.mkdirSync(PROJ, { recursive: true }); fs.mkdirSync(path.join(HOME, '.ametyping'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18828, PET = 18829, CDP = 9342, SID = 'eeeeeeee-1111-2222-3333-444444444444', SID2 = 'ffffffff-1111-2222-3333-444444444444';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const J = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(path.join(PROJ, SID + '.jsonl'), J({ type: 'permission-mode', permissionMode: 'plan', sessionId: SID }) +
  J({ type: 'user', uuid: 'u1', cwd: '/demo', timestamp: new Date(now - 60e3).toISOString(), message: { role: 'user', content: '先想想怎么改' } }) +
  J({ type: 'assistant', uuid: 'a1', cwd: '/demo', timestamp: new Date(now - 50e3).toISOString(), message: { id: 'm1', role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: 152000, output_tokens: 100 }, content: [{ type: 'text', text: '计划如下……' }] } }));
fs.writeFileSync(path.join(PROJ, SID2 + '.jsonl'), J({ type: 'user', uuid: 'v1', cwd: '/demo', timestamp: new Date(now - 40e3).toISOString(), message: { role: 'user', content: '另一个会话的问题' } }) +
  J({ type: 'assistant', uuid: 'v2', cwd: '/demo', timestamp: new Date(now - 30e3).toISOString(), message: { id: 'm2', role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: 50000, output_tokens: 100 }, content: [{ type: 'text', text: '另一个会话的回答' }] } }));
const SID3 = '99999999-1111-2222-3333-444444444444';
fs.writeFileSync(path.join(PROJ, SID3 + '.jsonl'), J({ type: 'user', uuid: 'w1', cwd: '/demo', timestamp: new Date(now - 3 * 86400e3).toISOString(), message: { role: 'user', content: '三天前讨论网格收敛 zebra42' } }) +
  J({ type: 'assistant', uuid: 'w2', cwd: '/demo', timestamp: new Date(now - 3 * 86400e3 + 5000).toISOString(), message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: '好的，先看收敛曲线' }] } }));
fs.utimesSync(path.join(PROJ, SID3 + '.jsonl'), new Date(now - 3 * 86400e3), new Date(now - 3 * 86400e3));
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
    const rect = (sel, text) => evalJs(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text || '')})); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    const mouse = async (p, button = 'left') => {
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, clickCount: 1 });
      await sleep(250);
    };
    const menuFor = async (sel, text) => { const p = await rect(sel, text); if (!p) throw new Error('no ' + sel + ' ' + text); await mouse(p, 'right'); };
    const item = async (label) => { const p = await rect('.ctxm .ctxi', label); if (!p) throw new Error('no menu item ' + label); await mouse(p); await sleep(500); };
    const hover = async (label) => { const p = await rect('.ctxm .ctxi', label); await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(250); };
    const listText = () => evalJs("[...document.querySelectorAll('.dash .list > *')].map(e => e.className.split(' ')[0] + ':' + e.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')");
    const cardsOrder = () => evalJs("[...document.querySelectorAll('.dash .list .card .nm')].map(e => e.textContent)");
    const enter = async () => { await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
    const marks = () => evalJs("fetch('/api/marks').then(r => r.json())");
    const K1 = 'box|' + SID, K2 = 'box|' + SID2;

    // placeholders: short again
    await rect('.dash .card', 'demo 会话').then(mouse); await sleep(600);
    chk('the terminal hint is short', (await evalJs("document.querySelector('.dash .say').placeholder")) === '回复（空框时按键直达终端）', await evalJs("document.querySelector('.dash .say').placeholder"));

    // 对话摘要: four days of notes for the demo session (a backfilled one without a note), the newest three shown
    const RD = path.join(T, 'srv', 'data', 'reports'); fs.mkdirSync(RD, { recursive: true });
    const rep = (date, note, extra = {}) => fs.writeFileSync(path.join(RD, date + '.json'), JSON.stringify({ date, from: 0, to: Date.parse(date + 'T20:00:00'), headline: 'h', projects: [], open: [],
      sessions: [{ key: 'S1', machine: 'box', id: SID, title: 'demo 会话', minutes: 45, note }], ...extra }));
    rep('2026-09-27', null, { brief: true });
    rep('2026-09-28', { did: '最早的一天', open: [], status: 'ongoing', ideas: [] });
    rep('2026-09-29', { did: '定下了网格方案', open: [], status: 'paused', ideas: [] });
    rep('2026-09-30', { did: '写了加密脚本，跑通了第一组', open: ['验证收敛', '整理结果图'], status: 'ongoing', ideas: ['两侧各加 5 层更稳'] });
    rep('2026-10-01', { did: '验证完收敛，收尾', open: [], status: 'done', ideas: [] });
    chk('summary button shown for a picked conversation', await evalJs("!document.querySelector('.dash .snbtn').hidden"), 0);
    await rect('.dash .snbtn').then(mouse); await sleep(800);
    const sn = await evalJs("document.querySelector('.dash .snotes').textContent");
    chk('panel: newest day first with its status', sn.startsWith('已完成10月1日') && sn.includes('验证完收敛'), sn);
    chk('panel: open items and ideas listed', sn.includes('没做验证收敛整理结果图') && sn.includes('要点两侧各加 5 层更稳'), sn);
    chk('panel: three days, then 更早的', sn.includes('定下了网格方案') && !sn.includes('最早的一天') && sn.includes('更早的 1 天'), sn);
    await shot('96-notes.png');
    await evalJs("document.querySelector('.dash .sn-more').scrollIntoView()"); await rect('.dash .sn-more').then(mouse); await sleep(300);
    chk('panel: 更早的 shows the rest', (await evalJs("document.querySelector('.dash .snotes').textContent")).includes('最早的一天'), 0);
    await rect('.dash .card', '第二个会话').then(mouse); await sleep(800);
    chk('panel: another conversation without notes says so', (await evalJs("document.querySelector('.dash .snotes').textContent")).includes('还没有这个对话的摘要'), await evalJs("document.querySelector('.dash .snotes').textContent"));
    await rect('.dash .snbtn').then(mouse); await sleep(300);
    chk('button again: panel closed (and remembered)', await evalJs("document.querySelector('.dash .snotes').hidden && !document.querySelector('.dash .snbtn').classList.contains('on')"), 0);
    await rect('.dash .card', 'demo 会话').then(mouse); await sleep(500);
    // context left: in the header, and a tag on the card when low
    const meta = await evalJs("document.querySelector('.dash .head .meta').textContent");
    chk('header: context left', meta.includes('上下文剩 9%') && await evalJs("!!document.querySelector('.dash .head .meta .cx.bad')"), meta);
    const tags = await evalJs("[...document.querySelectorAll('.dash .card')].map(c => c.textContent.includes('上下文 9%') + ':' + c.textContent.includes('上下文'))");
    chk('card: only the low one is tagged', tags.includes('true:true') && tags.includes('false:false'), tags);
    await shot('95-ctx.png');
    await rect('.dash .card', '第二个会话').then(mouse); await sleep(400);
    chk('header: the other one, plenty left', (await evalJs("document.querySelector('.dash .head .meta').textContent")).includes('上下文剩 70%'), await evalJs("document.querySelector('.dash .head .meta').textContent"));
    // the menu
    const first = (await cardsOrder())[0];
    await menuFor('.dash .card', '第二个会话');
    const labels = await evalJs("[...document.querySelectorAll('.ctxm .ctxi')].map(e => e.textContent)");
    chk('a session menu: open / pin / star / hide / group', ['打开', '置顶', '星标', '隐藏', '移到群组'].every((l) => labels.some((x) => x.includes(l))), labels);
    await shot('90-marks-menu.png');
    await item('置顶');
    chk('pinned: it leads its machine', (await cardsOrder())[0].includes('第二个会话') && (await cardsOrder())[0].includes('置顶'), await cardsOrder());
    await menuFor('.dash .card', 'demo 会话'); await item('置顶');
    chk('two pinned: both lead', (await cardsOrder()).slice(0, 2).every((x) => x.includes('置顶')), await cardsOrder());
    await menuFor('.dash .card', 'demo 会话'); await item('取消置顶');
    chk('pinned on the server', (await marks()).sessions[K2].pinned === true, await marks());
    await menuFor('.dash .card', 'demo 会话'); await item('星标');
    chk('starred: a star on the card', (await cardsOrder()).find((x) => x.includes('demo 会话')).startsWith('★'), await cardsOrder());
    // only starred
    await menuFor('.dash .list .mc', 'box'); await item('只看星标');
    chk('only starred: one card left', (await cardsOrder()).length === 1 && (await cardsOrder())[0].includes('demo 会话'), await cardsOrder());
    const p0 = await rect('.dash .list .mc', 'box'); await mouse({ x: p0.x, y: p0.y + 200 }, 'right'); await item('只看星标');
    chk('only starred off again', (await cardsOrder()).length === 2, await cardsOrder());

    // a group, made from a session's submenu
    await menuFor('.dash .card', '第二个会话'); await hover('移到群组');
    chk('the group submenu opens', (await evalJs("document.querySelectorAll('.ctxm').length")) === 2, 0);
    await shot('91-marks-submenu.png');
    await item('新建群组');
    chk('a name dialog', await evalJs("!!document.querySelector('.dlg input')"), 0);
    await evalJs("(() => { const i = document.querySelector('.dlg input'); i.value = 'Windose 开发'; })()");
    await enter(); await sleep(900);
    let lt = await listText();
    chk('the group heads the list with the session in it', /^mc:Windose 开发 · 1 个活动 \| card:第二个会话/.test(lt), lt);
    chk('a card in a group names its machine', lt.includes('box'), lt);
    const g = (await marks()).groups[0];
    chk('the group on the server', g && g.name === 'Windose 开发' && (await marks()).sessions[K2].group === g.id, await marks());
    await shot('92-marks-group.png');
    // the other session into it through the submenu
    await menuFor('.dash .card', 'demo 会话'); await hover('移到群组'); await item('Windose 开发');
    lt = await listText();
    chk('both sessions in the group, the pinned one first; the machine section is gone', /^mc:Windose 开发 · 2 个活动 \| card:第二个会话.*\| card:★demo 会话/.test(lt) && !lt.includes('mc:box'), lt);
    // fold
    await rect('.dash .list .mc', 'Windose').then(mouse);
    chk('a click on the head folds the group', (await cardsOrder()).length === 0, await listText());
    await rect('.dash .list .mc', 'Windose').then(mouse);
    chk('and unfolds it', (await cardsOrder()).length === 2, await listText());
    // rename
    await menuFor('.dash .list .mc', 'Windose'); await item('重命名');
    await evalJs("(() => { const i = document.querySelector('.dlg input'); i.value = '个人小项目'; })()");
    await enter(); await sleep(900);
    chk('renamed', (await listText()).startsWith('mc:个人小项目'), await listText());
    // hide
    await menuFor('.dash .card', 'demo 会话'); await item('隐藏');
    lt = await listText();
    chk('hidden: the card is gone, a line offers to show it', !lt.includes('demo 会话') && lt.includes('显示已隐藏的 1 个会话'), lt);
    await rect('.dash .list .more', '显示已隐藏').then(mouse);
    chk('shown again, dimmed', await evalJs("!!document.querySelector('.dash .card.hid')"), await listText());
    await menuFor('.dash .card', 'demo 会话'); await item('取消隐藏');
    chk('unhidden', !(await listText()).includes('已隐藏'), await listText());
    // the marks survive a reload (kept on the server)
    await call('Page.reload'); await sleep(3500);
    lt = await listText();
    chk('after a reload: group, pin and star are still there', /^mc:个人小项目 · 2 个活动 \| card:第二个会话置顶.* \| card:★demo 会话/.test(lt), lt);
    // win98 look
    await evalJs("document.documentElement.dataset.theme = 'win98'");
    await menuFor('.dash .card', 'demo 会话'); await hover('移到群组'); await shot('93-marks-menu-win98.png');
    await key('Escape', 27); await sleep(200);
    chk('Escape closes the menu', (await evalJs("document.querySelectorAll('.ctxm').length")) === 0, 0);
    await evalJs("delete document.documentElement.dataset.theme");
    // delete the group: the sessions go back under their machine, the other marks stay
    await menuFor('.dash .list .mc', '个人小项目'); await item('删除群组');
    lt = await listText();
    chk('group deleted: sessions back under box, pin kept', /^mc:box · 2 个活动 \| card:第二个会话置顶/.test(lt), lt);

    // 活动 / 全部
    const segOn = () => evalJs("(document.querySelector('.dash .seg.on') || {}).textContent || ''");
    chk('活动 by default: the old session is not listed', (await segOn()) === '活动' && !(await listText()).includes('三天前'), await listText());
    await rect('.dash .seg', '全部').then(mouse); await sleep(300);
    lt = await listText();
    chk('全部: the old session is there, heads count 会话', lt.includes('box · 3 个会话') && (await cardsOrder()).length === 3, lt);
    await shot('97-view-all.png');
    await rect('.dash .seg', '活动').then(mouse); await sleep(300);
    chk('back to 活动', (await cardsOrder()).length === 2, await listText());
    // search: by name at once, by content from the server (with the passage), nothing found, Escape
    const search = async (t) => { await evalJs("document.querySelector('.dash .lsearch').focus()"); await evalJs(`(() => { const i = document.querySelector('.dash .lsearch'); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input')); })()`); };
    await search('第二个'); await sleep(100);
    chk('search by name: at once', (await cardsOrder()).length === 1 && (await cardsOrder())[0].includes('第二个会话') && !(await segOn()), await listText());
    await search('zebra42'); await sleep(150);
    chk('search by content: 搜索中 first', (await listText()).includes('搜索中'), await listText());
    await sleep(1200);
    lt = await listText();
    chk('search by content: the old session found, with its passage', (await cardsOrder()).length === 1 && lt.includes('zebra42') && lt.includes('1 个结果') && await evalJs("!!document.querySelector('.dash .card .sm.hit')"), lt);
    await shot('98-search.png');
    await search('没有这种词xyz'); await sleep(1200);
    chk('search: nothing found says so', (await listText()).includes('没有找到「没有这种词xyz」'), await listText());
    await key('Escape', 27); await sleep(300);
    chk('Escape clears the search: back to 活动', (await evalJs("document.querySelector('.dash .lsearch').value")) === '' && (await segOn()) === '活动' && (await cardsOrder()).length === 2, await listText());
    await search('zebra42'); await sleep(1200);
    await rect('.dash .seg', '全部').then(mouse); await sleep(300);
    chk('a view button ends the search', (await evalJs("document.querySelector('.dash .lsearch').value")) === '' && (await segOn()) === '全部', await listText());
    await call('Page.reload'); await sleep(3500);
    chk('the view is remembered', (await segOn()) === '全部' && (await cardsOrder()).length === 3, await listText());
    await evalJs("document.documentElement.dataset.theme = 'win98'"); await sleep(200); await shot('99-view-win98.png');
    await evalJs("delete document.documentElement.dataset.theme");
    await rect('.dash .seg', '活动').then(mouse); await sleep(300);
    // the keyboard in the menu: ↓ moves, → opens the submenu, ← back, Esc closes, Enter runs
    await menuFor('.dash .card', '第二个会话');
    await key('ArrowDown', 40); await key('ArrowDown', 40);
    const focused = () => evalJs("(document.activeElement && document.activeElement.closest('.ctxm') && document.activeElement.textContent) || ''");
    chk('keys: ↓↓ marks the second item', (await focused()).includes('取消置顶'), await focused());
    for (let i = 0; i < 3; i++) await key('ArrowDown', 40);
    chk('keys: on to 移到群组', (await focused()).includes('移到群组'), await focused());
    await key('ArrowRight', 39); await sleep(150);
    chk('keys: → opens the submenu, its first item marked', (await evalJs("document.querySelectorAll('.ctxm').length")) === 2 && (await focused()).length > 0, await focused());
    await key('ArrowLeft', 37); await sleep(150);
    chk('keys: ← back to the menu', (await evalJs("document.querySelectorAll('.ctxm').length")) === 1 && (await focused()).includes('移到群组'), await focused());
    await key('ArrowUp', 38); await key('ArrowUp', 38);
    chk('keys: ↑ to 星标', (await focused()).includes('星标'), await focused());
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(700);
    chk('keys: Enter runs it (starred) and closes', (await evalJs("document.querySelectorAll('.ctxm').length")) === 0 && (await cardsOrder()).some((x) => x.startsWith('★第二个会话')), await cardsOrder());
    await menuFor('.dash .card', '第二个会话'); await item('取消星标');
    // 导出
    const ex = await evalJs(`fetch('/api/session/export?machine=box&id=${SID}&fmt=md').then(async r => ({ s: r.status, cd: r.headers.get('content-disposition'), ct: r.headers.get('content-type'), b: await r.text() }))`);
    chk('export md: attachment named after the conversation, with details and the conversation', ex.s === 200 && ex.cd.startsWith('attachment; filename*=UTF-8') && ex.ct.startsWith('text/markdown') &&
      ex.b.startsWith('# ') && ex.b.includes('- 电脑：box') && ex.b.includes('claude --resume ' + SID) && ex.b.includes('### 我 · ') && ex.b.includes('先想想怎么改') && ex.b.includes('### Claude · ') && ex.b.includes('计划如下'), ex);
    const et = await evalJs(`fetch('/api/session/export?machine=box&id=${SID}&fmt=txt').then(r => r.text())`);
    chk('export txt: plain', et.includes('] 我：') && !et.includes('###') && et.includes('计划如下'), et.slice(0, 400));
    const nf = await new Promise((r) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/session/export?machine=box&id=nope', headers: { Cookie: cname + '=' + cval } }, (res) => { res.resume(); r(res.statusCode); }));
    chk('export: unknown session 404', nf === 404, nf);
    const DL = path.join(T, 'dl'); fs.mkdirSync(DL);
    await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
    await menuFor('.dash .card', 'demo 会话'); await hover('导出'); await item('Markdown');
    let got = [];
    for (let i = 0; i < 30 && !(got = fs.readdirSync(DL).filter((f) => f.endsWith('.md'))).length; i++) await sleep(200);
    chk('the menu downloads the .md file', got.length === 1 && fs.readFileSync(path.join(DL, got[0]), 'utf8').includes('计划如下'), [got, fs.readdirSync(DL)]);
    // a phone: a long press opens the menu and does not open the session
    await call('Emulation.setDeviceMetricsOverride', { width: 393, height: 851, deviceScaleFactor: 1, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await call('Page.reload'); await sleep(3500);
    const pp = await rect('.dash .card', 'demo 会话');
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pp.x, y: pp.y }] });
    await sleep(800);
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    chk('long press: the menu is open', (await evalJs("document.querySelectorAll('.ctxm').length")) === 1, 0);
    chk('long press: the session was not opened', !(await evalJs("document.querySelector('.dash').classList.contains('viewing')")), 0);
    await shot('94-marks-phone.png');
    // a phone sending a click where the finger lifts (right on the first item): it must not pick it
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: pp.x, y: pp.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pp.x, y: pp.y, button: 'left', clickCount: 1 });
    await sleep(200);
    chk('long press: the click as the finger lifts picks nothing', (await evalJs("document.querySelectorAll('.ctxm').length")) === 1 && !(await evalJs("document.querySelector('.dash').classList.contains('viewing')")), 0);
    await sleep(400);
    await item('星标');
    chk('the phone menu works', !(await cardsOrder()).find((x) => x.includes('demo 会话')).startsWith('★'), await cardsOrder());
    // ⋯ on each card (touch screens): a tap opens the same menu, the session stays closed
    chk('⋯ shown on a phone', await evalJs("getComputedStyle(document.querySelector('.dash .card .cm')).display !== 'none'"), 0);
    const dots = await evalJs("(() => { const c = [...document.querySelectorAll('.dash .card')].find(x => x.textContent.includes('demo 会话')).querySelector('.cm').getBoundingClientRect(); return { x: c.left + c.width / 2, y: c.top + c.height / 2 }; })()");
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: dots.x, y: dots.y }] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    const dm = await evalJs("[...document.querySelectorAll('.ctxm .ctxi')].map(e => e.textContent)");
    chk('⋯: the session\'s menu, the session not opened', dm.some((x) => x.includes('移到群组')) && !(await evalJs("document.querySelector('.dash').classList.contains('viewing')")), dm);
    await shot('94b-marks-phone-dots.png');
    // what a real phone sends around a tap -- "resize" (its address bar, the keyboard) and "blur" -- is no reason to
    // close the menu; the page really turning, or going out of sight, is
    await evalJs("(() => { dispatchEvent(new Event('resize')); dispatchEvent(new Event('blur')); })()"); await sleep(200);
    chk('a phone\'s "resize" and "blur" around the tap do not close the menu', (await evalJs("document.querySelectorAll('.ctxm').length")) === 1, 0);
    await sleep(900);
    await evalJs("(() => { dispatchEvent(new Event('resize')); dispatchEvent(new Event('blur')); })()"); await sleep(200);
    chk('... nor later, while the window has not really changed', (await evalJs("document.querySelectorAll('.ctxm').length")) === 1, 0);
    chk('the menu is on the screen, whole', await evalJs("(() => { const r = document.querySelector('.ctxm').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && getComputedStyle(document.querySelector('.ctxm')).visibility === 'visible'; })()"), 0);
    await call('Emulation.setDeviceMetricsOverride', { width: 851, height: 393, deviceScaleFactor: 1, mobile: true }); await sleep(500);
    chk('the phone turned on its side: the menu closes', (await evalJs("document.querySelectorAll('.ctxm').length")) === 0, 0);
    await call('Emulation.setDeviceMetricsOverride', { width: 393, height: 851, deviceScaleFactor: 1, mobile: true }); await sleep(500);
    // a pressed card: our own colour (the phone's blue flash is off), and no hover colour left behind by a finger
    chk('a card pressed with a finger: the phone\'s own flash is off', await evalJs("getComputedStyle(document.querySelector('.dash .card')).webkitTapHighlightColor === 'rgba(0, 0, 0, 0)'"), await evalJs("getComputedStyle(document.querySelector('.dash .card')).webkitTapHighlightColor"));
    await key('Escape', 27); await sleep(200);
    const pq = await rect('.dash .card', '第二个会话');
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pq.x, y: pq.y }] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(600);
    chk('a short tap still opens the session', await evalJs("document.querySelector('.dash').classList.contains('viewing')"), 0);
    // the header on a phone: the title on its own line (the whole width), machine / project / 摘要 under it
    await sleep(500);
    const hd = await evalJs("(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const t = r('.dash .head b'), m = r('.dash .head .hr'), h = r('.dash .head'); return { tTop: t.top, tBottom: t.bottom, mTop: m.top, tWidth: t.width, hWidth: h.width, text: document.querySelector('.dash .head b').textContent }; })()");
    chk('phone header: the title on a line of its own, the details under it', hd.mTop >= hd.tBottom - 1, hd);
    // the reply box on a phone: a line of its own, the whole width; ⌨, the mode and 发送 on the line under it
    const lay = await evalJs("(() => { const r = (q) => { const e = document.querySelector(q); const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, hidden: e.hidden || getComputedStyle(e).display === 'none' }; }; return { box: r('.dash .compose'), say: r('.dash .say'), send: r('.dash .compose .btn.go'), mode: r('.dash .compose .mode'), kbd: r('.dash .compose .kbd') }; })()");
    chk('phone: the reply box takes the whole width, the buttons sit on the line under it (发送 at the right)', lay.say.w >= lay.box.w - 24 && lay.send.t >= lay.say.b - 1 && lay.send.r >= lay.box.r - 14 &&
      (lay.kbd.hidden || lay.kbd.t >= lay.say.b - 1) && (lay.mode.hidden || lay.mode.t >= lay.say.b - 1), lay);
    await shot('94c-marks-phone-compose.png');
    // a phone's back gesture (js/backnav.js) goes back inside Windose first: conversation -> list -> desktop
    const nav = () => evalJs("({ viewing: document.querySelector('.dash').classList.contains('viewing'), min: [...document.querySelectorAll('.win')].find(w => w.querySelector('.dash')).classList.contains('minimized'), at: location.pathname })");
    const tapCard = async (t) => { const r = await rect('.dash .card', t); await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] }); await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(600); };
    let nv = await nav();
    chk('(a conversation is open on the phone)', nv.viewing && !nv.min, nv);
    await evalJs('history.back()'); await sleep(500); nv = await nav();
    chk('back: from the conversation to the list (the window stays, the page stays)', !nv.viewing && !nv.min && nv.at === '/', nv);
    // back inside the page by its own button, then the gesture: straight to the desktop, not a step that does nothing
    await tapCard('第二个会话'); nv = await nav();
    chk('(opened again)', nv.viewing, nv);
    await evalJs("document.querySelector('.dash .back').click()"); await sleep(500);
    chk('‹ 返回: the list', !(await nav()).viewing, await nav());
    await evalJs('history.back()'); await sleep(500); nv = await nav();
    chk('back from the list: to the desktop (the window put away to the taskbar), still on the page', nv.min && nv.at === '/', nv);
    // the window brought back from the taskbar is a level again
    await evalJs("document.querySelector('#dock .dockbtn').click()"); await sleep(500);
    await tapCard('第二个会话');
    await evalJs('history.back()'); await sleep(400); await evalJs('history.back()'); await sleep(500); nv = await nav();
    chk('opened again from the taskbar: back twice -- list, then desktop', !nv.viewing && nv.min && nv.at === '/', nv);
    // the other windows with a list and an item (控制面板, 记事本 ...): back shows the list again, then puts the window away
    const openIcon = async (t) => { await evalJs(`[...document.querySelectorAll('.dicon')].find(b => b.textContent.includes('${t}')).click()`); await sleep(1200); };
    const winOf = (sel) => evalJs(`(() => { const r = document.querySelector('${sel}'); const w = r && r.closest('.win'); return w ? { there: true, min: w.classList.contains('minimized'), cls: r.className } : { there: false }; })()`);
    await openIcon('控制面板');
    let cpw = await winOf('.cp');
    chk('控制面板 on the phone: it opens on its first item', cpw.there && /narrow/.test(cpw.cls) && /picked/.test(cpw.cls), cpw);
    await evalJs('history.back()'); await sleep(500); cpw = await winOf('.cp');
    chk('back: 控制面板 的 icons, the window stays', !/picked/.test(cpw.cls) && !cpw.min, cpw);
    await evalJs("[...document.querySelectorAll('.cp-item')].find(b => b.textContent.includes('声音')).click()"); await sleep(600);
    chk('(an item opened)', /picked/.test((await winOf('.cp')).cls), await winOf('.cp'));
    await evalJs('history.back()'); await sleep(500); cpw = await winOf('.cp');
    chk('back: from the item to 控制面板 的 icons, the window stays', !/picked/.test(cpw.cls) && !cpw.min, cpw);
    await evalJs("[...document.querySelectorAll('.cp-item')].find(b => b.textContent.includes('声音')).click()"); await sleep(500);
    await evalJs("document.querySelector('.cp-back').click()"); await sleep(500);
    await evalJs('history.back()'); await sleep(500); cpw = await winOf('.cp');
    chk('its own ‹ button, then back: the window is put away (no step that does nothing)', cpw.min && (await nav()).at === '/', cpw);
    await openIcon('记事本');
    await evalJs("[...document.querySelectorAll('.notepad .btn')].find(b => /新/.test(b.textContent)).click()"); await sleep(600);
    let npw = await winOf('.notepad');
    chk('记事本: a note open', npw.there && /editing/.test(npw.cls), npw);
    await evalJs('history.back()'); await sleep(500); npw = await winOf('.notepad');
    chk('back: the list of notes', !/editing/.test(npw.cls) && !npw.min, npw);
    await evalJs('history.back()'); await sleep(500); npw = await winOf('.notepad');
    chk('back again: 记事本 put away, the desktop', npw.min && (await nav()).at === '/', npw);
    // at the desktop one more back would leave the page: asked first (the gesture is easily made by accident)
    const box = () => evalJs("(() => { const b = document.querySelector('.dlgmsg'); return b ? b.querySelector('.dlgtx').textContent + ' [' + [...b.querySelectorAll('.dlga .btn')].map(x => x.textContent).join('|') + ']' : ''; })()");
    await evalJs('history.back()'); await sleep(600);
    chk('back at the desktop: asked whether to leave, still on the page', /要离开 Windose 吗/.test(await box()) && /离开|留下/.test(await box()) && (await nav()).at === '/', [await box(), await nav()]);
    await evalJs("[...document.querySelectorAll('.dlgmsg .dlga .btn')].find(b => b.textContent === '留下').click()"); await sleep(400);
    chk('留下: the question gone, still here', (await box()) === '' && (await nav()).at === '/', [await box(), await nav()]);
    await evalJs('history.back()'); await sleep(600);
    chk('back again: asked again (staying did not use the question up)', /要离开 Windose 吗/.test(await box()), await box());
    await evalJs("setTimeout(() => [...document.querySelectorAll('.dlgmsg .dlga .btn')].find(b => b.textContent === '离开').click(), 50)");   // (the page goes away under the call otherwise)
    let gone = false; for (let i = 0; i < 30 && !gone; i++) { await sleep(200); try { gone = (await evalJs('location.pathname + location.protocol')) !== '/http:'; } catch {} }
    chk('离开: the page is left', gone, 0);
    await shot('95b-phone-header.png');
    const unauth = await new Promise((r) => http.get(`http://127.0.0.1:${PORT}/api/session/export?machine=box&id=${SID}`, (res) => { res.resume(); r(res.statusCode); }));
    chk('export: not logged in refused', unauth === 401, unauth);
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
