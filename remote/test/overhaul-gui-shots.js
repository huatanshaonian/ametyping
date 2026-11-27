// GUI overhaul baseline (docs/overhaul/05-gui-style-spec.md): a throwaway server on its own ports (web 18910, Chrome
// CDP 9441, fake Magpie 18911) filled with realistic data -- online / offline computers whose sessions come from fake
// agent sockets (working, waiting for a permission, done), GPU compute probes, infra reports (workstations, NAS, cloud,
// router), an AmeMesh project with master / workers / verifier, milestone tasks and a board, a compute job, daily /
// weekly reports, plans, mail, the literature module on the fakes of ui-literature.js -- then headless Chrome takes
// the desktop, every core window, the control panel's pages, the looks and shades (Windose / 深夜 / 夜灯 / Windows 标准 /
// 豆沙绿), the phone layout, and the Electron pet's bubble (app/bubble.html with its IPC stubbed).
// Shots go to D:/ametyping-refactor/docs/overhaul/shots-baseline (AME_SHOTS_OUT overrides; git-excluded) with
// manifest.json listing what each shot shows and the page errors seen. Nothing in the app is changed.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const { pathToFileURL } = require('url');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const { createFakeZotero, toWebdav } = require('./fake-zotero');
const { createFakeSources } = require('./fake-lit-sources');
const { makePdf } = require('./make-pdf');

const OUT = process.env.AME_SHOTS_OUT || 'D:/ametyping-refactor/docs/overhaul/shots-baseline';
fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-overhaul-'));
const PORT = 18910, CDP = 9441, MAGPIE = 18911;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BUBBLE = path.resolve(R, '..', 'app', 'bubble.html');
// the full Win98 icon set (not in git): candidates for the icons used for several things at once
const W98 = process.env.AME_W98_ICONS || 'D:/ametyping/windows98-icons/png';
const ICON_ROWS = [   // [what it is for, the icon in use now, candidates]
  ['文献（桌面/开始菜单/深读窗）', 'help_book_big', ['help_book_cool', 'help_book_small', 'catalog', 'address_book', 'search_file_2']],
  ['控制面板 › OpenCode 配置指南', 'help_book_big', ['help_book_computer', 'tip', 'appwizard']],
  ['Skill 管理 / Skill 与协同', 'notepad', ['script_file_teal', 'script_file_yellow', 'executable_script', 'notepad_file_gear', 'appwizard']],
  ['控制面板 › MCP', 'network_normal_two_pcs', ['gears', 'tools_gear', 'file_gears', 'server_gear', 'cable']],
  ['控制面板 › 电脑', 'network_normal_two_pcs', ['computer_2', 'network_three_pcs', 'user_computer_pair']],
  ['网络与设备（桌面）', 'network_cool_two_pcs', ['entire_network_globe', 'world_network_directories', 'network_three_pcs', 'server_window']],
  ['网络与设备 › 路由节点', 'network_cool_two_pcs', ['direct_cable_conn', 'cable', 'network_drive_world']],
  ['网络与设备 › 云端节点', 'network_normal_two_pcs', ['world', 'connected_world', 'server_to_desktop']],
  ['Google 账户（与「注销」同图）', 'key_win', ['key_world', 'users_key', 'mailbox_world']],
  ['项目管理 › 研究与计算', 'projects', ['magnifying_glass', 'search_file', 'processor']],
  ['项目管理 › 黑板与任务', 'projects', ['address_book_pad', 'notepad_file', 'address_book_users']],
  ['项目管理 › 角色与模型池', 'projects', ['users', 'users_key', 'user_card']],
  ['项目管理 › 触发器与看门狗（clock 缺图）', 'projects', ['clock', 'monitor_gear', 'directory_admin_tools']],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const DATA = path.join(T, 'srv', 'data'); fs.mkdirSync(DATA, { recursive: true });
const now = Date.now();
const day = (off) => { const d = new Date(now + off * 86400e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------- the literature fakes (as ui-literature.js) ----------
const WD = path.join(T, 'webdav'); fs.mkdirSync(WD);
const zot = createFakeZotero({ webdavDir: WD,
  collections: [{ key: 'QPUW2W6R', name: '气动隐身' }, { key: '4WQG3HZQ', name: '等离子体RCS', parent: 'QPUW2W6R' }, { key: 'JDF645IP', name: '每日文献' }],
  items: [
    { key: 'AAAAAAA1', itemType: 'journalArticle', title: 'Backward scattering of a reentry vehicle in plasma sheath', creators: [{ creatorType: 'author', lastName: 'Sun', firstName: 'Wei' }],
      publicationTitle: 'IEEE Transactions on Antennas and Propagation', ISSN: '0018-926X', DOI: '10.1109/tap.2018.1', date: '2018', abstractNote: 'plasma sheath electron density and backscattering', collections: ['QPUW2W6R'], citationKey: 'sun2018backward' },
    { key: 'ATTAAAA1', itemType: 'attachment', parentItem: 'AAAAAAA1', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'sun2018.pdf' },
    { key: 'ANNAAAA1', itemType: 'annotation', parentItem: 'ATTAAAA1', annotationType: 'highlight', annotationText: 'electron density', annotationComment: '关键', annotationPageLabel: '1', annotationSortIndex: '00001' },
    { key: 'AAAAAAA2', itemType: 'journalArticle', title: 'Radar cross section of cones', creators: [{ creatorType: 'author', lastName: 'Ross', firstName: 'R.' }], date: '1990', collections: ['4WQG3HZQ'] },
  ] });
toWebdav(WD, 'ATTAAAA1', 'sun2018.pdf', makePdf(['plasma sheath electron density profile page one', 'collision frequency model page two, see Fig. 1']));
const src = createFakeSources();

// a stand-in Magpie gateway: models, quotas and usage for the Magpie widget / window and the AI pages
const magpieSrv = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [
    { id: 'cc-ubuntu/claude/claude-opus-5-5', magpie_label: 'Claude Opus 5.5 · cc-ubuntu', owned_by: 'cc-ubuntu', context_window: 1000000, max_output_tokens: 128000, tool_call: true },
    { id: 'cc-ubuntu/claude/claude-sonnet-5-5', magpie_label: 'Claude Sonnet 5.5 · cc-ubuntu', owned_by: 'cc-ubuntu', context_window: 1000000, max_output_tokens: 64000, tool_call: true },
    { id: 'group/opus-main', magpie_label: 'opus-main · routing group', owned_by: 'kiro', context_window: 1000000, tool_call: true },
  ] }));
  if (req.url === '/v1/magpie/quotas') return res.end(JSON.stringify({ data: [
    { id: 'cc-ubuntu', label: 'Claude Max · cc-ubuntu', used: 0.62, resetAt: now + 3 * 3600e3, window: '5h' },
    { id: 'kiro', label: 'Kiro Pro', used: 0.18, resetAt: now + 6 * 86400e3, window: '30d' },
  ] }));
  if (req.url.startsWith('/v1/magpie/usage')) return res.end(JSON.stringify({ total: { requests: 1832, input: 52e6, output: 3.1e6 }, byModel: [] }));
  res.writeHead(404); res.end('{}');
}).listen(MAGPIE, '127.0.0.1');

