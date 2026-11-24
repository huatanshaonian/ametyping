// e2e: 设备更新 & 一键配置 through a real server and a real agent over their websocket. The agent runs from this
// repository -- a development checkout -- so it must report its version and never take an update; 一键配置 makes the
// computer's key at a fake Magpie (management API) and the agent writes Claude Code / Codex / OpenCode files in its
// temp home. Nothing real is touched.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..'), auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-fleet-e2e-'));
const HOME = path.join(T, 'home'), SERVER_HOME = path.join(T, 'server-home'), CFG = path.join(T, 'srv/config.json');
const PORT = 18852, kids = [];
fs.mkdirSync(path.dirname(CFG), { recursive: true }); fs.mkdirSync(SERVER_HOME); fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude/settings.json'), JSON.stringify({ model: 'opus', env: { HTTP_PROXY: 'http://127.0.0.1:9' } }));
const env = { ...process.env, HOME: SERVER_HOME, USERPROFILE: SERVER_HOME, AME_REMOTE_CONFIG: CFG, AME_NO_MCP_INSTALL: '1' };
delete env.AME_CC_HOME;
const node = (args, e = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...e }, windowsHide: true }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'fleet-e2e-password' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (name, value, info) => { value ? passed++ : failed++; console.log((value ? 'PASS ' : 'FAIL ') + name + (value || info === undefined ? '' : ' ' + JSON.stringify(info).slice(0, 400))); };

// a Magpie with the management API: the admin key, then the gateway keys it makes
const magpieKeys = [], magpieSeen = [];
const magpie = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    magpieSeen.push({ url: req.url, origin: req.headers.origin, fetchMode: req.headers['sec-fetch-mode'] });
    const send = (s, j) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== 'Bearer admin-e2e-key') return send(401, { error: { code: 'admin_key_required' } });
    if (req.url === '/v1/magpie/admin/gateway-keys') return send(200, { keys: magpieKeys });
    if (req.url === '/v1/magpie/admin/gateway-keys/add-key') { const d = JSON.parse(body); magpieKeys.push({ id: 'g' + magpieKeys.length, name: d.name }); return send(200, { keys: magpieKeys, secret: 'sk-e2e-machine-key' }); }
    send(404, { error: { message: 'this action is not in the management API' } });
  });
});

