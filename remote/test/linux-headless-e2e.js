// isolated test of ame-headless on dell97: port 3941, fake "claude" (cat) in tmux session amtest
const http = require('http'), fs = require('fs'), os = require('os'), { execSync, spawn } = require('child_process');
const PORT = 3941, H = os.homedir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function call(method, p, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, j }); }); });
    req.on('error', (e) => resolve({ code: 0, err: e.message })); req.end(data);
  });
}
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${cond ? '' : extra}`); };
(async () => {
  fs.mkdirSync(`${H}/amtest`, { recursive: true });
  try { fs.unlinkSync(`${H}/amtest/claude`); } catch {}
  fs.symlinkSync(execSync('command -v python3').toString().trim(), `${H}/amtest/claude`);
  fs.writeFileSync(`${H}/amtest/echo.py`, 'import sys\nfor l in sys.stdin: print("GOT:", l, end="")\n');
  execSync(`tmux new-session -d -s amtest -x 120 -y 30 "exec ${H}/amtest/claude ${H}/amtest/echo.py"`);
  await sleep(300);
  const pid = +execSync(`tmux list-panes -t amtest: -F '#{pane_pid}'`).toString().trim();
  const d = spawn(process.execPath, [`${H}/ametyping/headless/ame-headless.js`], { env: { ...process.env, AME_PORT: PORT }, stdio: 'inherit' });
  await sleep(600);
  try {
    const tok = fs.readFileSync(`${H}/.ametyping/control-token-${PORT}`, 'utf8').trim();
    const C = { 'X-Ame-Control': tok };
    ok('token file mode 600', (fs.statSync(`${H}/.ametyping/control-token-${PORT}`).mode & 0o777) === 0o600);
    ok('state without token -> 403', (await call('GET', '/control/state')).code === 403);
    ok('state with Origin -> 403', (await call('GET', '/control/state', null, { ...C, Origin: 'http://evil' })).code === 403);
    await call('POST', '/event/idle', { session: 't1', project: 'amtest', cwd: H, pid });
    await call('POST', '/event/message', { session: 't1', text: '收到：hi', pid });
    let st = (await call('GET', '/control/state', null, C)).j.sessions;
    const s = st.find((x) => x.id === 't1');
    ok('session located in tmux (via=terminal)', s && s.via === 'terminal', JSON.stringify(s));
    // permission long-poll
    const permP = call('POST', '/permission', { session: 't1', tool: 'Bash', input: { command: 'ls' }, pid });
    await sleep(200);
    st = (await call('GET', '/control/state', null, C)).j.sessions.find((x) => x.id === 't1');
    ok('permission card listed', st.perms.length === 1 && st.perms[0].tool === 'Bash', JSON.stringify(st.perms));
    const r0 = (await call('POST', '/control/send', { id: 't1', text: 'should be refused' }, C)).j;
    ok('send refused while waiting', r0 && r0.ok === false, JSON.stringify(r0));
    ok('decide wrong id refused', (await call('POST', '/control/decide', { session: 't1', id: 'nope', choice: 'allow' }, C)).j.ok === false);
    ok('decide allow', (await call('POST', '/control/decide', { session: 't1', id: st.perms[0].id, choice: 'allow' }, C)).j.ok === true);
    const pr = await permP;
    ok('hook received choice=allow', pr.j && pr.j.choice === 'allow', JSON.stringify(pr));
    await call('POST', '/event/thinking', { session: 't1', text: '在跑：ls', pid, hookEvent: 'PostToolUse' });
    // multi-line send into the pane
    const r1 = (await call('POST', '/control/send', { id: 't1', text: '第一行 hello\n第二行 world' }, C)).j;
    ok('send ok', r1 && r1.ok === true, JSON.stringify(r1));
    await sleep(400);
    const pane = execSync('tmux capture-pane -p -t amtest:').toString();
    ok('text arrived in pane', pane.includes('第一行 hello') && pane.includes('第二行 world'), JSON.stringify(pane.trim()));
    // hook disconnect cancels the card
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/permission', headers: { 'Content-Type': 'application/json' } });
    req.on('error', () => {}); req.end(JSON.stringify({ session: 't1', tool: 'Edit', pid }));
    await sleep(200); req.destroy(); await sleep(200);
    st = (await call('GET', '/control/state', null, C)).j.sessions.find((x) => x.id === 't1');
    ok('card gone after hook disconnect', st.perms.length === 0, JSON.stringify(st.perms));
    // process gone -> resume path chosen (not executed: session state not ended and pid dead)
    await call('POST', '/event/quit', { session: 't1' });
    st = (await call('GET', '/control/state', null, C)).j.sessions.find((x) => x.id === 't1');
    ok('ended session offers resume', st && st.via === 'resume', JSON.stringify(st));
  } finally {
    d.kill('SIGTERM'); await sleep(300);
    ok('token removed on exit', !fs.existsSync(`${H}/.ametyping/control-token-${PORT}`));
    try { execSync('tmux kill-session -t amtest'); } catch {}
    fs.rmSync(`${H}/amtest`, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
  }
})();
