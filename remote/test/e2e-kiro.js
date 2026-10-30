// e2e: Kiro CLI sessions (~/.kiro/sessions/cli/{id}.jsonl + {id}.json) are stored like Claude Code's and Codex's
// (slim records, title from the .json, `kiro-cli chat --resume-id`); a sub-session (session_created_reason
// "subagent") is skipped as a root. The agent discovers them, streams the conversation to the server, and the
// dashboard lists them with the right badge and resume command. A custom KIRO_HOME is honoured.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-kiro-'));
const HOME = path.join(T, 'home'); fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
// A custom KIRO_HOME (with a space, to catch quoting) shared by the agent and the record reader.
const KIRO_HOME = path.join(T, 'custom kiro home');
const CLI = path.join(KIRO_HOME, 'sessions', 'cli');
fs.mkdirSync(CLI, { recursive: true });
const MAIN = '11110000-0000-4000-8000-000000000001', SUB = '22220000-0000-4000-8000-000000000002';
const CWD = process.platform === 'win32' ? 'D:\\work\\proj' : '/home/u/work/proj';
const L = (o) => JSON.stringify(o) + '\n';
// the main session: a user turn, an assistant reply with a read tool, a (skipped) tool result, then a shell + reply
fs.writeFileSync(path.join(CLI, MAIN + '.jsonl'),
  L({ version: 1, kind: 'Prompt', data: { message_id: 'p0', content: [{ kind: 'text', data: '把 gui.py 的字体改一下' }], meta: { timestamp: 1700000000 } } }) +
  L({ version: 1, kind: 'AssistantMessage', data: { message_id: 'a0', content: [
    { kind: 'thinking', data: { text: 'SECRET-REASONING', signature: 's', redactedContent: [], modelId: 'm', toolsDigest: 'd' } },
    { kind: 'text', data: '好的，我先看看。' },
    { kind: 'toolUse', data: { toolUseId: 't0', name: 'read', input: { operations: [{ path: CWD + '/gui.py' }] } } },
  ] } }) +
  L({ version: 1, kind: 'ToolResults', data: { message_id: 'a0', content: [{ kind: 'toolResult', data: { toolUseId: 't0', content: ['TOOL-OUTPUT-SHOULD-NOT-BE-STORED'], status: 'success' } }], results: [{ toolUseId: 't0', status: 'success' }] } }) +
  L({ version: 1, kind: 'AssistantMessage', data: { message_id: 'a1', content: [
    { kind: 'toolUse', data: { toolUseId: 't1', name: 'shell', input: { command: 'python gui.py' } } },
    { kind: 'text', data: '改好了。' },
  ] } }));
fs.writeFileSync(path.join(CLI, MAIN + '.json'), JSON.stringify({
  session_id: MAIN, cwd: CWD, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:05:00Z', title: '改 GUI 字体',
  session_created_reason: 'user_prompt',
  session_state: { version: 'v1', conversation_metadata: { user_turn_metadatas: [{ model: 'claude-sonnet-4.5', context_usage_percentage: 9 }] } },
}));
// a sub-session: must not be listed as a root
fs.writeFileSync(path.join(CLI, SUB + '.jsonl'), L({ version: 1, kind: 'Prompt', data: { message_id: 'x', content: [{ kind: 'text', data: 'sub' }], meta: { timestamp: 1700000001 } } }));
fs.writeFileSync(path.join(CLI, SUB + '.json'), JSON.stringify({ session_id: SUB, cwd: CWD, title: 'sub', session_created_reason: 'subagent' }));
// a Kiro skill, and a Claude-only command, to prove command suggestions are isolated by provider
fs.mkdirSync(path.join(KIRO_HOME, 'skills', 'kiro-check'), { recursive: true });
fs.writeFileSync(path.join(KIRO_HOME, 'skills', 'kiro-check', 'SKILL.md'), '---\nname: kiro-check\ndescription: Kiro skill\n---');
fs.mkdirSync(path.join(HOME, '.claude', 'commands'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'commands', 'claude-only.md'), '# Claude command');

const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18797;
fs.mkdirSync(path.join(HOME, '.ametyping'), { recursive: true });
const petToken = 'test-kiro-token';
fs.writeFileSync(path.join(HOME, '.ametyping', 'control-token-18798'), petToken);
const pet = http.createServer((req, res) => {
  req.resume();
  res.setHeader('Content-Type', 'application/json');
  if (req.headers['x-ame-control'] !== petToken) { res.statusCode = 403; return res.end('{}'); }
  res.end(JSON.stringify({ sessions: [{ id: 'kiro:' + MAIN, provider: 'kiro', label: 'CLI label', project: 'proj', state: 'idle', via: 'terminal', t0: Date.now(), last: Date.now(), lines: [], perms: [] }] }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG, KIRO_HOME };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: true, scanMs: 400, petPort: 18798 }));
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
    await new Promise((resolve, reject) => { pet.once('error', reject); pet.listen(18798, '127.0.0.1', resolve); });
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' });
    const ready = () => new Promise((resolve) => http.get(`http://127.0.0.1:${PORT}/login`, (res) => { res.resume(); resolve(true); }).on('error', () => resolve(false)));
    if (!(await until(ready, 10000))) throw new Error('temporary dashboard server did not start');
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG });
    const cookie = await login();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie } });
    let snap = []; const convs = [];
    ws.on('message', (m) => { const o = JSON.parse(m); if (o.t === 'sessions') snap = o.data; if (o.t === 'conv') convs.push(o); });
    await new Promise((r) => ws.on('open', r));
    const find = (id) => { const m = snap.find((x) => x.machine === 'box'); return m && m.sessions.find((s) => s.id === id); };

    ok('Kiro session stored and listed', await until(() => find('kiro:' + MAIN)), JSON.stringify(snap));
    const s = find('kiro:' + MAIN) || {};
    ok('title from the .json metadata', s.label === '改 GUI 字体', s.label);
    ok('resume with kiro-cli chat --resume-id in its folder', typeof s.resume === 'string' && s.resume.includes('kiro-cli chat --resume-id ' + MAIN) && s.resume.includes('proj'), s.resume);
    ok('model vendor badge resolved (claude-sonnet-4.5 -> Anthropic)', s.ai && s.ai.slug === 'anthropic', JSON.stringify(s.ai));
    ok('sub-session not stored as a root', !find('kiro:' + SUB));

    const commands = (provider) => new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}/api/commands?machine=box&provider=${provider}`, { headers: { Cookie: cookie } }, (res) => {
        let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b).list || []); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const kiroCommands = await commands('kiro'), claudeCommands = await commands('claude');
    ok('command suggestions are isolated by provider', kiroCommands.some((c) => c.name === 'kiro-check') && !kiroCommands.some((c) => c.name === 'claude-only') && claudeCommands.some((c) => c.name === 'claude-only') && !claudeCommands.some((c) => c.name === 'kiro-check'), JSON.stringify({ kiroCommands, claudeCommands }));

    ws.send(JSON.stringify({ t: 'watch', machine: 'box', id: 'kiro:' + MAIN }));
    await until(() => convs.length > 0, 5000);
    const msgs = convs.length ? convs[convs.length - 1].msgs : [];
    const text = JSON.stringify(msgs);
    ok('conversation: user prompt, tool lines, assistant replies', msgs.some((m) => m.text === '把 gui.py 的字体改一下') && msgs.some((m) => m.text === '改好了。') && /gui\.py/.test(text) && /python gui\.py/.test(text), text);
    ok('reasoning and tool output left out', !/SECRET-REASONING|TOOL-OUTPUT/.test(text), text);
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
