#!/usr/bin/env node
'use strict';
// Codex lifecycle + permission adapter. stdout is reserved for the hook protocol.
const http = require('http');
const path = require('path');
const cut = (s, n = 100) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

function mapHook(p, eventAt = Date.now()) {
  if (!p || typeof p.session_id !== 'string' || !p.session_id) return null;
  const body = { provider: 'codex', session: p.session_id, project: path.basename(p.cwd || ''),
    cwd: p.cwd || '', hookEvent: p.hook_event_name, eventAt,
    agentId: p.agent_id || '', subagent: p.agent_type || '' };
  const input = p.tool_input || {};
  if (p.hook_event_name === 'PermissionRequest') {
    return { route: '/permission', body: { ...body, tool: p.tool_name || '工具', input } };
  }
  let event, text = '';
  switch (p.hook_event_name) {
    case 'SessionStart': event = 'idle'; break;
    case 'SessionEnd': event = 'quit'; break;
    case 'UserPromptSubmit': event = 'message'; text = `收到：${cut(p.prompt)}`; break;
    case 'PreToolUse': {
      event = 'thinking';
      if (p.tool_name === 'apply_patch') {
        const files = [...String(input.command || '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]);
        text = files.length ? `在改：${cut(files.join('、'))}` : '在修改文件';
      } else if (p.tool_name === 'Bash') text = `在跑：${cut(input.description || input.command)}`;
      else text = `在用 ${cut(p.tool_name)}`;
      break;
    }
    case 'PostToolUse': {
      const r = p.tool_response;
      const failed = r && typeof r === 'object' && (r.is_error || r.isError || r.success === false || (typeof r.exit_code === 'number' && r.exit_code !== 0));
      event = failed ? 'error' : 'thinking'; text = failed ? `出错了：${cut(p.tool_name)}` : '';
      break;
    }
    case 'Stop': event = 'done'; text = p.last_assistant_message ? `完成了：${cut(p.last_assistant_message, 200)}` : '完成了'; break;
    case 'Interrupt': event = 'paused'; text = '已中断'; break;
    default: return null;
  }
  return { route: '/event/' + event, body: { ...body, text } };
}

function decision(d) {
  if (!d || !['allow', 'deny'].includes(d.choice)) return {};
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
    behavior: d.choice, ...(d.choice === 'deny' ? { message: '在糖糖的面板上被拒绝了' } : {}),
  } } };
}

function run() {
  const eventAt = Date.now();
  let finished = false, guard;
  const finish = (output = {}) => {
    if (finished) return;
    finished = true; clearTimeout(guard);
    process.stdout.write(JSON.stringify(output), () => process.exit(0));
  };
  guard = setTimeout(finish, 2000);
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; if (raw.length > 2e6) finish(); });
  process.stdin.on('error', () => finish());
  process.stdin.on('end', () => {
    let p; try { p = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return finish(); }
    const mapped = mapHook(p, eventAt);
    if (!mapped) return finish();
    const permission = mapped.route === '/permission';
    clearTimeout(guard); guard = setTimeout(finish, permission ? 110000 : 700);
    const body = JSON.stringify(mapped.body);
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.AME_PORT) || 3940,
      path: mapped.route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { response += c; if (response.length > 65536) { res.destroy(); finish(); } });
      res.on('error', () => finish());
      res.on('end', () => {
        let d; try { d = JSON.parse(response); } catch {}
        finish(permission && res.statusCode === 200 ? decision(d) : {});
      });
    });
    req.on('error', () => finish());
    req.end(body);
  });
}
if (require.main === module) run();
module.exports = { mapHook, decision };
