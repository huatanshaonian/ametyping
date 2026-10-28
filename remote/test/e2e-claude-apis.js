// e2e: Claude Code API aliases -- the resolved settings reach the pet on launch, an import reads that machine's
// ~/.claude/settings.json without the key reaching the browser, the agent writes the local mirror + terminal
// wrappers, and a resumed session keeps the alias it was started with.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-apis-e2e-'));
const HOME = path.join(T, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'projects', '-work'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.ametyping'), { recursive: true });
const ROOT = path.join(T, 'share'); fs.mkdirSync(path.join(ROOT, 'proj'), { recursive: true });
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG), { recursive: true });
const RID = 'abcdef01-1111-2222-3333-444444444444';
fs.writeFileSync(path.join(HOME, '.claude', 'projects', '-work', RID + '.jsonl'),
  JSON.stringify({ type: 'user', cwd: ROOT, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n');
fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({
  env: { ANTHROPIC_BASE_URL: 'https://imported.example', ANTHROPIC_AUTH_TOKEN: 'sk-imported-secret', HTTP_PROXY: 'http://127.0.0.1:1080', CLAUDE_CONFIG_DIR: 'C:\\imported-memory' },
  model: 'opus', permissions: { allow: ['Read'] }, hooks: { Stop: [] },
}));
const PORT = 18842, PET = 18843;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const dataDir = path.join(T, 'srv', 'data'); fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'claude-apis.json'), JSON.stringify({
  default: 'deepseek',
  machines: { box: { default: 'deepseek' } },
  aliases: {
    deepseek: { label: 'DeepSeek', proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://deepseek.example', ANTHROPIC_AUTH_TOKEN: 'sk-deep-secret', CLAUDE_CONFIG_DIR: 'C:\\elsewhere' } }, machines: {} },
    nebula: { label: 'Nebula', proxy: 'inherit', settings: { env: { ANTHROPIC_BASE_URL: 'https://nebula.example', ANTHROPIC_AUTH_TOKEN: 'sk-nebula-secret' } }, machines: {} },
  },
}));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const tokRo = node([R + '/server/setup.js', 'add-agent', 'ro']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const tokMulti = node([R + '/server/setup.js', 'add-agent', 'multi']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: true, petPort: PET, files: { roots: [ROOT] } }));
const RO_HOME = path.join(T, 'home-ro'); fs.mkdirSync(path.join(RO_HOME, '.ametyping'), { recursive: true });
const RO_CFG = path.join(T, 'agent-ro.json');
fs.writeFileSync(RO_CFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tokRo, name: 'ro', control: false, petPort: PET + 1 }));
const petToken = 'x'.repeat(64);
fs.writeFileSync(path.join(HOME, '.ametyping', `control-token-${PET}`), petToken);
const launches = [];
let petSessions = [{ id: RID, label: 'old', project: 'work', state: 'idle', via: 'resume', t0: Date.now() - 6000, last: Date.now(), lines: [], perms: [], api: 'nebula' }];
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-ame-control'] !== petToken) { res.statusCode = 403; return res.end('{}'); }
    if (req.url === '/control/state') return res.end(JSON.stringify({ control: true, sessions: petSessions }));
    if (req.url === '/control/launch') { launches.push(JSON.parse(b)); return res.end(JSON.stringify({ ok: true, msg: 'fake launched' })); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(PET, '127.0.0.1');

const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
const req = (p, body, cookie) => new Promise((resolve) => {
  const data = JSON.stringify(body || {});
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } },
  (res) => { let out = ''; res.on('data', (c) => out += c); res.on('end', () => { let j = {}; try { j = JSON.parse(out); } catch {} resolve({ status: res.statusCode, j, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); }); });
  r.end(data);
});
const code = (offset = 0) => auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + offset);
const probeSockets = [];
// A pong is ordered after messages already queued on that same socket, so negative delivery assertions do not
// depend on sleeping long enough. These probes inspect the wire; a read-only agent discarding a key is too late.
function drained(socket) {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { socket.off('pong', done); reject(new Error('agent pong timed out')); }, 3000);
    socket.once('pong', done); socket.ping();
  });
}
async function aliasProbe(allowed) {
  const socket = new WebSocket('ws://127.0.0.1:' + PORT + '/agent', { headers: { Authorization: 'Bearer ' + tokMulti } });
  probeSockets.push(socket);
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent open timed out')), 3000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
  const hello = async (value) => {
    socket.send(JSON.stringify({ t: 'hello', machine: 'multi', control: value, apis: value }));
    await drained(socket);
  };
  if (typeof allowed === 'boolean') await hello(allowed);
  return { socket, messages, hello };
}