// ---------- server config, computers, data files ----------
const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000', AME_FLUSH_MS: '300' };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const tokens = {};
for (const m of ['dell97', 'remote3090', 'huatanshaonian', 'dell211', 'panasonic', 'nas', 'aws1', 'openwrt']) {
  tokens[m] = node([R + '/server/setup.js', 'add-agent', m]).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
}

function writeConfig(zp, sp) {
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex-lit.js')], categories: [{ match: 'CEM', cat: 'research' }] };
  cfg.magpie = { baseURL: `http://127.0.0.1:${MAGPIE}/v1` };
  const base = `http://127.0.0.1:${sp}`;
  cfg.literature = { zotero: `http://127.0.0.1:${zp}`, webdavDir: WD, kbDir: path.join(T, 'kb'), refreshMs: 400, pdfWaitMs: 1500, pollMs: 250, at: '23:59', daily: 5,
    endpoints: { openalex: base + '/oa', crossref: base + '/cr', arxiv: base + '/arxiv', aiaa: base + '/aiaa', ntrs: base + '/ntrs', cn: false } };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
}

// daily / weekly reports
{
  const RD = path.join(DATA, 'reports'); fs.mkdirSync(RD, { recursive: true });
  const d1 = day(-1), d2 = day(-2);
  const rep = (date, headline, projects, minutes) => ({ date, headline, from: now - 2 * 86400e3, to: now - 86400e3, stats: { minutes, sessions: 7, machines: 3 }, sessions: [],
    projects, open: [{ text: '整理第三章参考文献', project: 'RCS 论文', status: 'open', since: d2 }, { text: '复核 dell97 上 MLFMA 预条件的收敛曲线', project: 'CEM 求解器', status: 'open', since: d1 }],
    plans: [], keywords: ['MoM', 'CuPy', 'RCS', 'AmeMesh', 'Win98'],
    harness: { checkedAt: now - 86400e3, releases: [
      { id: 'claude', label: 'Claude Code', from: '2.1.323', to: '2.1.331', at: now - 86400e3, link: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md', major: ['新增 /goal 命令：给会话设一个持续目标'], highlights: ['启动更快'], other: '另有 6 项修复' }],
      updates: [{ machine: 'dell97', id: 'claude', before: '2.1.323', after: '2.1.331', ok: true, by: 'daily' }, { machine: 'dell211', id: 'claude', ok: false, skipped: true, by: 'daily', msg: '有会话开着' }], installs: [],
      behind: [{ machine: 'dell211', id: 'claude', version: '2.1.311', latest: '2.1.331' }] } });
  fs.writeFileSync(path.join(RD, d1 + '.json'), JSON.stringify(rep(d1, 'MLFMA 预条件调通，AmeMesh 拓扑总览改版', [
    { name: 'CEM 求解器', category: 'research', summary: '在 dell97 上把 MLFMA 的块对角预条件接进 CuPy 求解器，迭代数从 412 降到 96。', done: ['块对角预条件', '迭代残差曲线入库 npz'], decisions: ['近场阈值取 0.2λ'], unfinished: ['双站 RCS 与 FEKO 对比'], sessions: [], minutes: 210, files: [] },
    { name: 'AmeTyping', category: 'dev', summary: '项目管理的拓扑改成进度总览，黑板支持 #楼层引用。', done: ['拓扑总览', '黑板 @ 提醒'], decisions: [], unfinished: ['夜灯下项目页配色'], sessions: [], minutes: 160, files: [] },
    { name: '配置 git 代理', category: 'chore', summary: '给 remote3090 的 git 配了代理', done: [], decisions: [], unfinished: [], sessions: [], minutes: 6, files: [] }], 376)));
  fs.writeFileSync(path.join(RD, d2 + '.json'), JSON.stringify(rep(d2, '重画论文第三章 RCS 图', [
    { name: 'RCS 论文', category: 'research', summary: '第三章图表改成双对数坐标，补了误差棒。', done: ['图 3-4', '图 3-5'], decisions: [], unfinished: [], sessions: [], minutes: 185, files: [] }], 185)));
  fs.writeFileSync(path.join(RD, `week-${day(-7)}.json`), JSON.stringify({ start: day(-7), end: day(-1), headline: '这周 MLFMA 提速 4 倍，论文第三章定稿', highlights: ['MLFMA 预条件迭代数 412 → 96', '第三章图表全部重画'],
    projects: [{ name: 'CEM 求解器', category: 'research', summary: '预条件 + 近场缓存', progress: ['块对角预条件', '近场缓存'] }], days: [{ date: d1, headline: 'MLFMA 预条件调通', minutes: 376 }, { date: d2, headline: '重画 RCS 图', minutes: 185 }],
    open: [{ text: '整理参考文献', project: 'RCS 论文' }], artifacts: [], stats: { minutes: 1840, byCat: { research: 1300, dev: 420, chore: 120 }, days: 5, sessions: 31, chores: 4, artifacts: 2 } }));
}
// mail: one mailbox (its server not reachable here) with messages already archived on the NAS
{
  fs.writeFileSync(path.join(DATA, 'mail.json'), JSON.stringify({ accounts: [{ id: 'a1', address: 'demo@test.ac.cn', name: '所里', imap: { host: '127.0.0.1', port: 1 }, smtp: { host: '127.0.0.1', port: 1 }, pass: 'x', signature: '张三\n力学研究所', added: now }], state: {} }));
  const MD = path.join(DATA, 'mail', 'a1'); fs.mkdirSync(MD, { recursive: true });
  const ym = new Date(now).toISOString().slice(0, 7);
  const msg = (uid, ago, name, address, subject, text, att = []) => JSON.stringify({ key: `a1:1:${uid}`, acc: 'a1', uid, mid: `<m${uid}@x>`, date: now - ago, from: { name, address }, to: [{ address: 'demo@test.ac.cn' }], subject, text, att }) + '\n';
  fs.writeFileSync(path.join(MD, ym + '.jsonl'),
    msg(1, 30 * 3600e3, '财务处', 'caiwu@test.ac.cn', '关于 2026 年度经费报销截止时间的通知', '各课题组：今年的报销截止到 12 月 15 日，请尽快整理发票。') +
    msg(2, 20 * 3600e3, '王同学', 'wang@test.ac.cn', '论文初稿请看', '师兄好，初稿在附件里，第三章的 RCS 图还没换。', [{ name: 'paper.pdf', size: 482000, type: 'application/pdf' }]) +
    msg(3, 5 * 3600e3, '李老师', 'li@test.ac.cn', '组会改到周四下午三点', '各位：本周组会改到周四下午三点，地点 305 会议室。每人十分钟。') +
    msg(4, 2 * 3600e3, 'IEEE TAP', 'tap@ieee.org', 'Decision on Manuscript TAP-26-1187', 'Dear Author, your manuscript has been accepted with minor revisions.'));
}

// ---------- HTTP helpers ----------
let cookie = '';
const api = (method, p, body, headers = {}) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(data), Cookie: cookie, ...headers } },
    (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, h: res.headers }); }); });
  r.on('error', () => resolve({ status: 0 })); r.end(data);
});
const getJSON = (url, method = 'GET') => new Promise((resolve, reject) => { const r = http.request(url, { method }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.end(); });
async function until(fn, ms = 20000, step = 250) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; }

