// e2e: OpenCode sessions come from the plugin's own conversation mirror (~/.ametyping/opencode/sessions): the
// dashboard stores them like Claude Code's, shows the OpenCode badge/resume command, keeps the permission provider,
// and "在电脑上继续" forwards `opencode -s <id>` with the folder from the mirror.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-opencode-'));
const HOME = path.join(T, 'home');
const SID = 'ses_01a0aaaa000070008000000000000001';
const ID = 'opencode:' + SID;
const CWD = process.platform === 'win32' ? 'D:\\work\\ocproj' : '/home/u/work/ocproj';
const MIRROR = path.join(HOME, '.ametyping', 'opencode', 'sessions');
fs.mkdirSync(MIRROR, { recursive: true });
const line = (o) => JSON.stringify(o) + '\n';
const at = new Date(Date.now() - 60e3).toISOString();
fs.writeFileSync(path.join(MIRROR, `${SID}.jsonl`),
  line({ v: 1, type: 'meta', id: SID, cwd: CWD, title: 'OpenCode 测试', timestamp: at }) +
  line({ v: 1, uuid: 'm1:user', timestamp: at, cwd: CWD, role: 'user', text: '把 opencode 接上看板', mid: 'm1' }) +
  line({ v: 1, uuid: 'm1:user', timestamp: at, cwd: CWD, role: 'user', text: '把 opencode 接上看板', mid: 'm1' }) +   // the old multi-instance bug wrote it twice
  line({ v: 1, uuid: 'm2:tool:c1', timestamp: at, cwd: CWD, role: 'tool', items: ['运行 npm test'], x: { op: 'cmd', cmd: 'npm test' } }) +
  line({ v: 1, uuid: 'm2:text', timestamp: at, cwd: CWD, role: 'assistant', text: '接好了。', mid: 'm2' }));
fs.writeFileSync(path.join(MIRROR, `${SID}.json`), JSON.stringify({ v: 1, id: SID, provider: 'opencode', pid: process.pid,
  directory: CWD, cwd: CWD, title: 'OpenCode 测试', modelProvider: 'deepseek', modelID: 'deepseek-chat', transcript: path.join(MIRROR, `${SID}.jsonl`), updated: Date.now() }));

const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18805, PET = 18806;
const petToken = 'test-opencode-token';
fs.mkdirSync(path.join(HOME, '.ametyping'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.ametyping', `control-token-${PET}`), petToken);
let petMode = 'terminal', launches = [];
const pet = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-ame-control'] !== petToken) { res.statusCode = 403; return res.end('{}'); }
    if (req.url === '/control/launch') { try { launches.push(JSON.parse(body || '{}')); } catch {} return res.end(JSON.stringify({ ok: true })); }
    res.end(JSON.stringify({ sessions: [{ id: ID, provider: 'opencode', label: 'OpenCode 测试', project: 'ocproj', state: 'idle', via: petMode,
      t0: Date.now(), last: Date.now(), lines: [], perms: [{ id: 'perm1', provider: 'opencode', tool: 'bash', cwd: CWD, input: '{"resources":["npm test"]}', always: '' }] }] }));
  });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: true, scanMs: 400, petPort: PET }));
const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); p.stderr.on('data', (s) => process.stderr.write(s)); kids.push(p); return p; };
function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0]); });
    r.end(body);
  });
}
async function until(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return false; }

(async () => {
  try {
    await new Promise((resolve, reject) => { pet.once('error', reject); pet.listen(PET, '127.0.0.1', resolve); });
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' });
    const ready = () => new Promise((resolve) => http.get(`http://127.0.0.1:${PORT}/login`, (res) => { res.resume(); resolve(true); }).on('error', () => resolve(false)));
    if (!(await until(ready, 10000))) throw new Error('temporary dashboard server did not start');
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG });
    const cookie = await login();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie } });
    let snap = []; const convs = []; const waiting = new Map(); let n = 0;
    ws.on('message', (m) => {
      const o = JSON.parse(m);
      if (o.t === 'sessions') snap = o.data;
      if (o.t === 'conv') convs.push(o);
      if (o.t === 'result' && waiting.has(o.rid)) { waiting.get(o.rid)(o); waiting.delete(o.rid); }
    });
    await new Promise((r) => ws.on('open', r));
    const act = (o) => new Promise((resolve) => { const rid = 'o' + (++n); waiting.set(rid, resolve); ws.send(JSON.stringify({ ...o, rid })); });
    const find = (id) => { const m = snap.find((x) => x.machine === 'box'); return m && m.sessions.find((s) => s.id === id); };

    ok('OpenCode session stored and listed from the plugin mirror', await until(() => find(ID)), JSON.stringify(snap));
    const s = find(ID) || {};
    ok('title from the mirror', s.label === 'OpenCode 测试', s.label);
    ok('resume with "opencode -s <id>" in its folder', typeof s.resume === 'string' && s.resume.includes('opencode -s ' + SID) && s.resume.includes('ocproj'), s.resume);
    ok('permission card keeps the OpenCode provider', (s.perms || []).some((p) => p.provider === 'opencode' && p.tool === 'bash'), JSON.stringify(s.perms));
    ok('the session’s AI provider reaches the badge', s.ai && s.ai.slug === 'deepseek' && s.ai.name === 'DeepSeek' && s.model && s.model.providerID === 'deepseek', JSON.stringify([s.ai, s.model]));
    ws.send(JSON.stringify({ t: 'watch', machine: 'box', id: ID }));
    await until(() => convs.length > 0, 5000);
    const msgs = convs.length ? convs[convs.length - 1].msgs : [];
    const text = JSON.stringify(msgs);
    ok('conversation: user, tool, reply', msgs.length === 3 && msgs[0].text === '把 opencode 接上看板' && msgs[1].items.length === 1 && msgs[2].text === '接好了。', text);
    ok('tool line readable', /运行 npm test/.test(text), text);

    // 在电脑上继续: a closed OpenCode session is forwarded with its own folder, from the mirror
    petMode = 'off';
    ok('session shows as closed when the pet says so', await until(() => find(ID)?.via === 'off'));
    const r = await act({ t: 'resume', machine: 'box', id: ID });
    const got = launches[launches.length - 1] || {};
    ok('在电脑上继续 forwards "opencode:<id>" and the mirror folder', r.ok === true && got.resume === ID && got.cwd === CWD, JSON.stringify([r, got]));
    ws.close();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    pet.closeAllConnections(); pet.close();
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
