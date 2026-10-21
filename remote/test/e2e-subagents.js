// e2e: the subagents a Claude Code session started -- read from their own transcripts (agent/subagents.js), sent with
// the session, kept to known fields by the server, shown to the browser: running / finished / interrupted / gone quiet
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const { agentsOf } = require(R + '/agent/subagents');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-subagents-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-proj-demo');
const S = 'eeeeeeee-0000-0000-0000-000000000001', SUB = path.join(PROJ, S, 'subagents');
fs.mkdirSync(SUB, { recursive: true });
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18852;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();

// transcript lines as Claude Code writes them
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const user = (t, content) => JSON.stringify({ type: 'user', isSidechain: true, timestamp: iso(t), message: { role: 'user', content } });
const asst = (t, content, stop = null) => JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: iso(t), message: { role: 'assistant', content, stop_reason: stop } });
const tool = (name, input) => ({ type: 'tool_use', id: 'tu' + Math.random(), name, input });
const result = { type: 'tool_result', tool_use_id: 'x', content: 'ok' };
function agent(id, meta, lines) {
  fs.writeFileSync(path.join(SUB, `agent-${id}.jsonl`), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(SUB, `agent-${id}.meta.json`), JSON.stringify(meta));
  return path.join(SUB, `agent-${id}.jsonl`);
}
const t0 = now - 120e3;
// finished by handing back (how most end), by a last plain answer, interrupted, running a command, thinking after a tool
agent('a1', { agentType: 'Explore', description: 'Study the desktop UI', requestShape: 'background' },
  [user(t0, 'study it'), asst(t0 + 1000, [tool('Read', { file_path: '/x/index.html' })]), user(t0 + 2000, [result]),
    asst(t0 + 3000, [tool('SubagentHandback', { message: 'report' })]), user(t0 + 4000, [result]), JSON.stringify({ type: 'api-request', timestamp: iso(t0 + 4100) })]);
agent('a2', { agentType: 'fork', isFork: true, name: 'awsclaude', description: '迁回群晖' },
  [user(t0, 'q'), asst(t0 + 1000, [{ type: 'thinking', thinking: '' }]), asst(t0 + 1500, [{ type: 'text', text: 'answer' }], 'end_turn')]);
agent('a3', { agentType: 'general-purpose', description: 'Research parts' },
  [user(t0, 'q'), asst(t0 + 1000, [tool('WebSearch', { query: 'x' })]), user(t0 + 2000, [{ type: 'text', text: '[Request interrupted by user for tool use]' }])]);
const RUN = agent('a4', { agentType: 'general-purpose', description: 'Simulate the HV board' },
  [user(now - 30e3, 'q'), asst(now - 20e3, [{ type: 'thinking', thinking: '' }]), asst(now - 19e3, [tool('Bash', { command: 'ngspice -b x.cir', description: 'Run the simulation' })])]);
agent('a5', { agentType: 'general-purpose', description: 'Simulate the grid driver' },
  [user(now - 30e3, 'q'), asst(now - 20e3, [tool('Read', { file_path: 'C:\\sim\\grid.cir' })]), user(now - 10e3, [result])]);
// not finished but silent for 20 minutes: a terminal that was closed
const STALE = agent('a6', { agentType: 'Plan', description: 'Plan the layout' }, [user(now - 30 * 60e3, 'q'), asst(now - 20 * 60e3, [tool('Grep', { pattern: 'foo' })])]);
fs.utimesSync(STALE, new Date(now - 20 * 60e3), new Date(now - 20 * 60e3));
// finished yesterday: no longer listed
const OLD = agent('a7', { agentType: 'Explore', description: 'old one' }, [user(now - 30 * 3600e3, 'q'), asst(now - 30 * 3600e3, [{ type: 'text', text: 'done' }], 'end_turn')]);
fs.utimesSync(OLD, new Date(now - 30 * 3600e3), new Date(now - 30 * 3600e3));
fs.writeFileSync(path.join(PROJ, S + '.jsonl'), JSON.stringify({ type: 'user', cwd: '/proj/demo', timestamp: iso(now - 5000), message: { role: 'user', content: 'go' } }) + '\n');

