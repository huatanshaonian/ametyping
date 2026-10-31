// Kiro CLI sessions (~/.kiro/sessions/cli/{id}.jsonl + {id}.json) as the same slim records as Claude Code's
// (app/transcript.js recordsOf) and Codex's (app/codex-records.js): what you and the model said in full, each tool
// call as one line, tool output and reasoning left out. Read by the pet (the panel's conversation) and by the remote
// agent (the dashboard's).
//
// The jsonl log is one { version, kind, data } object per line:
//   - kind "Prompt"           : your turn.  data.content is [ { kind: "text", data: <string> }, ... ];
//                               data.meta.timestamp is Unix seconds.
//   - kind "AssistantMessage" : the model's turn.  data.content items are
//                               { kind: "text", data: <string> }                         -> assistant text
//                               { kind: "thinking", data: { text, signature, ... } }      -> folded away (reasoning)
//                               { kind: "toolUse", data: { toolUseId, name, input } }      -> one tool line
//   - kind "ToolResults"      : tool output (skipped); a toolResult with status "error" marks the tool line failed.
// The {id}.json holds metadata: session_id, cwd, title, session_created_reason ("subagent" marks a sub-session), and
// session_state.conversation_metadata.user_turn_metadatas[] (per turn: model, context_usage_percentage).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.KIRO_HOME || path.join(os.homedir(), '.kiro');
const SESSIONS = path.join(ROOT, 'sessions', 'cli');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// a tool call -> its one-line summary (as app/transcript.js toolLine)
function toolLine(name, input) {
  const n = String(name || '');
  const i = input && typeof input === 'object' ? input : {};
  if (n === 'read') {
    const ops = Array.isArray(i.operations) ? i.operations : [];
    const files = ops.map((o) => o && o.path).filter(Boolean).map((p) => path.basename(String(p)));
    return `读取 ${cut(files.join(' '), 80) || '文件'}`;
  }
  if (n === 'shell') return `运行 ${cut(i.command, 90)}`;
  if (n === 'write') return `修改 ${cut(path.basename(String(i.path || '')), 80) || '文件'}`;
  if (n === 'code') return '修改代码';
  if (n === 'grep') return `搜索 ${cut(i.pattern, 60)}`;
  if (n === 'glob') return `查找 ${cut(i.pattern, 60)}`;
  if (n === 'introspect') return `查文档 ${cut(i.query, 50)}`;
  if (n === 'web_fetch') return `抓取 ${cut(i.url, 60)}`;
  if (n === 'web_search') return `搜网 ${cut(i.query, 50)}`;
  if (n === 'todo_list') return '更新任务清单';
  if (n === 'use_aws') return `AWS ${cut(i.service_name, 30)} ${cut(i.operation_name, 40)}`;
  if (n === 'knowledge') return `知识库 ${cut(i.command, 30)}`;
  if (n === 'subagent') return '启动子代理';
  return `使用 ${cut(n, 40)}`;
}

// the structured detail next to the line (as app/transcript.js toolExtra): { op, p / cmd / todos } -- paths the way
// Kiro wrote them (often relative to the session folder), the full command, the plan's steps
function toolExtra(name, input) {
  const n = String(name || '');
  const i = input && typeof input === 'object' ? input : {};
  if (n === 'read') {
    const ops = Array.isArray(i.operations) ? i.operations : [];
    const p = ops.map((o) => o && o.path).filter(Boolean).map(String).slice(0, 50);
    return p.length ? { op: 'read', p } : undefined;
  }
  if (n === 'shell') return i.command ? { op: 'cmd', cmd: String(i.command).slice(0, 600) } : undefined;
  if (n === 'write') return i.path ? { op: 'write', p: [String(i.path)] } : undefined;
  if (n === 'todo_list') {
    const tasks = Array.isArray(i.tasks) ? i.tasks : [];
    return tasks.length ? { op: 'todo', todos: tasks.slice(0, 40).map((s) => [String((s && (s.task_description || s.description || s.task)) || '').slice(0, 200), String((s && s.status) || '')]) } : undefined;
  }
  return undefined;
}
function toolRec(name, input, t) {
  const x = toolExtra(name, input);
  const rec = { role: 'tool', items: [toolLine(name, input)], t };
  if (x) rec.x = x;
  return rec;
}

// the text of a Prompt / AssistantMessage content array ({ kind:"text", data:<string> } items)
function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.kind === 'text' && typeof c.data === 'string').map((c) => c.data).join('\n').trim();
}

