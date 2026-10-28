// AmeTyping's OpenCode plugin — pure helpers.
//
// The OpenCode server exposes a rich event stream and a control API, so unlike Claude Code and Codex CLI this
// provider needs no hooks, no terminal scraping and no screen reading: the plugin lives inside the OpenCode server,
// forwards events to Ame's local service and answers it through the server's own session API.
//
// These helpers are kept free of I/O so they can be tested with plain `node --test` (protocol.test.mjs).
'use strict';

export const PROVIDER = 'opencode';

const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (p) => { const s = String(p || '').replace(/[\\/]+$/, ''); const m = /[^\\/]+$/.exec(s); return m ? m[0] : ''; };

// --- tool calls, one line each (the same "slim" form app/transcript.js and app/codex-records.js produce) ---
export function toolLine(name, input) {
  const a = input && typeof input === 'object' ? input : {};
  const file = a.filePath || a.file_path || a.path || a.filename || '';
  const cmdOf = () => (Array.isArray(a.command) ? a.command[a.command.length - 1] : (a.command || a.cmd || ''));
  switch (String(name || '')) {
    case 'bash':
    case 'shell': return `运行 ${cut(cmdOf(), 90)}`;
    case 'edit': return `修改 ${cut(base(file), 80) || '文件'}`;
    case 'write': return `写入 ${cut(base(file), 80) || '文件'}`;
    case 'patch': return `修改 ${cut(base(file), 80) || '文件'}`;
    case 'read': return `读 ${cut(base(file), 80) || '文件'}`;
    case 'list': return `列目录 ${cut(file, 80) || ''}`.trim();
    case 'glob': return `查找 ${cut(a.pattern || '', 80)}`.trim();
    case 'grep': return `搜索 ${cut(a.pattern || '', 80)}`.trim();
    case 'webfetch': return `打开 ${cut(a.url || '', 90)}`.trim();
    case 'websearch': return `搜索网页 ${cut(a.query || '', 80)}`.trim();
    case 'task':
    case 'subagent': return `子代理：${cut(a.description || a.prompt || '', 80)}`.trim();
    case 'todowrite': return '更新计划';
    case 'todoread': return '查看计划';
    case 'skill': return `使用技能 ${cut(a.name || '', 60)}`.trim();
    case 'question': return '向你提问';
    case 'execute': return '执行代码';
    default: return `使用 ${cut(name || '工具', 40)}`;
  }
}

// the structured detail the dashboard shows next to the line (same ops as the other providers)
export function toolExtra(name, input) {
  const a = input && typeof input === 'object' ? input : {};
  const file = a.filePath || a.file_path || a.path || a.filename || '';
  const cmdOf = () => (Array.isArray(a.command) ? a.command[a.command.length - 1] : (a.command || a.cmd || ''));
  switch (String(name || '')) {
    case 'bash':
    case 'shell': {
      const cmd = String(cmdOf() || '');
      return cmd ? { op: 'cmd', cmd: cmd.slice(0, 600) } : undefined;
    }
    case 'edit':
    case 'write':
    case 'patch':
      return file ? { op: 'edit', p: [String(file)] } : undefined;
    case 'task':
    case 'subagent':
      return a.description ? { op: 'task', task: [String(a.description).slice(0, 300), ''] } : undefined;
    case 'todowrite': {
      const todos = Array.isArray(a.todos) ? a.todos : [];
      return todos.length ? { op: 'todo', todos: todos.slice(0, 40).map((t) => [cut(t && (t.content || t.step || t.title), 200), String((t && t.status) || '')]) } : undefined;
    }
    default: return undefined;
  }
}

// one assistant tool part -> a slim record, or null while it is still streaming (it will be written once it settles)
function toolRecord(msg, part, cwd) {
  const state = part.state || {};
  if (!state || state.status === 'streaming' || !state.status) return null;
  const t = (part.time && (part.time.completed || part.time.ran || part.time.created)) || Date.now();
  const input = state.input || {};
  const line = toolLine(part.name, input);
  if (!line) return null;
  const x = toolExtra(part.name, input);
  return {
    v: 1, uuid: `${msg.id}:tool:${part.id}`, timestamp: new Date(t).toISOString(), cwd,
    role: 'tool', items: [line], x,
  };
}

