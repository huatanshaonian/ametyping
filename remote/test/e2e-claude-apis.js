// Full local-profile flow: browser -> NAS -> selected capable agent -> cc-environments; no key mirror on the NAS.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..'), WebSocket = require(R + '/node_modules/ws'), auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-local-profiles-e2e-'));
const HOME = path.join(T, 'home'), SERVER_HOME = path.join(T, 'server-home'), ROOT = path.join(T, 'share');
const CFG = path.join(T, 'srv/config.json'), RID = 'abcdef01-1111-2222-3333-444444444444';
const PORT = 18842, PET = 18843, kids = [], sockets = [];
fs.mkdirSync(path.dirname(CFG), { recursive: true }); fs.mkdirSync(SERVER_HOME);
fs.mkdirSync(path.join(ROOT, 'project'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.claude/projects/-work'), { recursive: true }); fs.mkdirSync(path.join(HOME, '.ametyping'));
const shared = JSON.stringify({ env: {}, hooks: { Stop: [] }, permissions: { allow: ['Read'] } });
fs.writeFileSync(path.join(HOME, '.claude/settings.json'), shared); fs.writeFileSync(path.join(HOME, '.claude.json'), '{"sharedHistory":true}');
fs.writeFileSync(path.join(HOME, '.claude/projects/-work', RID + '.jsonl'),
  JSON.stringify({ type: 'user', cwd: ROOT, timestamp: new Date().toISOString(), message: { role: 'user', content: 'fixture' } }) + '\n');
for (const [name, s] of Object.entries({
  apinebula: { model: 'opus', env: { ANTHROPIC_BASE_URL: 'https://nebula.example', ANTHROPIC_AUTH_TOKEN: 'invented-nebula-key', HTTPS_PROXY: 'http://127.0.0.1:10808' } },
  deepseek: { model: 'deepseek-flash[1m]', env: { ANTHROPIC_BASE_URL: 'https://deepseek.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'invented-deepseek-key' } },
})) {
  const dir = path.join(HOME, 'cc-environments', name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s));
}
const env = { ...process.env, HOME: SERVER_HOME, USERPROFILE: SERVER_HOME, AME_REMOTE_CONFIG: CFG };
delete env.AME_CC_HOME;
const node = (args, e = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...e }, windowsHide: true }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'fixture-password-long' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map(s => s.trim()).find(s => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: 'ws://127.0.0.1:' + PORT + '/agent', token: tok, name: 'box',
  control: true, petPort: PET, scanMs: 100, files: { roots: [ROOT] } }));
