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
    case 'Skill': return `技能 ${cut(i.skill, 30)}`;
    default: return name && name.startsWith('mcp__') ? `调用 ${name.split('__').slice(1).join('/')}` : `使用 ${name}`;
  }
}

// a user "message" that is really the harness talking (slash commands, ! shell, reminders): tidy or drop it
function userText(s) {
  s = String(s || '');
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(s);
  if (cmd) { const a = /<command-args>([^<]*)<\/command-args>/.exec(s); return `${cmd[1]} ${a ? a[1] : ''}`.trim(); }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(s);
  if (bash) return '! ' + bash[1].trim();
  const out = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(s);
  if (out) return out[1].trim() ? { sys: cut(out[1], 300) } : null;
  if (/^\s*<(local-command-|system-reminder|task-notification)/.test(s)) return null;
  if (/^\[Request interrupted/.test(s)) return { sys: '已中断' };
  return s.trim() || null;
}

function parseLine(o, out) {
  if (!o || o.isSidechain || o.isMeta) return;
  const t = o.timestamp ? Date.parse(o.timestamp) : Date.now();
  const m = o.message;
  if (o.type === 'user' && m) {
    const parts = typeof m.content === 'string' ? [m.content]
      : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text);
    if (!parts.length) return;                                    // tool results
    const u = userText(parts.join('\n'));
    if (!u) return;
    if (typeof u === 'object') out.push({ role: 'sys', text: u.sys, t });
    else out.push({ role: 'user', text: u, t });
  } else if (o.type === 'assistant' && m && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b.type === 'text' && b.text && b.text.trim()) {
        const last = out[out.length - 1];                          // one reply streamed as several entries
        if (last && last.role === 'assistant' && last.mid === m.id) last.text += '\n\n' + b.text.trim();
        else out.push({ role: 'assistant', text: b.text.trim(), t, mid: m.id });
      } else if (b.type === 'tool_use') {
        const line = toolLine(b.name, b.input), last = out[out.length - 1];
        if (last && last.role === 'tool') { last.items.push(line); last.t = t; }   // consecutive tools: one group
        else out.push({ role: 'tool', items: [line], t });
      }
    }
  } else if (o.type === 'ai-title' || o.type === 'custom-title') {
    out.title = o.aiTitle || o.customTitle || o.title || out.title;
  }
}

// cache: { file, offset, msgs, title } -- returns true when something new was read
function poll(cache) {
  let st;
  try { st = fs.statSync(cache.file); } catch { return false; }
  if (cache.offset != null && st.size === cache.offset) return false;
  if (cache.offset == null || st.size < cache.offset) {          // first read (or the file was rewritten)
    cache.msgs = []; cache.offset = Math.max(0, st.size - FIRST_READ); cache.partial = '';
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

module.exports = { poll };
