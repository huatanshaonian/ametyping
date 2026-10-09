// e2e: agent record streaming -> server store on disk; restarts on both sides; batching; browser conv view
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-e2e-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-proj-demo');
fs.mkdirSync(PROJ, { recursive: true });
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18787, SID = '11111111-2222-3333-4444-555555555555', SID2 = '99999999-2222-3333-4444-555555555555';
const TF = path.join(PROJ, SID + '.jsonl'), TF2 = path.join(PROJ, SID2 + '.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
let uuidN = 0; const ts = () => new Date().toISOString();
const L = (o) => JSON.stringify({ uuid: 'u' + (++uuidN), timestamp: ts(), ...o }) + '\n';
const user = (text) => L({ type: 'user', message: { role: 'user', content: text } });
const asst = (mid, blocks) => L({ type: 'assistant', message: { id: mid, role: 'assistant', content: blocks } });

// ---- setup ----
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
let cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'tester']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'tester', control: false, scanMs: 500 }));
fs.writeFileSync(TF,
  L({ type: 'ai-title', aiTitle: '演示会话' }) + user('hello') +
  asst('A', [{ type: 'text', text: 'part1' }]) + asst('A', [{ type: 'text', text: 'part2' }]) +
  asst('B', [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/a.js' } }]) +
  L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'SECRET FILE CONTENT' }] } }) +
  asst('B', [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'list' } }]) +
  asst('C', [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'done' }]) +
  L({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }));

let srv = null, agent = null;
const startSrv = (flushMs) => { srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env: { ...env, AME_FLUSH_MS: String(flushMs) }, stdio: 'ignore' }); };
const startAgent = () => { agent = cp.spawn(process.execPath, [R + '/agent/agent.js'], { env: { ...env, USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }, stdio: 'ignore' }); };
const DATA = path.join(T, 'srv', 'data');
const state = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'))); } catch { return {}; } };
const recsOnDisk = (id) => {
  let n = 0; const all = []; if (!fs.existsSync(DATA)) return { n, all };
  for (const d of fs.readdirSync(DATA)) {
    const f = path.join(DATA, d, 'tester', id + '.jsonl');
    if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) { n++; all.push(JSON.parse(l)); }
  }
  return { n, all };
};
async function until(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(200); } return false; }
const synced = (id, file) => ((state().tester || {})[id] || {}).off === fs.statSync(file).size;

function login() {
  return new Promise((resolve) => {
    const secret = JSON.parse(fs.readFileSync(CFG)).totpSecret;
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(secret, Math.floor(Date.now() / 30000)) });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0]); });
    req.end(body);
  });
}

