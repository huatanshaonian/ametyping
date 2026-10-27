// The Windows headless service (headless/ame-headless-win.js) for real, on this Windows machine: started the way the
// installer starts it (conhost --headless, no window), on a port and a home folder of its own. A stand-in Claude Code
// (win-headless-target.js, run as "claude.exe") is launched from the dashboard's 启动 into a console window of its own;
// then a hook event finds its terminal, a reply is typed into it, its screen is read, a permission card is answered,
// and a second copy of the service refuses to start next to the first.
//   node remote/test/win-headless-e2e.js
'use strict';
const cp = require('child_process'), fs = require('fs'), path = require('path'), http = require('http');
if (process.platform !== 'win32') { console.log('SKIP Windows only'); process.exit(0); }
const R = path.resolve(__dirname, '..', '..');
const SVC = path.join(R, 'headless', 'ame-headless-win.js');
const TARGET = path.join(__dirname, 'win-headless-target.js');
const PORT = 3961;
const TMP = path.join(__dirname, 'out', 'win-headless-' + Date.now());
const HOME = path.join(TMP, 'home'), BIN = path.join(TMP, 'bin'), WORK = path.join(TMP, 'work');
for (const d of [HOME, BIN, WORK]) fs.mkdirSync(d, { recursive: true });
const res = []; const chk = (n, c, x) => { res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, step = 200) { const t = Date.now(); let v; while (Date.now() - t < ms) { if ((v = await fn())) return v; await sleep(step); } return v; }

// "claude.exe": node under that name (a hard link, or a copy across volumes)
const fakeClaude = path.join(BIN, 'claude.exe');
try { fs.linkSync(process.execPath, fakeClaude); } catch { fs.copyFileSync(process.execPath, fakeClaude); }

