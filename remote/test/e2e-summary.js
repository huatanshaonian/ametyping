// e2e: 日报. Part 1 checks the schedule (4:30, a quiet half hour, retry after a failure, drafts) and the condensing /
// hints on their own; part 2 runs server + agent + a fake codex (fake-codex.js): transcripts with files, a task list,
// a plan and repeated titles become a draft report; important items (重要计划) are checked and the done one ticked off.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createScheduler, dayOf } = require(R + '/server/summary/scheduler');
const { createReports } = require(R + '/server/summary/reports');
const { digest, absPath } = require(R + '/server/summary/digest');
const { createClassifier } = require(R + '/server/summary/classify');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-summary-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 600)}`); };
const at = (s) => new Date(s).getTime();

async function part1() {
  // ---- schedule ----
  const reports = createReports(path.join(T, 'sched'));
  let now = at('2026-10-01T03:00:00'), act = now, calls = [], failing = false;
  const store = { lastActivity: () => act };
  const generate = async (job) => { calls.push(job); if (failing) throw new Error('proxy down'); return {}; };
  const s = createScheduler({ reports, store, generate, tickMs: 0, now: () => now });
  ok('first start begins at the last 4:30 (no report of the past)', reports.state().lastTo === at('2026-09-30T04:30:00'), reports.state());
  ok('before 4:30 nothing is due', (await s.tick()) === 'done');
  now = at('2026-10-01T04:40:00'); act = at('2026-10-01T04:35:00');
  ok('after 4:30 but still working: waits', (await s.tick()) === 'busy');
  act = at('2026-10-01T04:05:00');
  ok('quiet for 30 minutes: writes the report', (await s.tick()) === 'ran' && calls.length === 1);
  ok('it covers since the last report, filed under the day that ended', calls[0].from === at('2026-09-30T04:30:00') && calls[0].to === now && calls[0].date === '2026-09-30', calls[0]);
  ok('then nothing more that day', (await s.tick()) === 'done' && reports.state().lastTo === now);
  now = at('2026-10-02T05:00:00'); act = at('2026-10-02T01:00:00'); failing = true;
  await s.tick();
  ok('a failure keeps the start and shows the error', reports.state().lastTo === at('2026-10-01T04:40:00') && s.status().lastError === 'proxy down', s.status());
  now = at('2026-10-02T05:10:00');
  ok('retried only after half an hour', (await s.tick()) === 'retry-wait');
  now = at('2026-10-02T05:31:00'); failing = false;
  ok('retry succeeds', (await s.tick()) === 'ran' && reports.state().lastTo === now && !s.status().lastError);
  const before = reports.state().lastTo;
  now = at('2026-10-02T15:00:00');
  s.draft(); await sleep(50);
  ok('a draft covers since the last report and does not move the schedule', calls[calls.length - 1].draft && calls[calls.length - 1].from === before && reports.state().lastTo === before);

  // ---- 补录: past days without a report, up to where the scheduled ones begin ----
  const rb = createReports(path.join(T, 'backfill'));
  let bnow = at('2026-10-10T15:00:00'); const bcalls = []; let bfail = 0;
  const bgen = async (job) => { bcalls.push(job); if (bfail) { bfail--; throw new Error('proxy down'); } return {}; };
  const sb = createScheduler({ reports: rb, store: { lastActivity: () => 0 }, generate: bgen, tickMs: 0, now: () => bnow });
  rb.save({ date: '2026-10-07', headline: 'x', open: [] });
  const bd = sb.backfillDays(5);
  ok('backfill: the days before the scheduled reports, skipping ones that have a report', bd.map((j) => j.date).join() === '2026-10-05,2026-10-06,2026-10-08,2026-10-09', bd.map((j) => j.date));
  ok('backfill: each day 4:30 to 4:30, brief', bd[0].from === at('2026-10-05T04:30:00') && bd[0].to === at('2026-10-06T04:30:00') && bd.every((j) => j.brief));
  const started = sb.backfill(5);
  for (let i = 0; i < 20 && sb.status().running; i++) await sleep(20);
  ok('backfill runs them in order', started.ok && bcalls.map((j) => j.date).join() === '2026-10-05,2026-10-06,2026-10-08,2026-10-09', bcalls.map((j) => j.date));
  bcalls.length = 0; bfail = 5;
  rb.state(); sb.backfill(5); for (let i = 0; i < 20 && sb.status().running; i++) await sleep(20);
  ok('two failures in a row stop it (proxy down)', bcalls.length === 2 && /proxy down/.test(sb.status().lastError), [bcalls.length, sb.status().lastError]);
  rb.save({ date: '2026-10-09', headline: 'brief', brief: true, open: [{ text: 'old', status: 'open' }] });
  ok('a backfilled report is not what the next one continues from', rb.latest().date === '2026-10-07', rb.latest());

  // ---- 周报: from the week's daily reports; after a Sunday's report the week follows, and the pet hears of it ----
  const { createWeekly, mondayOf } = require(R + '/server/summary/weekly');
  const rw = createReports(path.join(T, 'weekly'));
  const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09', '2026-10-11'];      // Mon..Sun, some days off
  days.forEach((d, i) => rw.save({ date: d, headline: '第' + i + '天', brief: i === 0, stats: { minutes: 60, sessions: 2 },
    projects: [{ name: 'FDTD', category: 'research', minutes: 40, summary: '推进', done: ['一步'] }, { name: '配代理', category: 'chore', minutes: 20, summary: '杂活' }],
    open: [{ text: '事' + i, status: i === 4 ? 'open' : 'done' }], artifacts: i === 2 ? [{ machine: 'pc', path: 'D:\\a.py', note: '脚本', backed: true, sha: 'x' }] : [] }));
  let wprompt = '';
  const wk = createWeekly({ reports: rw, ask: async (p) => { wprompt = p; return { headline: '这周推进 FDTD', projects: [{ name: 'FDTD', category: 'research', summary: 's', progress: ['a'] }, { name: '配代理', category: 'chore', summary: '', progress: [] }], highlights: ['h'] }; } });
  ok('mondayOf', mondayOf('2026-10-11') === '2026-10-05' && mondayOf('2026-10-05') === '2026-10-05' && mondayOf('2026-10-08') === '2026-10-05');
  ok('the finished week without a weekly report is pending', wk.pendingWeek() === '2026-10-05', wk.pendingWeek());
  const w = await wk.generateWeek('2026-10-05');
  ok('weekly numbers counted here (minutes per kind, days, chores, artifacts)', w.stats.minutes === 300 && w.stats.byCat.research === 200 && w.stats.byCat.chore === 100 &&
    w.stats.days === 5 && w.stats.chores === 5 && w.stats.artifacts === 1 && w.end === '2026-10-11', w.stats);
  ok('weekly: open items from the last day, chores not listed as projects', w.open.length === 1 && w.open[0].text === '事4' && w.projects.every((p) => p.category !== 'chore'), w);
  ok('weekly prompt: the days in order, chores only counted', /10月5日 周一（补录的简略日报）/.test(wprompt) && /10月11日 周日/.test(wprompt) && /杂活 1 件/.test(wprompt) && !/\[杂活\]/.test(wprompt), wprompt.slice(0, 600));
  ok('then nothing pending; listed and readable', !wk.pendingWeek() && rw.listWeeks()[0].start === '2026-10-05' && rw.get('week-2026-10-05').headline === '这周推进 FDTD');
  // a scheduled Sunday report: the week is written right after, and notify() fires for each
  const rs = createReports(path.join(T, 'sunday'));
  let snow = at('2026-10-12T05:30:00'); const notes = [];
  const sgen = async (job) => { rs.save({ date: job.date, headline: 'sun', stats: { minutes: 10, sessions: 1 }, projects: [], open: [] }); return {}; };
  const swk = createWeekly({ reports: rs, ask: async () => ({ headline: 'w', projects: [], highlights: [] }) });
  const ss = createScheduler({ reports: rs, store: { lastActivity: () => 0 }, generate: sgen, weekly: swk, notify: () => notes.push(snow), tickMs: 0, now: () => snow });
  rs.setState({ lastTo: at('2026-10-11T04:30:00') });
  ok('Sunday\'s report then the week, each announced', (await ss.tick()) === 'ran' && rs.has('2026-10-11') && rs.hasWeek('2026-10-05') && notes.length === 2, [rs.list(), rs.listWeeks(), notes.length]);

  // ---- condensing and hints ----
  const t0 = at('2026-10-02T09:00:00');
  const recs = [
    { role: 'user', text: '把网格加密', t: t0 },
    { role: 'tool', items: ['写入 a.py'], t: t0 + 60e3, x: { op: 'write', p: ['sub\\a.py'] } },
    { role: 'tool', items: ['运行 python a.py'], t: t0 + 120e3, x: { op: 'cmd', cmd: 'python a.py' } },
    { role: 'tool', items: ['更新任务列表'], t: t0 + 180e3, x: { op: 'todo', todos: [['加密', 'completed'], ['验证', 'pending']] } },
    { role: 'assistant', text: '好了', t: t0 + 240e3, mid: 'm1' },
    { role: 'user', text: '再看看', t: t0 + 3 * 3600e3 },                    // after a long pause
    { role: 'assistant', text: '看过了', t: t0 + 3 * 3600e3 + 300e3, mid: 'm2' },
  ];
  const d = digest({ machine: 'pc', id: 's1', cwd: 'D:\\work\\fdtd' }, recs);
  ok('relative paths made absolute (Windows)', d.files.length === 1 && d.files[0].path === 'D:\\work\\fdtd\\sub\\a.py' && d.files[0].op === 'write', d.files);
  ok('absPath keeps absolute and Linux paths', absPath('/x/y', '/home/u') === '/x/y' && absPath('b.js', '/home/u/p') === '/home/u/p/b.js');
  ok('working time skips long pauses', d.activeMin === 9, d.activeMin);
  ok('condensed text: user, folded tools, reply, task list', /我：把网格加密/.test(d.text) && /写入：a\.py · 运行：python a\.py · 更新任务列表/.test(d.text) && /\[x\] 加密；\[ \] 验证/.test(d.text), d.text);
  const hint = createClassifier([{ match: 'D:\\work', cat: 'research' }]);
  ok('folder rule', hint(d).cat === 'research');
  ok('home folder: probably a chore', hint({ cwd: 'C:\\Users\\TOP', userMsgs: 5, activeMin: 30, files: [] }).cat === 'chore');
  ok('short and no files: probably a chore', hint({ cwd: '/srv/x', userMsgs: 1, activeMin: 3, files: [] }).cat === 'chore');
  ok('otherwise no guess', hint({ cwd: '/srv/x', userMsgs: 6, activeMin: 40, files: [{}] }).cat === null);
}

async function part2() {
  const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-home-u-feko-data-fdtd'), PROJ2 = path.join(HOME, '.claude', 'projects', '-home-u');
  fs.mkdirSync(PROJ, { recursive: true }); fs.mkdirSync(PROJ2, { recursive: true });
  const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
  const PORT = 18798;
  const LOG = path.join(T, 'codex.log');
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, FAKE_CODEX_LOG: LOG };
  const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
  node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { codex: [process.execPath, path.join(__dirname, 'fake-codex.js')], model: 'gpt-6-luna', proxies: [], categories: [{ match: 'feko_data', cat: 'research' }] }; cfg.summary.at = (() => { const d = new Date(Date.now() - 6 * 3600e3); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); })();   // day boundary 6 h ago: independent of the clock
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
  const ACFG = path.join(T, 'agent.json');
  fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, scanMs: 400, petPort: 18799 }));
  // a mailbox already archived on the NAS (one message about the mesh, its key words far into the text)
  const MDIR = path.join(T, 'srv', 'data', 'mail', 'acc1'); fs.mkdirSync(MDIR, { recursive: true });
  fs.writeFileSync(path.join(MDIR, '2026-09.jsonl'), JSON.stringify({ key: 'acc1:1:5', acc: 'acc1', uid: 5, mid: '<m5@x>', date: Date.parse('2026-09-28T09:00:00'), from: { name: '导师', address: 'prof@example.edu.cn' },
    to: [], subject: '网格的事', text: '你好，' + '附上几篇文献。'.repeat(30) + '网格加密请参考 mesh_refine 的做法，周五组会讨论。', att: [] }) + '\n');
  // an earlier report with one open item (carried over)
  const RDIR = path.join(T, 'srv', 'data', 'reports'); fs.mkdirSync(RDIR, { recursive: true });
  const yday = dayOf(Date.now() - 86400e3);
  fs.writeFileSync(path.join(RDIR, yday + '.json'), JSON.stringify({ date: yday, headline: '昨天', from: 0, to: 0, projects: [], sessions: [], stats: { minutes: 30 },
    open: [{ text: '整理参考文献', project: '论文', status: 'open', since: '2026-09-28' }, { text: '早就做完的', project: 'x', status: 'done', since: '2026-09-20' }] }));

  const now = Date.now();
  let n = 0;
  const L = (o, t, cwd) => JSON.stringify({ uuid: 'u' + (++n), cwd, timestamp: new Date(t).toISOString(), ...o }) + '\n';
  const A = '/home/u/feko_data/fdtd', tu = (name, input, t) => L({ type: 'assistant', message: { id: 'a' + n, role: 'assistant', content: [{ type: 'tool_use', id: 't' + n, name, input }] } }, t, A);
  fs.writeFileSync(path.join(PROJ, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
    L({ type: 'ai-title', aiTitle: 'FDTD 网格加密' }, now - 170e3, A) + L({ type: 'ai-title', aiTitle: 'FDTD 网格加密' }, now - 169e3, A) + L({ type: 'ai-title', aiTitle: 'FDTD 网格加密' }, now - 168e3, A) +
    L({ type: 'user', message: { role: 'user', content: '帮我把 FDTD 的网格在界面附近加密，两侧各 5 层' } }, now - 160e3, A) +
    tu('Write', { file_path: A + '/mesh_refine.py', content: 'SECRET-CONTENT' }, now - 150e3) +
    L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'TOOL-OUTPUT-XYZ' }] } }, now - 149e3, A) +
    tu('Bash', { command: 'python mesh_refine.py --layers 5', description: '运行加密脚本' }, now - 140e3) +
    tu('TodoWrite', { todos: [{ content: '加密网格', status: 'completed' }, { content: '验证收敛', status: 'pending' }] }, now - 130e3) +
    tu('ExitPlanMode', { plan: '# 网格加密计划\n1. 两侧加密\n2. 验证收敛' }, now - 120e3) +
    L({ type: 'assistant', message: { id: 'af', role: 'assistant', content: [{ type: 'text', text: '改好了，网格数从 400 增加到 460。' }] } }, now - 110e3, A));
  fs.writeFileSync(path.join(PROJ2, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'),
    L({ type: 'user', message: { role: 'user', content: '帮我配一下 git 代理' } }, now - 100e3, '/home/u') +
    L({ type: 'assistant', message: { id: 'b1', role: 'assistant', content: [{ type: 'text', text: '配好了。' }] } }, now - 95e3, '/home/u'));
  fs.writeFileSync(path.join(PROJ, 'cccccccc-1111-2222-3333-444444444444.jsonl'),
    L({ type: 'user', message: { role: 'user', content: '很长的需求 ' + '啊'.repeat(1400) } }, now - 90e3, A) +
    Array.from({ length: 50 }, (_, i) => L({ type: 'assistant', message: { id: 'c' + i, role: 'assistant', content: [{ type: 'text', text: '很长的回复 ' + '嗯'.repeat(900) }] } }, now - 85e3 + i * 1000, A)).join(''));

  // a session three days ago, for the backfill
  const OLD = now - 3 * 86400e3, PROJ3 = path.join(HOME, '.claude', 'projects', '-home-u-old');
  fs.mkdirSync(PROJ3, { recursive: true });
  const oldFile = path.join(PROJ3, 'dddddddd-1111-2222-3333-444444444444.jsonl');
  fs.writeFileSync(oldFile, L({ type: 'user', message: { role: 'user', content: '三天前的活：整理参考文献格式' } }, OLD, '/home/u/old') +
    L({ type: 'assistant', message: { id: 'd1', role: 'assistant', content: [{ type: 'text', text: '格式整理好了。' }] } }, OLD + 60e3, '/home/u/old'));
  fs.utimesSync(oldFile, new Date(OLD + 120e3), new Date(OLD + 120e3));

  const kids = [];
  const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
  const req = (method, p, body, cookie) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
      'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
    });
    r.end(data);
  });
  try {
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' }); await sleep(3000);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG });
    const code = auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000));
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code });
    let snap = null;
    for (let i = 0; i < 60; i++) { snap = (await req('GET', '/api/sessions', null, cookie)).j; const m = snap && snap.data.find((x) => x.machine === 'box'); if (m && m.sessions.length >= 3) break; await sleep(250); }
    await sleep(800);
    ok('not logged in: refused', (await req('GET', '/api/reports')).status === 401);
    // the documents are indexed in the background after the start, before anyone searches
    { const emit = process.emitWarning; process.emitWarning = () => {}; const { DatabaseSync } = require('node:sqlite'); process.emitWarning = emit; let n = 0;   // (without its experimental warning)
      for (let i = 0; i < 40 && !n; i++) { try { const db = new DatabaseSync(path.join(T, 'srv', 'data', 'search.db'), { readOnly: true }); n = db.prepare("SELECT count(*) AS n FROM docs WHERE kind = 'mail'").get().n; db.close(); } catch {} if (!n) await sleep(250); }
      ok('search index: mail indexed in the background after the start', n === 1, n); }
    // two important items: the model (fake) finds the first done
    const t1 = await req('POST', '/api/todos/add', { text: '验证网格收敛', project: 'FDTD' }, cookie);
    const t2 = await req('POST', '/api/todos/add', { text: '写论文第四章', project: '论文', due: '2026-10-20' }, cookie);
    ok('important items added', t1.j && t1.j.ok && t2.j && t2.j.ok, [t1.j, t2.j]);
    const r0 = await req('POST', '/api/report/draft', {}, cookie);
    ok('draft started', r0.j && r0.j.ok, r0.j);
    let list = null;
    for (let i = 0; i < 80; i++) { list = (await req('GET', '/api/reports', null, cookie)).j; if (list && list.draft && !list.status.running) break; await sleep(250); }
    ok('draft finished, earlier report listed', list && list.draft && list.items.some((x) => x.date === yday) && !list.status.lastError, list);
    const rep = (await req('GET', '/api/report?date=draft', null, cookie)).j || {};
    const calls = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const day = calls.find((c) => /工作日报/.test(c.prompt)) || { args: [], prompt: '' };
    ok('codex: read-only, ephemeral, the chosen model', ['exec', '--ephemeral', '--skip-git-repo-check'].every((a) => day.args.includes(a)) && day.args.join(' ').includes('-s read-only') && day.args.join(' ').includes('-m gpt-6-luna'), day.args);
    ok('the long session was summarized first', calls.length === 2 && /会话较长，以下是它的摘要/.test(day.prompt), calls.length);
    const P = day.prompt;
    ok('prompt: what you said, full file path, task list, plan', /两侧各 5 层/.test(P) && P.includes(A + '/mesh_refine.py') && /\[ \] 验证收敛/.test(P) && /写了计划「网格加密计划」/.test(P), P.slice(0, 3000));
    ok('prompt: hints (rule and home folder)', /分类提示：科研（目录规则「feko_data」）/.test(P) && /分类提示：杂活（在主目录里/.test(P), P.slice(0, 3000));
    ok('prompt: the important items to check, not yesterday\'s loose ends', /## 重要计划/.test(P) && /T1\. \[FDTD\] 验证网格收敛/.test(P) && /T2\. \[论文\] 写论文第四章（.*10-20 截止）/.test(P) && !/整理参考文献/.test(P), P.slice(0, 1500));
    ok('prompt: no file contents, no tool output', !/SECRET-CONTENT|TOOL-OUTPUT-XYZ/.test(P));
    const pr = (rep.projects || [])[0] || {};
    ok('report: project with minutes, sessions and the file written', rep.headline === '给 FDTD 加密了网格' && pr.category === 'research' && pr.sessions.length === 3 &&
      pr.files.some((f) => f.path === A + '/mesh_refine.py' && f.op === 'write' && f.machine === 'box'), rep);
    const o2 = (rep.open || []).find((o) => o.text === '验证网格收敛');
    const tl = ((await req('GET', '/api/todos', null, cookie)).j || {}).items || [];
    const d1 = tl.find((t) => t.text === '验证网格收敛'), d2 = tl.find((t) => t.text === '写论文第四章');
    ok('the item found done is ticked off with its reason; the other stays open', d1 && d1.done && d1.doneBy === 'report:' + dayOf(Date.now()) && /验证过了/.test(d1.evidence) && d2 && !d2.done, tl);
    ok('the report says which important item got done', (rep.todosDone || []).length === 1 && rep.todosDone[0].text === '验证网格收敛', rep.todosDone);
    ok('the day\'s own loose ends are listed (from today, open)', o2 && o2.status === 'open' && o2.since === dayOf(Date.now()), rep.open);
    const n1 = ((rep.sessions || [])[0] || {}).note;
    ok('per-session notes: matched by number, status and ideas kept', n1 && n1.did === '做了 S1' && n1.status === 'ongoing' && n1.open[0] === '验证收敛' && n1.ideas.length === 1 &&
      rep.sessions.every((s) => s.note && s.note.did === '做了 ' + s.key), rep.sessions.map((s) => s.note));
    ok('the day prompt asks for the notes', /notes：每个会话一条/.test(P));
    const sn = (await req('GET', '/api/report/session?machine=box&id=' + rep.sessions[0].id, null, cookie)).j || {};
    ok('one conversation: the draft first, with its note', sn.items && sn.items[0] && sn.items[0].draft && sn.items[0].note.did === '做了 S1', sn);
    ok('one conversation: unknown one is empty; not logged in refused', !((await req('GET', '/api/report/session?machine=box&id=nope', null, cookie)).j.items.length) &&
      (await req('GET', '/api/report/session?machine=box&id=x')).status === 401);
    ok('sessions: resume commands, plan linked', (rep.sessions || []).length === 3 && rep.sessions.every((s) => /claude --resume/.test(s.resume)) && rep.plans[0].session === 'S1', rep.sessions);
    // the store itself: one title line, tool details kept
    const dayDir = path.join(T, 'srv', 'data', dayOf(now - 170e3), 'box');
    const stored = fs.readFileSync(path.join(dayDir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok('repeated titles stored once', stored.filter((r) => r.role === 'title').length === 1);
    // 补录: the day of the old session gets a brief report, nothing carried in
    const bd = (await req('GET', '/api/report/backfill', null, cookie)).j;
    ok('backfill lists the past days without a report', bd && bd.days.includes(dayOf(OLD - 6 * 3600e3)) && !bd.days.includes(yday), bd);
    const b0 = await req('POST', '/api/report/backfill', {}, cookie);
    let bl = null;
    for (let i = 0; i < 120; i++) { bl = (await req('GET', '/api/reports', null, cookie)).j; if (b0.j && b0.j.ok && bl && !bl.status.running) break; await sleep(250); }
    const oldDay = dayOf(OLD - 6 * 3600e3);                            // days run from the boundary (6 h before the test started)
    const oldRep = (await req('GET', '/api/report?date=' + oldDay, null, cookie)).j || {};
    ok('the old day got a brief report of its session', oldRep.brief === true && (oldRep.sessions || []).length === 1 && oldRep.sessions[0].id === 'dddddddd-1111-2222-3333-444444444444', oldRep);
    ok('days without sessions are skipped', bl.items.filter((x) => x.brief).length === 1, bl.items);
    const calls2 = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bp = (calls2.find((c) => /补录的旧日报/.test(c.prompt)) || {}).prompt || '';
    ok('backfill prompt: brief, important items not checked against old days', /三天前的活/.test(bp) && !/重要计划/.test(bp), bp.slice(0, 400));
    // ---- search and 问一问 ----
    const s1 = (await req('GET', '/api/search?q=' + encodeURIComponent('网格 加密'), null, cookie)).j || {};
    ok('search: every word must occur, conversations found with snippets', (s1.sessions || []).some((s) => s.id === 'aaaaaaaa-1111-2222-3333-444444444444' && s.hits.length && /网格/.test(s.hits[0].snippet)), s1);
    const s2 = (await req('GET', '/api/search?q=mesh_refine', null, cookie)).j || {};
    ok('search: full paths and commands are searchable', (s2.sessions || []).some((s) => s.hits.some((x) => /mesh_refine/.test(x.snippet))), s2);
    const s3 = (await req('GET', '/api/search?q=' + encodeURIComponent('参考文献'), null, cookie)).j || {};
    ok('search: reports found too', (s3.reports || []).some((x) => x.date === yday), s3.reports);
    const s4 = (await req('GET', '/api/search?q=zzz-nothing-like-this', null, cookie)).j || {};
    ok('search: nothing found is empty', !s4.reports.length && !s4.sessions.length && !s4.artifacts.length);
    ok('search: not logged in refused', (await req('GET', '/api/search?q=x')).status === 401);
    const s5 = (await req('GET', '/api/search?q=' + encodeURIComponent('周五组会'), null, cookie)).j || {};
    ok('search: mail found by words far into its text', (s5.mail || []).length === 1 && s5.mail[0].key === 'acc1:1:5' && s5.mail[0].subject === '网格的事' && /周五组会/.test(s5.mail[0].snippet), s5.mail);
    const a0 = await req('POST', '/api/ask', { q: '网格加密的脚本在哪' }, cookie);
    let job = null;
    for (let i = 0; i < 80; i++) { job = ((await req('GET', '/api/ask', null, cookie)).j || {}).job; if (job && !job.running) break; await sleep(250); }
    ok('问一问: words from the model, answer with sources mapped back', a0.j && a0.j.ok && job && job.terms.join() === '网格,mesh' && /mesh_refine/.test(job.answer) &&
      job.sources.some((s) => s.kind === 'session' && s.id) && job.sources.some((s) => s.kind === 'report') && !job.sources.some((s) => s.ref === 'R99'), job);
    const askCall = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((c) => /根据下面找到的资料回答/.test(c.prompt)) || { prompt: '' };
    ok('问一问: the model gets the found passages', /\[C1\] 会话/.test(askCall.prompt) && /网格/.test(askCall.prompt), askCall.prompt.slice(0, 500));
    ok('问一问: found mail goes in with its whole text', /\[M1\] 邮件「网格的事」（导师/.test(askCall.prompt) && /周五组会讨论/.test(askCall.prompt), askCall.prompt.slice(0, 3000));
    ok('tool details stored (path, command, todos, plan)', stored.some((r) => r.x && r.x.op === 'write' && r.x.p[0] === A + '/mesh_refine.py') &&
      stored.some((r) => r.x && r.x.cmd === 'python mesh_refine.py --layers 5') && stored.some((r) => r.x && r.x.op === 'todo') && stored.some((r) => r.x && r.x.op === 'plan'));
  } finally {
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
  }
}

(async () => {
  try { await part1(); await part2(); } catch (e) { fail++; console.log('ERROR', e); }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
