#!/usr/bin/env node
'use strict';
// Codex lifecycle + permission adapter. stdout is reserved for the hook protocol.
const path = require('path');
const { cutRawWs: cut, looksLikeToolFailure, postLoopbackJson, runJsonHook } = require('./remote/agent/hook-common');

function mapHook(p, eventAt = Date.now()) {
  if (!p || typeof p.session_id !== 'string' || !p.session_id) return null;
  const body = {
    provider: 'codex',
    session: p.session_id,
    project: path.basename(p.cwd || ''),
    cwd: p.cwd || '',
    hookEvent: p.hook_event_name,
    eventAt,
    // pid: what started us (Codex, or the shell it runs hooks through): the pet walks up from it to the terminal
    pid: p.agent_id ? undefined : process.ppid,
    transcript: !p.agent_id && typeof p.transcript_path === 'string' ? p.transcript_path : undefined,
    agentId: p.agent_id || '',
    subagent: p.agent_type || '',
  };
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
      const failed = looksLikeToolFailure(p.tool_response);
      event = failed ? 'error' : 'thinking';
      text = failed ? `出错了：${cut(p.tool_name)}` : '';
      break;
    }
    case 'Stop': event = 'done'; text = p.last_assistant_message ? `完成了：${cut(p.last_assistant_message, 200)}` : '完成了'; break;
    case 'Interrupt': event = 'paused'; text = '已中断'; break;
    case 'PreCompact': event = 'thinking'; text = '正在压缩上下文'; break;
    case 'PostCompact': event = 'thinking'; text = '上下文已压缩，继续工作'; break;
    case 'SubagentStart': event = 'thinking'; text = `子代理开始：${cut(p.agent_type || p.agent_id)}`; break;
    case 'SubagentStop': event = 'thinking'; text = `子代理完成：${cut(p.agent_type || p.agent_id)}`; break;
    default: return null;
  }
  // A child finishing must not mark its still-working parent as done (or close it).
  if (p.agent_id && (event === 'done' || event === 'quit' || event === 'idle')) event = 'thinking';
  return { route: '/event/' + event, body: { ...body, text } };
}

function decision(d) {
  if (!d || !['allow', 'deny'].includes(d.choice)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: d.choice,
        ...(d.choice === 'deny' ? { message: '在糖糖的面板上被拒绝了' } : {}),
      },
    },
  };
}

function run() {
  runJsonHook({
    fallbackOutput: {},
    onPayload: async (p, ctx) => {
      const mapped = mapHook(p, ctx.eventAt);
      if (!mapped) return ctx.finish({});
      const permission = mapped.route === '/permission';
      const budget = permission ? ctx.permissionTimeoutMs : ctx.notifyBudgetMs();
      if (!permission && budget <= 0) return ctx.finish({});
      ctx.setGuardTimeout(budget, {});
      const res = await postLoopbackJson({
        route: mapped.route,
        body: mapped.body,
        timeoutMs: budget,
        parseJson: permission,
      });
      ctx.finish(permission && res.ok ? decision(res.data) : {});
    },
  });
}

if (require.main === module) run();
module.exports = { mapHook, decision };
