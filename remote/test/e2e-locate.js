// e2e: where a path named in a conversation is (agent/locate.js), through the server to the browser's request:
// the folder the session was in when it said it, the full paths it used, its other folders, a bounded search; only
// what files.js lets be seen. Also files.js's "@claude-temp" root (Claude Code's temporary folder) and readOnly.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const { locate } = require(R + '/agent/locate');
const { createFiles } = require(R + '/agent/files');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ame-locate-')));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-cem');
const CEM = path.join(T, 'share', 'CEM_1');
const PORT = 18858;
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const put = (p, text = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

// a project with several branches; the session started in CEM_1, worked in CEM_FDTD, then in CST
put(path.join(CEM, 'CEM_FDTD', 'docs', 'figures', 'fdtd', 'vvd.png'));
put(path.join(CEM, 'CEM_FDTD', 'src', 'solver.py'));
put(path.join(CEM, 'CST', 'docs', 'figures', 'fdtd', 'vvd.png'));          // the same name in another branch
put(path.join(CEM, 'CST', 'model', 'run.py'));
put(path.join(CEM, 'OLD', 'deep', 'a', 'b', 'notes', 'plan.md'));          // only a search finds this one
put(path.join(CEM, 'CEM_FDTD', 'node_modules', 'x', 'skip', 'me.js'));     // never searched
put(path.join(CEM, 'CEM_FDTD', 'out', 'result.csv'));                       // named with its full path once
put(path.join(T, 'secret', 'docs', 'figures', 'fdtd', 'vvd.png'));         // outside what may be seen
const S = 'cccccccc-0000-0000-0000-00000000000c';
const t0 = Date.parse('2026-10-21T08:00:00Z');
const L = (min, cwd, content, role = 'assistant') => JSON.stringify({ type: role, cwd, timestamp: new Date(t0 + min * 60e3).toISOString(),
  message: { role, content: role === 'user' ? content : [{ type: 'text', text: content }] } });
fs.mkdirSync(PROJ, { recursive: true });
const TR = path.join(PROJ, S + '.jsonl');
fs.writeFileSync(TR, [
  L(0, CEM, '看看 FDTD 那边', 'user'),
  L(1, path.join(CEM, 'CEM_FDTD'), '图在 docs/figures/fdtd/vvd.png'),
  JSON.stringify({ type: 'assistant', cwd: path.join(CEM, 'CEM_FDTD'), timestamp: new Date(t0 + 2 * 60e3).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(CEM, 'CEM_FDTD', 'out', 'result.csv'), content: 'a,b' } }] } }),
  L(10, path.join(CEM, 'CST'), 'CST 的图也在 docs/figures/fdtd/vvd.png'),
  L(11, path.join(CEM, 'CST'), '模型脚本 model/run.py'),
].join('\n') + '\n');

const files = createFiles({ roots: [path.join(T, 'share')] });
const sessionFile = (id) => (id === S ? { file: TR } : null);
const at = (min) => t0 + min * 60e3;
const L1 = (p, a) => locate({ files, sessionFile }, { p, session: S, at: a });