// the records one jsonl line contributes (o is the parsed { version, kind, data })
function recordsOf(o) {
  const out = [];
  if (!o || typeof o !== 'object' || !o.data || typeof o.data !== 'object') return out;
  const d = o.data;
  if (o.kind === 'Prompt') {
    const t = d.meta && Number.isFinite(d.meta.timestamp) ? d.meta.timestamp * 1000 : Date.now();
    const text = textOf(d.content);
    if (text) out.push({ role: 'user', text, t });
  } else if (o.kind === 'AssistantMessage') {
    const t = Date.now();
    const text = textOf(d.content);
    if (text) out.push({ role: 'assistant', text, t, mid: d.message_id || undefined });
    for (const c of Array.isArray(d.content) ? d.content : []) {
      if (c && c.kind === 'toolUse' && c.data) out.push(toolRec(c.data.name, c.data.input, t));
    }
  } else if (o.kind === 'ToolResults') {
    const results = Array.isArray(d.results) ? d.results : [];
    const content = Array.isArray(d.content) ? d.content : [];
    const failed = [...results, ...content].some((r) => r && (r.status === 'error' || (r.data && r.data.status === 'error')));
    if (failed) out.push({ role: 'sys', text: '工具出错', t: Date.now() });
  }
  return out;
}

// ---- metadata from the sibling {id}.json ----
// The {id}.json of an active session carries a huge session_state (the whole conversation metadata), so it is never
// parsed whole -- that blocks the scan loop. The fields the dashboard needs (id, cwd, title, reason, the parent
// pointer, the latest model) all sit near the top, so only the first chunk is read and matched with regexes.
function jsonPath(file) { return file.replace(/\.jsonl$/i, '.json'); }
const HEAD_BYTES = 16384;
function readHead(file, bytes = HEAD_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(bytes);
    const n = fs.readSync(fd, b, 0, bytes, 0);
    return b.toString('utf8', 0, n);
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}
const strField = (s, k) => { const m = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(s); if (!m) return ''; try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; } };
// light metadata: { session_id, cwd, title, session_created_reason, parentId, model } or null
function metadataOf(file) {
  const s = readHead(jsonPath(file));
  if (s == null) return null;
  const id = strField(s, 'session_id');
  if (!id) return null;
  // a real parent pointer, if any: top-level parent_id / parent_session_id, or the first turn's agent_id.parent_id.
  // "null" / absent means this is a top-level session (session_created_reason alone does NOT make it a sub-session).
  let parentId = '';
  const pm = /"parent_id"\s*:\s*"([0-9a-f-]{36})"/.exec(s) || /"parent_session_id"\s*:\s*"([0-9a-f-]{36})"/.exec(s);
  if (pm) parentId = pm[1];
  // the most recent model mentioned near the top (best-effort; the badge degrades to just the Kiro mark if absent)
  const models = [...s.matchAll(/"model"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  return { session_id: id, cwd: strField(s, 'cwd'), title: strField(s, 'title'),
    session_created_reason: strField(s, 'session_created_reason'), parentId, model: models.length ? models[models.length - 1] : '' };
}
// a model name ("claude-sonnet-4.5") -> { id } so ai-providers aiOf can find the vendor
function modelRef(name) { return typeof name === 'string' && name ? { providerID: '', id: name } : null; }

// { id, cwd, title, sub, model } -- sub is true ONLY when a real parent session is referenced. Kiro tags many
// top-level sessions with session_created_reason "subagent" even though their parent_id is null; those are real
// sessions and must be listed, so the reason string alone is NOT used to hide them.
function metaOf(file) {
  const o = metadataOf(file);
  if (!o) return null;
  return { id: o.session_id, cwd: typeof o.cwd === 'string' ? o.cwd : '', title: typeof o.title === 'string' ? o.title : '',
    sub: !!o.parentId, model: modelRef(o.model) };
}
function titleOf(id) {
  const file = fileOf(id);
  const m = file && metaOf(file);
  return m && m.title ? m.title : '';
}

// ---- files ----
function allFiles() {
  let ents = [];
  try { ents = fs.readdirSync(SESSIONS, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.jsonl') || !ID.test(e.name.slice(0, -6))) continue;
    const file = path.join(SESSIONS, e.name);
    let st; try { st = fs.statSync(file); } catch { continue; }
    out.push({ file, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function recentFiles(withinMs) {
  const now = Date.now();
  return allFiles().filter((f) => now - f.mtime <= withinMs);
}
function fileOf(id) {
  const raw = String(id || '').replace(/^kiro:/, '');
  if (!ID.test(raw)) return null;
  const file = path.join(SESSIONS, raw + '.jsonl');
  return fs.existsSync(file) ? file : null;
}
// a session is live while its {id}.lock exists
function isLive(id) {
  const raw = String(id || '').replace(/^kiro:/, '');
  if (!ID.test(raw)) return false;
  return fs.existsSync(path.join(SESSIONS, raw + '.lock'));
}

module.exports = { ROOT, SESSIONS, recordsOf, toolLine, toolExtra, textOf, metadataOf, metaOf, titleOf, allFiles, recentFiles, fileOf, isLive };
