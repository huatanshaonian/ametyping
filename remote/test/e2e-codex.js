// e2e: Codex CLI sessions are stored like Claude Code's (slim records, title from session_index, codex resume),
// sub-threads are skipped
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-codex-'));
const HOME = path.join(T, 'home'); fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
const DAY = path.join(HOME, '.codex', 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
fs.mkdirSync(DAY, { recursive: true });
const MAIN = '01a0aaaa-0000-7000-8000-000000000001', SUB = '01a0bbbb-0000-7000-8000-000000000002';
const CWD = process.platform === 'win32' ? 'D:\\work\\proj' : '/home/u/work/proj';
const L = (o) => JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + '\n';
fs.writeFileSync(path.join(DAY, `rollout-x-${MAIN}.jsonl`),
  L({ type: 'session_meta', payload: { id: MAIN, session_id: MAIN, cwd: CWD } }) +
  L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>x</cwd>' }] } }) +
  L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '把 gui.py 的字体改一下' }] } }) +
  L({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'SECRET-REASONING' } }) +
  L({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['powershell.exe', '-Command', 'Get-ChildItem'] }), call_id: 'c1' } }) +
  L({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'TOOL-OUTPUT-SHOULD-NOT-BE-STORED' } }) +
  L({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: gui.py\n@@\n-a\n+b\n*** End Patch', call_id: 'c2' } }) +
  L({ type: 'response_item', payload: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: '改好了。' }] } }));
fs.writeFileSync(path.join(DAY, `rollout-y-${SUB}.jsonl`),
  L({ type: 'session_meta', payload: { id: SUB, session_id: MAIN, parent_thread_id: MAIN, cwd: CWD } }) +
  L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review this' }] } }));
fs.writeFileSync(path.join(HOME, '.codex', 'session_index.jsonl'), JSON.stringify({ id: MAIN, thread_name: '改 GUI 字体', updated_at: new Date().toISOString() }) + '\n');

const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18795;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, scanMs: 400, petPort: 18796 }));
const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
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
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' }); await sleep(3000);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG });
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: await login() } });
    let snap = []; const convs = [];
    ws.on('message', (m) => { const o = JSON.parse(m); if (o.t === 'sessions') snap = o.data; if (o.t === 'conv') convs.push(o); });
    await new Promise((r) => ws.on('open', r));
    const find = (id) => { const m = snap.find((x) => x.machine === 'box'); return m && m.sessions.find((s) => s.id === id); };
    ok('Codex session stored and listed', await until(() => find('codex:' + MAIN)), JSON.stringify(snap));
    const s = find('codex:' + MAIN) || {};
    ok('title from session_index', s.label === '改 GUI 字体', s.label);
    ok('resume with codex resume in its folder', typeof s.resume === 'string' && s.resume.includes('codex resume ' + MAIN) && s.resume.includes('proj'), s.resume);
    ok('sub-thread not stored', !find('codex:' + SUB));
    ws.send(JSON.stringify({ t: 'watch', machine: 'box', id: 'codex:' + MAIN }));
    await until(() => convs.length > 0, 5000);
    const msgs = convs.length ? convs[convs.length - 1].msgs : [];
    const text = JSON.stringify(msgs);
    ok('conversation: user, tools, reply', msgs.length === 3 && msgs[0].text === '把 gui.py 的字体改一下' && msgs[1].items.length === 2 && msgs[2].text === '改好了。', text);
    ok('tool lines readable', /运行 Get-ChildItem/.test(text) && /修改 gui\.py/.test(text), text);
    ok('harness context, reasoning and tool output left out', !/environment_context|SECRET-REASONING|TOOL-OUTPUT/.test(text));
    ws.close();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