// One session's messages (ctx.session.context) -> the appending JSONL records the panel and the agent read.
// Only finished text is returned: a message still streaming is written by its next event.
export function recordsForMessages(msgs, cwd, now = Date.now()) {
  const out = [];
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (!m || !m.id || !m.type) continue;
    const t = (m.time && (m.time.completed || m.time.created)) || now;
    const at = new Date(t).toISOString();
    if (m.type === 'user') {
      const text = typeof m.text === 'string' ? m.text : '';
      if (text.trim()) out.push({ v: 1, uuid: `${m.id}:user`, timestamp: at, cwd, role: 'user', text, mid: m.id });
    } else if (m.type === 'assistant') {
      const text = (Array.isArray(m.content) ? m.content : []).filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n').trim();
      if (text && (m.time.completed || m.finish)) out.push({ v: 1, uuid: `${m.id}:text`, timestamp: at, cwd, role: 'assistant', text, mid: m.id });
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (!p || p.type !== 'tool') continue;
        const rec = toolRecord(m, p, cwd);
        if (rec) out.push(rec);
      }
    } else if (m.type === 'compaction' && m.status === 'completed') {
      out.push({ v: 1, uuid: `${m.id}:compaction`, timestamp: at, cwd, role: 'sys', text: '（上下文已压缩）', mid: m.id });
    } else if (m.type === 'shell' && m.command && m.status && m.status !== 'running') {
      out.push({ v: 1, uuid: `${m.id}:shell`, timestamp: at, cwd, role: 'tool', items: [`运行 ${cut(m.command, 90)}`], x: { op: 'cmd', cmd: String(m.command).slice(0, 600) } });
    }
  }
  return out;
}

// The live conversation as a terminal-like text: the dashboard's "画面" for a provider that has no terminal of its own.
export function screenText(msgs, limit = 60) {
  const recs = recordsForMessages(msgs, '').slice(-limit);
  const lines = [];
  for (const r of recs) {
    if (r.role === 'user') lines.push('> ' + String(r.text || '').trim());
    else if (r.role === 'assistant') lines.push(String(r.text || '').trim());
    else if (r.role === 'tool') lines.push('[ ' + (r.items || []).join(' / ') + ' ]');
    else if (r.role === 'sys') lines.push('— ' + r.text + ' —');
    lines.push('');
  }
  return lines.join('\n').trim();
}

// The Ame event for one OpenCode event: { type, name, text, ... } | { permission } | null.
// st carries what the stream alone cannot say: cwd, title and the last finished reply.
export function mapEvent(ev, st = {}) {
  if (!ev || typeof ev !== 'object' || !ev.type) return null;
  const d = ev.data || {};
  const meta = { title: st.title, cwd: st.cwd, transcript: st.transcript, project: base(st.cwd) };
  const done = (text) => ({ type: 'event', name: 'done', text: text ? `完成了：${cut(text, 120)}` : '完成了', ...meta });
  switch (ev.type) {
    case 'session.created': return { type: 'event', name: 'idle', ...meta };
    case 'session.inbox.delivered': return { type: 'event', name: 'message', ...meta };
    case 'session.execution.started': return { type: 'event', name: 'thinking', text: '开始处理', ...meta };
    case 'session.execution.succeeded': return done(st.lastText);
    case 'session.execution.failed': return { type: 'event', name: 'error', text: `出错了：${cut((d.error && (d.error.message || d.error.type)) || '未知错误', 160)}`, ...meta };
    case 'session.execution.interrupted': return { type: 'event', name: 'paused', text: '已中断', ...meta };
    case 'session.compaction.started': return { type: 'event', name: 'thinking', text: '正在压缩上下文', ...meta };
    case 'session.compaction.ended': return { type: 'event', name: 'thinking', text: '上下文已压缩，继续工作', ...meta };
    case 'session.retry.scheduled': return { type: 'event', name: 'thinking', text: '遇到问题，重试中', ...meta };
    case 'session.status': {
      const s = d.status || {};
      if (s.type === 'retry') return { type: 'event', name: 'thinking', text: cut(s.message ? `重试中：${s.message}` : '重试中', 160), ...meta };
      return null;
    }
    case 'session.tool.called':
      return { type: 'event', name: 'thinking', text: toolLine(st.toolName || d.name, d.input || {}), ...meta };
    case 'session.tool.failed':
      return { type: 'event', name: 'error', text: `出错了：${cut((d.error && (d.error.message || d.error.type)) || 'tool', 160)}`, ...meta };
    case 'session.text.ended': return { type: 'event', name: 'thinking', ...meta };
    case 'session.renamed': return { type: 'event', name: 'meta', ...meta, title: d.title || st.title };
    case 'session.deleted': return { type: 'event', name: 'quit', ...meta };
    case 'session.idle': return { type: 'event', name: 'idle', ...meta };
    case 'permission.asked':
      return { type: 'permission', action: d.action, resources: d.resources, save: d.save, message: d.message, metadata: d.metadata };
    case 'permission.replied': return { type: 'event', name: 'thinking', hookEvent: 'PermissionReplied', text: '', ...meta };
    default: return null;
  }
}

export { base as projectOf, cut };