(async () => {
  try {
    // ---- locate.js alone ----
    let r = await L1('docs/figures/fdtd/vvd.png', at(1));
    ok('1. said while in CEM_FDTD: found there (not the CST copy)', r.ok && r.found.length === 1 && r.found[0].path === path.join(CEM, 'CEM_FDTD', 'docs', 'figures', 'fdtd', 'vvd.png') && r.found[0].how === 'cwd', JSON.stringify(r));
    r = await L1('docs/figures/fdtd/vvd.png', at(10));
    ok('1. the same words said later, in CST: the CST one', r.ok && r.found.length === 1 && r.found[0].path === path.join(CEM, 'CST', 'docs', 'figures', 'fdtd', 'vvd.png'), JSON.stringify(r));
    r = await L1('out/result.csv', at(11));
    ok('2. a full path the session used (written while elsewhere)', r.ok && r.found[0].path === path.join(CEM, 'CEM_FDTD', 'out', 'result.csv') && r.found[0].how === 'session', JSON.stringify(r));
    r = await L1('src/solver.py', at(11));
    ok('3. another folder the session was in', r.ok && r.found[0].path === path.join(CEM, 'CEM_FDTD', 'src', 'solver.py') && r.found[0].how === 'folder', JSON.stringify(r));
    r = await L1('notes/plan.md', at(11));
    ok('4. only a search finds it (below where it started)', r.ok && r.found[0].path === path.join(CEM, 'OLD', 'deep', 'a', 'b', 'notes', 'plan.md') && r.found[0].how === 'search', JSON.stringify(r));
    r = await L1('fdtd/vvd.png', 0);
    ok('several places: all given, to pick from', r.ok && r.found.length === 2, JSON.stringify(r));
    r = await L1('skip/me.js', 0);
    ok('node_modules is not searched', !r.ok && /找不到/.test(r.msg), JSON.stringify(r));
    r = await locate({ files, sessionFile }, { p: path.join(T, 'secret', 'docs', 'figures', 'fdtd', 'vvd.png'), session: S });
    ok('an absolute path outside what may be seen: refused', !r.ok && /不在允许/.test(r.msg), JSON.stringify(r));
    r = await locate({ files, sessionFile }, { p: path.join(CEM, 'CST', 'model', 'run.py'), session: S });
    ok('an absolute path inside: as it is', r.ok && r.found[0].path === path.join(CEM, 'CST', 'model', 'run.py') && r.found[0].how === 'abs', JSON.stringify(r));
    r = await locate({ files, sessionFile }, { p: 'docs/x.png', session: 'nope' });
    ok('an unknown session: said so', !r.ok && /会话/.test(r.msg), JSON.stringify(r));

    // ---- files.js: "@claude-temp", readOnly ----
    const TMP = path.join(T, 'tmp'), CT = path.join(TMP, process.platform === 'win32' ? 'claude' : `claude-${process.getuid()}`);
    put(path.join(CT, '-proj', 'sess', 'scratchpad', 'shot.png'));
    const keep = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = TMP;
    const f2 = createFiles({ roots: [{ path: '~', hideDot: true, deny: ['AppData'] }, { path: '@claude-temp', readOnly: true }], upload: true });
    const rs = await f2.roots(true);
    Object.assign(process.env, keep);
    const tr = rs.find((x) => x.name === 'Claude 临时文件夹');
    ok('"@claude-temp" is Claude Code\'s temporary folder, under its own name', tr && tr.path === fs.realpathSync(CT) && tr.readOnly === true, JSON.stringify(rs));
    const shot = path.join(CT, '-proj', 'sess', 'scratchpad', 'shot.png');
    ok('a scratchpad file can be read', (await f2.list(path.dirname(shot))).entries.some((e) => e.name === 'shot.png'));
    let err = ''; try { await f2.target(path.dirname(shot), 'new.txt'); } catch (e) { err = e.message; }
    ok('readOnly: nothing uploaded there', /只读/.test(err), err);

    // ---- through the server: the browser asks, the agent looks ----
    const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
    const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
    const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
    node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
    const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
    const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
    const ACFG = path.join(T, 'agent.json');
    fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, scanMs: 400, keepMs: 1e12, files: { roots: [path.join(T, 'share')] } }));
    const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
    const up = () => new Promise((res) => http.get(`http://127.0.0.1:${PORT}/login`, (x) => { x.resume(); res(true); }).on('error', () => res(false)));
    for (let i = 0; i < 75 && !(await up()); i++) await sleep(200);
    const ag = cp.spawn(process.execPath, [R + '/agent/agent.js'], { env: { ...env, USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }, stdio: 'ignore' });
    try {
      const cookie = await new Promise((resolve) => {
        const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
          (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0]); });
        req.end(body);
      });
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie } });
      const got = new Map(); let online = false;
      ws.on('message', (m) => { const o = JSON.parse(m); if (o.t === 'fs-res') got.set(o.rid, o); if (o.t === 'sessions') online = o.data.some((x) => x.machine === 'box' && x.online && x.files); });
      await new Promise((res) => ws.on('open', res));
      for (let i = 0; i < 50 && !online; i++) await sleep(200);
      const ask = async (rid, o) => { ws.send(JSON.stringify({ t: 'fs', rid, machine: 'box', op: 'locate', ...o })); for (let i = 0; i < 50 && !got.has(rid); i++) await sleep(100); return got.get(rid); };
      let x = await ask('q1', { path: 'docs/figures/fdtd/vvd.png', session: S, at: at(10) });
      ok('through the server: the browser\'s request answered by the agent', x && x.ok && x.found.length === 1 && x.found[0].path === path.join(CEM, 'CST', 'docs', 'figures', 'fdtd', 'vvd.png'), JSON.stringify(x));
      x = await ask('q2', { path: 'docs/figures/fdtd/vvd.png', session: '../../etc', at: 0 });
      ok('a bad session id is dropped by the server', x && !x.ok && /会话/.test(x.msg), JSON.stringify(x));
      ws.close();
    } finally { ag.kill(); srv.kill(); }
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    await sleep(400); fs.rmSync(T, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