// ---- the reader alone ----
{
  const rows = agentsOf(path.join(PROJ, S + '.jsonl'));
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  ok('handed back = finished (lines after it, like api-request, are skipped)', by.a1 && by.a1.state === 'done' && by.a1.type === 'Explore' && by.a1.bg === true, JSON.stringify(by.a1));
  ok('a last plain answer = finished; the fork keeps its name', by.a2 && by.a2.state === 'done' && by.a2.name === 'awsclaude', JSON.stringify(by.a2));
  ok('interrupted by the user = stopped', by.a3 && by.a3.state === 'stop' && by.a3.act === '被打断', JSON.stringify(by.a3));
  ok('a command waiting for its result = running, with what it does', by.a4 && by.a4.state === 'run' && by.a4.act === 'Bash：Run the simulation', JSON.stringify(by.a4));
  ok('a tool result as the last line = running, thinking', by.a5 && by.a5.state === 'run' && by.a5.act === '思考中', JSON.stringify(by.a5));
  ok('unfinished and silent for 20 minutes = stopped', by.a6 && by.a6.state === 'stop', JSON.stringify(by.a6));
  ok('finished more than 6 hours ago: not listed', !by.a7, JSON.stringify(rows.map((r) => r.id)));
  ok('running ones first', rows[0].state === 'run' && rows[1].state === 'run', rows.map((r) => r.state).join());
  ok('start time from the first line', Math.abs(by.a1.t0 - t0) < 5, by.a1.t0 - t0);
  ok('a session without subagents: empty', agentsOf(path.join(PROJ, 'nope.jsonl')).length === 0);
}

node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, scanMs: 400 }));
let srv = null, ag = null;
function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0]); });
    req.end(body);
  });
}
// (the server's start-up takes a second or more on a busy machine: wait for its port)
let up = false;
async function until(fn, ms = 15000, each) { const s = Date.now(); while (Date.now() - s < ms) { if (each) await each(); if (fn()) return true; await sleep(200); } return false; }

(async () => {
  try {
    srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env: { ...env, AME_FLUSH_MS: '300' }, stdio: 'ignore' });
    await until(() => up, 15000, async () => { up = await new Promise((r) => http.get(`http://127.0.0.1:${PORT}/login`, (res) => { res.resume(); r(true); }).on('error', () => r(false))); });
    ag = cp.spawn(process.execPath, [R + '/agent/agent.js'], { env: { ...env, USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }, stdio: 'ignore' });
    const cookie = await login();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie } });
    let snap = [];
    ws.on('message', (m) => { const o = JSON.parse(m); if (o.t === 'sessions') snap = o.data; });
    await new Promise((r) => ws.on('open', r));
    const ses = () => { const m = snap.find((x) => x.machine === 'box'); return m && m.sessions.find((s) => s.id === S); };
    ok('the browser gets the session with its subagents', await until(() => ses() && ses().agents && ses().agents.length === 6), JSON.stringify(ses()));
    const a = Object.fromEntries((ses().agents || []).map((x) => [x.id, x]));
    ok('states as read on the machine', a.a1.state === 'done' && a.a3.state === 'stop' && a.a4.state === 'run' && a.a6.state === 'stop', JSON.stringify(ses().agents.map((x) => [x.id, x.state])));
    ok('only the known fields reach the browser', Object.keys(a.a4).every((k) => ['id', 'type', 'name', 'desc', 'bg', 'state', 'act', 't0', 'last', 'end'].includes(k)), Object.keys(a.a4).join());
    // the running one hands back: the dashboard hears of it without the session itself changing
    fs.appendFileSync(RUN, [user(Date.now(), [result]), asst(Date.now(), [tool('SubagentHandback', { message: 'done' })]), user(Date.now(), [result])].join('\n') + '\n');
    ok('a subagent finishing is pushed on its own', await until(() => { const x = ses() && ses().agents.find((y) => y.id === 'a4'); return x && x.state === 'done' && x.end; }, 8000),
      JSON.stringify(ses() && ses().agents.find((y) => y.id === 'a4')));
    // a new one starts
    agent('a8', { agentType: 'Explore', description: 'A new search' }, [user(Date.now(), 'q'), asst(Date.now(), [tool('Grep', { pattern: 'bar' })])]);
    ok('a new subagent shows up, running, listed first', await until(() => ses() && ses().agents[0].id === 'a8' && ses().agents[0].state === 'run' && ses().agents[0].act === 'Grep：bar', 8000),
      JSON.stringify(ses() && ses().agents.map((x) => [x.id, x.state])));
    ws.close();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    try { ag.kill(); } catch {}
    try { srv.kill(); } catch {}
    await sleep(300); fs.rmSync(T, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
