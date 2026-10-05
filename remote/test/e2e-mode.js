// e2e: Claude Code's permission mode on the dashboard.
//   - the mode comes from the transcript's permission-mode lines (written with every message and on exit): the agent
//     streams them, the store keeps changes only, the session list carries the latest
//   - Shift+Tab (btab) goes server -> agent -> a fake pet that cycles modes like Claude Code; the result brings the
//     mode it switched to (the pet reads the status line once: app/permission-mode.js, checked on real screens)
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const { modeFromScreen } = require(path.resolve(R, '..', 'app', 'permission-mode'));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-mode-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-demo');
fs.mkdirSync(PROJ, { recursive: true }); fs.mkdirSync(path.join(HOME, '.ametyping'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18802, PET = 18803, SID = 'dddddddd-1111-2222-3333-444444444444';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };

// ---- the status line (read once after a Shift+Tab) ----
const screen = (status) => `❯ Try "how do I log an error?"\n${'─'.repeat(60)}\n  ⚠ Transcript saving is off\n  ${status} · install gh for PR status\n`;
ok('auto', modeFromScreen(screen('⏵⏵ auto mode on (shift+tab to cycle)')) === 'auto');
ok('manual', modeFromScreen(screen('⏸ manual mode on')) === 'manual');
ok('accept edits', modeFromScreen(screen('⏵⏵ accept edits on (shift+tab to cycle)')) === 'acceptEdits');
ok('plan', modeFromScreen(screen('⏸ plan mode on (shift+tab to cycle)')) === 'plan');
ok('bypass permissions', modeFromScreen(screen('⏵⏵ bypass permissions on (shift+tab to cycle)')) === 'bypassPermissions');
ok('words in the conversation above do not count', modeFromScreen('我们先 ⏸ plan mode on 看看\n' + 'x\n'.repeat(10) + '> \n  ? for shortcuts\n') === null);
ok('nothing readable: null', modeFromScreen(null) === null && modeFromScreen('') === null);

// ---- a transcript as Claude Code 2.1 writes it: permission-mode lines (no timestamp) around each message ----
const now = Date.now();
const TR = path.join(PROJ, SID + '.jsonl');
const J = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(TR, J({ type: 'permission-mode', permissionMode: 'auto', sessionId: SID }) +
  J({ type: 'user', uuid: 'u1', cwd: '/demo', timestamp: new Date(now - 60e3).toISOString(), permissionMode: 'auto', message: { role: 'user', content: '只回复 ok' } }) +
  J({ type: 'permission-mode', permissionMode: 'auto', sessionId: SID }) +
  J({ type: 'assistant', uuid: 'a1', cwd: '/demo', timestamp: new Date(now - 55e3).toISOString(), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) +
  J({ type: 'permission-mode', permissionMode: 'plan', sessionId: SID }));

// ---- server + agent + fake pet ----
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: true, petPort: PET, scanMs: 400 }));
const petToken = 'y'.repeat(64);
fs.writeFileSync(path.join(HOME, '.ametyping', `control-token-${PET}`), petToken);
const CYCLE = ['auto', 'manual', 'acceptEdits', 'plan'];
let mode = 'plan', bogus = false; const keys = [];
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-ame-control'] !== petToken) { res.statusCode = 403; return res.end('{}'); }
    const d = b ? JSON.parse(b) : {};
    if (req.url === '/control/state') return res.end(JSON.stringify({ control: true, sessions: [{ id: SID, label: 'demo', project: 'demo', state: 'idle', via: 'terminal', t0: now, last: now, lines: [], perms: [] }] }));
    if (req.url === '/control/key') {
      keys.push(d.key);
      if (d.key !== 'btab') return res.end(JSON.stringify({ ok: true }));
      mode = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length];
      return res.end(JSON.stringify({ ok: true, mode: bogus ? 'evil<script>' : mode }));
    }
    res.statusCode = 404; res.end('{}');
  });
}).listen(PET, '127.0.0.1');

const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
const post = (p, body) => new Promise((resolve) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(data) } },
    (res) => { res.resume(); resolve({ cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  req.end(data);
});
const code = (off = 0) => auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + off);
async function browser(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie } });
  const waiting = new Map(); let n = 0, snap = [];
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.t === 'sessions') snap = d.data; if (d.t === 'result' && waiting.has(d.rid)) { waiting.get(d.rid)(d); waiting.delete(d.rid); } });
  await new Promise((r) => ws.on('open', r));
  return { ws, session: () => { const m = snap.find((x) => x.machine === 'box'); return m && m.sessions.find((s) => s.id === SID); },
    act: (o) => new Promise((resolve) => { const rid = 'r' + (++n); waiting.set(rid, resolve); ws.send(JSON.stringify({ ...o, rid })); }) };
}
async function until(fn, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200); } return false; }

