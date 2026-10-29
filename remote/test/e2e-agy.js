// e2e: Antigravity (agy) sessions are stored like Claude Code's and Codex's (slim records,
// brain/<id>/.system_generated/logs/transcript.jsonl, subagent hierarchy, agy --conversation <id> resume),
// permission decision & ask_question, /api/commands?provider=agy, artifacts, and locate.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const { createArtifacts } = require(R + '/agent/artifacts');
const { locate } = require(R + '/agent/locate');
const { createFiles } = require(R + '/agent/files');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-agy-e2e-'));
const HOME = path.join(T, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });

// Setup custom AGY_HOME
const AGY_HOME = path.join(T, 'custom-agy-home');
const MAIN = '01a0aaaa-0000-7000-8000-000000000001';
const SUB = '01a0bbbb-0000-7000-8000-000000000002';
const ID = 'agy:' + MAIN;
const CWD = path.join(T, 'work', 'agyproj');
fs.mkdirSync(CWD, { recursive: true });

// Setup target files in CWD
const guiFile = path.join(CWD, 'gui.py');
fs.writeFileSync(guiFile, '# gui.py content\n');

// Setup brain directory structure
const mainBrainLogs = path.join(AGY_HOME, 'brain', MAIN, '.system_generated', 'logs');
const mainSubagentsDir = path.join(AGY_HOME, 'brain', MAIN, '.system_generated', 'subagents');
const subBrainLogs = path.join(AGY_HOME, 'brain', SUB, '.system_generated', 'logs');
fs.mkdirSync(mainBrainLogs, { recursive: true });
fs.mkdirSync(mainSubagentsDir, { recursive: true });
fs.mkdirSync(subBrainLogs, { recursive: true });

const at = new Date(Date.now() - 60e3).toISOString();

// Main session transcript with double-escaped Windows path in tool call
const doubleEscapedGui = guiFile.replace(/\\/g, '\\\\');
const mainTransFile = path.join(mainBrainLogs, 'transcript.jsonl');
fs.writeFileSync(mainTransFile, [
  JSON.stringify({
    step_index: 0,
    type: 'USER_INPUT',
    content: 'Model Selection: Model: gemini-2.5-pro\nActive Workspaces:\n- ' + CWD + '\n<USER_REQUEST>用 Antigravity 修改 gui.py 并运行测试</USER_REQUEST>',
    created_at: at,
    cwd: CWD,
  }),
  JSON.stringify({
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    tool_calls: [
      { name: 'write_file', args: { Path: doubleEscapedGui } },
      { name: 'run_command', args: { CommandLine: 'npm test' } },
    ],
    content: '已经修改了 gui.py 并执行测试。',
    token_usage: { input_tokens: 3200, output_tokens: 450, cache_read_tokens: 150 },
    created_at: at,
    cwd: CWD,
  }),
].join('\n') + '\n');

// Main session history title
fs.writeFileSync(
  path.join(AGY_HOME, 'history.jsonl'),
  JSON.stringify({ conversationId: MAIN, workspace: CWD, display: '修改 GUI 并测试' }) + '\n'
);

// Subagent descriptor & transcript
fs.writeFileSync(
  path.join(mainSubagentsDir, `${SUB}.json`),
  JSON.stringify({
    subagentDescriptor: { typeName: 'reviewer', role: '代码审查员' },
    workspaceUris: ['file://' + (process.platform === 'win32' ? '/' : '') + CWD.replace(/\\/g, '/')],
    state: 'RUNNING',
  })
);

fs.writeFileSync(
  path.join(subBrainLogs, 'transcript.jsonl'),
  JSON.stringify({
    step_index: 0,
    type: 'USER_INPUT',
    content: '<USER_REQUEST>审查变更</USER_REQUEST>',
    created_at: at,
    cwd: CWD,
  }) + '\n' +
  JSON.stringify({
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'read_file', args: { Path: guiFile } }],
    created_at: at,
    cwd: CWD,
  }) + '\n'
);