(async () => {
  try {
    spawn([R + '/server/server.js']); await sleep(3000);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG });
    spawn([R + '/agent/agent.js'], { USERPROFILE: RO_HOME, HOME: RO_HOME, AME_AGENT_CONFIG: RO_CFG });
    await sleep(3500);
    const login = await req('/api/login', { user: 'u', password: 'pw-123456789012', code: code() });
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: login.cookie } });
    const waiting = new Map(); let n = 0;
    ws.on('message', (m) => { const d = JSON.parse(m); if (d.t === 'result' && waiting.has(d.rid)) { waiting.get(d.rid)(d); waiting.delete(d.rid); } });
    await new Promise((r) => ws.on('open', r)); await sleep(1500);
    const act = (o) => new Promise((resolve) => { const rid = 'a' + (++n); waiting.set(rid, resolve); ws.send(JSON.stringify({ ...o, rid })); });

    const r1 = await act({ t: 'launch', machine: 'box', cwd: path.join(ROOT, 'proj'), prompt: 'hi', api: 'nebula' });
    ok('launch with an alias: forwarded to the pet with that alias', r1.ok && launches[0] && launches[0].api && launches[0].api.id === 'nebula' && launches[0].api.proxy === 'inherit' && launches[0].api.settings.env.ANTHROPIC_AUTH_TOKEN === 'sk-nebula-secret' && !('CLAUDE_CONFIG_DIR' in launches[0].api.settings.env), JSON.stringify([r1, launches[0]]));
    const r2 = await act({ t: 'launch', machine: 'box', cwd: path.join(ROOT, 'proj'), prompt: 'default' });
    ok('launch without one: the machine default (deepseek), direct', r2.ok && launches[1] && launches[1].api && launches[1].api.id === 'deepseek' && launches[1].api.proxy === 'direct' && launches[1].api.settings.env.ANTHROPIC_AUTH_TOKEN === 'sk-deep-secret' && !('CLAUDE_CONFIG_DIR' in launches[1].api.settings.env), JSON.stringify(launches[1]));
    const r3 = await act({ t: 'resume', machine: 'box', id: RID });
    ok('resume: the session keeps the alias it was started with (nebula)', r3.ok && launches[2] && launches[2].resume === RID && launches[2].api && launches[2].api.id === 'nebula', JSON.stringify([r3, launches[2]]));

    const imp = await req('/api/claude-apis/import', { machine: 'box', alias: 'imported', label: 'Imported', proxy: 'inherit', scope: 'machine' }, login.cookie);
    const av = imp.j && imp.j.view && imp.j.view.aliases && imp.j.view.aliases.imported;
    ok('import from the machine: ok, the key is masked in the answer, only the API slice kept', imp.j.ok && av && av.machines.box.settings.env.ANTHROPIC_AUTH_TOKEN === '__UNCHANGED__' && !JSON.stringify(imp.j).includes('sk-imported-secret') && av.machines.box.settings.env.HTTP_PROXY === undefined && av.machines.box.settings.env.CLAUDE_CONFIG_DIR === undefined && av.machines.box.settings.hooks === undefined, JSON.stringify(imp.j));
    const r4 = await act({ t: 'launch', machine: 'box', cwd: path.join(ROOT, 'proj'), prompt: 'imported', api: 'imported' });
    ok('the imported alias launches with the machine\'s real key and base URL', r4.ok && launches[3] && launches[3].api.id === 'imported' && launches[3].api.settings.env.ANTHROPIC_AUTH_TOKEN === 'sk-imported-secret' && launches[3].api.settings.env.ANTHROPIC_BASE_URL === 'https://imported.example' && !('CLAUDE_CONFIG_DIR' in launches[3].api.settings.env), JSON.stringify(launches[3]));
    // the local service forgets the session (a restart): the server still knows the alias from its own store and must
    // not fall back to the machine default (deepseek)
    petSessions = [];
    await sleep(3500);
    const n0 = launches.length;
    const r5 = await act({ t: 'resume', machine: 'box', id: RID });
    const resumed = launches[launches.length - 1] || {};
    ok('a forgotten session resumes with the remembered alias, not the machine default', r5.ok && launches.length === n0 + 1 && resumed.resume === RID && resumed.api && resumed.api.id === 'nebula', JSON.stringify([r5, resumed]));
    // the resume selector: this continuation may explicitly use another alias, or no alias at all
    const r5b = await act({ t: 'resume', machine: 'box', id: RID, api: 'deepseek' });
    const picked = launches[launches.length - 1] || {};
    ok('resume can explicitly choose another alias (deepseek)', r5b.ok && picked.resume === RID && picked.api && picked.api.id === 'deepseek', JSON.stringify([r5b, picked]));
    const r5c = await act({ t: 'resume', machine: 'box', id: RID, api: '__none__' });
    const plain = launches[launches.length - 1] || {};
    ok('resume can explicitly choose the machine settings (no alias)', r5c.ok && plain.resume === RID && !plain.api, JSON.stringify([r5c, plain]));

    // the agent writes this machine's resolved copy and the terminal wrappers
    let mirror = null;
    for (let i = 0; i < 60 && !mirror; i++) { try { mirror = JSON.parse(fs.readFileSync(path.join(HOME, '.ametyping', 'claude-apis.local.json'), 'utf8')); } catch { await sleep(250); } }
    ok('the agent keeps a local resolved copy', mirror && mirror.aliases.deepseek && mirror.aliases.deepseek.settings.env.ANTHROPIC_AUTH_TOKEN === 'sk-deep-secret' && mirror.aliases.nebula, JSON.stringify(mirror && Object.keys(mirror.aliases)));
    const dsFile = path.join(HOME, '.ametyping', 'claude-apis', 'deepseek.json');
    const nbFile = path.join(HOME, '.ametyping', 'claude-apis', 'nebula.json');
    const ds = (() => { try { return JSON.parse(fs.readFileSync(dsFile, 'utf8')); } catch { return {}; } })();
    const nb = (() => { try { return JSON.parse(fs.readFileSync(nbFile, 'utf8')); } catch { return {}; } })();
    ok('each alias is also a persistent per-machine settings file: direct clears its proxy',
      ds.env && ds.env.ANTHROPIC_AUTH_TOKEN === 'sk-deep-secret' && ds.env.ANTHROPIC_BASE_URL === 'https://deepseek.example' && ds.env.HTTP_PROXY === '' && ds.env.NO_PROXY === '*' && !('CLAUDE_CONFIG_DIR' in ds.env), JSON.stringify(ds));
    ok('per-machine settings file for inherit leaves the proxy to the machine',
      nb.env && nb.env.ANTHROPIC_AUTH_TOKEN === 'sk-nebula-secret' && nb.env.ANTHROPIC_BASE_URL === 'https://nebula.example' && !('HTTP_PROXY' in nb.env) && !('CLAUDE_CONFIG_DIR' in nb.env), JSON.stringify(nb));
    const bkFile = path.join(HOME, '.ametyping', 'backups', 'claude-settings.original.json');
    ok('the agent backed up the original ~/.claude/settings.json before syncing', fs.existsSync(bkFile) && fs.readFileSync(bkFile, 'utf8').includes('sk-imported-secret'), bkFile);
    const bkr = await req('/api/claude-apis/backup', { machine: 'box' }, login.cookie);
    ok('the backup action reports the untouched original paths', bkr.j.ok && Array.isArray(bkr.j.files) && bkr.j.files.some((f) => /claude-settings\.original\.json$/.test(f)), JSON.stringify(bkr.j));
    const wrapper = path.join(HOME, '.local', 'bin', process.platform === 'win32' ? 'claude-deepseek.cmd' : 'claude-deepseek');
    let wtxt = '';
    for (let i = 0; i < 40 && !wtxt; i++) { try { wtxt = fs.readFileSync(wrapper, 'utf8'); } catch { await sleep(250); } }
    ok('a terminal wrapper claude-deepseek was generated (and marks itself ours)', wtxt.includes('ametyping-claude-api') && wtxt.includes('deepseek'), wtxt);
    ok('the browser answer never carried a key', ![r1, r2, r3, r4, imp.j].some((x) => JSON.stringify(x).includes('sk-nebula-secret') || JSON.stringify(x).includes('sk-deep-secret')), '');
    // an alias that was deleted must fail the resume, not silently switch to deepseek
    const del = await req('/api/claude-apis/set', { default: 'deepseek', machines: { box: { default: 'deepseek' } }, aliases: {
      deepseek: { label: 'DeepSeek', proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://deepseek.example', ANTHROPIC_AUTH_TOKEN: 'sk-deep-secret' } }, machines: {} },
    } }, login.cookie);
    const n1 = launches.length;
    const r6 = await act({ t: 'resume', machine: 'box', id: RID });
    ok('a stored alias that is gone fails the resume instead of switching API', del.j.ok && r6.ok === false && launches.length === n1 && /API 别名「nebula」现在不可用/.test(r6.msg || ''), JSON.stringify([del.j.ok, r6, n1, launches.length]));
    await sleep(1200);                                  // the config change was pushed to every writable agent
    const roMirror = path.join(RO_HOME, '.ametyping', 'claude-apis.local.json');
    const roBin = path.join(RO_HOME, '.local', 'bin');
    const roWrappers = fs.existsSync(roBin) ? fs.readdirSync(roBin).filter((n) => /^claude-/.test(n)) : [];
    ok('a control:false agent never receives the shared keys or terminal wrappers', !fs.existsSync(roMirror) && roWrappers.length === 0, { mirror: fs.existsSync(roMirror), roWrappers });
    const readonly = await aliasProbe(false), writable = await aliasProbe(true);
    const hasConfig = (probe) => probe.messages.some((d) => d.t === 'claude-apis');
    const hasToken = (probe, token) => probe.messages.some((d) => d.t === 'claude-apis' &&
      d.aliases.deepseek.settings.env.ANTHROPIC_AUTH_TOKEN === token);
    const saveProbeToken = (token) => req('/api/claude-apis/set', { aliases: {
      deepseek: { proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://deepseek.example', ANTHROPIC_AUTH_TOKEN: token } } },
    } }, login.cookie);
    const firstSync = await saveProbeToken('sk-socket-first');
    await Promise.all([drained(readonly.socket), drained(writable.socket)]);
    ok('same machine: a writable hello never gives the read-only socket API keys',
      firstSync.j.ok && hasToken(writable, 'sk-socket-first') && !hasConfig(readonly));

    const pending = await aliasProbe(), laterReadonly = await aliasProbe(false);
    const secondSync = await saveProbeToken('sk-socket-second');
    await Promise.all([readonly, writable, pending, laterReadonly].map((p) => drained(p.socket)));
    ok('a new or read-only connection cannot disable an existing writable connection or receive its keys',
      secondSync.j.ok && hasToken(writable, 'sk-socket-second') && !hasConfig(readonly) && !hasConfig(laterReadonly) && !hasConfig(pending));

    await pending.hello(true);
    ok('a connection receives its first configuration only after its own writable hello', hasToken(pending, 'sk-socket-second'));
    await writable.hello(false);
    const thirdSync = await saveProbeToken('sk-socket-third');
    await Promise.all([readonly, writable, pending, laterReadonly].map((p) => drained(p.socket)));
    ok('revoking one connection stops its future keys while another writable connection keeps syncing',
      thirdSync.j.ok && !hasToken(writable, 'sk-socket-third') && hasToken(pending, 'sk-socket-third') &&
      !hasConfig(readonly) && !hasConfig(laterReadonly));
    ws.close();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    for (const socket of probeSockets) socket.terminate();
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
