// e2e: 产出物. Files a session wrote are checked by the machine's agent when the report is written: what git keeps
// (committed to a repository with a remote) is left out, the rest is listed with a note from the model and small
// files are copied to the NAS; the agent only answers for files that session wrote, never secrets.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createArtifacts } = require(R + '/agent/artifacts');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-art-'));
// the files made live outside the temp folder (temp is not where artifacts are looked for) and outside any repository
const W = fs.mkdtempSync(path.join(path.parse(__dirname).root, 'ame-art-work-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-work');
fs.mkdirSync(PROJ, { recursive: true });
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18808, SID = 'abababab-1111-2222-3333-444444444444';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 700)}`); };
const git = (cwd, ...a) => cp.execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });

// ---- the files ----
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const F = {
  plot: path.join(W, 'plot.py'), tracked: path.join(W, 'repo', 'tracked.py'), figure: path.join(W, 'repo', 'figure.png'),
  local: path.join(W, 'localrepo', 'a.txt'), big: path.join(W, 'big.bin'), env: path.join(W, '.env'),
  scratch: path.join(W, 'tmp', 'scratch.txt'), gone: path.join(W, 'gone.txt'), other: path.join(W, 'other.txt'),
};
for (const d of ['repo', 'localrepo', 'tmp']) fs.mkdirSync(path.join(W, d), { recursive: true });
fs.writeFileSync(F.plot, 'import matplotlib\n# RCS 对比图\n');
fs.writeFileSync(F.tracked, 'print(1)\n'); fs.writeFileSync(F.figure, PNG);
fs.writeFileSync(F.local, 'local notes\n'); fs.writeFileSync(F.big, Buffer.alloc(2000, 7));
fs.writeFileSync(F.env, 'SECRET=1\n'); fs.writeFileSync(F.scratch, 'x'); fs.writeFileSync(F.other, 'not written by the session');
git(path.join(W, 'repo'), 'init', '-q'); git(path.join(W, 'repo'), 'remote', 'add', 'origin', 'https://github.com/someone/proj.git');
git(path.join(W, 'repo'), 'add', 'tracked.py'); git(path.join(W, 'repo'), 'commit', '-q', '-m', 'x');
git(path.join(W, 'localrepo'), 'init', '-q'); git(path.join(W, 'localrepo'), 'add', 'a.txt'); git(path.join(W, 'localrepo'), 'commit', '-q', '-m', 'x');

// ---- the transcript: the session writes / edits all of them (gone.txt is written and deleted again) ----
const now = Date.now();
let n = 0;
const L = (o, t) => JSON.stringify({ uuid: 'u' + (++n), cwd: W, timestamp: new Date(t).toISOString(), ...o }) + '\n';
const tu = (name, input, t) => L({ type: 'assistant', message: { id: 'a' + n, role: 'assistant', content: [{ type: 'tool_use', id: 't' + n, name, input }] } }, t);
const TR = path.join(PROJ, SID + '.jsonl');
fs.writeFileSync(TR, L({ type: 'user', message: { role: 'user', content: '画一张 RCS 对比图' } }, now - 200e3) +
  tu('Write', { file_path: F.plot, content: '...' }, now - 190e3) + tu('Edit', { file_path: F.tracked }, now - 185e3) +
  tu('Write', { file_path: F.figure, content: '' }, now - 180e3) + tu('Edit', { file_path: F.local }, now - 175e3) +
  tu('Write', { file_path: F.big, content: '' }, now - 170e3) + tu('Write', { file_path: F.env, content: '' }, now - 165e3) +
  tu('Write', { file_path: F.scratch, content: '' }, now - 160e3) + tu('Write', { file_path: F.gone, content: '' }, now - 155e3) +
  L({ type: 'assistant', message: { id: 'af', role: 'assistant', content: [{ type: 'text', text: '图画好了。' }] } }, now - 150e3));

async function unit() {
  const sent = [];
  const a = createArtifacts({ sessionFile: (id) => (id === SID ? { file: TR, codex: false } : null), send: (o) => sent.push(o) });
  await a.handle({ rid: 'u1', items: [{ id: SID, path: F.other }, { id: 'nope', path: F.plot }, { id: SID, path: F.env }, { id: SID, path: 'relative.txt' }, { id: SID, path: F.plot }] });
  const r = sent.find((o) => o.t === 'art-res').items;
  ok('agent: a file the session did not write is refused', r[0].ok === false && r[0].why === 'not written by this session', r[0]);
  ok('agent: an unknown session is refused', r[1].ok === false && r[1].why === 'unknown session', r[1]);
  ok('agent: secrets refused even when written', r[2].ok === false && r[2].why === 'secret', r[2]);
  ok('agent: relative paths refused', r[3].ok === false, r[3]);
  ok('agent: a written file is checked (no repository)', r[4].ok && r[4].exists && r[4].size > 0 && !r[4].repo, r[4]);
  ok('agent: nothing sent without a backup request', !sent.some((o) => o.t === 'art-chunk'));
}

async function e2e() {
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
  const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
  node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { codex: [process.execPath, path.join(__dirname, 'fake-codex.js')], proxies: [], backupMaxMB: 0.001 }; cfg.summary.at = (() => { const d = new Date(Date.now() - 6 * 3600e3); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); })();   // day boundary 6 h ago: independent of the clock   // copies up to 1000 bytes
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
  const ACFG = path.join(T, 'agent.json');
  fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, scanMs: 400, petPort: 18809 }));
  const LOG = path.join(T, 'codex.log');
  const kids = [];
  const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, FAKE_CODEX_LOG: LOG, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
  const req = (method, p, body, cookie, raw) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
      'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); let j = null; if (!raw) try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, b, headers: res.headers, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
    });
    r.end(data);
  });
  try {
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' }); await sleep(3000);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG });
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    for (let i = 0; i < 60; i++) { const s = (await req('GET', '/api/sessions', null, cookie)).j; const m = s && s.data.find((x) => x.machine === 'box'); if (m && m.sessions.length) break; await sleep(250); }
    await sleep(1500);
    await req('POST', '/api/report/draft', {}, cookie);
    let list = null;
    for (let i = 0; i < 80; i++) { list = (await req('GET', '/api/reports', null, cookie)).j; if (list && list.draft && !list.status.running) break; await sleep(250); }
    const rep = (await req('GET', '/api/report?date=draft', null, cookie)).j || {};
    const arts = rep.artifacts || [];
    const got = (f) => arts.find((a) => a.path.toLowerCase() === f.toLowerCase());
    ok('listed: script outside a repository, untracked picture, local-only repository, big file', got(F.plot) && got(F.figure) && got(F.local) && got(F.big), arts.map((a) => a.path));
    ok('left out: committed with a remote, secret, scratch folder, deleted file', !got(F.tracked) && !got(F.env) && !got(F.scratch) && !got(F.gone), arts.map((a) => a.path));
    ok('git facts: untracked in a repository with a remote / local repository', got(F.figure).repo && got(F.figure).repo.tracked === false && /github/.test(got(F.figure).repo.remote) && got(F.local).repo && got(F.local).repo.remote === '', [got(F.figure), got(F.local)]);
    ok('small files copied, the big one not', got(F.plot).backed && got(F.figure).backed && !got(F.big).backed, arts);
    ok('notes from the model', /^说明 A\d+$/.test(got(F.plot).note), got(F.plot));
    const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const P = (calls.find((c) => /工作日报/.test(c.prompt)) || {}).prompt || '';
    ok('the model is shown the artifacts', /## 产出物/.test(P) && P.includes(F.plot), P.slice(-800));
    const d1 = await req('GET', `/api/artifact?sha=${got(F.plot).sha}&name=plot.py`, null, cookie, true);
    ok('copy downloadable, same bytes, shown as text', d1.status === 200 && d1.b.equals(fs.readFileSync(F.plot)) && /text\/plain/.test(d1.headers['content-type']), [d1.status, d1.headers['content-type']]);
    const d2 = await req('GET', `/api/artifact?sha=${got(F.figure).sha}&name=figure.png`, null, cookie, true);
    ok('a picture comes back as a picture', d2.status === 200 && d2.headers['content-type'] === 'image/png' && d2.b.equals(PNG), [d2.status, d2.headers['content-type']]);
    ok('unknown copy: 404; not logged in: 401', (await req('GET', '/api/artifact?sha=' + 'a'.repeat(64), null, cookie, true)).status === 404 && (await req('GET', `/api/artifact?sha=${got(F.plot).sha}`, null, null, true)).status === 401);
    const index = JSON.parse(fs.readFileSync(path.join(T, 'srv', 'data', 'artifacts', 'index.json'), 'utf8'));
    const ie = index.find((e) => e.path.toLowerCase() === F.plot.toLowerCase());
    ok('the index keeps them (machine, session, note, copy)', index.length === 4 && ie && ie.machine === 'box' && ie.sessions.includes(SID) && ie.backed && /^说明/.test(ie.note), index);
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
  }
}

(async () => {
  try { await unit(); await e2e(); } catch (e) { fail++; console.log('ERROR', e); }
  for (const d of [T, W]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
