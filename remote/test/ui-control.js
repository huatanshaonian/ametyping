// UI check (控制面板): one window for every setting -- the items with their icons, each page inside it, the old ways in
// (start menu, the calendar's 「连接 Google 日历」, 邮件's 设置) landing on the right page, AI 模型 (models from fake
// Codex and Claude Code caches, a change saved, the backup), the phone (icons first, then the page, and back). Shots in test/out/shots/8x-control-*.png.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uictl-'));
const PORT = 18890, CDP = 9343, API = 18891;
const memoryApi=http.createServer((req,res)=>{
  if(req.method==='GET'){res.setHeader('Content-Type','application/json');return res.end('{"data":[{"id":"fixture"}]}');}
  let body='';req.on('data',d=>body+=d);req.on('end',()=>{
    const output={summary:'界面 API 整理建议',groups:[{title:'整理所选记忆',category:'rewrite',reason:'保留原有事实并改善表达',operations:[{action:'update',target:'item1',scope:'global',owner:'',name:'界面 AI 整理',body:'API 建议正文 🌈'}]}]};
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('event: content_block_delta\ndata: '+JSON.stringify({delta:{type:'text_delta',text:JSON.stringify(output)}})+'\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n');
  });
}).listen(API,'127.0.0.1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const HOME = path.join(T, 'codexhome'); fs.mkdirSync(HOME);
const lv = (...e) => e.map((x) => ({ effort: x }));
fs.writeFileSync(path.join(HOME, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier intelligence', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), default_reasoning_level: 'low', visibility: 'list' },
  { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', description: 'Previous generation workhorse', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), default_reasoning_level: 'medium', visibility: 'list' },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Fast and affordable', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max'), default_reasoning_level: 'medium', visibility: 'list' }] }));
fs.writeFileSync(path.join(HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'SECRET' }, last_refresh: '2026-09-28T20:01:56Z' }));
const env = { ...process.env, HOME, USERPROFILE: HOME, AME_CC_HOME: path.join(T, 'cc-environments'),
  AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000' };
cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
// Claude Code: no catalog of its own yet (its main models offered), a fake that is logged in
const CHOME = path.join(T, 'claudehome'); fs.mkdirSync(CHOME);
cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')], codexHome: HOME,
  claude: [process.execPath, path.join(__dirname, 'fake-claude.js')], claudeHome: CHOME,claudeApiBase:'http://127.0.0.1:'+API };
fs.writeFileSync(CFG, JSON.stringify(cfg));
fs.mkdirSync(path.join(T, 'srv', 'data'), { recursive: true });
fs.writeFileSync(path.join(T, 'srv', 'data', 'codex-check.json'), JSON.stringify({ version: '0.160.0', at: Date.now() - 2 * 86400e3, error: '' }));

const getJSON = (url, method = 'GET') => new Promise((resolve, reject) => { const r = http.request(url, { method }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.end(); });
function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0].split('=')); });
    req.end(body);
  });
}

