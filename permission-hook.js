#!/usr/bin/env node
// Claude Code PermissionRequest hook -> the AmeTyping pet: the permission prompt also shows up as a card in
// the pet's panel ([允许] [本会话都允许] [拒绝]). The terminal shows its own prompt at the same time; whichever
// you answer first wins (an answer in the terminal simply makes this hook's later reply irrelevant).
// Pet not running / no answer in time -> no output, and Claude Code carries on with its normal prompt.
// Configure WITHOUT "async" (the decision is this hook's output) and with a timeout above WAIT_MS, e.g. 120.
'use strict';
const http = require('http');
const path = require('path');

const PORT = 3940;
const WAIT_MS = 110e3;
setTimeout(() => process.exit(0), WAIT_MS + 3000).unref();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(raw.replace(/^﻿/, '')); } catch { process.exit(0); }
  const body = JSON.stringify({
    session: p.session_id || null, tool: p.tool_name || '', input: p.tool_input || {},
    suggestions: Array.isArray(p.permission_suggestions) ? p.permission_suggestions : [],
    project: p.cwd ? path.basename(p.cwd) : '', cwd: p.cwd || '', transcript: p.transcript_path || '',
    subagent: p.agent_type || '', agentId: p.agent_id || '', pid: process.ppid,
  });
  // the pet holds this request open until you choose (long poll)
  const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/permission',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { out += c; });
    res.on('end', () => {
      let d = {}; try { d = JSON.parse(out || '{}'); } catch {}
      reply(d, p);
    });
  });
  req.on('error', () => process.exit(0));                  // pet not running: the normal terminal prompt
  req.setTimeout(WAIT_MS, () => { req.destroy(); process.exit(0); });
  req.end(body);
});

function reply(d, p) {
  let decision = null;
  if (d.choice === 'allow') decision = { behavior: 'allow' };
  else if (d.choice === 'always') {                        // allow, and apply what the prompt offered ("…for this session")
    decision = { behavior: 'allow' };
    const s = (p.permission_suggestions || []).filter((x) => x && x.destination !== 'userSettings' && x.destination !== 'projectSettings' && x.destination !== 'localSettings');
    if (s.length) decision.updatedPermissions = s;
  } else if (d.choice === 'deny') decision = { behavior: 'deny', message: d.message || '在糖糖的面板上被拒绝了' };
  if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
  process.exit(0);
}
