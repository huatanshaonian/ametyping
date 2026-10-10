// e2e: "launch Claude in a folder" through server + agent, against a fake pet (records requests, starts nothing)
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-'));
const HOME = path.join(T, 'home'); fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.ametyping'));
const ROOT = path.join(T, 'share'); fs.mkdirSync(path.join(ROOT, 'proj', '.ssh'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'proj', 'a.txt'), 'x');
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
// a past conversation of this machine, in a folder that is not one of the browsable roots (「在电脑上继续」 needs none)
const RID = 'abcdef01-1111-2222-3333-444444444444', WORK = path.join(T, 'work'); fs.mkdirSync(WORK);
fs.mkdirSync(path.join(HOME, '.claude', 'projects', '-work'), { recursive: true });
// a Codex thread of this machine, in a folder of its own
const CID = '01a0aaaa-0000-7000-8000-00000000c0de', CWORK = path.join(T, 'cwork'); fs.mkdirSync(CWORK);
{
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const day = path.join(HOME, '.codex', 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  fs.mkdirSync(day, { recursive: true });
  const L = (o) => JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + '\n';
  fs.writeFileSync(path.join(day, `rollout-x-${CID}.jsonl`), L({ type: 'session_meta', payload: { id: CID, cwd: CWORK } }) +
    L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看看这个目录' }] } }));
}
// (as a session copied from another really looks: it begins with a few hundred kilobytes of lines that carry no
// folder -- file-history snapshots -- then starts in one folder and later moves to another; it is opened again where
// it was last)
const START = path.join(T, 'started-here'); fs.mkdirSync(START);
const tline = (cwd, t, text) => JSON.stringify({ uuid: 'u' + t, cwd, timestamp: new Date(Date.now() - t).toISOString(), type: 'user', message: { role: 'user', content: text } }) + '\n';
fs.writeFileSync(path.join(HOME, '.claude', 'projects', '-work', RID + '.jsonl'),
  JSON.stringify({ type: 'ai-title', aiTitle: '一个接着做的会话' }) + '\n' +
  [1, 2, 3, 4].map((i) => JSON.stringify({ type: 'file-history-snapshot', messageId: 'm' + i, snapshot: '快照'.repeat(18000) }) + '\n').join('') +
  tline(START, 9000, '一开始在这里') + tline(START, 8000, '还在这里') + tline(WORK, 5000, '上次说到一半'));
const PORT = 18792, PET = 18793;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: true, petPort: PET, files: { roots: [ROOT] } }));
// fake pet: control token file + the endpoints the agent uses
const petToken = 'x'.repeat(64);
fs.writeFileSync(path.join(HOME, '.ametyping', `control-token-${PET}`), petToken);
const launches = [];
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-ame-control'] !== petToken) { res.statusCode = 403; return res.end('{}'); }
    if (req.url === '/control/state') return res.end(JSON.stringify({ control: true, sessions: [] }));
    if (req.url === '/control/launch') { launches.push(JSON.parse(b)); return res.end(JSON.stringify({ ok: true, msg: 'fake launched' })); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(PET, '127.0.0.1');

const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
const post = (p, body, cookie) => new Promise((resolve) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } },
    (res) => { res.resume(); resolve({ status: res.statusCode, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  req.end(data);
});
const code = (offset = 0) => auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + offset);

