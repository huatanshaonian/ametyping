#!/usr/bin/env node
'use strict';
// Antigravity (agy) lifecycle + permission hook adapter.
// stdout is reserved for the hook protocol (JSON output to agy).
const path = require('path');
const os = require('os');
const fs = require('fs');
const { aiOf, modelOf } = require('./app/ai-providers');
const { cut, baseName, postLoopbackJson, runJsonHook } = require('./remote/agent/hook-common');

const short = (s, n = 50) => cut(s, n, true);

function unquote(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
      try { return JSON.parse(s); } catch {}
    }
  }
  return v;
}

function parseArgs(raw) {
  let a = raw;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return {}; }
  }
  if (!a || typeof a !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    out[k] = unquote(v);
  }
  return out;
}

function cleanUserRequest(s) {
  const str = String(s || '');
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(str);
  if (m) return m[1].trim();
  if (/<(?:EPHEMERAL_MESSAGE|TASK_NOTIFICATION)>/i.test(str)) return '';
  return str.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '').trim();
}

function resolveEvent(d, argEvent) {
  if (argEvent) return argEvent;
  if (d && (d.hook_event_name || d.hookEventName || d.event)) {
    return d.hook_event_name || d.hookEventName || d.event;
  }
  if (!d || typeof d !== 'object') return 'SessionStart';
  if (d.terminationReason !== undefined || d.finalModelOutput !== undefined || d.fullyIdle !== undefined) {
    return 'Stop';
  }
  if (d.toolCall && d.error !== undefined) {
    return 'PostToolUse';
  }
  if (d.toolCall) {
    return 'PreToolUse';
  }
  if (typeof d.initialNumSteps === 'number' && typeof d.invocationNum === 'number') {
    return 'PreInvocation';
  }
  if (typeof d.invocationNum === 'number') {
    return 'PostInvocation';
  }
  return 'SessionStart';
}

const READ_TOOLS = new Set([
  'read_file', 'view_file', 'view_file_outline', 'view_code_item', 'Read',
  'list_dir', 'find_by_name', 'Glob', 'grep_search', 'Grep',
  'search_web', 'WebSearch', 'read_url_content', 'WebFetch',
]);

const WRITE_OR_EXEC_TOOLS = new Set([
  'run_command', 'Bash',
  'write_file', 'write_to_file', 'Write',
  'edit_file', 'replace_file_content', 'multi_replace_file_content', 'Edit',
]);