// ---------- fake agents: sessions, conversations, compute probes ----------
const sockets = [];
const L = (text, type = '', ago = 0) => ({ text, type, t: now - ago });
const AGENTS = {
  dell97: { sessions: [
    { id: 'aaaaaaaa-1111-2222-3333-444444444401', label: 'MLFMA 预条件调优', project: 'CEM_Solver', state: 'working', steps: 46, t0: now - 3 * 3600e3, last: now - 20e3, via: 'terminal', model: 'claude-opus-5-5',
      lines: [L('Read src/mlfma/precond.py', 'tool', 300e3), L('Edit src/mlfma/precond.py', 'tool', 200e3), L('Bash python -m pytest tests/test_precond.py -q', 'tool', 60e3), L('块对角预条件已接入，迭代数 412 → 96，正在跑 FEKO 对比算例', 'message', 20e3)] },
    { id: 'aaaaaaaa-1111-2222-3333-444444444402', label: 'RCS 扫频批处理', project: 'CEM_Results', state: 'waiting', steps: 12, t0: now - 40 * 60e3, last: now - 90e3, via: 'terminal', model: 'claude-sonnet-5-5',
      lines: [L('准备在 GPU0 上启动 2–18 GHz 扫频（161 个频点）', 'message', 120e3)],
      perms: [{ id: 'perm-1', provider: 'claude', tool: 'Bash', cwd: '/home/dell/CEM_Results', always: 'Bash(python sweep.py:*)', input: JSON.stringify({ command: 'python sweep.py --f0 2e9 --f1 18e9 --n 161 --gpu 0', description: '启动 RCS 扫频批处理' }) }] },
    { id: 'aaaaaaaa-1111-2222-3333-444444444403', label: '整理 npz 归档', project: 'CEM_Results', state: 'done', steps: 8, t0: now - 5 * 3600e3, last: now - 2 * 3600e3, via: 'resume', lines: [L('42 个算例已全部写入 npz，并生成索引 index.csv', 'done', 2 * 3600e3)] },
  ], conv: { 'aaaaaaaa-1111-2222-3333-444444444401': [
    { role: 'user', text: '把 MLFMA 的块对角预条件接进 CuPy 求解器，近场阈值 0.2λ。', t: now - 3 * 3600e3 },
    { role: 'assistant', text: '好的。先看现在的近场矩阵组装：\n\n```python\nZ_near = assemble_near(mesh, k0, thresh=0.2 * lam)\nM = block_diag_inverse(Z_near, block=64)\n```\n\n我会把 **每个叶子盒** 的自作用块求逆后作为预条件，GMRES 改成右预条件。', t: now - 2.9 * 3600e3 },
    { role: 'assistant', text: '改好了：\n\n| 算例 | 未知量 | 迭代（前） | 迭代（后） |\n|---|---|---|---|\n| 锥球 3 GHz | 48 210 | 412 | 96 |\n| 杏仁体 10 GHz | 131 004 | 1 280 | 233 |\n\n残差曲线已存到 `results/precond_cmp.npz`。', t: now - 20e3 },
  ] },
    probe: { at: now, hasGpu: true, gpuBusy: false, gpus: [
      { index: 0, name: 'NVIDIA RTX A6000', memUsedMiB: 38120, memTotalMiB: 49140, utilPct: 97, busy: true, numaNode: 0, managedBy: 'ame' },
      { index: 1, name: 'NVIDIA RTX A6000', memUsedMiB: 1210, memTotalMiB: 49140, utilPct: 3, busy: false, numaNode: 1 }],
      numaNodes: [{ id: 0, cpuList: '0-31', cpuCount: 32, busy: true }, { id: 1, cpuList: '32-63', cpuCount: 32, busy: false }], cpuBusy: false, cores: 64 } },
  remote3090: { sessions: [
    { id: 'bbbbbbbb-1111-2222-3333-444444444401', label: '文献 PDF 解析', project: 'ametyping', state: 'working', steps: 19, t0: now - 50 * 60e3, last: now - 8e3, via: 'codex', model: 'gpt-6-sol',
      lines: [L('解析第 37/120 篇 PDF 的图表', 'message', 8e3)] },
    { id: 'bbbbbbbb-1111-2222-3333-444444444402', label: 'GUI 风格基线截图', project: 'ametyping-refactor', state: 'idle', steps: 3, t0: now - 15 * 60e3, last: now - 10 * 60e3, via: 'terminal', lines: [] },
  ], probe: { at: now, hasGpu: true, gpuBusy: true, gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 3090', memUsedMiB: 22100, memTotalMiB: 24576, utilPct: 88, busy: true, numaNode: null }],
    numaNodes: [{ id: 0, cpuList: '0-23', cpuCount: 24, busy: false }], cpuBusy: false, cores: 24 } },
  huatanshaonian: { sessions: [
    { id: 'cccccccc-1111-2222-3333-444444444401', label: 'Windose 美术风格会诊', project: 'ametyping-refactor', state: 'working', steps: 64, t0: now - 70 * 60e3, last: now - 4e3, via: 'terminal', model: 'claude-opus-5-5',
      lines: [L('node remote/test/overhaul-gui-shots.js', 'tool', 30e3), L('读取 26 个 CSS 文件，统计硬编码色值', 'message', 4e3)] },
    { id: 'cccccccc-1111-2222-3333-444444444402', label: '论文第三章', project: 'latex', state: 'waiting', steps: 5, t0: now - 20 * 60e3, last: now - 60e3, via: 'terminal', lines: [L('需要你选择图 3-4 的配色方案', 'waiting', 60e3)],
      perms: [{ id: 'perm-ask', provider: 'claude', tool: 'AskUserQuestion', cwd: 'G:/latex', ask: true, input: JSON.stringify({ questions: [{ header: '配色', question: '图 3-4 用哪套配色？', multiSelect: false, options: [{ label: '色盲安全', description: 'Okabe-Ito 八色' }, { label: '期刊默认', description: 'IEEE 灰度友好' }] }] }) }] },
  ], probe: { at: now, hasGpu: true, gpuBusy: false, gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 4070', memUsedMiB: 2100, memTotalMiB: 12282, utilPct: 6, busy: false, numaNode: null }],
    numaNodes: [{ id: 0, cpuList: '0-19', cpuCount: 20, busy: false }], cpuBusy: false, cores: 20 } },
};
function connectAgent(name, a) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`, { headers: { Authorization: 'Bearer ' + tokens[name] } });
    sockets.push(ws);
    ws.on('error', () => resolve(false));
    ws.on('open', async () => {
      const send = (o) => ws.send(JSON.stringify(o));
      send({ t: 'hello', machine: name, control: true, files: false });
      await sleep(150);
      send({ t: 'state', control: true, sessions: a.sessions });
      for (const [id, msgs] of Object.entries(a.conv || {})) send({ t: 'conv', id, msgs });
      if (a.probe) send({ t: 'compute-probe', probe: a.probe });
      resolve(true);
    });
  });
}
const infraReport = (name, role, rep) => api('POST', '/api/infra/report', { role, report: { ts: Date.now(), ...rep } }, { Authorization: 'Bearer ' + tokens[name], Cookie: '' });

// ---------- shots bookkeeping ----------
const manifest = [], errors = [], failed = [];
let id = 0, ws = null; const pending = new Map();
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
const waitFor = async (expr, ms = 8000) => { for (let i = 0; i < ms / 250; i++) { if (await evalJs(expr)) return true; await sleep(250); } return false; };
async function shot(name, what) {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  if (!r.result || !r.result.data) { failed.push(name + ': no screenshot data'); return; }
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  manifest.push({ file: name, what });
  console.log('shot', name, '-', what);
}
// one step; a failure is noted and the run goes on with the next window
async function step(name, fn) { try { await fn(); } catch (e) { failed.push(`${name}: ${e && e.message}`); console.log('FAIL', name, e && e.message); } }
const viewport = (width, height, mobile = false, scale = 1) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
const q = (s) => JSON.stringify(s);
const closeAll = () => evalJs("document.querySelectorAll('.win .tbtn.close').forEach(b => b.click())").then(() => sleep(400));
const openIcon = async (idOrLabel) => {
  const ok = await evalJs(`(() => { const b = document.querySelector('.dicon[data-id=' + ${q(idOrLabel)} + ']') || [...document.querySelectorAll('.dicon')].find(x => x.textContent.includes(${q(idOrLabel)})); if (!b) return false; b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  if (!ok) throw new Error('no desktop icon ' + idOrLabel);
  await sleep(1400);
};
const maxTop = () => evalJs("(() => { const w = [...document.querySelectorAll('.win')].pop(); const b = w && w.querySelector('.tbtn[title=最大化]'); if (b && !w.classList.contains('max') && !w.classList.contains('maxed')) b.click(); return !!b; })()").then(() => sleep(500));
const clickText = async (sel, text, root = 'document') => {
  const ok = await evalJs(`(() => { const b = [...${root}.querySelectorAll(${q(sel)})].find(x => x.textContent.trim().includes(${q(text)})); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`nothing ${sel} with "${text}"`);
  await sleep(900);
};
async function load(prefs = {}, w = 1440, hgt = 900, mobile = false) {
  await viewport(w, hgt, mobile, mobile ? 2 : 1);
  await call('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/login` }); await sleep(600);
  await evalJs(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('ame.')) localStorage.removeItem(k); const p = ${JSON.stringify(prefs)}; for (const [k, v] of Object.entries(p)) localStorage.setItem('ame.' + k, JSON.stringify(v)); localStorage.setItem('ame.machine', '"dell97"'); localStorage.setItem('ame.scale', '"s"'); })()`);
  await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(3200);
}

(async () => {
  let chrome, srv;
  try {
    const zp = await zot.listen(), sp = await src.listen();
    writeConfig(zp, sp);
    srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
    if (!await until(async () => (await api('GET', '/login')).status === 200, 20000)) throw new Error('server did not start on ' + PORT);
    const lg = await api('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    cookie = String(lg.h['set-cookie'] || '').split(';')[0];
    if (!cookie) throw new Error('login failed');

    // computers online with their sessions; two registered but offline (dell211, panasonic)
    for (const [n, a] of Object.entries(AGENTS)) await connectAgent(n, a);
    const disk = (usedGb, totalGb, mount = '/') => ({ usedGb, totalGb, pct: Math.round(usedGb / totalGb * 100), mount });
    const memo = (usedMb, totalMb) => ({ usedMb, totalMb, pct: Math.round(usedMb / totalMb * 100) });
    await infraReport('dell97', 'workstation', { uptimeSec: 12 * 86400, load1: 31.2, cpuPct: 48, mem: memo(181000, 257000), disk: disk(3100, 3700), net: { rxKbps: 820, txKbps: 96 },
      gpus: [{ name: 'NVIDIA RTX A6000', utilPct: 97, memUsedMb: 38120, memTotalMb: 49140, tempC: 78 }, { name: 'NVIDIA RTX A6000', utilPct: 3, memUsedMb: 1210, memTotalMb: 49140, tempC: 41 }],
      services: [{ name: 'ame-agent', label: '糖糖 agent', state: 'running', kind: 'systemd' }, { name: 'sshd', label: 'sshd', state: 'running', kind: 'systemd' }],
      containers: [{ name: 'jupyter', state: 'running', status: 'Up 2 days', ports: '8888', compose: 'jupyter', upgrade: { state: 'rolledback', msg: '新版本启动失败，已回退到旧版本', from: 'aaa', to: 'bbb', at: now } }, { name: 'scratch', state: 'stopped', status: 'Exited (0)' }] });
    await infraReport('remote3090', 'workstation', { uptimeSec: 3 * 86400, load1: 6.1, cpuPct: 71, mem: memo(52000, 65000), disk: disk(1700, 1860), gpus: [{ name: 'NVIDIA GeForce RTX 3090', utilPct: 88, memUsedMb: 22100, memTotalMb: 24576, tempC: 74 }], services: [], containers: [] });
    await infraReport('huatanshaonian', 'workstation', { uptimeSec: 86400, load1: 2.4, cpuPct: 12, mem: memo(21000, 65000), disk: disk(820, 2000), gpus: [{ name: 'NVIDIA GeForce RTX 4070', utilPct: 6, memUsedMb: 2100, memTotalMb: 12282, tempC: 45 }],
      services: [{ name: 'local-proxy', label: '本地代理 (v2rayN :10809)', state: 'running', kind: 'port', port: 10809 }, { name: 'tailscaled', label: 'Tailscale 客户端', state: 'running', kind: 'process' }], containers: [] });
    await infraReport('nas', 'nas', { uptimeSec: 41 * 86400, load1: 1.8, cpuPct: 22, mem: memo(13800, 16000), disk: disk(31200, 43600, '/volume2'), net: { rxKbps: 12400, txKbps: 3300 },
      services: [{ name: 'synology-drive', label: 'Synology Drive', state: 'running', kind: 'port' }, { name: 'magpie', label: 'Magpie 网关', state: 'running', kind: 'port' }],
      containers: [{ name: 'windose-server', state: 'running', status: 'Up 5 days', compose: 'windose' }, { name: 'zotero-webdav', state: 'running', status: 'Up 12 days', compose: 'zotero' }, { name: 'llama-embed', state: 'stopped', status: 'Exited (137)' }] });
    await infraReport('aws1', 'cloud', { uptimeSec: 90 * 86400, load1: 0.2, cpuPct: 4, mem: memo(700, 1900), disk: disk(14, 30), services: [{ name: 'nginx', label: 'nginx', state: 'running', kind: 'systemd' }, { name: 'xray', label: 'xray', state: 'running', kind: 'systemd' }], containers: [] });
    await infraReport('openwrt', 'router', { uptimeSec: 20 * 86400, load1: 0.4, cpuPct: 9, mem: memo(180, 512), disk: disk(0.1, 0.5), services: [{ name: 'tailscale', label: 'Tailscale 子网路由', state: 'running', kind: 'process' }], containers: [] });

    // plans
    const todo = (d) => api('POST', '/api/todos/add', d);
    await todo({ text: '投稿 TAP 小修回复', project: 'RCS 论文', due: day(2), star: true, steps: ['逐条回复审稿意见', '补充 FEKO 对比图', '重新编译 PDF'] });
    await todo({ text: '双站 RCS 与 FEKO 对比', project: 'CEM 求解器', due: day(5), steps: ['锥球 3 GHz', '杏仁体 10 GHz'] });
    await todo({ text: '续费 aws1', project: '', due: day(-1) });
    await todo({ text: 'Windose 美术风格统一方案拍板', project: 'AmeTyping', due: day(1) });

    // the AmeMesh project: master, workers, verifier; milestone tasks; the board
    const proj = (await api('POST', '/api/mesh/project', { name: 'AmeTyping-Overhaul', mode: 'master-worker', goal: '全栈 GUI 美术风格统一：Windose 98 复古灵魂 + 现代高密度信息承载',
      stopCondition: '05-gui-style-spec.md 经用户拍板后停下', autoResumeClosed: true,
      workspaces: [{ machine: 'huatanshaonian', path: 'D:/ametyping-refactor', mode: 'rw', tag: 'repo' }, { machine: 'dell97', path: '/home/dell/CEM_Solver', mode: 'ro', tag: 'solver' }] })).j;
    const pid = proj && proj.project && proj.project.id;
    if (pid) {
      const addNode = async (d) => ((await api('POST', '/api/mesh/node', { projectId: pid, ...d })).j || {}).node || {};
      const master = await addNode({ machine: 'huatanshaonian', sessionId: 'cccccccc-1111-2222-3333-444444444401', role: 'master', label: '主控会话', tool: 'claude', goal: '统筹 GUI 改造', stopCondition: '用户拍板' });
      const designer = await addNode({ machine: 'huatanshaonian', sessionId: 's-designer', role: 'worker', label: 'designer-opus-gui', tool: 'claude', goal: '真实截图采样与风格规范', stopCondition: '05-gui-style-spec.md 提交后停下', cwd: 'D:/ametyping-refactor' });
      const css = await addNode({ machine: 'remote3090', sessionId: 'bbbbbbbb-1111-2222-3333-444444444401', role: 'worker', label: 'css-refactor', tool: 'codex', goal: '按 Token 规范替换硬编码色值', stopCondition: 'check-static 通过' });
      const verifier = await addNode({ machine: 'dell97', sessionId: 'aaaaaaaa-1111-2222-3333-444444444401', role: 'verifier', label: 'verifier', tool: 'kiro', goal: '对比基线截图验收', stopCondition: '逐页验收完成' });
      await addNode({ machine: 'dell211', sessionId: 's-offline', role: 'worker', label: 'icon-curator', tool: 'agy', goal: '图标去重', stopCondition: '图标映射表落地' });
      const task = async (d) => ((await api('POST', '/api/mesh/task', { action: 'add', projectId: pid, ...d })).j || {}).task || {};
      const t0 = await task({ title: 'M0 基线截图采样', ownerNodeId: designer.id, boundaries: ['remote/test/overhaul-gui-shots.js'], doneWhen: ['全部窗口截图'] });
      const t1 = await task({ title: 'M0 风格规范 05-gui-style-spec.md', ownerNodeId: designer.id, blockedBy: [t0.id] });
      const t2 = await task({ title: 'M1 Token 落地：projects.css / infra.css', ownerNodeId: css.id, blockedBy: [t1.id], boundaries: ['remote/public/css/projects.css', 'remote/public/css/infra.css'] });
      await task({ title: 'M1 图标去重与重配', ownerNodeId: 's-offline' });
      await task({ title: 'M2 逐页截图验收', ownerNodeId: verifier.id, blockedBy: [t2.id] });
      if (t0.id) await api('POST', '/api/mesh/task', { action: 'update', projectId: pid, taskId: t0.id, status: 'done' });
      if (t1.id) await api('POST', '/api/mesh/task', { action: 'update', projectId: pid, taskId: t1.id, status: 'in_progress' });
      const post = (nodeId, text, extra = {}) => api('POST', '/api/mesh/board/post', { projectId: pid, nodeId, text, ...extra });
      await post(master.id, '@designer-opus-gui 先做全栈真实截图，再出 Token 规范；严禁改业务 CSS。');
      await post(designer.id, '基线截图 62 张已生成，正在逐张审阅。发现 projects.css 有 197 处硬编码色值，夜灯下冷暖打架。');
      await post(css.id, '收到，等 #2 的 Token 表定稿后我从 projects.css 开始替换。');
      await post(verifier.id, '@css-refactor 替换后请对照 #2 的基线图逐页给我验收。');
      await api('POST', '/api/mesh/node', { projectId: pid, nodeId: designer.id, id: designer.id, reviewStatus: 'waiting_review' });
      // a compute job on dell97's spare GPU
      await api('POST', '/api/mesh/queue', { op: 'submit', machine: 'dell97', command: 'python sweep.py --f0 2e9 --f1 18e9 --n 161', resource: 'gpu', gpus: 1, priority: 'normal', projectId: pid, label: 'RCS 扫频' });
    } else failed.push('mesh project not created: ' + JSON.stringify(proj));

    // literature: library mirrored, profile confirmed, the day's push (bounded; the windows are shot either way)
    await step('literature setup', async () => {
      const lit = async (name, fn, ms) => { if (!await until(fn, ms)) throw new Error(name + ' did not happen'); };
      await lit('library mirrored', async () => (((await api('GET', '/api/lit')).j || {}).zotero || {}).items === 2, 60000);
      await api('POST', '/api/lit/profile/save', { story: '再入飞行器气动隐身：我在算等离子体鞘套对 RCS 的影响，卡在电子密度剖面怎么取，也缺验证数据。' });
      await api('POST', '/api/lit/profile/organize');
      await lit('profile organized', async () => { const r = (await api('GET', '/api/lit/profile')).j || {}; return r.profile && r.profile.organizedAt && !(r.state || {}).running; }, 90000);
      await api('POST', '/api/lit/profile/fill');
      const pr = await until(async () => { const r = (await api('GET', '/api/lit/profile')).j || {}; return r.profile && r.profile.filledAt && !(r.state || {}).running && r.profile; }, 90000);
      if (pr) await api('POST', '/api/lit/profile/save', { questions: pr.questions, confirm: true });
      await api('POST', '/api/lit/zotero/authorize');
      await api('POST', '/api/lit/feed/run');
      await lit('the day\'s push', async () => { const f = (await api('GET', '/api/lit/feed')).j || {}; return f.status && !f.status.running && (f.items || []).length; }, 120000);
    });

    // ---------- Chrome ----------
    chrome = cp.spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(T, 'chrome')}`,
      '--no-first-run', '--no-proxy-server', '--allow-file-access-from-files', '--hide-scrollbars=false', 'about:blank'], { stdio: 'ignore' });
    if (!await until(async () => { try { await getJSON(`http://127.0.0.1:${CDP}/json/version`); return true; } catch { return false; } }, 15000, 200)) throw new Error('Chrome CDP did not start on ' + CDP);
    const tab = await getJSON(`http://127.0.0.1:${CDP}/json/new?about:blank`, 'PUT');
    ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
    let where = '';
    ws.on('message', (m) => {
      const o = JSON.parse(m);
      if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); }
      if (o.method === 'Runtime.exceptionThrown') errors.push(`[${where}] exception: ` + String(o.params.exceptionDetails.exception && o.params.exceptionDetails.exception.description || o.params.exceptionDetails.text).slice(0, 300));
      if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push(`[${where}] console: ` + o.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error' && !/favicon/.test(o.params.entry.url || '')) errors.push(`[${where}] log: ` + o.params.entry.text.slice(0, 200) + ' ' + (o.params.entry.url || ''));
    });
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    const [cname, cval] = cookie.split('=');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });

    // ===== 1. the desktop (Windose, the default look) =====
    where = 'desktop';
    await load();
    await step('desktop', async () => {
      await shot('01-desktop-boot.png', '登录后的默认桌面：糖糖看板自动打开，左侧图标、右侧网上邻居、桌面挂件、任务栏');
      await closeAll(); await sleep(600);
      await shot('02-desktop-clean.png', '关掉所有窗口的桌面：图标列、桌面挂件（计划/Magpie/待确认）、网上邻居面板、任务栏托盘');
      await evalJs("document.querySelector('#startbtn').click()"); await sleep(600);
      await shot('03-desktop-startmenu.png', '开始菜单展开（应用列表 + 网上邻居 + 注销）');
      await evalJs("document.querySelector('#startbtn').click()"); await sleep(300);
      const icons = await evalJs("[...document.querySelectorAll('.dicon')].map(b => b.dataset.id + ':' + b.querySelector('img').getAttribute('src')).join('\\n')");
      manifest.push({ file: '(data)', what: 'desktop icons', data: icons });
    });

    // ===== 2. core windows =====
    const W = [
      ['dashboard', '10-dashboard', '糖糖看板：会话列表 + 会话详情', async () => { await evalJs(`(() => { const c = [...document.querySelectorAll('.dash .card')].find(x => x.textContent.includes('MLFMA')); c && c.click(); })()`); await sleep(1500); }],
      ['projects', '20-projects', '项目管理（默认页签）', null],
      ['infra', '30-infra-topo', '网络与设备：互联拓扑', null],
      ['literature', '40-lit-feed', '文献：今日推送', null],
      ['knowledge', '50-knowledge', '记忆与存档', null],
      ['reports', '51-reports', '工作日报', null],
      ['todo', '52-todo', '重要计划', null],
      ['board', '53-board', '画板', null],
      ['mail', '54-mail', '邮件', async () => { await evalJs("(() => { const r = document.querySelector('.ml-row, .mail-row, .ml-list > *'); r && r.click(); })()"); await sleep(800); }],
      ['calendar', '55-calendar', '日历', null],
      ['mycomputer', '56-mycomputer', '我的电脑（当前电脑没开放文件浏览时的说明窗）', null],
      ['magpie', '57-magpie', 'Magpie 用量', null],
      ['notepad', '58-notepad', '记事本', null],
    ];
    for (const [icon, name, what, after] of W) {
      where = name;
      await step(name, async () => {
        await closeAll();
        await openIcon(icon);
        await shot(`${name}-window.png`, what + '（默认窗口大小）');
        await maxTop();
        if (after) await after();
        await sleep(500);
        await shot(`${name}-max.png`, what + '（最大化）');
      });
    }
    // projects: every tab, the selected project
    where = 'projects-tabs';
    await step('projects tabs', async () => {
      await closeAll(); await openIcon('projects'); await maxTop();
      await evalJs("(() => { const i = [...document.querySelectorAll('.pm-item')].find(x => x.textContent.includes('Overhaul')); i && i.click(); })()"); await sleep(1000);
      const tabs = [['研究与计算', '21-projects-research'], ['黑板与任务', '22-projects-board'], ['协同拓扑', '23-projects-topo'], ['角色与模型池', '24-projects-roles'], ['跨机目录', '25-projects-vfs'], ['触发器', '26-projects-events']];
      for (const [label, name] of tabs) {
        await step(name, async () => { await clickText('.pm-tab', label); await sleep(700); await shot(name + '.png', '项目管理 › ' + label); });
      }
      // the topology: the graph view if the overview offers one
      await step('23b-projects-topo-graph', async () => {
        await clickText('.pm-tab', '协同拓扑');
        const sw = await evalJs("(() => { const b = [...document.querySelectorAll('button')].find(x => /拓扑图|关系图|图谱|画布/.test(x.textContent)); if (!b) return false; b.click(); return b.textContent; })()");
        if (sw) { await sleep(900); await shot('23b-projects-topo-graph.png', '项目管理 › 协同拓扑：切到图（' + sw + '）'); }
      });
    });
    // infra: a node's details, the compute panel
    where = 'infra';
    await step('infra details', async () => {
      await closeAll(); await openIcon('infra'); await maxTop();
      await evalJs("(() => { const n = [...document.querySelectorAll('.inf-node')].find(x => x.textContent.includes('dell97')); n && n.click(); })()"); await sleep(900);
      await shot('31-infra-node.png', '网络与设备：选中 dell97（GPU、容器、升级失败红标）');
      await evalJs("(() => { const n = [...document.querySelectorAll('.inf-node')].find(x => x.textContent.includes('群晖')); n && n.click(); })()"); await sleep(900);
      await shot('31b-infra-nas.png', '网络与设备：选中 NAS（容器列表）');
      await clickText('button', '算力'); await sleep(1500);
      await shot('32-infra-compute.png', '网络与设备 › 算力调度面板（GPU 卡片、NUMA、作业队列、Colab/曙光 Provider）');
    });
    // literature tabs
    where = 'literature';
    await step('literature tabs', async () => {
      await closeAll(); await openIcon('literature'); await maxTop();
      for (const [tabId, label, name] of [['stream', '速览流', '41-lit-stream'], ['library', '文献库', '42-lit-library'], ['cards', '卡片库', '43-lit-cards'], ['kb', '知识库', '44-lit-kb'], ['profile', '画像', '45-lit-profile']]) {
        await step(name, async () => { await evalJs(`document.querySelector('.lit-tab[data-tab=${tabId}]').click()`); await sleep(1300); await shot(name + '.png', '文献 › ' + label); });
      }
    });
    // the dashboard: a session waiting for a permission
    where = 'dashboard-perm';
    await step('dashboard perm', async () => {
      await closeAll(); await openIcon('dashboard'); await maxTop();
      await evalJs(`(() => { const c = [...document.querySelectorAll('.dash .card')].find(x => x.textContent.includes('RCS 扫频')); c && c.click(); })()`); await sleep(1500);
      await shot('11-dashboard-permission.png', '糖糖看板：等待确认的会话（权限卡片）');
    });

    // ===== 3. the control panel =====
    where = 'control';
    await step('control', async () => {
      await closeAll(); await openIcon('control');
      await evalJs("(() => { const b = document.querySelector('.cp-back'); b && getComputedStyle(b).display !== 'none' && b.click(); })()"); await sleep(500);
      await shot('60-control-home.png', '控制面板首页（11 项及图标）');
      await maxTop();
      for (const [label, name] of [['显示属性', '61-control-display'], ['AI 模型', '62-control-ai'], ['MCP', '63-control-mcp'], ['电脑', '64-control-computers'], ['通知', '65-control-notify']]) {
        await step(name, async () => { await clickText('.cp-item', label); await sleep(800); await shot(name + '.png', '控制面板 › ' + label); });
      }
      await clickText('.cp-item', 'Skill 与协同');
      for (const [tabId, label, n] of [['skills', 'Skill 管理', '66a'], ['roles', '角色提示词', '66b'], ['pools', '全局模型池', '66c'], ['machines', '机器角色备忘', '66d'], ['fleet', '设备与 Harness', '66e']]) {
        await step(n, async () => { await evalJs(`document.querySelector('.skp-tab[data-tab=${tabId}]').click()`); await sleep(1100); await shot(`${n}-control-skills-${tabId}.png`, '控制面板 › Skill 与协同 › ' + label); });
      }
    });

    // ===== 4. looks and shades =====
    const looks = [
      ['70-win98', { theme: 'win98' }, 'Windows 标准（Win98 灰）外观'],
      ['72-night', { 'shade.day': { windose: 'night' } }, 'Windose · 深夜（暗色色调）'],
      ['74-nightlight', { nl: { mode: 'on', level: 0.7 } }, 'Windose · 夜灯 70%'],
      ['76-win98-green', { theme: 'win98', 'shade.day': { win98: 'green' } }, 'Windows 标准 · 豆沙绿（护眼）'],
      ['78-win98-nightlight', { theme: 'win98', nl: { mode: 'on', level: 0.7 } }, 'Windows 标准 · 夜灯 70%'],
    ];
    for (const [pre, prefs, what] of looks) {
      where = pre;
      await step(pre, async () => {
        await load(prefs);
        await closeAll();
        await shot(`${pre}-desktop.png`, what + '：桌面');
        await openIcon('projects'); await maxTop();
        await evalJs("(() => { const i = [...document.querySelectorAll('.pm-item')].find(x => x.textContent.includes('Overhaul')); i && i.click(); })()"); await sleep(700);
        await step(pre + ' projects board', async () => { await clickText('.pm-tab', '黑板与任务'); await shot(`${pre}-projects-board.png`, what + '：项目管理 › 黑板与任务'); });
        await step(pre + ' projects topo', async () => { await clickText('.pm-tab', '协同拓扑'); await shot(`${pre}-projects-topo.png`, what + '：项目管理 › 协同拓扑'); });
        await closeAll(); await openIcon('infra'); await maxTop();
        await evalJs("(() => { const n = [...document.querySelectorAll('.inf-node')].find(x => x.textContent.includes('dell97')); n && n.click(); })()"); await sleep(800);
        await shot(`${pre}-infra.png`, what + '：网络与设备');
        await step(pre + ' compute', async () => { await clickText('button', '算力'); await sleep(1200); await shot(`${pre}-infra-compute.png`, what + '：算力调度'); });
        await closeAll(); await openIcon('dashboard'); await maxTop();
        await evalJs(`(() => { const c = [...document.querySelectorAll('.dash .card')].find(x => x.textContent.includes('MLFMA')); c && c.click(); })()`); await sleep(1200);
        await shot(`${pre}-dashboard.png`, what + '：糖糖看板');
        await closeAll(); await openIcon('control'); await sleep(600);
        await shot(`${pre}-control.png`, what + '：控制面板');
      });
    }

    // ===== 5. the phone (390 x 844) =====
    where = 'phone';
    await step('phone', async () => {
      await load({}, 390, 844, true);
      await closeAll();
      await shot('80-phone-desktop.png', '手机 390×844：桌面');
      await evalJs("document.querySelector('#startbtn').click()"); await sleep(600);
      await shot('81-phone-startmenu.png', '手机：开始菜单');
      await evalJs("document.querySelector('#startbtn').click()"); await sleep(300);
      await evalJs("document.querySelector('#netbtn') && document.querySelector('#netbtn').click()"); await sleep(600);
      await shot('82-phone-netpanel.png', '手机：网上邻居');
      for (const [ic, name, what] of [['dashboard', '83-phone-dashboard', '糖糖看板'], ['projects', '84-phone-projects', '项目管理'], ['infra', '85-phone-infra', '网络与设备'], ['literature', '86-phone-literature', '文献'], ['control', '87-phone-control', '控制面板']]) {
        await step(name, async () => { await load({}, 390, 844, true); await closeAll(); await openIcon(ic); await sleep(800); await shot(name + '.png', '手机：' + what); });
      }
      await step('84b-phone-projects-board', async () => {
        await evalJs("document.querySelectorAll('.win .tbtn.close').forEach(b => b.click())"); await openIcon('projects');
        await evalJs("(() => { const i = [...document.querySelectorAll('.pm-item')].find(x => x.textContent.includes('Overhaul')); i && i.click(); })()"); await sleep(700);
        await clickText('.pm-tab', '黑板与任务'); await shot('84b-phone-projects-board.png', '手机：项目管理 › 黑板与任务');
      });
    });

    // ===== 6. the pet's bubble (Electron app/bubble.html, its IPC stubbed) =====
    where = 'bubble';
    await step('bubble', async () => {
      await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__h = {}; window.bubble = new Proxy({}, { get: (_, k) => k.startsWith('on') ? (fn) => { window.__h[k] = fn; } : (...a) => (k === 'decidePermission' || k === 'send' ? Promise.resolve({ ok: true }) : undefined) });` });
      const url = pathToFileURL(BUBBLE).href;
      // (the pet's own state names: thinking / reading / message are 进行中; t0 is when the session started)
      const sess = (o) => ({ provider: 'claude', steps: 10, t0: now - 14 * 60e3, last: now - 30e3, via: 'terminal', permissions: [], ...o });
      const S = [
        sess({ id: 's1', label: 'MLFMA 预条件调优', project: 'CEM_Solver', state: 'thinking', model: 'claude-opus-5-5', lines: [{ text: 'Read src/mlfma/precond.py', t: now - 200e3, type: 'tool' }, { text: 'Bash pytest tests/test_precond.py -q', t: now - 60e3, type: 'tool' }, { text: '块对角预条件已接入，迭代数 412 → 96', t: now - 20e3, type: 'message' }] }),
        sess({ id: 's2', label: '文献 PDF 解析', project: 'ametyping', provider: 'codex', state: 'done', lines: [{ text: '120 篇 PDF 解析完成', t: now - 600e3, type: 'done' }] }),
        sess({ id: 's3', label: 'RCS 扫频批处理', project: 'CEM_Results', state: 'idle', lines: [] }),
        sess({ id: 's4', label: 'GUI 风格会诊', project: 'ametyping-refactor', provider: 'opencode', ai: 'anthropic', state: 'reading', lines: [{ text: '读取截图 37/62', t: now - 5e3, type: 'message' }] }),
      ];
      const fire = (k, d) => evalJs(`window.__h[${q(k)}] && window.__h[${q(k)}](${JSON.stringify(d)})`);
      await viewport(600, 280); await call('Page.navigate', { url }); await sleep(1200);
      await fire('onState', { sessions: S, changedId: 's1', mode: 'log', sound: false }); await sleep(500);
      await shot('90-bubble-log.png', '桌宠气泡 600×280：会话卡片列表 + 选中会话的日志');
      const perm = { id: 'p1', provider: 'claude', tool: 'Bash', cwd: '/home/dell/CEM_Results', always: 'Bash(python sweep.py:*)', input: { command: 'python sweep.py --f0 2e9 --f1 18e9 --n 161 --gpu 0', description: '启动 RCS 扫频批处理' } };
      await viewport(600, 420); await call('Page.navigate', { url }); await sleep(1000);
      await fire('onState', { sessions: [S[0], { ...S[2], state: 'waiting', permissions: [perm], lines: [{ text: '等待确认：Bash', t: now - 5e3, type: 'waiting' }] }, S[1]], changedId: 's3', mode: 'log', sound: false }); await sleep(500);
      await shot('91-bubble-permission.png', '桌宠气泡：权限确认卡片（允许 / 总是允许 / 拒绝）');
      const ask = { id: 'p2', provider: 'claude', tool: 'AskUserQuestion', ask: true, input: { questions: [{ header: '配色', question: '图 3-4 用哪套配色？', multiSelect: false, options: [{ label: '色盲安全', description: 'Okabe-Ito 八色' }, { label: '期刊默认', description: 'IEEE 灰度友好' }, { label: 'Windose 粉青', description: '和桌面一致' }] }] } };
      await call('Page.navigate', { url }); await sleep(1000);
      await fire('onState', { sessions: [{ ...S[3], state: 'waiting', permissions: [ask] }, S[0]], changedId: 's4', mode: 'log', sound: false }); await sleep(500);
      await shot('92-bubble-ask.png', '桌宠气泡：Claude 提问卡片（选项按钮 + 自填）');
      await viewport(680, 460); await call('Page.navigate', { url }); await sleep(1000);
      await fire('onState', { sessions: S, changedId: 's1', mode: 'chat', sound: false }); await sleep(300);
      await fire('onChat', { id: 's1', msgs: [
        { role: 'user', text: '把 MLFMA 的块对角预条件接进 CuPy 求解器，近场阈值 0.2λ。', t: now - 3 * 3600e3 },
        { role: 'assistant', text: '好的。先看近场矩阵组装：\n\n```python\nZ_near = assemble_near(mesh, k0, thresh=0.2 * lam)\nM = block_diag_inverse(Z_near, block=64)\n```\n\n我会把 **每个叶子盒** 的自作用块求逆后作为预条件。', t: now - 2.9 * 3600e3 },
        { role: 'assistant', items: [{ type: 'tool', name: 'Edit', input: { file_path: 'src/mlfma/precond.py' } }], text: '', t: now - 2.8 * 3600e3 },
        { role: 'assistant', text: '改好了：锥球 3 GHz 迭代 412 → 96，杏仁体 10 GHz 1280 → 233。残差曲线已存到 `results/precond_cmp.npz`。', t: now - 20e3 }] }); await sleep(600);
      await shot('93-bubble-chat.png', '桌宠气泡 680×460：常驻对话模式（Markdown、代码块、回复框）');
      await viewport(600, 42); await evalJs("document.body.classList.add('collapsed'); document.querySelector('#ub').classList.add('on'); document.querySelector('#ubn').textContent = '2'"); await sleep(300);
      await shot('94-bubble-collapsed.png', '桌宠气泡：折叠成标题条（未读红点）');
    });

    // ===== 7. icon contact sheet: the icons now used for several things, next to candidates from the Win98 set =====
    where = 'icons';
    await step('icon sheet', async () => {
      if (!fs.existsSync(W98)) { failed.push('icon sheet skipped: no ' + W98); return; }
      const all = fs.readdirSync(W98);
      const size = (f) => { try { return fs.readFileSync(path.join(W98, f)).readUInt32BE(16); } catch { return 0; } };
      // the 32 px picture of an icon in the Win98 set (its -N suffixes are not the same size from icon to icon)
      const pick = (n) => all.filter((f) => f === n + '.png' || (f.startsWith(n + '-') && /^\d+\.png$/.test(f.slice(n.length + 1)))).find((f) => size(f) === 32);
      const cur = (n) => pathToFileURL(path.join(R, 'public', 'icons', n + '.png')).href;
      const cell = (src, label, note = '') => `<figure><img src="${src}"><figcaption>${label}${note ? `<small>${note}</small>` : ''}</figcaption></figure>`;
      const rows = ICON_ROWS.map(([what, now, cands]) => `<tr><th>${what}</th><td class="now">${cell(cur(now), now, '现用')}</td><td>${
        cands.map((c) => { const f = pick(c); return f ? cell(pathToFileURL(path.join(W98, f)).href, c, f.replace(/\.png$/, '').slice(c.length)) : cell('', c, '缺'); }).join('')}</td></tr>`).join('');
      const html = `<!doctype html><meta charset="utf-8"><style>body{margin:12px;font:12px "Microsoft YaHei UI",sans-serif;background:#fff8ff;color:#2a1f5e}
        table{border-collapse:collapse}th,td{border:1px solid #c9b8f0;padding:6px;vertical-align:top}th{text-align:left;width:150px;background:#f1e6fb}
        td.now{background:#fff3f3}figure{display:inline-block;margin:0 6px 4px 0;width:92px;text-align:center}img{width:32px;height:32px;image-rendering:pixelated}
        figcaption{font-size:11px;word-break:break-all}small{display:block;color:#8a7aa8}</style>
        <h3>图标去重：现用（红底）与 Win98 图标库候选（32 px）</h3><table>${rows}</table>`;
      const file = path.join(T, 'icons.html'); fs.writeFileSync(file, html);
      await viewport(1100, 1200); await call('Page.navigate', { url: pathToFileURL(file).href }); await sleep(1200);
      const hgt = await evalJs('document.documentElement.scrollHeight');
      await viewport(1100, Math.min(4000, hgt + 20)); await sleep(300);
      await shot('99-icon-candidates.png', '图标去重对比表：一图多用的现用图标与 windows98-icons 候选');
    });
    ws.close();
  } catch (e) { failed.push('script: ' + (e && e.stack)); }
  finally {
    for (const s of sockets) try { s.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { srv && srv.kill(); } catch {}
    try { magpieSrv.close(); zot.close && zot.close(); src.close && src.close(); } catch {}
    await sleep(800);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    const shots = manifest.filter((m) => m.file.endsWith('.png'));
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), out: OUT, shots: manifest, failed, pageErrors: [...new Set(errors)] }, null, 2));
    console.log(errors.length ? `page errors (${new Set(errors).size} distinct):\n` + [...new Set(errors)].slice(0, 40).join('\n') : 'no page errors');
    if (failed.length) console.log('FAILED STEPS:\n' + failed.join('\n'));
    console.log(`== ${shots.length} shots in ${OUT}`);
    process.exit(shots.length >= 40 && !failed.some((f) => f.startsWith('script:')) ? 0 : 1);
  }
})();