(async () => {
  try {
    startSrv(300); await sleep(700); startAgent();
    ok('initial history stored (offset == file size)', await until(() => synced(SID, TF)));
    await sleep(600);
    const d = recsOnDisk(SID);
    ok('7 slim records on disk (tool output / meta / thinking dropped)', d.n === 7, `got ${d.n}`);
    ok('tool output never stored', !JSON.stringify(d.all).includes('SECRET FILE CONTENT'));
    ok('title recorded in state', (state().tester[SID] || {}).title === '演示会话', JSON.stringify(state().tester[SID]));

    // browser view
    const cookie = await login();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie } });
    const convs = []; ws.on('message', (m) => { const o = JSON.parse(m); if (o.t === 'conv') convs.push(o); });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'watch', machine: 'tester', id: SID }));
    await until(() => convs.length > 0, 5000);
    const c0 = convs.length ? convs[convs.length - 1].msgs : [];
    ok('conv merged for display (4 msgs)', c0.length === 4, JSON.stringify(c0));
    ok('streamed reply parts merged', c0[1] && c0[1].text === 'part1\n\npart2', JSON.stringify(c0[1]));
    ok('tool calls grouped', c0[2] && c0[2].items && c0[2].items.length === 2, JSON.stringify(c0[2]));

    // partial line is held back until complete
    const line = user('second question');
    fs.appendFileSync(TF, line.slice(0, 20)); await sleep(2000);
    ok('partial line not sent', recsOnDisk(SID).n === 7, `got ${recsOnDisk(SID).n}`);
    const nConv = convs.length;
    fs.appendFileSync(TF, line.slice(20));
    ok('completed line stored', await until(() => synced(SID, TF) && recsOnDisk(SID).n === 8));
    ok('live update pushed to viewer', await until(() => convs.length > nConv && convs[convs.length - 1].msgs.length === 5, 5000));

    // agent restart: no duplicates
    agent.kill(); await sleep(500); startAgent(); await sleep(3500);
    ok('agent restart: no duplicates', recsOnDisk(SID).n === 8, `got ${recsOnDisk(SID).n}`);

    // server crash before flush: nothing lost, nothing doubled
    srv.kill(); await sleep(500); startSrv(60000); await sleep(4000);             // agent reconnects
    fs.appendFileSync(TF, user('third')); await sleep(2500);                      // sent, still buffered in the server
    ok('buffered, not yet on disk', recsOnDisk(SID).n === 8, `got ${recsOnDisk(SID).n}`);
    srv.kill(); await sleep(500); startSrv(300);                                  // hard kill: buffer lost
    ok('after crash + restart: resent exactly once', await until(() => synced(SID, TF) && recsOnDisk(SID).n === 9, 20000), `got ${recsOnDisk(SID).n}`);

    // big history + a line larger than one read (4 MB): batching and skipping
    let big = '';
    for (let i = 0; i < 3000; i++) big += asst('M' + i, [{ type: 'text', text: `msg ${i} ` + 'x'.repeat(2000) }]);
    big += L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(5e6) }] } });
    big += user('after the huge line');
    fs.writeFileSync(TF2, big);
    ok('big transcript fully stored', await until(() => synced(SID2, TF2), 60000), JSON.stringify((state().tester || {})[SID2]));
    await sleep(600);
    const d2 = recsOnDisk(SID2);
    ok('3001 records (3000 replies + line after the huge one)', d2.n === 3001, `got ${d2.n}`);
    ok('order preserved', d2.n === 3001 && d2.all[0].text.startsWith('msg 0 ') && d2.all[2999].text.startsWith('msg 2999 ') && d2.all[3000].text === 'after the huge line');
    // a compaction summary stored as something you said (agents before the fix sent it so): read as a note, the file kept
    const OLD = path.join(T, 'old'), now = Date.now(), pad = (n) => String(n).padStart(2, '0'), dd = new Date(now);
    const dayDir = path.join(OLD, `${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`, 'pc'); fs.mkdirSync(dayDir, { recursive: true });
    const SUM = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. ...';
    const oldLines = [{ role: 'user', t: now - 3000, text: SUM }, { role: 'user', t: now - 2000, text: '这是什么意思：This session is being continued from a previous conversation that ran out of context.' }, { role: 'assistant', t: now - 1000, text: '对', mid: 'm1' }];
    fs.writeFileSync(path.join(dayDir, 's1.jsonl'), oldLines.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(OLD, 'state.json'), JSON.stringify({ pc: { s1: { off: 1, days: [path.basename(path.dirname(dayDir))], first: now - 3000, last: now - 1000 } } }));
    const st = require(R + '/server/store').createStore(OLD);
    const shown = st.tail('pc', 's1').map((r) => r.role + ':' + r.text.slice(0, 9)), forSum = st.records('pc', 's1', now - 9000, now).map((r) => r.role);
    ok('an old stored compaction summary: shown as a note, and not counted as yours in the summaries; quoting its first sentence is still yours',
      shown.join('|') === 'sys:（上下文已压缩）|user:这是什么意思：Th|assistant:对' && forSum.join() === 'sys,user,assistant' && fs.readFileSync(path.join(dayDir, 's1.jsonl'), 'utf8').includes('"role":"user","t":' + (now - 3000)), JSON.stringify([shown, forSum]));
    ws.close();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    try { agent.kill(); } catch {}
    try { srv.kill(); } catch {}
    await sleep(300); fs.rmSync(T, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
