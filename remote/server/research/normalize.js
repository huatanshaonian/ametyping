// Rebuildable semantic events. Original bytes remain in the vault, including suppressed diagnostics.
'use strict';
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const VERSION = '4';
const cleanText = s => String(s || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
const textOf = x => typeof x === 'string' ? x : Array.isArray(x) ? x.map(p => p?.text || (p?.type === 'tool_result' ? textOf(p.content) : '')).filter(Boolean).join('\n') : '';
const NOISE = /^(?:\s*(?:\d{1,3}%|[▏▎▍▌▋▊▉█░▒▓━─. ]{4,}|heartbeat|ping|pong|tokens?[:= ]+\d+)\s*)$/i;
function toolDetails(name,input,call_id) {
  let args=input;
  if(typeof args==='string')try{args=JSON.parse(args);}catch{}
  const command=args&&typeof args==='object'?(args.cmd||args.command):null;
  const origin=/^(?:Read|read_file|ReadFile|view_file)$/i.test(name||'') || (typeof command==='string'&&/\b(?:cat|sed|head|tail|Get-Content)\b/i.test(command)&&!/\b(?:python\d*|matlab|feko|octave)\s/i.test(command))?'file_read':'unknown';
  return {name,call_id,origin,...(typeof command==='string'&&command.length<=4096?{command}:{})};
}
function* jsonLines(chunks) {
  const decoder = new StringDecoder('utf8'); let rest = '', line = 0;
  for (const chunk of chunks) {
    rest += decoder.write(chunk); let i;
    while ((i = rest.indexOf('\n')) >= 0) { const text = rest.slice(0, i); rest = rest.slice(i + 1); yield { line: ++line, text }; }
  }
  rest += decoder.end(); if (rest.trim()) yield { line: ++line, text: rest };
}
function documentId(s) { return hash([s.machine, s.key, s.generation, s.digest, VERSION].join('\0')); }

function* normalize(source, chunks) {
  const sourceId = documentId(source);
  const calls=new Map();
  function* events(o, line) {
    let part = 0;
    function ev(role, kind, text, extra = {}) {
      const rawText = cleanText(text); if (!rawText.trim()) return null;
      const n = part++, id = hash(sourceId + ':' + line + ':' + n);
      const time = o.timestamp || o.created_at || o.createdAt || o.info?.time?.created || o.data?.meta?.timestamp || null;
      const t = typeof time === 'number' ? (time < 1e11 ? time * 1000 : time) : Date.parse(time);
      return { id, source_id: sourceId, line, part: n, t: Number.isFinite(t) ? t : null, role, kind,
        text: rawText, suppressed: NOISE.test(rawText), details: extra };
    }
    const emit = (role, kind, text, extra) => ev(role, kind, text, extra);
    const out = [];
    if (source.provider === 'claude') {
      const m = o.message;
      if (m && !o.isCompactSummary) {
        if (typeof m.content === 'string') out.push(emit(o.type === 'user' ? 'user' : 'assistant', 'message', m.content));
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b.type === 'text') out.push(emit(o.type === 'user' ? 'user' : 'assistant', 'message', b.text));
          else if (b.type === 'tool_use') {const details=toolDetails(b.name,b.input,b.id);calls.set(b.id,details);out.push(emit('tool', 'tool_call', JSON.stringify(b.input || {}), details));}
          else if (b.type === 'tool_result') out.push(emit('tool', 'tool_result', textOf(b.content), { call_id: b.tool_use_id, error: !!b.is_error,origin:calls.get(b.tool_use_id)?.origin||'unknown' }));
        }
      }
    } else if (source.provider === 'codex') {
      const p = o.payload || {};
      if (o.type === 'session_meta') out.push(emit('system', 'code_context', JSON.stringify({ cwd: p.cwd, git: p.git })));
      if (o.type === 'response_item') {
        if (p.type === 'message' && ['user', 'assistant'].includes(p.role) && !(p.role === 'user' && /^\s*(?:<environment_context>|# AGENTS\.md|<permissions instructions>)/.test(textOf(p.content))))
          out.push(emit(p.role, 'message', textOf(p.content)));
        else if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)){
          const details=toolDetails(p.name,p.arguments||p.input||p.action,p.call_id);calls.set(p.call_id,details);
          out.push(emit('tool', 'tool_call', p.arguments || p.input || JSON.stringify(p.action || {}), details));
        }
        else if (['function_call_output', 'custom_tool_call_output'].includes(p.type))
          out.push(emit('tool', 'tool_result', typeof p.output === 'string' ? p.output : JSON.stringify(p.output), { call_id: p.call_id,origin:calls.get(p.call_id)?.origin||'unknown' }));
      }
    } else if (source.provider === 'agy') {
      if (o.type === 'USER_INPUT') out.push(emit('user', 'message', o.content));
      if (o.type === 'PLANNER_RESPONSE') {
        out.push(emit('assistant', 'message', o.content));
        for (const tc of o.tool_calls || []) out.push(emit('tool', 'tool_call', typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || tc.input || tc.arguments || {}), toolDetails(tc.name,tc.args||tc.input||tc.arguments,tc.id)));
      }
      if (/TOOL.*(?:RESULT|OUTPUT|RESPONSE)/.test(o.type || '')) out.push(emit('tool', 'tool_result', textOf(o.content || o.output || o.result)));
    } else if (source.provider === 'kiro') {
      const d = o.data || {};
      if (o.kind === 'Prompt' || o.kind === 'AssistantMessage') out.push(emit(o.kind === 'Prompt' ? 'user' : 'assistant', 'message',
        (d.content || []).filter(x => x.kind === 'text').map(x => x.data).join('\n')));
      if (o.kind === 'ToolResults') out.push(emit('tool', 'tool_result', JSON.stringify(d)));
    } else if (source.provider === 'opencode') {
      // Official exports have message.info + message.parts; event logs are handled as separate sources.
      const role = o.info?.role || o.role;
      if (['user', 'assistant'].includes(role)) {
        for (const p of o.parts || []) {
          if (p.type === 'text') out.push(emit(role, 'message', p.text));
          else if (p.type === 'tool') {
            out.push(emit('tool', 'tool_call', JSON.stringify(p.state?.input || {}), toolDetails(p.tool,p.state?.input,p.callID)));
            out.push(emit('tool', 'tool_result', textOf(p.state?.output || p.state?.error), { call_id: p.callID,origin:toolDetails(p.tool,p.state?.input,p.callID).origin }));
          }
        }
      }
    }
    for (const x of out) if (x) yield x;
  }
  if (source.provider === 'opencode' && source.kind === 'native') {
    const raw = Buffer.concat([...chunks]).toString('utf8');
    const doc = JSON.parse(raw); if (!Array.isArray(doc.messages)) throw Error('OpenCode 原生导出缺少 messages');
    for (let i = 0; i < doc.messages.length; i++) yield* events(doc.messages[i], i + 1);
    return;
  }
  for (const { line, text } of jsonLines(chunks)) {
    if (!text.trim()) continue;
    let o; try { o = JSON.parse(text); } catch { throw Error('原生记录第 ' + line + ' 行不是有效 JSON'); }
    yield* events(o, line);
  }
}

// No content is dropped by the prompt budget: large events are sliced with explicit character offsets.
function* segments(events, maxChars = 18000) {
  if (!Number.isInteger(maxChars) || maxChars < 2000 || maxChars > 100000) throw Error('片段预算需要在 2000～100000 字符之间');
  let batch = [], size = 0;
  for (const e of events) {
    if (e.suppressed) continue;
    for (let start = 0; start < e.text.length;) {
      let end=Math.min(start+maxChars,e.text.length);
      if(end<e.text.length&&/[\uD800-\uDBFF]/.test(e.text[end-1]))end--;
      const item = { id: e.id, role: e.role, kind: e.kind, t: e.t, details: e.details || {}, start, text: e.text.slice(start,end) };
      if (batch.length && size + item.text.length > maxChars) { yield batch; batch = []; size = 0; }
      batch.push(item); size += item.text.length;
      start=end;
    }
  }
  if (batch.length) yield batch;
}
module.exports = { VERSION, normalize, documentId, jsonLines, segments, cleanText, hash };