// Skills for AGY command suggestions isolation
const AGY_CONFIG_DIR = path.join(T, 'agy-config');
fs.mkdirSync(path.join(AGY_CONFIG_DIR, 'skills', 'agy-check'), { recursive: true });
fs.writeFileSync(path.join(AGY_CONFIG_DIR, 'skills', 'agy-check', 'SKILL.md'), '---\nname: agy-check\ndescription: Antigravity skill\n---\n# Skill');
fs.mkdirSync(path.join(HOME, '.claude', 'commands'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'commands', 'claude-only.md'), '# Claude command');

const CFG = path.join(T, 'srv', 'config.json');
fs.mkdirSync(path.dirname(CFG));
const PORT = 18815, PET = 18816;
const petToken = 'test-agy-token';
fs.mkdirSync(path.join(HOME, '.ametyping'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.ametyping', `control-token-${PET}`), petToken);

let petMode = 'terminal', launches = [], decisions = [];
const pet = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-ame-control'] !== petToken) { res.statusCode = 403; return res.end('{}'); }
    if (req.url === '/control/launch') {
      try { launches.push(JSON.parse(body || '{}')); } catch {}
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === '/control/decide') {
      try { decisions.push(JSON.parse(body || '{}')); } catch {}
      return res.end(JSON.stringify({ ok: true }));
    }
    res.end(JSON.stringify({
      sessions: [{
        id: ID,
        provider: 'agy',
        label: '修改 GUI 并测试',
        project: 'agyproj',
        state: 'idle',
        via: petMode,
        t0: Date.now(),
        last: Date.now(),
        lines: [],
        perms: [{
          id: 'perm1',
          provider: 'agy',
          tool: 'AskUserQuestion',
          cwd: CWD,
          input: { questions: [{ question: '是否继续？', options: ['是', '否'] }] },
          always: '',
        }],
      }],
    }));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };

const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AGY_HOME, AGY_CONFIG_DIR };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG));
cfg.web.port = PORT;
fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: true, scanMs: 400, petPort: PET }));

const kids = [];
const spawn = (args, e) => {
  const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  p.stderr.on('data', (s) => process.stderr.write(s));
  kids.push(p);
  return p;
};

function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      resolve(String(res.headers['set-cookie'] || '').split(';')[0]);
    });
    r.end(body);
  });
}

async function until(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(250);
  }
  return false;
}

