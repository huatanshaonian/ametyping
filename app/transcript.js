// Reads a Claude Code session transcript (~/.claude/projects/<proj>/<session>.jsonl) into a chat log for
// the panel's "常驻对话" mode. The file only ever grows, so each session keeps a byte offset and only the
// new tail is parsed on every poll. Main process only (plain Node fs).
'use strict';
const fs = require('fs');
const path = require('path');

const FIRST_READ = 3e6;        // on first open, only the last ~3 MB of a long transcript is read
const KEEP = 400;              // messages kept per session

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (f) => (f ? path.basename(String(f)) : '');

function toolLine(name, i) {
  i = i || {};
  switch (name) {
    case 'Read': case 'NotebookRead': return `读取 ${base(i.file_path || i.notebook_path)}`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `修改 ${base(i.file_path || i.notebook_path)}`;
    case 'Write': return `写入 ${base(i.file_path)}`;
    case 'Bash': case 'PowerShell': return `运行 ${cut(i.description || i.command, 90)}`;
    case 'Grep': return `搜索 ${cut(i.pattern, 50)}`;
    case 'Glob': return `查找 ${cut(i.pattern, 50)}`;
    case 'WebSearch': return `搜索网页 ${cut(i.query, 60)}`;
    case 'WebFetch': return `打开 ${cut(i.url, 70)}`;
    case 'Agent': case 'Task': return `子代理 ${cut(i.description || i.prompt, 60)}`;
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return '更新任务列表';
    case 'ExitPlanMode': return '提交计划';
    case 'AskUserQuestion': { const q = Array.isArray(i.questions) ? i.questions : []; return `提问 ${cut(q.map((x) => x && x.question).filter(Boolean).join(' / '), 90)}`; }
    case 'Skill': return `技能 ${cut(i.skill, 30)}`;
    default: return name && name.startsWith('mcp__') ? `调用 ${name.split('__').slice(1).join('/')}` : `使用 ${name}`;
  }
}

// Detail kept next to a tool call's one-line description (x on the record): the full path of a file written or
// edited, the whole command, the task list, a plan's text. The daily summary reads it (what was made where, what was
// planned); the panel ignores it. Reads and tool output are still left out.
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
function toolExtra(name, i) {
  i = i || {};
  switch (name) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': { const p = i.file_path || i.notebook_path; return p ? { op: 'edit', p: [String(p)] } : undefined; }
    case 'Write': return i.file_path ? { op: 'write', p: [String(i.file_path)] } : undefined;
    case 'Bash': case 'PowerShell': return i.command ? { op: 'cmd', cmd: clip(i.command, 600) } : undefined;
    case 'TodoWrite': return Array.isArray(i.todos) ? { op: 'todo', todos: i.todos.slice(0, 40).map((t) => [clip(t && t.content, 200), String((t && t.status) || '')]) } : undefined;
    case 'TaskCreate': return { op: 'task', task: [clip(i.subject || i.description, 200), 'pending'] };
    case 'TaskUpdate': return { op: 'task', task: [clip(i.subject || `#${i.taskId || ''}`, 200), String(i.status || '')] };
    case 'ExitPlanMode': return i.plan ? { op: 'plan', plan: clip(i.plan, 30000) } : undefined;
    default: return undefined;
  }
}

const FORK = /⑂ forked (\S+) \(([0-9a-f]+)\)/;
// What a slash command printed (<local-command-stdout> / -stderr): the terminal's colours taken out, as text.
// null: nothing worth a record (empty, "(no content)", /btw's fork line -- that one is paired with its answer below).
const CMD_OUT = 20000;
function commandOutput(s) {
  const parts = [...String(s || '').matchAll(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/g)].map((m) => m[1]);
  if (!parts.length) return null;
  const text = parts.join('\n').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '');
  if (!text.trim() || text.trim() === '(no content)' || FORK.test(text)) return null;
  return text.length > CMD_OUT ? text.slice(0, CMD_OUT) + '\n…' : text;
}