function describeTool(name, args = {}) {
  const n = String(name || '');
  const a = args || {};
  switch (n) {
    case 'run_command':
    case 'Bash': {
      const cmd = short(a.CommandLine || a.command || '', 45);
      return `运行: ${cmd || '命令'}`;
    }
    case 'manage_task':
    case 'command_status':
    case 'send_command_input':
      return '管理后台任务';
    case 'read_file':
    case 'view_file':
    case 'view_file_outline':
    case 'view_code_item':
    case 'Read':
      return `读取 ${baseName(a.Path || a.AbsolutePath || a.FilePath || a.file_path) || '文件'}`;
    case 'write_file':
    case 'write_to_file':
    case 'Write':
      return `写入 ${baseName(a.Path || a.TargetFile || a.file_path) || '文件'}`;
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'Edit':
      return `编辑 ${baseName(a.Path || a.TargetFile || a.file_path) || '文件'}`;
    case 'list_dir':
    case 'find_by_name':
    case 'Glob':
      return '查找文件';
    case 'grep_search':
    case 'Grep':
      return `搜索: ${short(a.Query || a.pattern || '', 30) || '代码'}`;
    case 'search_web':
    case 'WebSearch':
      return `网页搜索: ${short(a.query || '', 30)}`;
    case 'read_url_content':
    case 'WebFetch':
      return '读取网页';
    case 'invoke_subagent':
    case 'define_subagent':
    case 'manage_subagents':
    case 'send_message':
      return `调用子智能体: ${short(a.Role || a.TypeName || a.Name || a.Recipient || '', 30) || 'agent'}`;
    case 'ask_question':
    case 'AskUserQuestion':
      return '向你提问';
    case 'schedule':
      return '设置定时任务';
    case 'browser_subagent':
    case 'open_browser_url':
      return '操作浏览器';
    default:
      return `使用 ${n}`;
  }
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const rootFile = (id) => (SAFE_ID_RE.test(String(id || '')) ? path.join(os.tmpdir(), `ame-agy-root-${id}`) : '');

function ret(endpoint, payload, stdout = '{}') {
  return {
    endpoint,
    route: endpoint,
    payload,
    body: payload,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
  };
}

function resolveSubagentLineage(d, ev) {
  const convId = d.conversationId || d.conversation_id || d.session_id || d.session || '';
  let rootId = d.rootConversationId || d.parentConversationId || '';
  let subId = d.subagentConversationId || d.subagentId || d.agent_id || d.agentId || '';

  if (!rootId && convId) {
    try {
      const f = rootFile(convId);
      if (f && fs.existsSync(f)) {
        rootId = fs.readFileSync(f, 'utf8').trim();
        if (rootId && rootId !== convId) subId = convId;
      }
    } catch {}
  }

  if (ev === 'SubagentStart') {
    const parent = rootId || convId;
    const child = subId || (convId !== parent ? convId : '');
    if (parent && child && parent !== child) {
      const f = rootFile(child);
      if (f) { try { fs.writeFileSync(f, parent, 'utf8'); } catch {} }
      rootId = parent;
      subId = child;
    }
  } else if (ev === 'SubagentStop') {
    const child = subId || (convId !== rootId ? convId : '');
    const f = rootFile(child);
    if (f) { try { fs.unlinkSync(f); } catch {} }
  }

  const isSub = Boolean((rootId && rootId !== convId) || (subId && subId !== convId) || d.agent_id || d.agentId);
  const session = (isSub && rootId) ? rootId : convId;
  const agentId = isSub ? (subId || d.agent_id || d.agentId || (convId !== session ? convId : '')) : '';
  const subagent = isSub ? (d.agentName || d.agent_type || 'subagent') : (d.agent_type || '');
  return { isSub, session, agentId, subagent };
}

function buildPermissionPayload(base, ev, name, args) {
  if (name === 'ask_question' || name === 'AskUserQuestion') {
    const questions = (Array.isArray(args.questions) ? args.questions : []).map((q) => ({
      question: String(q.question || ''),
      header: q.header ? String(q.header) : undefined,
      multiSelect: Boolean(q.multiSelect || q.is_multi_select),
      options: (Array.isArray(q.options) ? q.options : []).map((o) =>
        typeof o === 'string'
          ? { label: o }
          : { label: String(o.label || ''), description: o.description ? String(o.description) : undefined }
      ),
    }));
    return { ...base, tool: 'AskUserQuestion', rawTool: name, input: { ...args, questions }, text: '向你提问' };
  }

  if (ev !== 'PermissionRequest' && !(process.env.AME_AGY_PERMISSIONS === '1' && WRITE_OR_EXEC_TOOLS.has(name))) {
    return null;
  }

  let tool = name;
  let input = { ...args };
  let alwaysRule;
  if (name === 'run_command' || name === 'Bash') {
    tool = 'Bash';
    const cmd = args.CommandLine || args.command || '';
    input = { ...args, command: cmd };
    alwaysRule = 'command(' + (cmd.trim().split(/\s+/)[0] || '*') + ')';
  } else if (name === 'write_file' || name === 'write_to_file' || name === 'Write') {
    tool = 'Write';
    input = { ...args, file_path: args.Path || args.TargetFile || args.file_path || '' };
  } else if (name === 'edit_file' || name === 'replace_file_content' || name === 'multi_replace_file_content' || name === 'Edit') {
    tool = 'Edit';
    input = { ...args, file_path: args.Path || args.TargetFile || args.file_path || '' };
  }
  return { ...base, tool, rawTool: name, input, alwaysRule, text: describeTool(name, args) };
}

function handleEvent(d, argEvent, eventAt = Date.now()) {
  if (!d || typeof d !== 'object') return null;
  const ev = resolveEvent(d, argEvent);
  const { isSub, session, agentId, subagent } = resolveSubagentLineage(d, ev);

  const cwd = (Array.isArray(d.workspacePaths) && d.workspacePaths[0]) || d.cwd || '';
  const project = cwd ? baseName(cwd) : 'unknown';
  const transcript = d.transcript || d.transcriptPath || d.transcript_path || '';
  const modelName = d.modelName || d.model || '';
  let modelProvider = d.modelProvider || '';
  if (!modelProvider && modelName) {
    if (/claude|sonnet|opus|haiku/i.test(modelName)) modelProvider = 'anthropic';
    else if (/gpt|o[134]-|openai/i.test(modelName)) modelProvider = 'openai';
    else if (/deepseek/i.test(modelName)) modelProvider = 'deepseek';
    else modelProvider = 'google';
  }

  const modelObj = modelOf({ modelID: modelName, modelProvider }) || (modelName ? { providerID: modelProvider || 'google', id: modelName } : null);
  const ai = modelObj ? aiOf(modelObj) : null;

  const base = {
    provider: 'agy',
    pid: isSub ? undefined : process.ppid,
    session,
    cwd,
    project,
    hookEvent: ev,
    eventAt,
    transcript: isSub ? undefined : transcript,
    ...(agentId ? { agentId } : {}),
    ...(subagent ? { subagent } : {}),
    ...(modelObj ? { model: modelObj, modelID: modelName, modelProvider: modelObj.providerID } : {}),
    ...(ai ? { ai } : {}),
  };

  switch (ev) {
    case 'SessionStart':
      return isSub
        ? ret('/event/thinking', { ...base, text: '子智能体开始: ' + (subagent || agentId) })
        : ret('/event/idle', { ...base, text: 'Antigravity 会话开始' });
    case 'UserPromptSubmit':
    case 'PreInvocation': {
      const prompt = cleanUserRequest(d.lastUserInput || d.prompt || '');
      return prompt
        ? ret('/event/message', { ...base, text: '收到指令: ' + short(prompt, 50), prompt })
        : ret('/event/thinking', { ...base, text: isSub ? ('子智能体思考: ' + subagent) : '思考中...' });
    }
    case 'PreToolUse':
    case 'PermissionRequest': {
      const tc = d.toolCall || {};
      const name = tc.name || d.tool_name || 'tool';
      const args = parseArgs(tc.args || d.tool_input);
      const perm = buildPermissionPayload(base, ev, name, args);
      if (perm) {
        return { permission: perm, endpoint: '/permission', route: '/permission', payload: perm, body: perm };
      }
      // AGY PreToolUse requires a "decision" field (empty {} is treated as fail-closed deny).
      return ret(
        READ_TOOLS.has(name) ? '/event/reading' : '/event/thinking',
        { ...base, tool: name, text: describeTool(name, args) },
        ev === 'PreToolUse' ? { decision: 'allow' } : '{}'
      );
    }
    case 'PostToolUse': {
      const tc = d.toolCall || {};
      const name = tc.name || d.tool_name || 'tool';
      const args = parseArgs(tc.args || d.tool_input);
      const failed = Boolean((typeof d.error === 'string' && d.error.trim()) || d.status === 'ERROR');
      return ret(failed ? '/event/error' : '/event/thinking', { ...base, tool: name, text: failed ? ('错误: ' + name) : ('完成: ' + describeTool(name, args)) });
    }
    case 'PostInvocation':
      return ret('/event/thinking', { ...base, text: '整理回复...' });
    case 'SubagentStart':
      return ret('/event/thinking', { ...base, text: '子智能体开始: ' + (subagent || agentId || 'agent') });
    case 'SubagentStop':
      return ret('/event/thinking', { ...base, text: '子智能体完成: ' + (subagent || agentId || 'agent') });
    case 'Stop': {
      if (isSub) return ret('/event/thinking', { ...base, text: '子智能体完成: ' + (subagent || agentId || 'agent') });
      if (['USER_CANCELED', 'INTERRUPTED', 'ABORTED'].includes(d.terminationReason)) {
        return ret('/event/paused', { ...base, text: '已打断' });
      }
      if (d.terminationReason === 'ERROR' || (typeof d.error === 'string' && d.error.trim())) {
        return ret('/event/error', { ...base, text: '出错: ' + short(d.error || '运行异常', 40) });
      }
      const lastMsg = d.last_assistant_message || d.finalModelOutput || '';
      const reply = short(lastMsg, 60);
      return ret('/event/done', { ...base, text: reply ? ('完成: ' + reply) : '本轮完成！', last_assistant_message: lastMsg });
    }
    case 'SessionEnd':
      return isSub
        ? ret('/event/thinking', { ...base, text: '子智能体退出' })
        : ret('/event/quit', { ...base, text: '会话结束' });
    default:
      return null;
  }
}

function decisionFor(r, perm) {
  if (!r) return {};
  const choice = r.choice || r.decision || '';
  if (choice === 'defer') return {};

  const isAsk = perm && (perm.tool === 'AskUserQuestion' || perm.tool === 'ask_question' || perm.rawTool === 'ask_question' || perm.rawTool === 'AskUserQuestion');
  if (isAsk) {
    if (r.updatedInput && r.updatedInput.answers) {
      const lines = Object.entries(r.updatedInput.answers).map(([q, a]) => `- ${q}: ${a}`).join('\n');
      const reason = '已由用户在糖糖看板回答：\n' + lines;
      return { decision: 'deny', permissionDecision: 'deny', reason, permissionDecisionReason: reason };
    }
    if (r.message || r.reason) {
      const reason = r.message || r.reason;
      return { decision: 'deny', permissionDecision: 'deny', message: reason, reason, permissionDecisionReason: reason };
    }
  }

  const dec = r.decision || (r.choice === 'always' ? 'allow' : r.choice);
  const isAlways = Boolean(r.always || r.choice === 'always');
  if (dec === 'allow') {
    const alwaysRule = (perm && perm.alwaysRule) || (r.updatedPermissions && r.updatedPermissions[0]) || undefined;
    return {
      decision: 'allow',
      permissionDecision: 'allow',
      ...(isAlways && alwaysRule ? { updatedPermissions: [alwaysRule], permissionOverrides: [alwaysRule] } : {}),
    };
  }
  if (dec === 'deny') {
    const msg = r.message || r.reason || '在糖糖的面板上被拒绝了';
    return { decision: 'deny', permissionDecision: 'deny', message: msg, reason: msg, permissionDecisionReason: msg };
  }
  return {};
}

function run() {
  const argEvent = process.argv[2] || '';
  // AGY PreToolUse is fail-closed when stdout lacks "decision"; fall back to allow on timeout/error/defer.
  const fallbackOut = argEvent === 'PreToolUse' ? { decision: 'allow' } : {};
  runJsonHook({
    fallbackOutput: fallbackOut,
    formatOutput: (outputVal) => {
      const out = (argEvent === 'PreToolUse' && outputVal && typeof outputVal === 'object' && !outputVal.decision)
        ? { decision: 'allow' }
        : outputVal;
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
    onPayload: async (d, ctx) => {
      const mapped = handleEvent(d, argEvent, ctx.eventAt);
      if (!mapped) return ctx.finish();
      if (mapped.permission) {
        ctx.setGuardTimeout(ctx.permissionTimeoutMs);
        const res = await postLoopbackJson({
          route: '/permission',
          body: mapped.permission,
          timeoutMs: ctx.permissionTimeoutMs,
          parseJson: true,
        });
        return ctx.finish(res.ok ? decisionFor(res.data, mapped.permission) : {});
      }
      if (mapped.endpoint) {
        const budget = ctx.notifyBudgetMs();
        if (budget <= 0) return ctx.finish(mapped.stdout || '{}');
        ctx.setGuardTimeout(budget, mapped.stdout || '{}');
        await postLoopbackJson({ route: mapped.endpoint, body: mapped.payload, timeoutMs: budget, parseJson: false });
        return ctx.finish(mapped.stdout || '{}');
      }
      ctx.finish();
    },
  });
}

if (require.main === module) run();

module.exports = {
  handleEvent,
  mapHook: handleEvent,
  describeTool,
  decisionFor,
  decision: decisionFor,
  unquote,
  parseArgs,
  cleanUserRequest,
  resolveEvent,
};
