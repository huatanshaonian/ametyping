// UI check (壳层 + 6项控制面板 + 设备与算力中心 + AI与额度5-Tab中心 + 兼容路由):
// 11图标桌面、额外桌面图标复选框、四段级联开始菜单、6项纯净控制面板、control.open 旧 ID 100% 转发、
// Fleet + NAS CLI、AI 模型与全局模型池、MCP、Skill 与角色库、OpenCode 生成器 + 复活 claude-apis、记忆与存档、手机端自适应。
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = process.env.AME_CONTROL_UI_OUT || path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uictl-'));
const PORT = 18890, CDP = 9343, API = 18891;
const guiMerged = fs.existsSync(path.join(R, 'public', 'css', 'tokens.css'));
const pendingIconRe = /\/icons\/(catalog|network_three_pcs|network_drive_world|world|key_world|search_file_2|help_book_computer|script_file_teal|tools_gear|magnifying_glass|users|clock)(-16)?\.png(\?|$)/;

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
const CHOME = path.join(T, 'claudehome'); fs.mkdirSync(CHOME);
cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')], codexHome: HOME,
  claude: [process.execPath, path.join(__dirname, 'fake-claude.js')], claudeHome: CHOME,claudeApiBase:'http://127.0.0.1:'+API };
const MAGPIE = 18892;
const magpieSrv = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [
    { id: 'group/opus-main', magpie_label: 'opus-main · routing group', owned_by: 'kiro', context_window: 1000000, max_output_tokens: 128000, reasoning_levels: ['low', 'medium', 'high'], tool_call: true },
    { id: 'devin/swe-2', magpie_label: 'SWE-2 · Devin', owned_by: 'devin', context_window: 262000, max_input_tokens: 262000, max_output_tokens: 128000, native_endpoints: ['/v1/chat/completions'], modalities: { input: ['text', 'image'] }, reasoning_levels: ['medium', 'high', 'max'], tool_call: true },
    { id: 'cc-ubuntu/claude/claude-fable-5-2', magpie_label: 'Claude Fable 5.2 · Claude Code · cc-ubuntu', owned_by: 'cc-ubuntu', context_window: 1000000, max_output_tokens: 128000, native_endpoints: ['/v1/messages'], modalities: { input: ['text', 'image', 'pdf'] }, reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'], tool_call: true },
    { id: 'auto/claude-opus-5-5', magpie_label: 'Claude Opus 5.5 · routing group', owned_by: 'cc-ubuntu', context_window: 1000000, max_output_tokens: 128000, tool_call: true },
  ] }));
  if (req.url === '/v1/magpie/quotas') return res.end('{"data":[]}');
  if (req.url.startsWith('/v1/magpie/usage')) return res.end('{}');
  res.writeHead(404); res.end('{}');
}).listen(MAGPIE, '127.0.0.1');
cfg.magpie = { baseURL: 'http://127.0.0.1:' + MAGPIE + '/v1' };
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
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error') {
        const u = o.params.entry.url || '';
        if (!guiMerged && pendingIconRe.test(u)) return;
        errors.push('log: ' + o.params.entry.text.slice(0, 300) + ' ' + u);
      }
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    const winTitle = () => evalJs("[...document.querySelectorAll('.win .title')].map(t => t.textContent).join('|')");
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    const downloadDir=path.join(OUT,'downloads');fs.mkdirSync(downloadDir,{recursive:true});
    await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir});
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    // 1. 11 core desktop icons + 4-section cascading Start Menu
    const desk = await evalJs("[...document.querySelectorAll('.dicon')].map(b => b.textContent).join('|')");
    chk('11 curated core desktop icons (no duplicate Skill 与协同 or separate Word/Excel/PPT)',
      desk === '糖糖看板|项目管理|设备与算力|AI 与额度|文献|记忆与存档|工作日报|日历|邮件|我的电脑|控制面板', desk);

    await evalJs("document.getElementById('startbtn').click()"); await sleep(200);
    await evalJs("(() => { const p = [...document.querySelectorAll('#startmenu .mitem.has-sub')].find(x => x.textContent.includes('办公与附件')); p && p.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); })()");
    await sleep(200);
    const startState = await evalJs("({ subs: [...document.querySelectorAll('#startmenu .mitem.has-sub > .smi > span:first-of-type')].map(s => s.textContent).join('|'), openSub: [...document.querySelectorAll('#startmenu .mitem.has-sub.open .msub .mitem')].map(b => b.textContent).join('|'), allText: document.getElementById('startmenu').textContent })");
    chk('4-section cascading Start Menu with expandable submenus',
      startState.subs === '日历与计划|办公与附件|控制面板' && /Office 文档/.test(startState.openSub) && /记事本/.test(startState.openSub) && /设备与算力/.test(startState.allText) && /AI 与额度/.test(startState.allText),
      startState);
    await shot('80-desktop-startmenu.png');
    await evalJs("document.getElementById('startbtn').click()"); await sleep(150);

    // 2. 网上邻居 hide/restore
    const netState = () => evalJs("({ panel: document.querySelector('#netpanel').getBoundingClientRect().width, desk: document.querySelector('#desktop').getBoundingClientRect().width, btn: getComputedStyle(document.querySelector('#netbtn')).display, kept: localStorage.getItem('ame.net.off') })");
    const n0 = await netState();
    await evalJs("document.querySelector('#hidepc').click()"); const n1 = await netState();
    await evalJs("document.querySelector('#netbtn').click()"); const n2 = await netState();
    chk('网上邻居 can be put away on a wide screen and brought back from the tray', n0.panel > 200 && n0.btn === 'none' && n1.panel === 0 && n1.desk > n0.desk + 200 && n1.btn !== 'none' && n1.kept === 'true' &&
      n2.panel === n0.panel && n2.desk === n0.desk && n2.kept === 'false', [n0, n1, n2]);

    // 3. Slimmed 6-item Control Panel + optional desktop icon checkboxes in 显示属性
    await evalJs("document.querySelector('.dicon[data-id=control]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"); await sleep(1200);
    const items = await evalJs("[...document.querySelectorAll('.cp-item .cp-l')].map(b => b.textContent).join('|')");
    chk('控制面板 slimmed to 6 pure system/preference items with hub shortcut links',
      items === '显示属性|声音|通知|Google 账户|邮箱|文献推送设置' &&
      (await evalJs("document.querySelectorAll('.cp-item img').length")) === 6 &&
      (await evalJs("!!document.querySelector('.cp-pane .walls') && !!document.querySelector('.cp-hub-links')")), items);

    await evalJs("(() => { const chk = document.querySelector('.cp-pane input[data-extra-icon=\"todo\"]'); chk && chk.click(); })()"); await sleep(200);
    const withTodo = await evalJs("!!document.querySelector('.dicon[data-id=todo]')");
    await evalJs("(() => { const chk = document.querySelector('.cp-pane input[data-extra-icon=\"todo\"]'); chk && chk.click(); })()"); await sleep(200);
    const withoutTodo = await evalJs("!document.querySelector('.dicon[data-id=todo]')");
    chk('显示属性 extra desktop icon checkboxes dynamically add and remove desktop icons', withTodo && withoutTodo, [withTodo, withoutTodo]);
    await shot('80-control-display.png');

    for (const [label, sel, txt] of [['声音', '.sounds', '全部静音'], ['通知', '.nt', '收通知的设备'], ['Google 账户', '.gacc', '授权客户端'], ['邮箱', '.mla', '添加邮箱']]) {
      await evalJs(`[...document.querySelectorAll('.cp-item')].find(b => b.textContent.includes('${label}')).click()`); await sleep(700);
      chk(`控制面板 → ${label}: opens inside Control Panel with matching title`,
        (await evalJs(`(document.querySelector('.cp-pane ${sel}') || {}).textContent || ''`)).includes(txt) && (await winTitle()).includes('控制面板 - ' + label),
        [await winTitle(), await evalJs("document.querySelector('.cp-pane').textContent.slice(0, 120)")]);
    }

    // 4. Legacy control.open forwarding -> 设备与算力 (Fleet + NAS CLI)
    await evalJs("(async () => (await import('/js/apps/control.js')).open('computers'))()"); await sleep(900);
    chk('control.open("computers") forwards to 设备与算力 › 设备接入与令牌',
      (await winTitle()).includes('设备与算力') && (await evalJs("!!document.querySelector('.infra-hub .computers')")), await winTitle());

    await evalJs("(async () => (await import('/js/apps/control.js')).open('fleet'))()"); await sleep(1200);
    const fleetState = await evalJs("(() => { const f = document.querySelector('.infra-hub .fleet'); return f ? { text: f.textContent, urls: f.querySelectorAll('input[type=url]').length, codex: (f.querySelector('.aim-cli[data-tool=codex]')||{}).textContent||'', claude: (f.querySelector('.aim-cli[data-tool=claude]')||{}).textContent||'' } : null; })()");
    chk('设备与算力 › Fleet embeds Fleet setup + NAS Claude Code / Codex CLI version status',
      fleetState && /还没有（运行一次 node remote\/deploy\/deploy\.js/.test(fleetState.text) &&
      fleetState.urls === 2 && /默认代理/.test(fleetState.text) && /gateway-key admin/.test(fleetState.text) &&
      /2\.1\.288/.test(fleetState.claude) && /已登录（Claude 账号 · Max 订阅）/.test(fleetState.claude) &&
      /0\.158\.0/.test(fleetState.codex) && /0\.160\.0（有新版本）/.test(fleetState.codex) && /已登录（ChatGPT 账号）/.test(fleetState.codex) && !/SECRET/.test(fleetState.codex),
      fleetState);
    await shot('81-control-fleet.png');

    // 5. AI 与额度 5-Tab Hub: Tab 2 (Global Model Pools + AI Models), Tab 3 (Skills & Roles), Tab 4 (MCP), Tab 5 (OpenCode + claude-apis)
    await evalJs("(async () => (await import('/js/apps/control.js')).open('ai'))()"); await sleep(1200);
    const aiTabs = await evalJs("[...document.querySelectorAll('.ai-hub > .skp-tabs .skp-tab')].map(b => b.textContent).join('|')");
    chk('AI 与额度 hub has 5 top tabs and control.open("ai") lands on 模型路由与能力池',
      aiTabs === '额度与顾问|模型路由与能力池|Skill 与角色库|MCP 工具中枢|客户端配置与入口' &&
      (await evalJs("document.querySelector('.ai-hub > .skp-tabs .skp-tab.sel')?.dataset.tab === 'models'")) &&
      (await evalJs("!!document.querySelector('.ai-hub .pm-roles-sec') && /全局模型能力池与熔断路由/.test(document.querySelector('.ai-hub').textContent)")),
      aiTabs);

    const ai = await evalJs("(() => { const s = [...document.querySelectorAll('.aim-row select')]; return { rows: document.querySelectorAll('.aim-row').length, models: [...s[0].options].map(o => o.value).join(), groups: [...s[0].querySelectorAll('optgroup')].map(g => g.label).join('|') }; })()");
    chk('AI 模型: default + backup rows and thirteen jobs, Claude/OpenAI/Magpie grouped', ai.rows === 15 &&
      ai.models.startsWith(',claude-opus-5-5,claude-fable-5-1,claude-sonnet-5-5,claude-haiku-4-5-20251001,gpt-6-astra,gpt-6-sol,gpt-6-luna,magpie:') && ai.groups === 'Claude|OpenAI（Codex）|Magpie', ai);
    const api = await evalJs("(() => { const b = document.querySelector('.aim-cli[data-tool=api]'); return { text: b.textContent, field: b.querySelector('input.aim-key').type, btns: [...b.querySelectorAll('button')].map(x => x.textContent).join() }; })()");
    chk('AI 模型: Claude API password field and credit instructions', /还没填/.test(api.text) && /API 赠金/.test(api.text) && api.field === 'password' && api.btns === '保存', api);
    await evalJs("(() => { const row = [...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')); const [m] = row.querySelectorAll('select'); m.value = 'gpt-6-astra'; m.dispatchEvent(new Event('change')); })()"); await sleep(300);
    const efforts = await evalJs("[...[...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')).querySelectorAll('select')[1].options].map(o => o.value).join()");
    await evalJs("(() => { const row = [...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')); const e = row.querySelectorAll('select')[1]; e.value = 'xhigh'; e.dispatchEvent(new Event('change')); })()");
    await sleep(1500);
    const saved = await evalJs("fetch('/api/ai').then(r => r.json()).then(v => JSON.stringify(v.tasks.find(t => t.id === 'ask').set))");
    const uses = await evalJs("[...document.querySelectorAll('.aim-row')].find(r => r.textContent.includes('问一问')).querySelector('.aim-uses').textContent");
    chk('a job set on its own: efforts offered, saved, and actual model shown', efforts === ',low,medium,high,xhigh,max,ultra' && /GPT-6-Astra · 很高/.test(uses) && saved === '{"model":"gpt-6-astra","effort":"xhigh"}', [efforts, uses, saved]);
    await evalJs("(() => { const m = document.querySelector('.aim-bak select'); m.value = 'claude-opus-5-5'; m.dispatchEvent(new Event('change')); })()"); await sleep(1500);
    const bak = await evalJs("fetch('/api/ai').then(r => r.json()).then(v => JSON.stringify(v.backup))");
    const uses2 = await evalJs("[...document.querySelectorAll('.aim-uses')].map(e => e.textContent)");
    chk('后备模型: picked, saved, each job shows fallback', bak === '{"model":"claude-opus-5-5","effort":""}' && uses2.length === 13 && uses2.every((t) => /出错时改用 Opus 5\.5/.test(t)), [bak, uses2]);
    await shot('81-control-ai.png');

    // Tab 3: Skill 与角色库 (cleaned of duplicate pools/machines/fleet tabs + dirty guard)
    await evalJs("(async () => (await import('/js/apps/control.js')).open('skills', 'roles'))()"); await sleep(900);
    const skpSubTabs = await evalJs("[...document.querySelectorAll('.ai-hub .skp .skp-tab')].map(b => b.textContent).join('|')");
    chk('Skill 与角色库 keeps only Skill + 角色提示词 sub-tabs and preselects roles via forwarding',
      skpSubTabs === '跨机 Skill 管理|角色提示词 (.md)' && (await evalJs("document.querySelector('.ai-hub .skp .skp-tab.sel')?.dataset.tab === 'roles'")), skpSubTabs);
    await shot('81-aihub-skills.png');

    // Tab 4: MCP 工具中枢
    await evalJs("(async () => (await import('/js/apps/control.js')).open('mcp'))()"); await sleep(900);
    chk('AI 与额度 → MCP 工具中枢: managed MCP servers with limits and install commands',
      await evalJs("document.querySelectorAll('.ai-hub [data-pane=mcp] .mcp-card').length >= 3 && /一次最多 20 个 DOI/.test(document.querySelector('.ai-hub [data-pane=mcp] .mcp').textContent) && /install-mesh-mcp\\.js --status/.test(document.querySelector('.ai-hub [data-pane=mcp] .mcp').textContent) && /设备与算力 › 设备接入与令牌/.test(document.querySelector('.ai-hub [data-pane=mcp] .mcp').textContent)"),
      await evalJs("document.querySelector('.ai-hub [data-pane=mcp] .mcp')?.textContent.slice(0, 400)"));
    await shot('81-control-mcp.png');

    // Tab 5: 客户端配置与入口 (OpenCode generator + folded manual + resurrected claude-apis)
    await evalJs("(async () => (await import('/js/apps/control.js')).open('opencode'))()"); await sleep(600);
    chk('客户端配置与入口 mounts both OpenCode generator and resurrected cc-environments (claude-apis) panel',
      await evalJs("!!document.querySelector('.ai-hub .ocg') && !!document.querySelector('.ai-hub .capi') && !document.querySelector('.ai-hub .ocg-manual').open"));

    for (let n = 0; n < 40 && !(await evalJs("/提供 4 个/.test(document.querySelector('.ocg-gen-status').textContent)")); n++) await sleep(100);
    const gen0 = await evalJs("(() => { const rows=[...document.querySelectorAll('.ocg-gen-row')]; const cfg=JSON.parse(document.querySelector('.ocg-gen pre code').textContent); return { status: document.querySelector('.ocg-gen-status').textContent, rows: rows.length, ticked: rows.filter(r=>r.querySelector('input[type=checkbox]').checked).length, legends: [...document.querySelectorAll('.ocg-gen-group legend')].map(l=>l.textContent), models: Object.keys(cfg.providers.magpie.models).length, model: cfg.model, explore: cfg.agents.explore.model, key: cfg.providers.magpie.settings.apiKey, gone: document.querySelectorAll('.ocg-gen-row.gone').length }; })()");
    const baseCount = Object.keys(JSON.parse(fs.readFileSync(R + '/public/downloads/opencode-magpie.json', 'utf8')).providers.magpie.models).length;
    chk('generator lists the gateway models grouped by source, base config ticked and generated', /提供 4 个/.test(gen0.status) && gen0.ticked === baseCount && gen0.models === baseCount && gen0.rows === baseCount + 1 &&
      gen0.legends.includes('路由组') && gen0.legends.includes('cc-ubuntu') && gen0.model === 'magpie/group/opus-main' && gen0.explore === 'magpie/group/deepseek-worker' && gen0.key === '{file:~/.config/opencode/.secrets/magpie-nas.key}' && gen0.gone > 0, gen0);
    await evalJs("(() => { const row=document.querySelector('.ocg-gen-row[data-id=\"cc-ubuntu/claude/claude-fable-5-2\"]'); const c=row.querySelector('input[type=checkbox]'); c.click(); const n=row.querySelector('.ocg-gen-name'); n.value='Fable · VM'; n.dispatchEvent(new Event('input')); const s=document.querySelector('.ocg-gen select[data-role=main]'); s.value='cc-ubuntu/claude/claude-fable-5-2'; s.dispatchEvent(new Event('change')); })()");
    const gen1 = await evalJs("(() => { const cfg=JSON.parse(document.querySelector('.ocg-gen pre code').textContent); const e=cfg.providers.magpie.models['cc-ubuntu/claude/claude-fable-5-2']; return { model: cfg.model, name: e && e.name, pkg: e && e.package, input: e && e.capabilities.input.join(), effort: e && e.capabilities.reasoning.effort.join(), ctx: e && e.limit.context }; })()");
    chk('ticking a new model builds its entry from gateway data and it can be the main model', gen1.model === 'magpie/cc-ubuntu/claude/claude-fable-5-2' && gen1.name === 'Fable · VM' && gen1.pkg === '@opencode/ai/providers/anthropic-compatible' && gen1.input === 'text,image' && gen1.effort === 'low,medium,high,xhigh,max' && gen1.ctx === 1000000, gen1);
    await evalJs("(() => { const s=document.querySelector('.ocg-gen-tools input[type=search]'); s.value='swe'; s.dispatchEvent(new Event('input')); [...document.querySelectorAll('.ocg-gen-tools .btn')].find(b=>b.textContent==='全不选').click(); s.value=''; s.dispatchEvent(new Event('input')); })()");
    const gen2 = await evalJs("(() => { const cfg=JSON.parse(document.querySelector('.ocg-gen pre code').textContent); return { swe: !!cfg.providers.magpie.models['devin/swe-2'], fable: !!cfg.providers.magpie.models['cc-ubuntu/claude/claude-fable-5-2'] }; })()");
    chk('filter + 全不选 only affects the rows shown', !gen2.swe && gen2.fable, gen2);
    await evalJs("[...document.querySelectorAll('.ocg-gen-tools .btn')].find(b=>b.textContent==='恢复默认').click()");
    chk('恢复默认 brings back the base configuration exactly', await evalJs("document.querySelector('.ocg-gen pre code').textContent") === fs.readFileSync(R + '/public/downloads/opencode-magpie.json', 'utf8').replace(/\r\n/g, '\n'));
    await evalJs("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{window.genCopied=t;}}});document.querySelector('.ocg-gen [data-gen=copy]').click()"); await sleep(100);
    chk('复制配置 copies exactly the generated JSON', await evalJs("window.genCopied===document.querySelector('.ocg-gen pre code').textContent"));
    const genFile = path.join(downloadDir, 'opencode.json'); if (fs.existsSync(genFile)) fs.unlinkSync(genFile);
    await evalJs("document.querySelector('.ocg-gen [data-gen=download]').click()");
    for (let n = 0; n < 60 && !fs.existsSync(genFile); n++) await sleep(100);
    chk('下载 opencode.json saves the generated file', fs.existsSync(genFile) && fs.readFileSync(genFile, 'utf8') === await evalJs("document.querySelector('.ocg-gen pre code').textContent"));
    chk('the generator API rejects anonymous clients', (await new Promise((ok) => http.get(`http://127.0.0.1:${PORT}/api/magpie/opencode-models`, (r) => { r.resume(); ok(r.statusCode); }))) === 401);
    await shot('81-control-opencode-generator.png');

    const downloaded=path.join(downloadDir,'opencode-magpie-usage.zip');
    if(fs.existsSync(downloaded))fs.unlinkSync(downloaded);
    await evalJs("document.querySelector('.ocg [data-download=usage-plugin]').click()");
    for(let n=0;n<60&&!fs.existsSync(downloaded);n++)await sleep(100);
    chk('portable usage plugin downloads as a complete ZIP',fs.existsSync(downloaded)&&fs.readFileSync(downloaded).equals(fs.readFileSync(R+'/public/downloads/opencode-magpie-usage.zip')));

    // Expand manual tutorial inside Tab 5 and verify Windows/Linux steps
    await evalJs("document.querySelector('.ocg-manual').open = true; document.querySelector('.ocg [data-os=windows]').click()"); await sleep(100);
    chk('Windows instructions cover install, secure key file, proxy and connectivity checks', await evalJs("(() => {const t=document.querySelector('.ocg-body').textContent;return t.includes('opencode.exe --version')&&t.includes('AsSecureString')&&t.includes('icacls.exe')&&t.includes('service set env NO_PROXY')&&t.includes('Resolve-DnsName')&&t.includes('不带 http://、端口或 full:');})()"));
    chk('Windows install defaults to npm with no pinned version, standalone CLI folded away', await evalJs("(() => {const c=[...document.querySelectorAll('.ocg-body .ocg-step')][1];const first=c.querySelector(':scope > div > .ocg-code code').textContent;return first.startsWith('npm.cmd install -g @opencode/cli\\n')&&!/@opencode\\/cli@/.test(c.textContent)&&c.querySelector('details').textContent.includes('opencode.exe --version');})()"));
    await evalJs("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{window.guideCopied=t;}}});document.querySelector('.ocg-body .ocg-code .btn').click()"); await sleep(100);
    chk('guide command copy uses the displayed command and reports success', await evalJs("window.guideCopied===document.querySelector('.ocg-body .ocg-code code').textContent && [...document.querySelectorAll('.ocg-body .ocg-copy-note')].some(n => n.textContent==='已复制')"));
    await evalJs("document.querySelector('.ocg [data-os=linux]').click()");
    chk('Linux instructions have Bash key permissions, lowercase proxy bypass and service setup', await evalJs("(() => {const t=document.querySelector('.ocg-body').textContent;return document.querySelector('.ocg-body').dataset.os==='linux'&&t.includes('opencode.ai/v2/install')&&t.includes('chmod 600')&&t.includes('export no_proxy=')&&t.includes('getent ahostsv4')&&t.includes('sudo tailscale up');})()"));
    chk('guide explains HTTP80 and HTTPS443; claude-apis lives cleanly below .ocg', await evalJs("document.querySelector('.ocg-body').textContent.includes('现在使用 HTTPS 默认443') && !document.querySelector('.ocg form, .ocg input[type=password]') && !!document.querySelector('.capi .capi-editor')"));
    await evalJs("(async () => (await import('/js/apps/control.js')).open('apis'))()"); await sleep(300);
    await shot('81-control-opencode-guide.png');

    // 6. Global #hash router check
    await evalJs("location.hash = '#infra?tab=compute'"); await sleep(500);
    chk('router.js dispatches #infra?tab=compute and clears hash',
      await evalJs("location.hash === '' && document.querySelector('.infra-hub .skp-tab.sel')?.dataset.tab === 'compute'"));

    // 7. 记忆与存档 (knowledge)
    await evalJs("[...document.querySelectorAll('.dicon')].find(b=>b.textContent.includes('记忆与存档')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");await sleep(900);
    chk('记忆与存档 opens as a standalone app with memory icon, SQLite status and scope management',await evalJs("document.querySelector('.knowledge').textContent.includes('NAS SQLite') && document.querySelector('.knowledge').textContent.includes('共享全局') && [...document.querySelectorAll('.dicon')].find(b=>b.textContent.includes('记忆与存档')).querySelector('img').src.endsWith('/icons/memory.png')") && (await winTitle()).includes('记忆与存档'));
    await evalJs("[...document.querySelectorAll('.knowledge button')].find(b=>b.textContent==='新增记忆').click();document.querySelector('.knowledge-editor input[placeholder=记忆名称]').value='界面记忆';document.querySelector('.knowledge-body').value='中文与 emoji 🌈';document.querySelector('.knowledge-editor').requestSubmit()");await sleep(900);
    chk('memory form publishes Unicode text to SQLite',await evalJs("fetch('/api/knowledge').then(r=>r.json()).then(d=>d.memories.some(m=>m.name==='界面记忆'&&m.body==='中文与 emoji 🌈'))"));
    await evalJs("[...document.querySelectorAll('.knowledge-fact button')].find(b=>b.textContent==='编辑').click()");
    chk('editing an existing memory preloads its complete body',await evalJs("document.querySelector('.knowledge-editor textarea').value==='中文与 emoji 🌈'"));
    await evalJs("[...document.querySelectorAll('.knowledge-editor button')].find(b=>b.textContent==='取消').click()");
    await evalJs("fetch('/api/knowledge/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'global',owner:'',name:'界面副本',body:'中文与 emoji 🌈'})})");
    await evalJs("fetch('/api/knowledge/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'machine',owner:'huatanshaonian',name:'本机 Windows 路径与 Claude 入口',body:'Windows 用户目录：C:/Users/TOP；AmeTyping 主仓库：D:/ametyping。\\n按需同步数据：G:/feko_data 与 C:/Users/TOP/Desktop/SynologyDrive。\\nClaude Code 使用同一程序、共享 .claude 与 .claude.json，通过 claude-nebula / claude-deepseek 选择 API。\\nNebula 默认 opus、使用本机代理；DeepSeek 默认 deepseek-flash[1m]、直连。'})})");
    await evalJs("fetch('/api/knowledge/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'project',owner:'ametyping',name:'AmeTyping 多机同步架构规范',body:'包含 Electron 宠物端、Web 桌面应用群及多机 WebSocket Agent。'})})");
    await evalJs("[...document.querySelectorAll('.knowledge button')].find(b=>b.textContent==='刷新').click()");await sleep(500);
    const expandBefore=await evalJs("(() => {const b=document.querySelector('.knowledge-expand-btn'),p=b?.previousElementSibling;return {hasBtn:!!b,collapsed:p?.classList.contains('is-collapsed'),preCount:b?.closest('.knowledge-fact')?.querySelectorAll('pre').length};})()");
    await evalJs("document.querySelector('.knowledge-expand-btn')?.click()");await sleep(200);
    const expandAfter=await evalJs("(() => {const b=document.querySelector('.knowledge-expand-btn'),p=b?.previousElementSibling;return {btnText:b?.textContent,expanded:p?.classList.contains('is-expanded')&&!p?.classList.contains('is-collapsed'),preCount:b?.closest('.knowledge-fact')?.querySelectorAll('pre').length};})()");
    chk('memory card expand button toggles the single text box in-place instead of opening a second box',expandBefore.hasBtn&&expandBefore.collapsed&&expandBefore.preCount===1&&expandAfter.expanded&&expandAfter.preCount===1&&expandAfter.btnText.includes('收起全文'),{expandBefore,expandAfter});
    await shot('83-knowledge-grouped.png');
    await evalJs("(() => {const s=document.querySelector('.knowledge input[placeholder=\"搜索名称、正文或归属\"]');s.value='副本';s.dispatchEvent(new Event('input'));})()");
    chk('memory list supports body/name search and per-entry content',await evalJs("document.querySelectorAll('.knowledge-fact').length===1 && document.querySelector('.knowledge-fact').textContent.includes('中文与 emoji 🌈')"));
    await evalJs("(() => {const s=document.querySelector('.knowledge input[placeholder=\"搜索名称、正文或归属\"]');s.value='';s.dispatchEvent(new Event('input'));const sc=document.querySelector('.knowledge-filter-bar select');sc.value='global';sc.dispatchEvent(new Event('change'));[...document.querySelectorAll('.knowledge button')].find(b=>b.textContent==='勾选当前列表').click();[...document.querySelectorAll('.knowledge button')].find(b=>b.textContent==='对齐所选').click();})()");await sleep(500);
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

    // 8. Calendar -> Google 账户 & Mail -> 邮箱
    await evalJs("(async () => (await import('/js/apps/calendar.js')).open())()"); await sleep(1500);
    await evalJs("[...document.querySelectorAll('.cal-g .rs-link')].find(b => b.textContent.includes('连接 Google')).click()"); await sleep(1200);
    chk('the calendar\'s 「连接 Google 日历」 opens 控制面板 → Google 账户', (await winTitle()).includes('控制面板 - Google 账户'), await winTitle());
    await evalJs("(async () => (await import('/js/apps/mail.js')).open())()"); await sleep(1200);
    await evalJs("[...document.querySelectorAll('.ml-bar .btn')].find(b => b.textContent === '设置').click()"); await sleep(1200);
    chk('邮件\'s 设置 opens 控制面板 → 邮箱 (one 控制面板 window)', (await winTitle()).includes('控制面板 - 邮箱') && (await evalJs("document.querySelectorAll('.cp').length")) === 1, await winTitle());

    // 9. z-index check after 400 focuses
    const over = await evalJs(`(async () => {
      const wm = await import('/js/wm.js'), menu = await import('/js/ctxmenu.js');
      const el = document.querySelector('.win:not(.minimized)'), r = el.getBoundingClientRect();
      for (let n = 0; n < 400; n++) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      menu.show(x, y, [{ label: '一' }, { label: '二' }]);
      const m = document.querySelector('.ctxm').getBoundingClientRect();
      const hit = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2);
      const out = { z: +el.style.zIndex, menu: !!(hit && hit.closest('.ctxm')), layer: getComputedStyle(document.querySelector('#windows')).zIndex };
      menu.close();
      return out;
    })()`);
    chk('a window focused 400 times is still under a right-click menu opened over it', over.z > 300 && over.menu, over);

    // 10. Phone layout check (390x780)
    await evalJs("[...document.querySelectorAll('.win')].forEach(w => { const t = w.querySelector('.title'); if (t && !t.textContent.startsWith('控制面板')) w.querySelector('.tbtn.close').click(); })"); await sleep(300);
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
    await sleep(1000);
    await evalJs("document.querySelector('.cp-back').click()"); await sleep(500);
    chk('phone: 控制面板 shows icons first', await evalJs("getComputedStyle(document.querySelector('.cp-nav')).display !== 'none' && getComputedStyle(document.querySelector('.cp-main')).display === 'none'"), 0);
    await shot('82-control-phone.png');
    await evalJs("[...document.querySelectorAll('.cp-item')].find(b => b.textContent.includes('声音')).click()"); await sleep(800);
    chk('phone: clicking an item fills the window, with ‹ 控制面板 to go back', await evalJs("getComputedStyle(document.querySelector('.cp-nav')).display === 'none' && getComputedStyle(document.querySelector('.cp-back')).display !== 'none' && !!document.querySelector('.cp-pane .sounds')"), 0);
    await shot('83-control-phone-sounds.png');

    await evalJs("(async () => (await import('/js/apps/ai-hub.js')).open({ tab: 'clients', sec: 'opencode' }))()"); await sleep(600);
    chk('phone: OpenCode guide in AI 与额度 keeps command overflow inside its code panes', await evalJs("document.querySelector('.ocg').scrollWidth<=document.querySelector('.ocg').clientWidth+2"));
    await shot('85-control-phone-opencode.png');
    ws.close();
  } catch (e) { errors.push('test: ' + e.stack); }
  finally { try { chrome && chrome.kill(); } catch {} srv.kill();memoryApi.close();magpieSrv.close(); }
  for (const r of res) console.log(r);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  await sleep(800);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(res.some((r) => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})();
