// e2e: older sessions reach the server's archive. The agent streams every transcript of the last 30 days the server
// does not have whole (not only the live ones); lines without their own timestamp (permission mode, title) take the
// time of the file's other lines, so an old session does not look active today; an agent restart sends nothing twice.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-archive-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-work-fdtd');
fs.mkdirSync(PROJ, { recursive: true });
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18806;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 500)}`); };
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const now = Date.now(), D10 = now - 10 * 86400e3, D40 = now - 40 * 86400e3;
const ids = { live: '11111111-0000-0000-0000-000000000001', old10: '11111111-0000-0000-0000-000000000010', old40: '11111111-0000-0000-0000-000000000040' };
const J = (o) => JSON.stringify(o) + '\n';
const conv = (id, t) => J({ type: 'permission-mode', permissionMode: 'auto', sessionId: id }) + J({ type: 'ai-title', aiTitle: '旧的网格会话 ' + id.slice(-2) }) +
  J({ type: 'user', uuid: id + 'u', cwd: '/work/fdtd', timestamp: new Date(t).toISOString(), message: { role: 'user', content: '加密网格 ' + id.slice(-2) } }) +
  J({ type: 'assistant', uuid: id + 'a', cwd: '/work/fdtd', timestamp: new Date(t + 60e3).toISOString(), message: { id: 'm' + id, role: 'assistant', content: [{ type: 'text', text: '好了' }] } }) +
  J({ type: 'permission-mode', permissionMode: 'plan', sessionId: id });
for (const [k, t] of [['live', now - 60e3], ['old10', D10], ['old40', D40]]) {
  const f = path.join(PROJ, ids[k] + '.jsonl');
  fs.writeFileSync(f, conv(ids[k], t));
  fs.utimesSync(f, new Date(t + 120e3), new Date(t + 120e3));
}

const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, scanMs: 300, petPort: 18807 }));
const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
const req = (method, p, body, cookie) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ j, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.end(data);
});
const DATA = path.join(T, 'srv', 'data');
const storedLines = () => {
  const out = {};
  for (const day of fs.readdirSync(DATA).filter((d) => /^\d{4}-/.test(d))) {
    let names = []; try { names = fs.readdirSync(path.join(DATA, day, 'box')); } catch {}
    for (const n of names) out[day + '/' + n] = fs.readFileSync(path.join(DATA, day, 'box', n), 'utf8').trim().split('\n').length;
  }
  return out;
};

(async () => {
  try {
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' }); await sleep(800);
    let agent = spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG });
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    let box = null;
    for (let i = 0; i < 60; i++) { const s = (await req('GET', '/api/sessions', null, cookie)).j; box = s && s.data.find((m) => m.machine === 'box'); if (box && box.sessions.length >= 2) break; await sleep(250); }
    await sleep(1500);
    const s10 = box && box.sessions.find((s) => s.id === ids.old10);
    ok('a 10-day-old session is archived', !!s10, box);
    ok('one older than 30 days is not', box && !box.sessions.some((s) => s.id === ids.old40));
    ok('the old session keeps its own time (not "just now")', s10 && Math.abs(s10.last - (D10 + 60e3)) < 1000 && s10.state === 'history', s10);
    ok('its title and last mode came along', s10 && s10.label === '旧的网格会话 10' && s10.mode === 'plan', s10);
    const lines1 = storedLines();
    ok('filed under its own day only (nothing in today\'s folder)', Object.keys(lines1).some((k) => k === `${dayOf(D10)}/${ids.old10}.jsonl`) && !Object.keys(lines1).some((k) => k === `${dayOf(now)}/${ids.old10}.jsonl`), lines1);
    // restart the agent: everything is already stored, nothing goes twice
    agent.kill(); await sleep(500);
    agent = spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }); await sleep(4000);
    ok('an agent restart sends nothing twice', JSON.stringify(storedLines()) === JSON.stringify(lines1), [lines1, storedLines()]);
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