// a user "message" that is really the harness talking (slash commands, ! shell, reminders): tidy or drop it
// (a string: what you typed; { sys }: a note; { cmd }: what a slash command printed)
function userText(s) {
  s = String(s || '');
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(s);
  if (cmd) { const a = /<command-args>([^<]*)<\/command-args>/.exec(s); return `${cmd[1]} ${a ? a[1] : ''}`.trim(); }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(s);
  if (bash) return '! ' + bash[1].trim();
  const out = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(s);
  if (out) return out[1].trim() ? { sys: cut(out[1], 300) } : null;
  if (/^\s*<local-command-std(out|err)>/.test(s)) { const c = commandOutput(s); return c ? { cmd: c } : null; }
  if (/^\s*<(local-command-|system-reminder|task-notification)/.test(s)) return null;
  if (/^\[Request interrupted/.test(s)) return { sys: '已中断' };
  return s.trim() || null;
}

// The records one transcript line contributes, unmerged: what the conversation says without the tool output
// (user / assistant text in full, each tool call as one line). The dashboard agent stores these on the server;
// the panel merges them (parseLine).
// /btw (a side question): Claude Code forks a background agent and shows its answer in an overlay; the transcript only
// has the command's output "⑂ forked <name> (<suffix>)" and, later, a task notification for task "a<name>-…<suffix>"
// with the answer in <result>. st (any object kept per transcript) pairs the two: the question becomes a user record,
// the answer a "btw" record. Without st the answers are left out. A reader that starts after the question (a restart)
// finds it through st.forkLookup (forkLookup(file): the transcript searched for that fork line).
const isFork = (key, id) => { const [name, suf] = key.split('|'); return id.startsWith('a' + name + '-') && id.endsWith(suf); };
function forkLookup(file) {
  const found = new Set();
  let scanned = 0;
  return (id) => {
    // read on from where the last look stopped (a little overlap: a fork line cut by the previous end)
    let size = 0; try { size = fs.statSync(file).size; } catch { return false; }
    if (size > scanned) {
      const from = Math.max(0, scanned - 400), n = size - from, buf = Buffer.alloc(n);
      try { const fd = fs.openSync(file, 'r'); try { fs.readSync(fd, buf, 0, n, from); } finally { fs.closeSync(fd); } } catch { return false; }
      for (const m of buf.toString('utf8').matchAll(new RegExp(FORK.source, 'g'))) found.add(m[1] + '|' + m[2]);
      scanned = size;
    }
    return [...found].some((k) => isFork(k, id));
  };
}
function btwRecords(o, st, t) {
  if (o.type === 'system' && o.subtype === 'local_command' && o.commandRun && o.commandRun.command === 'btw') {
    const f = FORK.exec(String(o.content || ''));
    if (!f) return [];                                             // (no question: just the usage line)
    if (st) (st.btw = st.btw || new Map()).set(f[1] + '|' + f[2], 1);
    return [{ role: 'user', text: ('/btw ' + String(o.commandRun.args || '')).trim(), t }];
  }
  if (o.type === 'queue-operation' && o.operation === 'enqueue' && st && (st.btw || st.forkLookup) && /^<task-notification>/.test(String(o.content || ''))) {
    const c = String(o.content), id = (/<task-id>([^<]+)<\/task-id>/.exec(c) || [])[1] || '';
    const res = /<result>([\s\S]*)<\/result>/.exec(c);
    if (!res || !/<status>completed<\/status>/.test(c)) return [];
    const fork = [...(st.btw || new Map()).keys()].some((k) => isFork(k, id)) || (/^a\S+-[0-9a-f]+$/.test(id) && !!st.forkLookup && st.forkLookup(id));
    if (!fork) return [];
    // (a resumed fork notifies again: a new answer is a new record, the same one again is not)
    const seen = (st.btwSeen = st.btwSeen || new Set()), sig = id + '|' + res[1].length + '|' + res[1].slice(0, 80);
    if (seen.has(sig)) return [];
    seen.add(sig);
    return [{ role: 'btw', text: res[1].trim(), t }];
  }
  return [];
}

function recordsOf(o, st) {
  const out = [];
  if (!o || o.isSidechain || o.isMeta) return out;
  if (o.type === 'system' || o.type === 'queue-operation') {
    const t = o.timestamp ? Date.parse(o.timestamp) : Date.now();
    // a slash command that ran in the terminal alone (/context, /resume, /rename ...): the command as you typed it, and
    // what it printed. /btw is told apart: its question and answer are paired (btwRecords).
    if (o.type === 'system' && o.subtype === 'local_command' && !(o.commandRun && o.commandRun.command === 'btw')) {
      const u = userText(o.content);
      if (typeof u === 'string' && u && !/^\/btw(\s|$)/.test(u)) out.push({ role: 'user', text: u, t });
      else if (u && u.cmd) out.push({ role: 'cmd', text: u.cmd, t });
      return out;
    }
    return btwRecords(o, st, t);
  }
  // a message you sent while Claude was busy: it waits in a queue and is handed to Claude mid-turn -- written then as an
  // attachment, not as a user message (background tasks' notifications come the same way: not yours, left out)
  if (o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command') {
    const a = o.attachment;
    if (a.commandMode !== 'prompt' || a.humanTurn === false) return out;
    const raw = typeof a.prompt === 'string' ? a.prompt : Array.isArray(a.prompt) ? a.prompt.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    const u = userText(raw);
    if (u && typeof u === 'string') out.push({ role: 'user', text: u, t: o.timestamp ? Date.parse(o.timestamp) : Date.now() });
    return out;
  }
  const t = o.timestamp ? Date.parse(o.timestamp) : Date.now();
  const m = o.message;
  // the summary Claude Code writes when the context is compacted: recorded as a "user" message (it is what the model reads
  // from then on), but nothing you said -- a note where it happened, as for Codex
  if (o.isCompactSummary) { out.push({ role: 'sys', text: '（上下文已压缩）', t }); return out; }
  if (o.type === 'user' && m) {
    const parts = typeof m.content === 'string' ? [m.content]
      : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text);
    // tool results are left out -- but for what you answered when Claude asked (AskUserQuestion): question → answer
    if (!parts.length) {
      const a = o.toolUseResult && o.toolUseResult.answers;
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        const said = Object.entries(a).filter(([, v]) => typeof v === 'string' && v).map(([q, v]) => `${cut(q, 80)} → ${cut(v, 200)}`);
        if (said.length) out.push({ role: 'sys', text: '回答：' + said.join('；'), t });
      }
      return out;
    }
    const u = userText(parts.join('\n'));
    if (!u) return out;
    if (u.cmd) out.push({ role: 'cmd', text: u.cmd, t });
    else if (typeof u === 'object') out.push({ role: 'sys', text: u.sys, t });
    else out.push({ role: 'user', text: u, t });
  } else if (o.type === 'assistant' && m && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b.type === 'text' && b.text && b.text.trim()) out.push({ role: 'assistant', text: b.text.trim(), t, mid: m.id });
      else if (b.type === 'tool_use') {
        const x = toolExtra(b.name, b.input);
        out.push(x ? { role: 'tool', items: [toolLine(b.name, b.input)], t, x } : { role: 'tool', items: [toolLine(b.name, b.input)], t });
      }
    }
    // how full the context is: everything the model read for this reply plus what it wrote (the next request carries
    // both). "used/window"; the window is not in the transcript: 200k for Haiku (the reply names its model), else left
    // open (0: the reader fills in 1M, see remote/agent/records.js)
    const u = m.usage;
    if (u && Number.isFinite(u.input_tokens)) {
      const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      if (used > 0) out.push({ role: 'ctx', text: used + '/' + (/haiku/i.test(String(m.model || '')) ? 200000 : 0), t });
    }
  } else if (o.type === 'ai-title' || o.type === 'custom-title') {
    const title = o.aiTitle || o.customTitle || o.title;
    if (title) out.push({ role: 'title', text: String(title), t });
  } else if (o.type === 'permission-mode' && typeof o.permissionMode === 'string' && o.permissionMode) {
    // the permission mode (auto / manual / acceptEdits / plan ...): written when the session starts, around every
    // message and on exit -- not on each Shift+Tab. A metadata record like the title (the line has no timestamp).
    out.push({ role: 'mode', text: o.permissionMode.slice(0, 24), t });
  }
  return out;
}