(async () => {
  try {
    await new Promise((resolve, reject) => { pet.once('error', reject); pet.listen(PET, '127.0.0.1', resolve); });
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' });
    const ready = () => new Promise((resolve) => http.get(`http://127.0.0.1:${PORT}/login`, (res) => { res.resume(); resolve(true); }).on('error', () => resolve(false)));
    if (!(await until(ready, 10000))) throw new Error('temporary dashboard server did not start');

    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG, AGY_HOME, AGY_CONFIG_DIR });
    const cookie = await login();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie } });

    let snap = [];
    const convs = [];
    const waiting = new Map();
    let n = 0;

    ws.on('message', (m) => {
      const o = JSON.parse(m);
      if (o.t === 'sessions') snap = o.data;
      if (o.t === 'conv') convs.push(o);
      if (o.t === 'result' && waiting.has(o.rid)) { waiting.get(o.rid)(o); waiting.delete(o.rid); }
    });

    await new Promise((r) => ws.on('open', r));
    const act = (o) => new Promise((resolve) => { const rid = 'o' + (++n); waiting.set(rid, resolve); ws.send(JSON.stringify({ ...o, rid })); });
    const find = (id) => { const m = snap.find((x) => x.machine === 'box'); return m && m.sessions.find((s) => s.id === id); };

    // 1. Session discovery from $AGY_HOME/brain/<id>/.system_generated/logs/transcript.jsonl
    ok('Antigravity session stored and listed from $AGY_HOME', await until(() => find(ID)), JSON.stringify(snap));
    const s = find(ID) || {};
    ok('title from history.jsonl', s.label === '修改 GUI 并测试', s.label);

    // 2. resumeCmd generating agy --conversation <id>
    ok('resume with "agy --conversation <id>" in its folder', typeof s.resume === 'string' && s.resume.includes('agy --conversation ' + MAIN) && s.resume.includes('agyproj'), s.resume);

    // 3. AI provider and badge
    ok('AI badge shows Google provider for Gemini model', s.ai && s.ai.slug === 'google' && s.ai.name === 'Google', JSON.stringify(s.ai));

    // 4. Subagents state reaches dashboard
    ok('Antigravity subagent reaches the dashboard', await until(() => find(ID)?.agents?.some((a) => a.id === SUB && a.name === '代码审查员' && a.state === 'run')));

    // 5. Suggestion commands isolation for /api/commands?provider=agy
    const commands = (provider) => new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}/api/commands?machine=box&provider=${provider}`, { headers: { Cookie: cookie } }, (res) => {
        let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b).list || []); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const agyCmds = await commands('agy'), claudeCmds = await commands('claude');
    ok('command suggestions are isolated by provider for agy', agyCmds.some((c) => c.name === 'agy-check') && !agyCmds.some((c) => c.name === 'claude-only') && claudeCmds.some((c) => c.name === 'claude-only') && !claudeCmds.some((c) => c.name === 'agy-check'));

    // 6. Streaming recordsOf conversation to store
    ws.send(JSON.stringify({ t: 'watch', machine: 'box', id: ID }));
    await until(() => convs.length > 0, 5000);
    const msgs = convs.length ? convs[convs.length - 1].msgs : [];
    const text = JSON.stringify(msgs);
    ok('conversation: user, tool calls, reply', msgs.length === 3 && msgs[0].text === '用 Antigravity 修改 gui.py 并运行测试' && msgs[1].items.length === 2 && msgs[2].text === '已经修改了 gui.py 并执行测试。', text);
    ok('tool lines readable: command and file write', /运行: npm test/.test(text) && /写入:? gui\.py/.test(text), text);
    ok('session context window usage recorded in store', await until(() => Boolean(find(ID)?.ctx)), JSON.stringify(find(ID)));

    // 7. Permission decision & ask_question interaction
    ok('permission card exists with AskUserQuestion', (s.perms || []).some((p) => p.provider === 'agy' && p.tool === 'AskUserQuestion'), JSON.stringify(s.perms));
    const decideRes = await act({
      t: 'decide',
      machine: 'box',
      id: ID,
      perm: 'perm1',
      choice: 'answer',
      answers: { '是否继续？': '是' },
    });
    ok('decide forwards answer through pet', decideRes.ok === true && decisions.some((d) => d.session === ID && d.answers && d.answers['是否继续？'] === '是'), JSON.stringify([decideRes, decisions]));

    // 8. artifacts.pathsOf('agy:<id>')
    const artifacts = createArtifacts({
      sessionFile: (sid) => (sid === ID ? { file: mainTransFile, agy: true, cwd: CWD } : null),
      send: () => {},
    });
    const paths = artifacts.pathsOf(ID);
    const WIN = process.platform === 'win32';
    const norm = (p) => (WIN ? path.win32.normalize(p).toLowerCase() : path.posix.normalize(p));
    ok('artifacts.pathsOf detects files written in session', paths && paths.has(norm(guiFile)), JSON.stringify([...(paths || [])]));

    // 9. locate with double-escaped Windows paths
    const files = createFiles({ roots: [T] });
    const loc = await locate({
      files,
      sessionFile: (sid) => (sid === ID ? { file: mainTransFile, agy: true, cwd: CWD } : null),
    }, { p: 'gui.py', session: ID });
    ok('locate finds file with double-escaped Windows paths in transcript', loc.ok && loc.found.length > 0 && norm(loc.found[0].path) === norm(guiFile), JSON.stringify(loc));

    // 10. 在电脑上继续 (resume)
    petMode = 'off';
    ok('session marks as closed when pet says so', await until(() => find(ID)?.via === 'off'));
    const r = await act({ t: 'resume', machine: 'box', id: ID });
    const got = launches[launches.length - 1] || {};
    ok('在电脑上继续 forwards "agy:<id>" and the agyproj folder', r.ok === true && got.resume === ID && got.cwd === CWD, JSON.stringify([r, got]));

    ws.close();
  } catch (e) {
    fail++;
    console.log('ERROR', e);
  } finally {
    pet.closeAllConnections();
    pet.close();
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