(async () => {
  try {
    // a stale code (AME_FRESH_MS=1): Shift+Tab needs the code like any key
    spawn([R + '/server/server.js'], { AME_FRESH_MS: '1', AME_FLUSH_MS: '300' }); await sleep(800);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }); await sleep(2500);
    let b = await browser((await post('/api/login', { user: 'u', password: 'pw-123456789012', code: code() })).cookie);
    ok('mode from the transcript: the latest recorded one', await until(() => (b.session() || {}).mode === 'plan'), JSON.stringify(b.session()));
    const k0 = await b.act({ t: 'key', machine: 'box', id: SID, key: 'btab' });
    ok('Shift+Tab needs a fresh code', !k0.ok && k0.need === 'totp' && keys.length === 0, JSON.stringify(k0));
    // the next message records the new mode: the list follows without any polling
    fs.appendFileSync(TR, J({ type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: SID }));
    ok('a new mode line updates the list', await until(() => (b.session() || {}).mode === 'acceptEdits'), JSON.stringify(b.session()));
    await sleep(800);
    const day = fs.readdirSync(path.join(T, 'srv', 'data')).find((d) => /^\d{4}-/.test(d));
    const stored = fs.readFileSync(path.join(T, 'srv', 'data', day, 'box', SID + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.role === 'mode');
    ok('only changes stored (auto, plan, acceptEdits)', stored.map((r) => r.text).join(',') === 'auto,plan,acceptEdits', stored.map((r) => r.text).join(','));
    b.ws.close();
    for (const k of kids.splice(0, 1)) k.kill(); await sleep(500);
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' }); await sleep(3500);
    b = await browser((await post('/api/login', { user: 'u', password: 'pw-123456789012', code: code(1) })).cookie);
    ok('the mode survives a server restart', await until(() => (b.session() || {}).mode === 'acceptEdits'), JSON.stringify(b.session()));
    const seen = [];
    for (let i = 0; i < 4; i++) { const r = await b.act({ t: 'key', machine: 'box', id: SID, key: 'btab' }); seen.push(r.ok ? r.mode : 'fail:' + r.msg); }
    ok('Shift+Tab cycles and brings the new mode back', seen.join(',') === 'auto,manual,acceptEdits,plan', seen.join(','));
    ok('the pet got btab', keys.length === 4 && keys.every((k) => k === 'btab'), keys.join(','));
    bogus = true;
    const bg = await b.act({ t: 'key', machine: 'box', id: SID, key: 'btab' });
    ok('a mode the server does not know is not passed on', bg.ok && bg.mode === undefined, JSON.stringify(bg));
    const e1 = await b.act({ t: 'key', machine: 'box', id: SID, key: 'shift+tab' });
    ok('unknown key names refused by the server', !e1.ok && keys.length === 5, JSON.stringify(e1));
    // Claude Code's Ctrl combinations: three fixed names reach the pet; any other combination does not
    const cs = [];
    for (const k of ['ctrlb', 'ctrls', 'ctrlxs']) cs.push((await b.act({ t: 'key', machine: 'box', id: SID, key: k })).ok);
    const e2 = await b.act({ t: 'key', machine: 'box', id: SID, key: 'ctrlc' }), e3 = await b.act({ t: 'key', machine: 'box', id: SID, key: 'ctrlx' });
    ok('Ctrl+B / Ctrl+S / Ctrl+X Ctrl+S reach the pet by name; other combinations are refused', cs.every(Boolean) && keys.slice(5).join() === 'ctrlb,ctrls,ctrlxs' && !e2.ok && !e3.ok, [cs, keys, e2, e3]);
    const { KEYS: TK } = require(path.resolve(R, '..', 'headless', 'tmux.js'));
    ok('tmux: the same names as send-keys keys (the chord as two)', TK.ctrlb === 'C-b' && TK.ctrls === 'C-s' && JSON.stringify(TK.ctrlxs) === '["C-x","C-s"]' && !TK.ctrlc, TK);
    const q = await Promise.race([b.act({ t: 'mode', machine: 'box', id: SID }), sleep(3000).then(() => ({ ok: false, ignored: true }))]);
    ok('there is no mode query action (no polling of screens)', !q.ok || q.mode === undefined, JSON.stringify(q));
    const audit = fs.readFileSync(path.join(T, 'srv', 'audit.log'), 'utf8');
    ok('keys audited', new RegExp(`control-key .* box ${SID} btab`).test(audit));
    b.ws.close();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