const env = { ...process.env, AME_PORT: String(PORT), USERPROFILE: HOME, PATH: BIN + path.delimiter + process.env.PATH };
const start = () => cp.spawn('conhost.exe', ['--headless', process.execPath, SVC], { env, stdio: 'ignore', windowsHide: true });
const tokenFile = path.join(HOME, '.ametyping', `control-token-${PORT}`);
let token = '';
function call(method, p, body, { auth = true, port = PORT } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (auth) headers['X-Ame-Control'] = token;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c);
      r.on('end', () => { let j = null; try { j = JSON.parse(b || 'null'); } catch {} resolve({ code: r.statusCode, body: j }); });
    });
    req.on('error', (e) => resolve({ code: 0, err: e.message })); req.end(data);
  });
}
const state = async () => ((await call('GET', '/control/state')).body || {}).sessions || [];
const kill = (pid) => { try { cp.spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch {} };

let svc, targetPid = 0;
(async () => {
  svc = start();
  token = await until(() => { try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; } }, 15000);
  chk('starts hidden and writes its control token', !!token && token.length === 64, token.length);
  const log = path.join(HOME, '.ametyping', 'headless.log');
  chk('logs its start', /无头服务启动/.test(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''), 0);

  // the control API: token only, no web pages
  chk('no token: refused', (await call('GET', '/control/state', null, { auth: false })).code === 403, 0);
  const st0 = await call('GET', '/control/state');
  chk('state: empty list, no switch of its own (agent.json decides)', st0.code === 200 && Array.isArray(st0.body.sessions) && !('control' in st0.body), st0.body);

  // 启动 from the dashboard: a new console window, "claude.exe <prompt>" in the folder
  const L = await call('POST', '/control/launch', { cwd: WORK, prompt: TARGET });
  chk('launch: ok', L.body && L.body.ok === true, L.body);
  targetPid = +(await until(() => { try { return fs.readFileSync(path.join(WORK, 'target.pid'), 'utf8'); } catch { return ''; } }, 15000)) || 0;
  chk('launch: the stand-in is running', targetPid > 0, targetPid);
  const bridge = require(path.join(R, 'app', 'bridge.js'));
  const own = await until(async () => { const t = await bridge.screen(targetPid); return t && /AME-HEADLESS-TARGET READY/.test(t) ? t : ''; }, 8000, 400);
  chk('launch: in a console of its own (its screen readable)', !!own, own);
  const anc = await bridge.ancestors(targetPid);
  bridge.stop();
  chk('launch: started by the service (through its console bridge)', anc.length > 1 && /^powershell\.exe$/i.test(anc[1].name), anc.slice(0, 3));

  // a hook event from it: the session listed, its terminal found
  const SID = '0b6f6a1e-4a59-4c6b-9d55-0c2f4ad1e001';
  const ev = await call('POST', '/event/message', { session: SID, text: '给无头服务写测试', project: 'work', cwd: WORK, pid: targetPid }, { auth: false });
  chk('hook event: answered', ev.code === 200, ev);
  const s1 = await until(async () => (await state()).find((x) => x.id === SID && x.via === 'terminal'), 8000);
  chk('hook event: listed, reply goes to its terminal', !!s1 && s1.state === 'message' && s1.lines.some((l) => l.text === '给无头服务写测试'), await state());

  // the dashboard's 终端画面 and a reply
  const sc = await call('POST', '/control/screen', { id: SID });
  chk('screen: read', sc.body && sc.body.ok && /AME-HEADLESS-TARGET READY/.test(sc.body.screen), sc.body);
  const sd = await call('POST', '/control/send', { id: SID, text: '你好 headless' });
  chk('reply: sent', sd.body && sd.body.ok === true, sd.body);
  const got = await until(() => { const t = fs.readFileSync(path.join(WORK, 'target-in.log'), 'utf8'); return /你好 headless\r/.test(t) ? t : ''; }, 6000);
  chk('reply: typed into the terminal, with Enter', !!got, fs.readFileSync(path.join(WORK, 'target-in.log'), 'utf8').slice(-80));
  const ky = await call('POST', '/control/key', { id: SID, key: 'down' });
  chk('key: sent', ky.body && ky.body.ok === true, ky.body);
  chk('key: arrived', !!(await until(() => fs.readFileSync(path.join(WORK, 'target-in.log'), 'utf8').endsWith('\u001b[B'), 4000)), 0);

  // a permission card: held open until answered from the dashboard
  let permAnswer = null;
  const perm = call('POST', '/permission', { session: SID, tool: 'Bash', input: { command: 'dir' }, cwd: WORK, pid: targetPid }, { auth: false }).then((r) => { permAnswer = r; });
  const card = await until(async () => { const s = (await state()).find((x) => x.id === SID); return s && s.perms.length ? s : null; }, 5000);
  chk('card: listed, session waiting', !!card && card.state === 'waiting' && card.perms[0].tool === 'Bash', card);
  const busy = await call('POST', '/control/send', { id: SID, text: 'should not go' });
  chk('reply refused while a card is open', busy.body && busy.body.ok === false && /确认/.test(busy.body.msg), busy.body);
  const dc = await call('POST', '/control/decide', { session: SID, id: card && card.perms[0].id, choice: 'allow' });
  await perm;
  chk('card: answered allow, the hook gets it', dc.body && dc.body.ok && permAnswer && permAnswer.body && permAnswer.body.choice === 'allow', [dc.body, permAnswer]);
  const after = (await state()).find((x) => x.id === SID);
  chk('card: session back to work', after && after.state === 'thinking' && after.perms.length === 0 && /已允许：Bash/.test(after.lines.slice(-1)[0].text), after);

  // /rename heard by the NAS
  const ti = await call('POST', '/control/title', { id: SID, title: '无头测试' });
  chk('title: set', ti.body && ti.body.ok && (await state()).find((x) => x.id === SID).label === '无头测试', ti.body);
  chk('morning / mail bubbles: not here', (await call('POST', '/control/report', { date: '2026-10-27' })).code === 404, 0);

  // one at a time: a second copy on the same port gives up
  const second = start();
  const code = await new Promise((r) => { second.on('exit', r); setTimeout(() => r('still running'), 8000); });
  if (code === 'still running') kill(second.pid);
  chk('a second copy exits (port taken), says why in the log', code !== 'still running' && /失败/.test(fs.readFileSync(log, 'utf8')), code);
  chk('the first still answers', (await call('GET', '/control/state')).code === 200, 0);
})().catch((e) => chk('no exception', false, e.stack)).finally(() => {
  if (targetPid) kill(targetPid);
  if (svc) kill(svc.pid);
  console.log(res.join('\n'));
  const bad = res.filter((l) => l.startsWith('FAIL')).length;
  console.log(`\n${res.length - bad}/${res.length} passed`);
  setTimeout(() => process.exit(bad ? 1 : 0), 300);
});
