#!/usr/bin/env node
// Claude Code PermissionRequest hook -> the AmeTyping pet: the permission prompt also shows up as a card in
// the pet's panel and the dashboard ([允许] [总是允许] [拒绝]). The terminal shows its own prompt at the same time; whichever
// you answer first wins (an answer in the terminal simply makes this hook's later reply irrelevant).
// Pet not running / no answer in time -> no output, and Claude Code carries on with its normal prompt.
// Configure WITHOUT "async" (the decision is this hook's output) and with a timeout above WAIT_MS, e.g. 3660.
'use strict';
const path = require('path');
const { postLoopbackJson, runJsonHook } = require('./remote/agent/hook-common');

const PORT = +process.env.AME_PORT || 3940;
const WAIT_MS = 3600e3; // the terminal prompt is shown meanwhile: waiting blocks nothing

function formatReply(d, p) {
  if (!d || typeof d !== 'object') return '';
  let decision = null;
  if (d.choice === 'allow') {
    decision = { behavior: 'allow' };
    if (d.updatedInput && typeof d.updatedInput === 'object' && !Array.isArray(d.updatedInput)) {
      decision.updatedInput = d.updatedInput;
    }
  } else if (d.choice === 'always') {
    decision = { behavior: 'allow' };
    const s = (p.permission_suggestions || []).filter((x) => x && typeof x === 'object');
    if (s.length) decision.updatedPermissions = s;
  } else if (d.choice === 'deny') {
    decision = { behavior: 'deny', message: d.message || '在糖糖的面板上被拒绝了' };
  }
  return decision ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }) : '';
}

function run() {
  runJsonHook({
    initialTimeoutMs: 2000,
    permissionTimeoutMs: WAIT_MS,
    fallbackOutput: '',
    formatOutput: (s) => (typeof s === 'string' ? s : ''),
    onPayload: async (p, ctx) => {
      if (!p || typeof p !== 'object') return ctx.finish('');
      ctx.setGuardTimeout(WAIT_MS + 3000, '');
      const body = {
        session: p.session_id || null,
        tool: p.tool_name || '',
        input: p.tool_input || {},
        suggestions: Array.isArray(p.permission_suggestions) ? p.permission_suggestions : [],
        project: p.cwd ? path.basename(p.cwd) : '',
        cwd: p.cwd || '',
        transcript: p.transcript_path || '',
        subagent: p.agent_type || '',
        agentId: p.agent_id || '',
        pid: process.ppid,
      };
      const res = await postLoopbackJson({
        port: PORT,
        route: '/permission',
        body,
        timeoutMs: WAIT_MS,
        parseJson: true,
      });
      ctx.finish(res.ok ? formatReply(res.data, p) : '');
    },
  });
}

if (require.main === module) run();
module.exports = { formatReply };