function request(method, target, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: target, method,
      headers: { Origin: 'http://127.0.0.1:' + PORT, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } },
    (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => {
      let value = {}; try { value = JSON.parse(raw); } catch {}
      resolve({ value, cookie: String(res.headers['set-cookie'] || '').split(';')[0], status: res.statusCode });
    }); });
    r.setTimeout(30000, () => r.destroy(new Error('request timeout'))); r.on('error', reject); r.end(data);
  });
}
async function until(fn, n = 200) { for (let i = 0; i < n; i++) { if (await fn()) return true; await sleep(50); } return false; }
let childErr = '';
function start(file, extra = {}) {
  const p = cp.spawn(process.execPath, [file], { env: { ...env, ...extra }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  p.stderr.on('data', (d) => { childErr = (childErr + d).slice(-2000); });
  kids.push(p);
}

(async () => {
  try {
    await new Promise((r) => magpie.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(T, 'admin.key'), 'admin-e2e-key\n');
    const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
    cfg.magpie = { baseURL: `http://127.0.0.1:${magpie.address().port}/v1`, adminKeyFile: path.join(T, 'admin.key') };
    fs.writeFileSync(CFG, JSON.stringify(cfg));
    const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
    const ACFG = path.join(T, 'agent.json');
    fs.writeFileSync(ACFG, JSON.stringify({ server: 'ws://127.0.0.1:' + PORT + '/agent', token: tok, name: 'box', control: true, petPort: 18853, scanMs: 200 }));
    // a bundle at a commit the checkout is not at
    const dataDir = path.join(path.dirname(CFG), 'data', 'fleet', 'bundle');
    fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'manifest.json'), JSON.stringify({ commit: 'c'.repeat(40), at: new Date().toISOString(), files: {}, headless: [], known: [] }));

    start(R + '/server/server.js');
    await until(async () => { try { return (await request('GET', '/login')).status === 200; } catch { return false; } });
    start(R + '/agent/agent.js', { HOME, USERPROFILE: HOME, AME_AGENT_CONFIG: ACFG, AME_HARNESS_DELAY_MS: '1500', AME_NO_NET_PROBE: '1' });
    const login = await request('POST', '/api/login', { user: 'u', password: 'fleet-e2e-password', code: auth.totpAt(cfg.totpSecret, Math.floor(Date.now() / 30000)) });
    const cookie = login.cookie;
    const view = async () => (await request('GET', '/api/fleet', null, cookie)).value;
    const box = async () => ((await view()).machines || []).find((m) => m.name === 'box');
    ok('the agent reports its version on connecting', await until(async () => { const m = await box(); return m && m.version && m.version.commit; }), childErr);
    const m = await box();
    ok('this checkout is a git copy at its HEAD', m.version.mode === 'git' && m.version.commit === cp.execFileSync('git', ['-C', path.resolve(R, '..'), 'rev-parse', 'HEAD']).toString().trim(), m.version);
    ok('a development checkout says why it is not updated', m.version.auto === false && /工作树|分支|没提交|autoUpdate/.test(m.version.why), m.version);
    ok('the bundle and the machine behind it are shown', (await view()).bundle.commit === 'c'.repeat(40) && m.behind === true);
    const up = (await request('POST', '/api/fleet/update', { machine: 'box' }, cookie)).value;
    ok('updating a development checkout is refused, even when asked', up.ok === false && /工作树|分支|没提交|autoUpdate/.test(up.msg), up);
    await sleep(3500);                                                // (past the automatic check after hello)
    ok('nothing was started for it on its own', !(await box()).run);

    const saved = (await request('POST', '/api/fleet/settings', { auto: true, gateway: 'https://gw.e2e.example/v1', proxy: 'http://127.0.0.1:10808', models: { opus: 'e2e/opus' } }, cookie)).value;
    ok('settings saved, the gateway without /v1, the default proxy', saved.ok && saved.settings.gateway === 'https://gw.e2e.example' && saved.settings.proxy === 'http://127.0.0.1:10808', saved);
    ok('the panel says Magpie keys can be made', (await view()).magpie.ok === true);
    await until(async () => !!(await box()).version.harnesses);       // (looked up a while after the agent starts)
    const hs = (await box()).version.harnesses;
    ok('the agent reports the four harnesses it looked for', Array.isArray(hs) && hs.map((x) => x.id).join() === 'claude,codex,opencode,agy' && hs.every((x) => typeof x.installed === 'boolean'), hs);
    const bad = (await request('POST', '/api/fleet/harness', { machine: 'box', id: '*', action: 'install' }, cookie)).value;
    ok('installing everything at once is refused (only updates go together)', bad.ok === false && /一起更新/.test(bad.msg), bad);
    ok('each harness says how it was installed', hs.filter((x) => x.installed).every((x) => x.method === 'npm' || x.method === 'self'), hs);
    const v0 = await view();
    ok('the daily harness check is on by default at 03:40, before the 04:30 report', v0.settings.daily.on === true && v0.settings.daily.at === '03:40' && !!v0.releases, v0.settings);
    const dset = (await request('POST', '/api/fleet/settings', { daily: { on: true, at: '03:15' }, harnessOff: { machine: 'box', off: true } }, cookie)).value;
    ok('the daily check time and a computer set off are saved', dset.ok && dset.settings.daily.at === '03:15' && dset.settings.harnessOff.box === true, dset);
    const badTime = (await request('POST', '/api/fleet/settings', { daily: { at: '25:99' } }, cookie)).value;
    ok('a wrong time keeps the old one', badTime.ok && badTime.settings.daily.at === '03:15', badTime);
    ok('the computer shows as set off', (await box()).harnessOff === true);
    await request('POST', '/api/fleet/settings', { harnessOff: { machine: 'box', off: false } }, cookie);
    ok('and on again', (await box()).harnessOff === false);
    const c = (await request('POST', '/api/fleet/configure', { machine: 'box', targets: ['claude', 'codex', 'opencode'], proxy: 'http://127.0.0.1:7890' }, cookie)).value;
    ok('一键配置 succeeds with a key made for this computer', c.ok === true && c.key && c.key.issued && c.key.name === 'windose-box', c);
    ok('the key was made through the management API with no browser headers', magpieKeys.length === 1 && magpieKeys[0].name === 'windose-box' && magpieSeen.filter((s) => s.url.startsWith('/v1/magpie/admin/')).every((s) => !s.origin && !s.fetchMode), magpieSeen);
    const s = JSON.parse(fs.readFileSync(path.join(HOME, '.claude/settings.json'), 'utf8'));
    ok('Claude Code settings point at the gateway with the key, the rest kept', s.env.ANTHROPIC_AUTH_TOKEN === 'sk-e2e-machine-key' && s.env.ANTHROPIC_BASE_URL === 'https://gw.e2e.example' && s.env.HTTP_PROXY === 'http://127.0.0.1:9' && s.model === 'opus' && s.env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'e2e/opus', s);
    ok('Claude Code reaches the gateway directly though the file has a proxy (NO_PROXY)', /gw\.e2e\.example/.test(s.env.NO_PROXY || ''), s.env);
    const net = JSON.parse(fs.readFileSync(path.join(HOME, '.ametyping/harness-net.json'), 'utf8'));
    ok('Codex keeps its own sign-in: no config.toml written, the computer\'s proxy recorded for it', !fs.existsSync(path.join(HOME, '.codex/config.toml')) && net.proxy === 'http://127.0.0.1:7890' && net.tools.includes('codex'), net);
    ok('the computer\'s own proxy is kept on the server and reported back by the agent', (await box()).proxy === 'http://127.0.0.1:7890' && await until(async () => (await box()).version.proxy === 'http://127.0.0.1:7890'));
    ok('OpenCode has the key file', fs.readFileSync(path.join(HOME, '.config/opencode/.secrets/magpie-nas.key'), 'utf8').trim() === 'sk-e2e-machine-key');
    const page = JSON.stringify(await view()), state = fs.readFileSync(path.join(path.dirname(CFG), 'data', 'fleet', 'state.json'), 'utf8');
    ok('neither the panel nor the server state holds the secret', !/sk-e2e-machine-key/.test(page) && !/sk-e2e-machine-key/.test(state));
    ok('the agent now reports the key id (no secret)', await until(async () => { const b = await box(); return b.version.magpieKey && b.version.magpieKey.id === 'g0'; }));
    const again = (await request('POST', '/api/fleet/configure', { machine: 'box', targets: ['claude'] }, cookie)).value;
    ok('a second 一键配置 keeps the computer\'s key', again.ok && again.key.issued === false && magpieKeys.length === 1, again);
    const anon = await request('POST', '/api/fleet/configure', { machine: 'box', targets: ['claude'] });
    ok('not without a login', anon.status === 401 || anon.value.ok !== true);
  } catch (e) { ok('script ' + e.stack, false); }
  finally {
    for (const k of kids) { try { k.kill(); } catch {} }
    magpie.close();
    await sleep(300);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