const petToken = 'x'.repeat(64); fs.writeFileSync(path.join(HOME, '.ametyping/control-token-' + PET), petToken);
let petSessions = [{ id: RID, state: 'idle', via: 'resume', t0: Date.now(), last: Date.now(), lines: [], perms: [], api: 'nebula' }];
const launches = [];
const pet = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-ame-control'] !== petToken) { res.statusCode = 403; return res.end('{}'); }
    if (req.url === '/control/state') return res.end(JSON.stringify({ control: true, sessions: petSessions }));
    if (req.url === '/control/launch') { launches.push(JSON.parse(body)); return res.end('{"ok":true}'); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(PET, '127.0.0.1');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (name, value) => { value ? passed++ : failed++; console.log((value ? 'PASS ' : 'FAIL ') + name); };
function request(method, target, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: target, method,
      headers: { Origin: 'http://127.0.0.1:' + PORT, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } },
    res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => {
      let value = {}; try { value = JSON.parse(raw); } catch {}
      resolve({ value, cookie: String(res.headers['set-cookie'] || '').split(';')[0], status: res.statusCode });
    }); });
    r.setTimeout(18000, () => r.destroy(new Error('fixture request timeout'))); r.on('error', reject); r.end(data);
  });
}
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(50); } throw new Error('fixture startup/state timeout'); }
let childFailure = '';
function start(file, extra = {}) {
  const p = cp.spawn(process.execPath, [file], { env: { ...env, ...extra }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  p.stderr.on('data', d => { childFailure = (childFailure + d.toString()).slice(-2000); });
  kids.push(p);
}
(async () => {
  try {
    start(R + '/server/server.js');
    await until(async () => { try { return (await request('GET', '/login')).status === 200; } catch { return false; } });
    start(R + '/agent/agent.js', { HOME, USERPROFILE: HOME, AME_AGENT_CONFIG: ACFG });
    const login = await request('POST', '/api/login', { user: 'u', password: 'fixture-password-long',
      code: auth.totpAt(cfg.totpSecret, Math.floor(Date.now() / 30000)) });
    const cookie = login.cookie, get = () => request('GET', '/api/claude-apis?machine=box', null, cookie);
    await until(async () => { const r = await get(); return r.value.ready && r.value.profiles.length === 2; });
    const first = (await get()).value;
    ok('the panel discovers both local files, including apinebula -> claude-nebula', first.aliases.some(p => p.id === 'nebula') && first.aliases.some(p => p.id === 'deepseek'));
    ok('metadata has the DeepSeek default model and shared data directory', first.profiles.find(p => p.id === 'deepseek').model === 'deepseek-flash[1m]' && first.sharedDirectory === path.join(HOME, '.claude'));
    ok('browser metadata never contains API keys or env objects', !/invented-nebula-key|invented-deepseek-key|"env":/.test(JSON.stringify(first)));
    const refreshed = await request('POST', '/api/claude-apis/refresh', { machine: 'box' }, cookie);
    ok('refresh reads the selected capable agent without importing global settings', refreshed.value.ok && refreshed.value.view.profiles.length === 2);
    const legacy = await request('POST', '/api/claude-apis/import', { machine: 'box', alias: 'deepseek' }, cookie);
    ok('old default-only import fails clearly instead of replacing an independent entry', !legacy.value.ok && /cc-environments/.test(legacy.value.msg));
    const profile = { id: 'deepseek', baseUrl: 'https://deepseek.example/anthropic', model: 'deepseek-flash[1m]', key: 'new-invented-key', network: 'direct' };
    const saved = await request('POST', '/api/claude-apis/save', { machine: 'box', profile }, cookie);
    const providerFile = path.join(HOME, 'cc-environments/deepseek/settings.json');
    ok('saving writes the target computer provider file and confirms without echoing the key',
      saved.value.ok && JSON.parse(fs.readFileSync(providerFile)).env.ANTHROPIC_AUTH_TOKEN === profile.key && !JSON.stringify(saved.value).includes(profile.key));
    ok('shared settings, approvals, hooks and global history remain unchanged',
      fs.readFileSync(path.join(HOME, '.claude/settings.json'), 'utf8') === shared &&
      fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8') === '{"sharedHistory":true}');
    ok('the local provider configuration is backed up before editing', fs.readdirSync(path.join(HOME, 'cc-environments/backups/deepseek')).length > 0);
    const browser = new WebSocket('ws://127.0.0.1:' + PORT + '/ws', { headers: { Origin: 'http://127.0.0.1:' + PORT, Cookie: cookie } });
    sockets.push(browser); await new Promise((resolve, reject) => { browser.once('open', resolve); browser.once('error', reject); });
    let counter = 0;
    const act = d => new Promise((resolve, reject) => {
      const rid = 'fixture-' + (++counter), timer = setTimeout(() => reject(new Error('fixture action timeout')), 5000);
      const listener = raw => { const r = JSON.parse(raw); if (r.t === 'result' && r.rid === rid) { clearTimeout(timer); browser.off('message', listener); resolve(r); } };
      browser.on('message', listener); browser.send(JSON.stringify({ ...d, machine: 'box', rid }));
    });
    const launched = await act({ t: 'launch', cwd: path.join(ROOT, 'project'), prompt: 'fixture', api: 'deepseek' });
    ok('launch sends only a local entry ID and the real project path', launched.ok && launches[0].api.id === 'deepseek' &&
      launches[0].api.local === true && !launches[0].api.settings && launches[0].cwd === path.join(ROOT, 'project'));
    const resumed = await act({ t: 'resume', id: RID, api: 'deepseek' });
    ok('switching entry resumes the same shared history through the chosen profile', resumed.ok && launches[1].resume === RID && launches[1].api.id === 'deepseek');
    const missing = await act({ t: 'launch', cwd: path.join(ROOT, 'project'), prompt: '', api: 'missing' });
    ok('a missing local entry never falls back to a different API', !missing.ok && launches.length === 2);
    petSessions = [];
    await until(async () => { const r = await request('GET', '/api/claude-apis?machine=box', null, cookie); return r.value.ready; });
    await sleep(200);
    const history = await act({ t: 'resume', id: RID });
    ok('a forgotten session still resumes using its recorded entry', history.ok && launches.at(-1).api.id === 'nebula');

    const readonly = new WebSocket('ws://127.0.0.1:' + PORT + '/agent', { headers: { Authorization: 'Bearer ' + tok } });
    sockets.push(readonly); const messages = [];
    readonly.on('message', raw => messages.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => { readonly.once('open', resolve); readonly.once('error', reject); });
    readonly.send(JSON.stringify({ t: 'hello', control: false, claudeProfilesVersion: 1, claudeProfilesAllowed: false }));
    const newerOld = new WebSocket('ws://127.0.0.1:' + PORT + '/agent', { headers: { Authorization: 'Bearer ' + tok } });
    sockets.push(newerOld); await new Promise((resolve, reject) => { newerOld.once('open', resolve); newerOld.once('error', reject); });
    newerOld.send(JSON.stringify({ t: 'hello', control: true }));
    const refreshAgain = await request('POST', '/api/claude-apis/refresh', { machine: 'box' }, cookie);
    ok('a newer old/read-only connection does not steal requests from the capable agent', refreshAgain.value.ok);
    const launchAgain = await act({ t: 'launch', cwd: path.join(ROOT, 'project'), prompt: 'route fixture', api: 'deepseek' });
    ok('entry launch also chooses the capable writable agent instead of the newest old socket',
      launchAgain.ok && launches.at(-1).api.id === 'deepseek' && launches.at(-1).api.local === true);
    const savedAgain = await request('POST', '/api/claude-apis/save', { machine: 'box', profile: { ...profile, key: '' } }, cookie);
    ok('blank key preserves the existing local key', savedAgain.value.ok && JSON.parse(fs.readFileSync(providerFile)).env.ANTHROPIC_AUTH_TOKEN === profile.key);
    await sleep(100);
    ok('read-only sibling connections never receive provider keys or write requests',
      !JSON.stringify(messages).includes(profile.key) && !messages.some(d => d.t === 'claude-profiles-request' || d.t === 'claude-apis'));
    ok('legacy NAS key storage and agent mirrors are not created', !fs.existsSync(path.join(T, 'srv/data/claude-apis.json')) &&
      !fs.existsSync(path.join(HOME, '.ametyping/claude-apis.local.json')));
    const dataFiles = fs.readdirSync(path.join(T, 'srv/data')).filter(n => /\.(json|jsonl)$/.test(n));
    ok('NAS data and audit do not persist submitted provider keys', dataFiles.every(n =>
      !fs.readFileSync(path.join(T, 'srv/data', n), 'utf8').includes(profile.key)));
    const changed = JSON.parse(fs.readFileSync(providerFile)); changed.model = 'externally-edited-model'; fs.writeFileSync(providerFile, JSON.stringify(changed));
    await until(async () => (await get()).value.profiles.some(p => p.id === 'deepseek' && p.model === changed.model));
    ok('external edits to cc-environments appear in the panel without a second configuration source', true);
  } catch (e) { failed++; console.log('ERROR ' + e.message); if (childFailure) console.log(childFailure); }
  finally {
    for (const socket of sockets) socket.terminate();
    for (const child of kids) child.kill();
    pet.close(); await sleep(400);
    if (path.dirname(path.resolve(T)) === path.resolve(os.tmpdir())) fs.rmSync(T, { recursive: true, force: true });
    console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0);
  }
})();