(async () => {
  try {
    // AME_FRESH_MS=1: the login's own code is stale at once, so the step-up path is exercised
    spawn([R + '/server/server.js'], { AME_FRESH_MS: '1' }); await sleep(3000);          // (0.8 s was not always enough on a busy machine)
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }); await sleep(2500);
    const login = await post('/api/login', { user: 'u', password: 'pw-123456789012', code: code() });
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: login.cookie } });
    const waiting = new Map(); let n = 0;
    ws.on('message', (m) => { const d = JSON.parse(m); if (d.t === 'result' && waiting.has(d.rid)) { waiting.get(d.rid)(d); waiting.delete(d.rid); } });
    await new Promise((r) => ws.on('open', r)); await sleep(500);
    const act = (o) => new Promise((resolve) => { const rid = 'a' + (++n); waiting.set(rid, resolve); ws.send(JSON.stringify({ ...o, rid })); });
    const r0 = await act({ t: 'launch', machine: 'box', cwd: path.join(ROOT, 'proj'), prompt: 'hi' });
    ok('without a fresh code: asks for it', r0.ok === false && r0.need === 'totp', JSON.stringify(r0));
    // server with AME_FRESH_MS=1 cannot be made fresh for long: restart it normally for the rest
    for (const k of kids.splice(0, 1)) k.kill(); await sleep(500);
    spawn([R + '/server/server.js']); await sleep(3500);
    const login2 = await post('/api/login', { user: 'u', password: 'pw-123456789012', code: code(1) });
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: login2.cookie } });
    ws2.on('message', (m) => { const d = JSON.parse(m); if (d.t === 'result' && waiting.has(d.rid)) { waiting.get(d.rid)(d); waiting.delete(d.rid); } });
    await new Promise((r) => ws2.on('open', r)); await sleep(2500);
    const act2 = (o) => new Promise((resolve) => { const rid = 'b' + (++n); waiting.set(rid, resolve); ws2.send(JSON.stringify({ ...o, rid })); });
    const r1 = await act2({ t: 'launch', machine: 'box', cwd: path.join(ROOT, 'proj', '.', 'x', '..'), prompt: '第一句话' });
    ok('allowed folder: forwarded to the pet', r1.ok === true && launches.length === 1, JSON.stringify(r1));
    ok('pet gets the real path and the prompt', launches[0] && fs.realpathSync(launches[0].cwd) === fs.realpathSync(path.join(ROOT, 'proj')) && launches[0].prompt === '第一句话', JSON.stringify(launches[0]));
    const r2 = await act2({ t: 'launch', machine: 'box', cwd: T, prompt: '' });
    ok(`outside the roots refused (${r2.msg})`, r2.ok === false && launches.length === 1, JSON.stringify(r2));
    const r3 = await act2({ t: 'launch', machine: 'box', cwd: path.join(ROOT, 'proj', 'a.txt'), prompt: '' });
    ok(`a file refused (${r3.msg})`, r3.ok === false && launches.length === 1, JSON.stringify(r3));
    const r4 = await act2({ t: 'launch', machine: 'box', cwd: path.join(ROOT, 'proj', '.ssh'), prompt: '' });
    ok(`a protected folder refused (${r4.msg})`, r4.ok === false && launches.length === 1, JSON.stringify(r4));
    // 在电脑上继续: a past conversation opened again there -- the folder comes from its own transcript on that machine
    const n0 = launches.length;
    const q1 = await act2({ t: 'resume', machine: 'box', id: RID });
    const got = launches[launches.length - 1] || {};
    ok('在电脑上继续: forwarded to the pet with the id of the conversation and the folder its transcript names', q1.ok === true && launches.length === n0 + 1 && got.resume === RID && fs.realpathSync(got.cwd) === fs.realpathSync(WORK) && !got.prompt, JSON.stringify([q1, got]));
    const q2 = await act2({ t: 'resume', machine: 'box', id: 'abcdef01-9999-2222-3333-444444444444' });
    ok(`a conversation this machine does not have: refused (${q2.msg})`, q2.ok === false && launches.length === n0 + 1, JSON.stringify(q2));
    const q3 = await act2({ t: 'resume', machine: 'box', id: 'codex:abc' }), q4 = await act2({ t: 'resume', machine: 'box', id: RID + ' --dangerously-skip-permissions' }), q5 = await act2({ t: 'resume', machine: 'box' });
    ok('an id that is none, an id with anything else in it, no id: refused', !q3.ok && !q4.ok && !q5.ok && launches.length === n0 + 1, JSON.stringify([q3, q4, q5]));
    // a Codex thread: the same, with its id as the dashboard names it and the folder its rollout says
    const q6 = await act2({ t: 'resume', machine: 'box', id: 'codex:' + CID }), gotC = launches[launches.length - 1] || {};
    ok('在电脑上继续, a Codex thread: forwarded with "codex:<id>" and its folder', q6.ok === true && launches.length === n0 + 2 && gotC.resume === 'codex:' + CID && fs.realpathSync(gotC.cwd) === fs.realpathSync(CWORK), JSON.stringify([q6, gotC]));
    const q7 = await act2({ t: 'resume', machine: 'box', id: 'codex:01a0aaaa-0000-7000-8000-00000000ffff' });
    ok('a Codex thread this machine does not have: refused', q7.ok === false && launches.length === n0 + 2, JSON.stringify(q7));
    const audit = fs.readFileSync(path.join(T, 'srv', 'audit.log'), 'utf8');
    ok('written to the audit log', new RegExp('control-resume .* box ' + RID).test(audit));
    ok('launch written to the audit log', /control-launch .* box /.test(audit));
    ws.close(); ws2.close();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
