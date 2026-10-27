// Offline CLI fixture for linux-codex-e2e.js. The process has Codex's /proc name, a real tty, bracketed paste,
// and invokes the real Ame hook adapter. It never connects to a model or executes submitted commands.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
process.title = 'codex';
const args = process.argv.slice(2), exec = args[0] === 'exec', resume = args[0] === 'resume' || exec;
const id = resume ? args.find((a) => /^[0-9a-f-]{36}$/.test(a)) : process.env.AME_FAKE_ID || randomUUID();
const log = (row) => fs.appendFileSync(process.env.AME_FAKE_LOG, JSON.stringify({ id, pid: process.pid, ...row }) + '\n');
const dir = path.join(process.env.CODEX_HOME, 'sessions', '2020', '01', '01');
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, `rollout-test-${id}.jsonl`);
const record = (type, payload) => fs.appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
if (!fs.existsSync(transcript)) record('session_meta', { id, cwd: process.cwd() });
function hook(event, extra = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.env.AME_TEST_HOOK], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => err += d);
    p.once('error', reject);
    p.once('close', (code) => {
      let result; try { result = JSON.parse(out); } catch { return reject(new Error(`hook ${event}: ${code} ${err} ${out}`)); }
      log({ kind: 'hook', event, result }); resolve(result);
    });
    p.stdin.end(JSON.stringify({ session_id: id, cwd: process.cwd(), transcript_path: transcript, hook_event_name: event, ...extra }));
  });
}
async function submit(text) {
  log({ kind: 'input', text });
  record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  await hook('UserPromptSubmit', { prompt: text });
  if (text === 'PERMISSION') {
    const tool = { tool_name: 'Bash', tool_input: { command: 'echo isolated-test', description: 'offline test only' } };
    await hook('PreToolUse', tool);
    const decision = await hook('PermissionRequest', tool);
    process.stdout.write('\r\nDECISION ' + JSON.stringify(decision) + '\r\n');
    await hook('PostToolUse', { ...tool, tool_response: { exit_code: 0 } });
  }
  record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RECEIVED ' + text }] });
  await hook('Stop', { last_assistant_message: 'RECEIVED ' + text });
  process.stdout.write('\r\nRECEIVED ' + text + '\r\n› Ask Codex to do anything\r\n');
}
(async () => {
  log({ kind: 'start', args, exec });
  await hook('SessionStart');
  if (exec) {
    let text = ''; process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += chunk;
    await new Promise((r) => setTimeout(r, 500));
    await submit(text);
    process.exit(0);
  }
  if (!process.stdin.isTTY) throw new Error('fixture requires a tty');
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
  let wire = '', draft = '', pasted = false, queue = Promise.resolve();
  process.stdin.on('data', (chunk) => {
    wire += chunk;
    while (wire) {
      const markers = ['\x1b[200~', '\x1b[201~'];
      if (markers.some((m) => m.startsWith(wire) && m !== wire)) break;
      if (wire.startsWith(markers[0])) { pasted = true; wire = wire.slice(6); continue; }
      if (wire.startsWith(markers[1])) { pasted = false; wire = wire.slice(6); continue; }
      const ansi = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(wire);
      if (ansi) { log({ kind: 'key', key: ansi[0] }); wire = wire.slice(ansi[0].length); continue; }
      const ch = wire[0]; wire = wire.slice(1);
      // tmux paste-buffer maps LF to CR; terminal text editors normalize pasted CR back to a line break.
      if (pasted) { draft += ch === '\r' ? '\n' : ch; continue; }
      if (ch === '\n' && process.platform === 'win32') draft += '\n'; // Codex on Windows: Ctrl+J inserts a newline.
      else if (ch === '\r' || ch === '\n') { const text = draft; draft = ''; queue = queue.then(() => submit(text)).catch((e) => { console.error(e); process.exit(1); }); }
      else if (ch === '\x15') draft = '';
      else if (ch === '\b' || ch === '\x7f') draft = draft.slice(0, -1);
      else if (ch >= ' ') draft += ch;
    }
  });
  process.stdout.write('\x1b[?2004h› Ask Codex to do anything\r\n');
  log({ kind: 'ready' });
  if (!resume && args.length) queue = queue.then(() => submit(args.join(' ')));
})().catch((e) => { console.error(e); process.exit(1); });
