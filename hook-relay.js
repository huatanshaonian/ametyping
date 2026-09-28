#!/usr/bin/env node
// Claude Code hook relay -> the AmeTyping desktop pet (listens on 127.0.0.1:3940).
// Maps the hook JSON to a pet event plus a short human-readable progress line
// ("在读 renderer.js", "完成了：..."), fires non-blocking POSTs, and always exits fast
// so hooks never slow Claude down (a pet not running = silently ignored). Local only.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORTS = [3940];
const eventAt = Date.now();
const READING_TOOLS = new Set(['Read', 'NotebookRead']);
setTimeout(() => process.exit(0), 700);            // hard exit guard

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(raw.replace(/^﻿/, '')); } catch {}
  const event = mapEvent(p);
  if (!event) process.exit(0);
  let text = '';
  try { text = describe(p, event); } catch {}
  let title = '';
  try { title = sessionTitle(p.transcript_path); } catch {}
  // pid: our parent, i.e. the Claude Code process (the pet walks up from it to find the terminal to reply into);
  // transcript + cwd: for the full conversation view and for resuming a closed session
  const body = JSON.stringify({ session: p.session_id || null, text, title, project: p.cwd ? path.basename(p.cwd) : '',
    cwd: p.cwd || '', transcript: p.transcript_path || '', pid: process.ppid,
    hookEvent: p.hook_event_name, agentId: p.agent_id || '', eventAt });
  let pending = PORTS.length;
  const done = () => { if (--pending <= 0) process.exit(0); };
  for (const port of PORTS) send(port, event, body, done);
});

function looksLikeToolError(r) {
  if (r == null || typeof r === 'string') return false;
  return r.is_error === true || r.isError === true || r.success === false;
}

function mapEvent(p) {
  // subagent internals: only their tool calls
  if (p.agent_id && !['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(p.hook_event_name)) return null;
  switch (p.hook_event_name) {
    case 'UserPromptSubmit': return 'message';
    case 'PreToolUse': return READING_TOOLS.has(p.tool_name) ? 'reading' : 'thinking';
    case 'PostToolUse': return looksLikeToolError(p.tool_response) ? 'error' : 'thinking';
    case 'PostToolUseFailure': return 'error';
    case 'Notification': return 'waiting';
    case 'Stop': return 'done';
    case 'StopFailure': return 'error';
    case 'SessionStart': return 'idle';
    case 'SessionEnd': return 'quit';
    default: return null;
  }
}

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (f) => (f ? path.basename(String(f)) : '');

function describeTool(name, i) {
  i = i || {};
  switch (name) {
    case 'Read': case 'NotebookRead': return `在读 ${base(i.file_path || i.notebook_path)}`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `在改 ${base(i.file_path || i.notebook_path)}`;
    case 'Write': return `在写 ${base(i.file_path)}`;
    case 'Bash': case 'PowerShell': return `在跑：${cut(i.description || i.command, 56)}`;
    case 'Grep': return `在找 “${cut(i.pattern, 24)}”`;
    case 'Glob': return `在找文件 ${cut(i.pattern, 26)}`;
    case 'WebSearch': return `在搜 ${cut(i.query, 48)}`;
    case 'WebFetch': return `在看网页 ${cut((i.url || '').replace(/^https?:\/\//, ''), 30)}`;
    case 'Agent': case 'Task': return `派了个助手：${cut(i.description || i.prompt, 48)}`;
    case 'TodoWrite': {
      const cur = (i.todos || []).find((t) => t.status === 'in_progress');
      return cur ? `正在：${cut(cur.activeForm || cur.content, 50)}` : '在整理待办';
    }
    case 'Skill': return `在用技能 ${cut(i.skill, 24)}`;
    default: return `在用 ${cut(name.replace(/^mcp__[^_]+__/, ''), 28)}`;
  }
}

// the conversation's title as shown in the Claude app (latest "custom-title" / "agent-name" line in the transcript)
function readTail(file, n) {
  const st = fs.statSync(file); n = Math.min(st.size, n);
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd);
  return buf.toString('utf8');
}
function sessionTitle(file) {
  if (!file || !fs.existsSync(file)) return '';
  for (const n of [256e3, 4e6]) {
    const lines = readTail(file, n).split(String.fromCharCode(10));
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.includes('"custom-title"') && !l.includes('"agent-name"')) continue;
      try { const o = JSON.parse(l); const t = o.customTitle || o.agentName; if (t) return String(t).slice(0, 60); } catch {}
    }
  }
  return '';
}

// last assistant text in the transcript (read only the tail of the file)
function lastAssistantText(file) {
  if (!file || !fs.existsSync(file)) return '';
  const st = fs.statSync(file), n = Math.min(st.size, 300000);
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').reverse();
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const m = o.message;
    if (o.type !== 'assistant' || !m || !Array.isArray(m.content)) continue;
    const t = m.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
    if (t) return t.replace(/[#*`>|_]/g, '').replace(/\s+/g, ' ');
  }
  return '';
}

function describe(p, event) {
  switch (p.hook_event_name) {
    case 'UserPromptSubmit': return `收到：${cut(p.prompt, 56)}`;
    case 'PreToolUse': return describeTool(p.tool_name, p.tool_input);
    case 'PostToolUse': return event === 'error' ? `出错了：${p.tool_name}` : '';
    case 'PostToolUseFailure': return `出错了：${p.tool_name}`;
    case 'Notification': {
      const msg = String(p.message || '');
      const perm = /permission to use (.+)$/i.exec(msg);
      if (perm) return `要你确认：用 ${cut(perm[1], 30)}`;
      if (/waiting for your input/i.test(msg)) return '在等你回复～';
      return `等你一下：${cut(msg, 50)}`;
    }
    case 'StopFailure': return `出错了：${p.error_type || 'API error'}`;
    case 'Stop': {
      const t = p.last_assistant_message ? String(p.last_assistant_message).replace(/[#*`>|_]/g, '').replace(/\s+/g, ' ')
        : lastAssistantText(p.transcript_path); return t ? `完成了：${cut(t, 150)}` : '完成了'; }
    default: return '';
  }
}

function send(port, event, body, done) {
  const req = http.request({ host: '127.0.0.1', port, path: `/event/${event}`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 400 },
    (res) => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(body);
}
