// e2e: 添加电脑 from the web (token once, needs a fresh code), the token lets an agent in, removing kicks it out
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-agents-'));
const HOME = path.join(T, 'home'); fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18794;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const code = (off = 0) => auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + off);
const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
function req(method, p, body, cookie) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
      'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
    });
    r.end(data);
  });
}
const agentConnects = (tok) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`, { headers: { Authorization: 'Bearer ' + tok } });
  ws.on('open', () => resolve({ ws, ok: true })); ws.on('unexpected-response', () => resolve({ ok: false })); ws.on('error', () => resolve({ ok: false }));
});

(async () => {
  try {
    // a server whose fresh window is tiny: the login's own code is stale at once
    spawn([R + '/server/server.js'], { AME_FRESH_MS: '1' }); await sleep(3000);
    let login = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: code() });
    const r0 = await req('POST', '/api/agents/add', { name: 'newbox' }, login.cookie);
    ok('adding without a fresh code asks for it', r0.j && r0.j.need === 'totp' && !r0.j.token, JSON.stringify(r0.j));
    for (const k of kids.splice(0)) k.kill(); await sleep(500);
    spawn([R + '/server/server.js']); await sleep(3000);
    login = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: code(1) });
    const bad = await req('POST', '/api/agents/add', { name: '../evil' }, login.cookie);
    ok('bad name refused', bad.j && bad.j.ok === false, JSON.stringify(bad.j));
    const r1 = await req('POST', '/api/agents/add', { name: 'newbox' }, login.cookie);
    ok('added: token returned once', r1.j && r1.j.ok && typeof r1.j.token === 'string' && r1.j.token.length >= 40, JSON.stringify(r1.j));
    const stored = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    ok('config keeps only the hash', stored.agents.some((a) => a.name === 'newbox' && a.hash) && !JSON.stringify(stored).includes(r1.j.token));
    ok('config file is private', process.platform === 'win32' || (fs.statSync(CFG).mode & 0o777) === 0o600);
    const list = await req('GET', '/api/agents', null, login.cookie);
    ok('listed', list.j && list.j.items.some((a) => a.name === 'newbox'), JSON.stringify(list.j));
    const a1 = await agentConnects(r1.j.token);
    ok('the new token lets an agent in', a1.ok);
    let closed = null; if (a1.ws) a1.ws.on('close', (c) => { closed = c; });
    const rm = await req('POST', '/api/agents/remove', { name: 'newbox' }, login.cookie);
    ok('removed', rm.j && rm.j.ok, JSON.stringify(rm.j));
    await sleep(500);
    ok('its live connection was closed (4403)', closed === 4403, String(closed));
    const a2 = await agentConnects(r1.j.token);
    ok('the old token no longer gets in', !a2.ok);
    const r2 = await req('POST', '/api/agents/add', { name: 'newbox' }, login.cookie);
    const r3 = await req('POST', '/api/agents/add', { name: 'newbox' }, login.cookie);
    ok('adding the same name again replaces the token', r3.j && r3.j.replaced === true && r3.j.token !== r2.j.token);
    ok('the replaced token is dead', !(await agentConnects(r2.j.token)).ok && (await agentConnects(r3.j.token)).ok);
    const audit = fs.readFileSync(path.join(T, 'srv', 'audit.log'), 'utf8');
    ok('audit has add and remove', /agent-add .* newbox/.test(audit) && /agent-remove .* newbox/.test(audit));
    const anon = await req('POST', '/api/agents/add', { name: 'x' });
    ok('not logged in: refused', anon.status === 401);
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
