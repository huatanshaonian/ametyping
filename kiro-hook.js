#!/usr/bin/env node
'use strict';
// Kiro CLI lifecycle adapter. Maps the five hook triggers Kiro CLI offers
// (agentSpawn / userPromptSubmit / preToolUse / postToolUse / stop) to the pet's /event/* endpoints, the same way
// codex-hook.js does for Codex. stdout is captured by Kiro (agentSpawn/userPromptSubmit stdout is added to the
// agent's context, so we keep it empty); progress is reported over the loopback HTTP channel instead.
//
// What Kiro does NOT provide, and how we cope (see docs/kiro-support.md):
//   - No PermissionRequest hook. preToolUse can only allow (exit 0) or block (exit 2, stderr returned to the model);
//     it cannot carry an approval decision back the way Codex's PermissionRequest does. So the pet shows progress and
//     the terminal keeps its own approval prompts; the dashboard answers through the terminal's screen and keys.
//   - No SessionEnd / Subagent / Interrupt / Compact triggers. Session close is inferred from the .lock file
//     disappearing (kiro-records.js); sub-sessions are told apart by the .json session_created_reason and skipped.
//
// The session id is KIRO_SESSION_ID (set by Kiro for every child process); the hook event JSON does not carry it.
const http = require('http');
const path = require('path');
const os = require('os');
const cut = (s, n = 100) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// the session's transcript jsonl (KIRO_HOME or ~/.kiro), for the panel's local conversation
function transcriptOf(session) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(session || ''))) return '';
  const home = process.env.KIRO_HOME || path.join(os.homedir(), '.kiro');
  return path.join(home, 'sessions', 'cli', session + '.jsonl');
}

// a tool's one-line "what it is doing now", and whether it is a read (the pet shows 读 vs 想)
function toolSummary(name, input) {
  const n = String(name || '');
  const i = input && typeof input === 'object' ? input : {};
  if (n === 'read') {
    const ops = Array.isArray(i.operations) ? i.operations : [];
    const f = ops.map((o) => o && o.path).filter(Boolean)[0];
    return { read: true, text: f ? `在看 ${cut(path.basename(String(f)), 60)}` : '在读取' };
  }
  if (n === 'grep' || n === 'glob') return { read: true, text: `在找 ${cut(i.pattern || i.query, 60)}` };
  if (n === 'introspect' || n === 'web_fetch' || n === 'web_search') return { read: true, text: `在查 ${cut(i.query || i.url, 60)}` };
  if (n === 'shell') return { read: false, text: `在跑 ${cut(i.command, 80)}` };
  if (n === 'write') return { read: false, text: `在改 ${cut(path.basename(String(i.path || '')), 60) || '文件'}` };
  if (n === 'code') return { read: false, text: '在改代码' };
  if (n === 'todo_list') return { read: false, text: '更新任务清单' };
  if (n === 'use_aws') return { read: false, text: `在调 AWS ${cut(i.service_name, 40)}` };
  if (n === 'subagent') return { read: false, text: '启动子代理' };
  return { read: false, text: `在用 ${cut(n, 40)}` };
}

// a hook event (stdin JSON) + the session id -> { route, body } or null
function mapHook(p, session, eventAt = Date.now()) {
  if (!p || typeof p !== 'object') return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(session || ''))) return null;
  const cwd = typeof p.cwd === 'string' ? p.cwd : '';
  const body = { provider: 'kiro', session, project: path.basename(cwd || ''), cwd, hookEvent: p.hook_event_name,
    eventAt, pid: process.ppid, transcript: transcriptOf(session) };
  let event, text = '';
  switch (p.hook_event_name) {
    case 'agentSpawn': case 'AgentSpawn': case 'SessionStart': event = 'idle'; break;
    case 'userPromptSubmit': case 'UserPromptSubmit': event = 'message'; text = `收到：${cut(p.prompt)}`; break;
    case 'preToolUse': case 'PreToolUse': {
      const s = toolSummary(p.tool_name, p.tool_input);
      event = s.read ? 'reading' : 'thinking'; text = s.text; break;
    }
    case 'postToolUse': case 'PostToolUse': {
      const r = p.tool_response;
      const failed = r && typeof r === 'object' && (r.success === false || r.status === 'error' || r.is_error || r.isError);
      event = failed ? 'error' : 'thinking'; text = failed ? `出错了：${cut(p.tool_name)}` : ''; break;
    }
    case 'stop': case 'Stop': event = 'done'; text = p.assistant_response ? `完成了：${cut(p.assistant_response, 200)}` : '完成了'; break;
    default: return null;
  }
  return { route: '/event/' + event, body: { ...body, text } };
}

function run() {
  const eventAt = Date.now();
  const session = process.env.KIRO_SESSION_ID || '';
  let finished = false, guard;
  const finish = () => {
    if (finished) return;
    finished = true; clearTimeout(guard);
    process.stdout.write('', () => process.exit(0));   // never add noise to the agent's context
  };
  guard = setTimeout(finish, 2000);
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; if (raw.length > 2e6) finish(); });
  process.stdin.on('error', () => finish());
  process.stdin.on('end', () => {
    let p; try { p = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return finish(); }
    const mapped = mapHook(p, session, eventAt);
    if (!mapped) return finish();
    clearTimeout(guard); guard = setTimeout(finish, 700);
    const data = JSON.stringify(mapped.body);
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.AME_PORT) || 3940,
      path: mapped.route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      res.on('data', () => {}); res.on('error', () => finish()); res.on('end', () => finish());
    });
    req.on('error', () => finish());
    req.end(data);
  });
}
if (require.main === module) run();
module.exports = { mapHook, toolSummary, transcriptOf };
