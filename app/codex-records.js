// Codex CLI sessions (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) as the same slim records as Claude Code's
// (transcript.js recordsOf): what you and Codex said in full, each tool call as one line, tool output and
// reasoning left out. Sub-threads (auto review and the like: session_meta.parent_thread_id) are not sessions of
// their own and are skipped. Titles come from ~/.codex/session_index.jsonl (thread_name).
// Read by the pet (the panel's conversation) and by the remote agent (the dashboard's).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS = path.join(ROOT, 'sessions');
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// text Codex adds to the conversation itself (context, instructions), not something you typed
const HARNESS = /^\s*(<(environment_context|user_instructions|permissions|user_shell_command|turn_aborted|subagent_notification)|# AGENTS\.md instructions)/;

function toolLine(name, args) {
  name = String(name || '').replace(/^functions\./, '');
  if (name === 'shell' || name === 'exec_command' || name === 'shell_command') {
    let a = args; try { a = typeof args === 'string' ? JSON.parse(args) : args; } catch {}
    const cmd = Array.isArray(a && a.command) ? a.command[a.command.length - 1] : (a && (a.command || a.cmd)) || '';
    return `运行 ${cut(cmd, 90)}`;
  }
  if (name === 'apply_patch') {
    const files = [...String(args || '').matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => path.basename(m[1].trim()));
    return `修改 ${cut(files.join(' '), 80) || '文件'}`;
  }
  if (name === 'update_plan') return '更新计划';
  return `使用 ${name}`;
}
// the structured detail next to the line (as in app/transcript.js toolExtra): full command, patched files (paths as
// Codex wrote them, often relative to the session's folder), the plan's steps
function toolExtra(name, args) {
  name = String(name || '').replace(/^functions\./, '');
  if (name === 'shell' || name === 'exec_command' || name === 'shell_command') {
    let a = args; try { a = typeof args === 'string' ? JSON.parse(args) : args; } catch {}
    const cmd = Array.isArray(a && a.command) ? a.command[a.command.length - 1] : (a && (a.command || a.cmd)) || '';
    return cmd ? { op: 'cmd', cmd: String(cmd).slice(0, 600) } : undefined;
  }
  if (name === 'apply_patch') {
    const p = [...String(args || '').matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)].map((m) => m[1].trim());
    return p.length ? { op: 'edit', p: p.slice(0, 50) } : undefined;
  }
  if (name === 'update_plan') {
    let a = args; try { if (typeof args === 'string') a = JSON.parse(args); } catch {}
    const steps = a && Array.isArray(a.plan) ? a.plan : [];
    return steps.length ? { op: 'todo', todos: steps.slice(0, 40).map((s) => [String(s.step || '').slice(0, 200), String(s.status || '')]) } : undefined;
  }
  return undefined;
}
const toolRec = (name, args, t) => { const x = toolExtra(name, args); return x ? { role: 'tool', items: [toolLine(name, args)], t, x } : { role: 'tool', items: [toolLine(name, args)], t }; };

// the records one rollout line contributes
function recordsOf(o) {
  const out = [];
  if (!o || typeof o !== 'object') return out;
  const t = o && o.timestamp ? Date.parse(o.timestamp) : Date.now();
  const p = (o && o.payload) || {};
  if (o.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const text = (p.content || []).filter((c) => c && typeof c.text === 'string' && /^(input|output)_text$/.test(c.type)).map((c) => c.text).join('\n').trim();
    if (!text || (p.role === 'user' && HARNESS.test(text))) return out;
    out.push(p.role === 'user' ? { role: 'user', text, t } : { role: 'assistant', text, t, mid: p.id || undefined });
  } else if (o.type === 'response_item' && p.type === 'function_call') {
    out.push(toolRec(p.name, p.arguments, t));
  } else if (o.type === 'response_item' && p.type === 'custom_tool_call') {
    out.push(toolRec(p.name, p.input, t));
  } else if (o.type === 'response_item' && p.type === 'local_shell_call') {
    out.push(toolRec('shell', p.action, t));
  } else if (o.type === 'turn_context') {
    const mode = p.permission_mode || (p.collaboration_mode && p.collaboration_mode.mode === 'plan' ? 'plan' : p.approval_policy === 'never' ? 'dontAsk' : 'default');
    out.push({ role: 'mode', text: String(mode).slice(0, 24), t });
  } else if (o.type === 'compacted') {
    out.push({ role: 'sys', text: '（上下文已压缩）', t });
  } else if (o.type === 'event_msg' && p.type === 'turn_aborted') {
    out.push({ role: 'sys', text: '已中断', t });
  } else if (o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.last_token_usage) {
    // how full the context is ("used/window"), as Codex reports it after each request
    const used = +p.info.last_token_usage.total_tokens || 0, win = +p.info.model_context_window || 0;
    if (used > 0) out.push({ role: 'ctx', text: used + '/' + win, t });
  }
  return out;
}

// { id, cwd, sub } from the first line (session_meta)
function metadataOf(file) {
  try {
    // the whole first line: it carries Codex's instructions too (over 20 KB since 0.16x), so read on to its end
    const fd = fs.openSync(file, 'r'), parts = [];
    try {
      for (let at = 0; at < 1 << 20;) {
        const buf = Buffer.alloc(65536), n = fs.readSync(fd, buf, 0, buf.length, at);
        const nl = buf.subarray(0, n).indexOf(10);
        parts.push(buf.subarray(0, nl >= 0 ? nl : n));
        if (nl >= 0 || n < buf.length) break;
        at += n;
      }
    } finally { fs.closeSync(fd); }
    const o = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (o.type !== 'session_meta' || !o.payload || !o.payload.id) return null;
    return o.payload;
  } catch { return null; }
}
function metaOf(file) {
  const p = metadataOf(file);
  if (!p) return null;
  return { id: p.id, cwd: p.cwd || '', sub: !!p.parent_thread_id || !!(p.source && typeof p.source === 'object' && p.source.subagent) };
}

// A resumed thread keeps its original date directory. Filter by file mtime, never the directory's date.
function recentFiles(withinMs) {
  const out = [], now = Date.now();
  for (const file of allFiles()) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (now - st.mtimeMs <= withinMs) out.push({ file, mtime: st.mtimeMs });
  }
  return out;
}
// every rollout file (for telling the server where stored sessions live)
function allFiles() {
  const out = [];
  (function walk(d, depth) {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  })(SESSIONS, 0);
  return out;
}

// the rollout file of a thread id (its name ends with the id); the newest folders first
function fileOf(id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
  const hit = (list) => list.find((f) => f.endsWith(`-${id}.jsonl`));
  return hit(allFiles()) || null;
}

// thread titles (id -> name); re-read only when the index file changes
let titles = new Map(), titlesAt = 0;
function titleOf(id) {
  const f = path.join(ROOT, 'session_index.jsonl');
  try {
    const m = fs.statSync(f).mtimeMs;
    if (m !== titlesAt) {
      titlesAt = m; titles = new Map();
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) { try { const o = JSON.parse(l); if (o.id && o.thread_name) titles.set(o.id, String(o.thread_name)); } catch {} }
    }
  } catch {}
  return titles.get(id) || '';
}

module.exports = { recordsOf, metaOf, metadataOf, recentFiles, allFiles, fileOf, titleOf };
