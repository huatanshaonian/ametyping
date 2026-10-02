// e2e: stored sessions stay listed (history), newest first, with resume commands
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-e2e-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-proj-demo');
fs.mkdirSync(PROJ, { recursive: true });
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18788;
const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'bbbbbbbb-0000-0000-0000-000000000002';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
let n = 0;
const line = (cwd, t, text) => JSON.stringify({ uuid: 'u' + (++n), cwd, timestamp: new Date(t).toISOString(), type: 'user', message: { role: 'user', content: text } }) + '\n';

node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
// keepMs 4 s: the agent stops reporting a session 4 s after its file last changed
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, scanMs: 400, keepMs: 4000 }));
const now = Date.now();
fs.writeFileSync(path.join(PROJ, A + '.jsonl'), line("D:\\it's\\proj", now - 60000, 'older one'));
fs.writeFileSync(path.join(PROJ, B + '.jsonl'), line('/home/dell/proj', now - 1000, 'newer one'));

let srv = null, agent = null;
const startSrv = () => { srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env: { ...env, AME_FLUSH_MS: '300' }, stdio: 'ignore' }); };
const startAgent = () => { agent = cp.spawn(process.execPath, [R + '/agent/agent.js'], { env: { ...env, USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }, stdio: 'ignore' }); };
function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0]); });
    req.end(body);
  });
}
async function until(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(200); } return false; }

(async () => {
  try {
    startSrv(); await sleep(700); startAgent();
    const cookie = await login();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie } });
    let snap = [];
    ws.on('message', (m) => { const o = JSON.parse(m); if (o.t === 'sessions') snap = o.data; });
    await new Promise((r) => ws.on('open', r));
    const box = () => snap.find((m) => m.machine === 'box');
    const ses = (id) => { const m = box(); return m && m.sessions.find((s) => s.id === id); };
    ok('both sessions listed while live', await until(() => ses(A) && ses(B)), JSON.stringify(snap));
    // the agent's keepMs drops them from its report; the server keeps them as history
    ok('after agent stops reporting: still listed as history', await until(() => ses(A) && ses(A).state === 'history' && ses(B) && ses(B).state === 'history', 20000),
      JSON.stringify(box() && box().sessions.map((s) => [s.id.slice(0, 4), s.state])));
    ok('newest first', box().sessions[0].id === B, JSON.stringify(box().sessions.map((s) => s.id.slice(0, 4))));
    ok('windows resume command (PowerShell, quote doubled)', ses(A).resume === "cd 'D:\\it''s\\proj'; claude --resume " + A, ses(A).resume);
    ok('linux resume command', ses(B).resume === "cd '/home/dell/proj' && claude --resume " + B, ses(B).resume);
    agent.kill(); await sleep(1000);
    ok('agent offline: machine offline, sessions kept', await until(() => box() && !box().online && box().sessions.length === 2, 8000), JSON.stringify(box()));
    // server restart: history comes back from disk alone (agent still down)
    srv.kill(); await sleep(600); startSrv(); await sleep(900);
    const cookie2 = await login();
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie2 } });
    let snap2 = [];
    ws2.on('message', (m) => { const o = JSON.parse(m); if (o.t === 'sessions') snap2 = o.data; });
    await new Promise((r) => ws2.on('open', r)); await sleep(500);
    const b2 = snap2.find((m) => m.machine === 'box');
    ok('after server restart (agent down): both listed from disk', b2 && b2.sessions.length === 2 && b2.sessions.every((s) => s.state === 'history' && s.resume), JSON.stringify(snap2));
    ws.close(); ws2.close();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    try { agent.kill(); } catch {}
    try { srv.kill(); } catch {}
    await sleep(300); fs.rmSync(T, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