(async () => {
  const errors = [], res = [];
  const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  let chrome;
  try {
    for (let n = 0; n < 60; n++) { if (await new Promise((ok) => http.get(`http://127.0.0.1:${PORT}/`, (r) => { r.resume(); ok(true); }).on('error', () => ok(false)))) break; await sleep(250); }
    const [cname, cval] = await login();
    chrome = cp.spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${path.join(T, 'chrome')}`, '--no-first-run', '--no-proxy-server', 'about:blank'], { stdio: 'ignore' });
    let debugReady=false;
    for(let n=0;n<100;n++){try{await getJSON(`http://127.0.0.1:${CDP}/json/version`);debugReady=true;break;}catch{await sleep(100);}}
    if(!debugReady)throw new Error('isolated Chrome debugging endpoint did not start');
    const tab = await getJSON(`http://127.0.0.1:${CDP}/json/new?about:blank`, 'PUT');
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
    let id = 0; const pending = new Map();
    ws.on('message', (m) => {
      const o = JSON.parse(m);
      if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); }
      if (o.method === 'Runtime.exceptionThrown') errors.push('exception: ' + JSON.stringify(o.params.exceptionDetails).slice(0, 1000));
      if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push('console: ' + o.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error') errors.push('log: ' + o.params.entry.text.slice(0, 300) + ' ' + (o.params.entry.url || ''));
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    const winTitle = () => evalJs("[...document.querySelectorAll('.win .title')].map(t => t.textContent).join('|')");
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    const desk = await evalJs("[...document.querySelectorAll('.dicon')].map(b => b.textContent).join('|')");
    const menu = await evalJs("[...document.querySelectorAll('#startmenu .smi')].map(b => b.textContent).join('|')");
    chk('desktop and start menu: 控制面板 in, the separate settings out', /控制面板/.test(desk) && !/显示属性/.test(desk) && /控制面板/.test(menu) &&
      !/添加电脑|Google 账户|声音/.test(menu) && /重要计划/.test(menu) && /网上邻居/.test(menu), [desk, menu]);
    // 网上邻居 on a wide screen: there at the right; » puts it away (the desktop takes the room, remembered), the tray's button brings it back
    const netState = () => evalJs("({ panel: document.querySelector('#netpanel').getBoundingClientRect().width, desk: document.querySelector('#desktop').getBoundingClientRect().width, btn: getComputedStyle(document.querySelector('#netbtn')).display, kept: localStorage.getItem('ame.net.off') })");
    const n0 = await netState();
    await evalJs("document.querySelector('#hidepc').click()"); const n1 = await netState();
    await evalJs("document.querySelector('#netbtn').click()"); const n2 = await netState();
    chk('网上邻居 can be put away on a wide screen and brought back from the tray', n0.panel > 200 && n0.btn === 'none' && n1.panel === 0 && n1.desk > n0.desk + 200 && n1.btn !== 'none' && n1.kept === 'true' &&
      n2.panel === n0.panel && n2.desk === n0.desk && n2.kept === 'false', [n0, n1, n2]);
    await evalJs("[...document.querySelectorAll('.dicon')].find(b => b.textContent.includes('控制面板')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"); await sleep(1500);
    const items = await evalJs("[...document.querySelectorAll('.cp-item .cp-l')].map(b => b.textContent).join('|')");
    chk('控制面板: the ten items with their icons; the first one open beside them', items === '显示属性|声音|通知|电脑|Google 账户|邮箱|AI 模型|Claude Code API|记忆与存档|文献' &&
      (await evalJs("document.querySelectorAll('.cp-item img').length")) === 10 && (await evalJs("!!document.querySelector('.cp-pane .walls')")), items);
    await shot('80-control-display.png');
    for (const [label, sel, txt] of [['声音', '.sounds', '全部静音'], ['通知', '.nt', '收通知的设备'], ['电脑', '.computers', '已登记的电脑'], ['Google 账户', '.gacc', '授权客户端'], ['邮箱', '.mla', '添加邮箱'], ['Claude Code API', '.capi-form', '刷新电脑配置'], ['AI 模型', '.aim', '默认']]) {
      await evalJs(`[...document.querySelectorAll('.cp-item')].find(b => b.textContent.includes('${label}')).click()`); await sleep(900);
      chk(`控制面板 → ${label}: the page inside, the title says so`, (await evalJs(`(document.querySelector('.cp-pane ${sel}') || {}).textContent || ''`)).includes(txt) && (await winTitle()).includes('控制面板 - ' + label),
        [await winTitle(), await evalJs("document.querySelector('.cp-pane').textContent.slice(0, 120)")]);
    }
    // AI 模型: the models of both accounts (Claude's, then OpenAI's), efforts per model, a change saved, the backup;
    // both tools' state
    await sleep(800);
    const ai = await evalJs("(() => { const s = [...document.querySelectorAll('.aim-row select')]; return { rows: document.querySelectorAll('.aim-row').length, models: [...s[0].options].map(o => o.value).join(), groups: [...s[0].querySelectorAll('optgroup')].map(g => g.label).join('|'), codex: document.querySelector('.aim-cli[data-tool=codex]').textContent, claude: document.querySelector('.aim-cli[data-tool=claude]').textContent }; })()");
    chk('AI 模型: default + backup rows and the thirteen jobs, both accounts\' models grouped, Codex and Claude Code version / newest / login', ai.rows === 15 &&
      ai.models === ',claude-opus-5-5,claude-fable-5-1,claude-sonnet-5-5,claude-haiku-4-5-20251001,gpt-6-astra,gpt-6-sol,gpt-6-luna' && ai.groups === 'Claude|OpenAI（Codex）' &&
      /2\.1\.288/.test(ai.claude) && /已登录（Claude 账号 · Max 订阅）/.test(ai.claude) &&
      /0\.158\.0/.test(ai.codex) && /0\.160\.0（有新版本）/.test(ai.codex) && /已登录（ChatGPT 账号）/.test(ai.codex) && !/SECRET/.test(ai.codex), ai);
    const api = await evalJs("(() => { const b = document.querySelector('.aim-cli[data-tool=api]'); return { text: b.textContent, field: b.querySelector('input.aim-key').type, btns: [...b.querySelectorAll('button')].map(x => x.textContent).join() }; })()");
    chk('AI 模型: the Claude API -- no key yet: a field for one (not shown as typed), how to get the credit', /还没填/.test(api.text) && /API 赠金/.test(api.text) && api.field === 'password' && api.btns === '保存', api);
    await evalJs("(() => { const row = [...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')); const [m] = row.querySelectorAll('select'); m.value = 'gpt-6-astra'; m.dispatchEvent(new Event('change')); })()"); await sleep(300);
    const efforts = await evalJs("[...[...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')).querySelectorAll('select')[1].options].map(o => o.value).join()");
    await evalJs("(() => { const row = [...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')); const e = row.querySelectorAll('select')[1]; e.value = 'xhigh'; e.dispatchEvent(new Event('change')); })()");
    await sleep(1500);
    const saved = await evalJs("fetch('/api/ai').then(r => r.json()).then(v => JSON.stringify(v.tasks.find(t => t.id === 'ask').set))");
    const uses = await evalJs("[...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')).querySelector('.aim-uses').textContent");
    chk('a job set on its own: the efforts that model has, saved, what it will use shown', efforts === ',low,medium,high,xhigh,max,ultra' && /GPT-6-Astra · 很高/.test(uses) && saved === '{"model":"gpt-6-astra","effort":"xhigh"}', [efforts, uses, saved]);
    // the backup: Opus 5.5 picked in its row -> saved, every job says what it falls back to
    await evalJs("(() => { const m = document.querySelector('.aim-bak select'); m.value = 'claude-opus-5-5'; m.dispatchEvent(new Event('change')); })()"); await sleep(1500);
    const bak = await evalJs("fetch('/api/ai').then(r => r.json()).then(v => JSON.stringify(v.backup))");
    const uses2 = await evalJs("[...document.querySelectorAll('.aim-uses')].map(e => e.textContent)");
    chk('后备模型: picked, saved, each job shows it', bak === '{"model":"claude-opus-5-5","effort":""}' && uses2.length === 13 && uses2.every((t) => /出错时改用 Opus 5\.5/.test(t)), [bak, uses2]);
    await shot('81-control-ai.png');
    // Claude Code API: a configured key must show as set (the row check used to pass the env object to a helper that
    // expected a settings object, always showing 未设置)
    const capi = await evalJs("fetch('/api/claude-apis/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({machine:'nas',profile:{id:'deepseek',baseUrl:'https://deepseek.example',model:'deepseek-flash[1m]',key:'sk-ui-test',network:'direct'}})}).then(r=>r.json())");
    await evalJs("[...document.querySelectorAll('.cp-item')].find(b => b.textContent.includes('Claude Code API')).click()"); await sleep(900);
    const capiShown = await evalJs("(document.querySelector('.capi-token') || {}).textContent || ''");
    chk('Claude Code API: a configured key shows as set, not 密钥未设置', capi.ok === true && capiShown === '密钥已设置', [capi, capiShown]);
    await evalJs("document.querySelector('.capi-row .btn').click()");
    const editor = await evalJs("(() => { const f=document.querySelector('.capi-editor'), x=f.querySelectorAll('input'); return {shown:!f.hidden,id:x[0].value,model:x[2].value,keyType:x[3].type,keyValue:x[3].value}; })()");
    chk('profile editor shows the local default model and an empty password field', editor.shown && editor.id === 'deepseek' && editor.model === 'deepseek-flash[1m]' && editor.keyType === 'password' && editor.keyValue === '', editor);
    await evalJs("(() => { const f=document.querySelector('.capi-editor'); f.querySelectorAll('input')[2].value='deepseek-ui[1m]'; f.requestSubmit(); })()");
    await sleep(900);
    const savedProfile = await evalJs("fetch('/api/claude-apis?machine=nas').then(r=>r.json()).then(v=>({model:v.profiles[0].model,hasCredential:v.profiles[0].hasCredential,raw:JSON.stringify(v)}))");
    chk('saving through the editor changes the local model and preserves the blank key without echoing it', savedProfile.model === 'deepseek-ui[1m]' && savedProfile.hasCredential && !savedProfile.raw.includes('sk-ui-test'), savedProfile.model);
    await evalJs("[...document.querySelectorAll('.cp-item')].find(b=>b.textContent.includes('记忆与存档')).click()");await sleep(900);
    chk('记忆与存档 opens with SQLite status and scope management',await evalJs("document.querySelector('.knowledge').textContent.includes('NAS SQLite') && document.querySelector('.knowledge').textContent.includes('共享全局')"));
    await evalJs("[...document.querySelectorAll('.knowledge button')].find(b=>b.textContent==='新增记忆').click();document.querySelector('.knowledge-editor input[placeholder=记忆名称]').value='界面记忆';document.querySelector('.knowledge-body').value='中文与 emoji 🌈';document.querySelector('.knowledge-editor').requestSubmit()");await sleep(900);
    chk('memory form publishes Unicode text to SQLite',await evalJs("fetch('/api/knowledge').then(r=>r.json()).then(d=>d.memories.some(m=>m.name==='界面记忆'&&m.body==='中文与 emoji 🌈'))"));
    await evalJs("[...document.querySelectorAll('.knowledge-fact button')].find(b=>b.textContent==='编辑').click()");
    chk('editing an existing memory preloads its complete body',await evalJs("document.querySelector('.knowledge-editor textarea').value==='中文与 emoji 🌈'"));
    await evalJs("[...document.querySelectorAll('.knowledge-editor button')].find(b=>b.textContent==='取消').click()");
    await evalJs("fetch('/api/knowledge/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'global',owner:'',name:'界面副本',body:'中文与 emoji 🌈'})})");
    await evalJs("[...document.querySelectorAll('.knowledge button')].find(b=>b.textContent==='刷新').click()");await sleep(500);
    await evalJs("(() => {const s=document.querySelector('.knowledge input[placeholder=\"搜索名称、正文或归属\"]');s.value='副本';s.dispatchEvent(new Event('input'));})()");
    chk('memory list supports body/name search and per-entry content',await evalJs("document.querySelectorAll('.knowledge-fact').length===1 && document.querySelector('.knowledge-fact').textContent.includes('中文与 emoji 🌈')"));
    await evalJs("(() => {const s=document.querySelector('.knowledge input[placeholder=\"搜索名称、正文或归属\"]');s.value='';s.dispatchEvent(new Event('input'));[...document.querySelectorAll('.knowledge button')].find(b=>b.textContent==='勾选当前列表').click();[...document.querySelectorAll('.knowledge button')].find(b=>b.textContent==='对齐所选').click();})()");await sleep(500);
    await evalJs("[...document.querySelectorAll('.knowledge-review button')].find(b=>b.textContent==='核对所选原文').click()");await sleep(500);
    chk('alignment compares selected entries with full originals and duplicate evidence',await evalJs("document.querySelector('.knowledge-review').textContent.includes('100%') && document.querySelector('.knowledge-review').textContent.includes('正文相同') && document.querySelectorAll('.knowledge-diff').length===2"));
    await evalJs("fetch('/api/ai/api/key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'sk-ant-memory-ui-fixture-1234567890'})}).then(r=>r.json())");
    await evalJs("[...document.querySelectorAll('.knowledge button')].find(b=>b.textContent==='对齐与智能整理').click()");await sleep(500);
    await evalJs("[...document.querySelectorAll('.knowledge-review button')].find(b=>b.textContent==='智能整理所选').click()");
    for(let n=0;n<80;n++){if(await evalJs("document.querySelectorAll('.knowledge-proposal').length===1"))break;await sleep(100);}
    const proposalState=await evalJs("({count:document.querySelectorAll('.knowledge-proposal').length,body:document.querySelector('.knowledge-proposal textarea')?.value,checked:document.querySelector('.knowledge-proposal input[type=checkbox]')?.checked})");
    chk('API smart analysis creates an editable proposal without publishing it',proposalState.count===1&&proposalState.body==='API 建议正文 🌈'&&!proposalState.checked&&await evalJs("fetch('/api/knowledge').then(r=>r.json()).then(d=>!d.memories.some(m=>m.name==='界面 AI 整理'))"),proposalState);
    await shot('85-control-memory-review.png');
    await evalJs("document.querySelector('.knowledge-proposal textarea').value='人工审阅后的正文 🌈';document.querySelector('.knowledge-proposal input[type=checkbox]').click();[...document.querySelectorAll('.knowledge-review button')].find(b=>b.textContent==='应用勾选分组').click()");await sleep(800);
    chk('only selected proposal groups apply and preserve the human edit and provenance',await evalJs("fetch('/api/knowledge').then(r=>r.json()).then(d=>d.memories.some(m=>m.name==='界面 AI 整理'&&m.body==='人工审阅后的正文 🌈'&&m.source.startsWith('memory-review:')))")&&await evalJs("document.querySelector('.knowledge-review').textContent.includes('已应用')"));
    await evalJs("[...document.querySelectorAll('.knowledge button')].find(b=>b.textContent==='完整会话').click()");await sleep(400);
    chk('full archive panel explains completeness and download boundaries',await evalJs("document.querySelector('.knowledge').textContent.includes('原生会话按字节保存')"));
    await shot('84-control-knowledge.png');
    // the old ways in land on their page
    await evalJs("(async () => (await import('/js/apps/calendar.js')).open())()"); await sleep(1500);
    await evalJs("[...document.querySelectorAll('.cal-g .rs-link')].find(b => b.textContent.includes('连接 Google')).click()"); await sleep(1200);
    chk('the calendar\'s 「连接 Google 日历」 opens 控制面板 → Google 账户', (await winTitle()).includes('控制面板 - Google 账户'), await winTitle());
    await evalJs("(async () => (await import('/js/apps/mail.js')).open())()"); await sleep(1200);
    await evalJs("[...document.querySelectorAll('.ml-bar .btn')].find(b => b.textContent === '设置').click()"); await sleep(1200);
    chk('邮件\'s 设置 opens 控制面板 → 邮箱 (one 控制面板 window)', (await winTitle()).includes('控制面板 - 邮箱') && (await evalJs("document.querySelectorAll('.cp').length")) === 1, await winTitle());
    // a window brought to the front many times (a page left open for days) still stays under the menus and message boxes
    const over = await evalJs(`(async () => {
      const wm = await import('/js/wm.js'), menu = await import('/js/ctxmenu.js');
      const el = document.querySelector('.win:not(.minimized)'), r = el.getBoundingClientRect();
      for (let n = 0; n < 400; n++) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      menu.show(x, y, [{ label: '一' }, { label: '二' }]);
      const m = document.querySelector('.ctxm').getBoundingClientRect();
      const hit = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2);
      const bar = document.querySelector('#taskbar').getBoundingClientRect();
      const out = { z: +el.style.zIndex, menu: !!(hit && hit.closest('.ctxm')), layer: getComputedStyle(document.querySelector('#windows')).zIndex };
      menu.close();
      return out;
    })()`);
    chk('a window focused 400 times is still under a right-click menu opened over it', over.z > 300 && over.menu, over);
    // phone: icons first, then the page with a way back
    await evalJs("[...document.querySelectorAll('.win')].forEach(w => { const t = w.querySelector('.title'); if (t && !t.textContent.startsWith('控制面板')) w.querySelector('.tbtn.close').click(); })"); await sleep(300);
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
    await sleep(1000);
    await evalJs("document.querySelector('.cp-back').click()"); await sleep(500);
    chk('phone: the icons first', await evalJs("getComputedStyle(document.querySelector('.cp-nav')).display !== 'none' && getComputedStyle(document.querySelector('.cp-main')).display === 'none'"), 0);
    await shot('82-control-phone.png');
    await evalJs("[...document.querySelectorAll('.cp-item')].find(b => b.textContent.includes('AI 模型')).click()"); await sleep(1200);
    chk('phone: an item fills the window, with ‹ 控制面板 to go back', await evalJs("getComputedStyle(document.querySelector('.cp-nav')).display === 'none' && getComputedStyle(document.querySelector('.cp-back')).display !== 'none' && !!document.querySelector('.cp-pane .aim')"), 0);
    await shot('83-control-phone-ai.png');
    ws.close();
  } catch (e) { errors.push('test: ' + e.stack); }
  finally { try { chrome && chrome.kill(); } catch {} srv.kill();memoryApi.close(); }
  for (const r of res) console.log(r);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  await sleep(800);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(res.some((r) => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})();