// append records to a chat log the way the panel shows it: one reply streamed as several entries becomes one
// message, consecutive tool calls one group; a title record sets out.title
function mergeRecords(out, recs) {
  for (const r of recs) {
    const last = out[out.length - 1];
    if (r.role === 'title') out.title = r.text;
    else if (r.role === 'mode') out.mode = r.text;
    else if (r.role === 'ctx') out.ctx = r.text;
    else if (r.role === 'assistant' && last && last.role === 'assistant' && last.mid === r.mid) last.text += '\n\n' + r.text;
    else if (r.role === 'tool' && last && last.role === 'tool') { last.items.push(...r.items); last.t = r.t; }
    else out.push(r.role === 'tool' ? { ...r, items: [...r.items] } : { ...r });
  }
}

function parseLine(o, out) { mergeRecords(out, recordsOf(o, out)); }        // (the message list carries the /btw pairing)

// cache: { file, offset, msgs, title } -- returns true when something new was read
function poll(cache) {
  let st;
  try { st = fs.statSync(cache.file); } catch { return false; }
  if (cache.offset != null && st.size === cache.offset) return false;
  if (cache.offset == null || st.size < cache.offset) {          // first read (or the file was rewritten)
    cache.msgs = []; cache.offset = Math.max(0, st.size - FIRST_READ); cache.partial = '';
    cache.msgs.forkLookup = forkLookup(cache.file);              // (a /btw asked before the part read now)
    cache.skipFirst = cache.offset > 0;
  }
  const n = st.size - cache.offset;
  const fd = fs.openSync(cache.file, 'r'), buf = Buffer.alloc(n);
  try { fs.readSync(fd, buf, 0, n, cache.offset); } finally { fs.closeSync(fd); }
  cache.offset = st.size;
  const lines = (cache.partial + buf.toString('utf8')).split('\n');
  cache.partial = lines.pop();                                    // an unfinished last line waits for the next poll
  if (cache.skipFirst) { lines.shift(); cache.skipFirst = false; }
  const out = cache.msgs;
  for (const l of lines) {
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    parseLine(o, out);
  }
  if (out.title) cache.title = out.title;
  if (out.length > KEEP) out.splice(0, out.length - KEEP);
  return true;
}

module.exports = { poll, recordsOf, mergeRecords, forkLookup };
