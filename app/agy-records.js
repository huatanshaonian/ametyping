// Antigravity (agy) session transcripts (<root>/brain/<id>/.system_generated/logs/transcript.jsonl)
// as slim records for AmeTyping pet and remote dashboard.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { aiOf } = require('./ai-providers');
const { parseArgs, cleanUserRequest, describeTool } = require('../agy-hook');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {}

const short = (s, n = 80) => {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
};

function agyRoots(home = os.homedir()) {
  const h = home || os.homedir();
  const candidates = [
    process.env.AGY_HOME,
    h && fs.existsSync(path.join(h, 'brain')) ? h : null,
    h && path.join(h, '.gemini', 'antigravity-cli'),
    h && path.join(h, '.gemini', 'antigravity'),
    h && path.join(h, '.gemini', 'antigravity-ide'),
  ].filter(Boolean);
  const seen = new Set();
  const roots = [];
  for (const c of candidates) {
    const norm = path.resolve(c);
    if (!seen.has(norm) && fs.existsSync(norm)) {
      seen.add(norm);
      roots.push(norm);
    }
  }
  return roots;
}

function idOfFile(file) {
  const m = /[\\/]brain[\\/]([^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript(?:_full)?\.jsonl$/i.exec(file);
  return m ? m[1] : null;
}

function rootOfFile(file) {
  const m = /^(.*?)[\\/]brain[\\/][^\\/]+[\\/]\.system_generated[\\/]logs[\\/]transcript(?:_full)?\.jsonl$/i.exec(file);
  return m ? m[1] : null;
}

function allFiles(home) {
  const roots = agyRoots(home);
  const byId = new Map();
  for (const root of roots) {
    const brainDir = path.join(root, 'brain');
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const file = path.join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const prev = byId.get(ent.name);
      if (!prev || st.mtimeMs > prev.mtimeMs) {
        byId.set(ent.name, { file, mtimeMs: st.mtimeMs });
      }
    }
  }
  return Array.from(byId.values()).map((x) => x.file);
}

function recentFiles(maxAgeMs, now = Date.now(), home) {
  const roots = agyRoots(home);
  const byId = new Map();
  for (const root of roots) {
    const brainDir = path.join(root, 'brain');
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const file = path.join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - st.mtimeMs <= maxAgeMs) {
        const prev = byId.get(ent.name);
        if (!prev || st.mtimeMs > prev.mtime) {
          byId.set(ent.name, { file, mtime: st.mtimeMs, id: ent.name });
        }
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.mtime - a.mtime);
}

function fileOf(id, home) {
  const rawId = String(id || '').replace(/^agy:/, '');
  if (!rawId) return null;
  const roots = agyRoots(home);
  let best = null, bestMtime = -1;
  for (const root of roots) {
    const file = path.join(root, 'brain', rawId, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = file;
      }
    } catch {}
  }
  return best;
}

function fileUriToPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      let s = uri.replace(/^file:\/\//, '');
      try { s = decodeURIComponent(s); } catch {}
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(s)) {
        s = s.slice(1);
      }
      return path.normalize(s);
    }
  }
  return uri;
}

const dbCache = new Map();
function summaryFromDb(root, id) {
  if (!root || !id || !sqlite || !sqlite.DatabaseSync) return null;
  const dbFile = path.join(root, 'conversation_summaries.db');
  let st;
  try { st = fs.statSync(dbFile); } catch { return null; }
  let cached = dbCache.get(root);
  if (!cached || cached.mtime !== st.mtimeMs) {
    const rows = new Map();
    let db = null;
    try {
      db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
      const list = db.prepare('SELECT conversation_id, title, workspace_uris, status, parent_conversation_id, agent_name, last_modified_time FROM conversation_summaries').all();
      for (const row of list) {
        if (!row || !row.conversation_id) continue;
        let cwd = '';
        if (row.workspace_uris) {
          try {
            const uris = JSON.parse(row.workspace_uris);
            if (Array.isArray(uris) && uris[0]) cwd = fileUriToPath(uris[0]);
          } catch {}
        }
        rows.set(row.conversation_id, {
          title: row.title || '',
          cwd: cwd || '',
          status: row.status || '',
          parentConversationId: row.parent_conversation_id || '',
          agentName: row.agent_name || '',
          lastModifiedTime: row.last_modified_time || '',
        });
      }
      cached = { mtime: st.mtimeMs, rows };
      dbCache.set(root, cached);
    } catch {
      return cached ? (cached.rows.get(id) || null) : null;
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  }
  return cached.rows.get(id) || null;
}

const historyCache = new Map();
function historyMeta(root, id) {
  if (!root || !id) return null;
  const file = path.join(root, 'history.jsonl');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let cached = historyCache.get(root);
  if (!cached || cached.mtime !== st.mtimeMs) {
    const map = new Map();
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry && entry.conversationId) {
            map.set(entry.conversationId, { cwd: entry.workspace || '', title: entry.display || '' });
          }
        } catch {}
      }
    } catch {}
    cached = { mtime: st.mtimeMs, entries: map };
    historyCache.set(root, cached);
  }
  return cached.entries.get(id) || null;
}

function subagentDescriptor(root, id) {
  if (!root || !id) return null;
  const brainDir = path.join(root, 'brain');
  let entries = [];
  try { entries = fs.readdirSync(brainDir, { withFileTypes: true }); } catch { return null; }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === id) continue;
    const descFile = path.join(brainDir, ent.name, '.system_generated', 'subagents', `${id}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(descFile, 'utf8'));
      const desc = data.subagentDescriptor || {};
      let cwd = '';
      if (Array.isArray(data.workspaceUris) && data.workspaceUris[0]) {
        cwd = fileUriToPath(data.workspaceUris[0]);
      }
      return {
        parent: ent.name,
        role: desc.role || desc.typeName || 'subagent',
        cwd,
      };
    } catch {}
  }
  return null;
}

function providerOfModel(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (/claude|sonnet|opus|haiku/.test(m)) return 'anthropic';
  if (/gpt|o[134]-|openai/.test(m)) return 'openai';
  if (/deepseek/.test(m)) return 'deepseek';
  return 'google';
}

const metaCache = new Map();
function metadataOf(file, home) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = metaCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.meta;

  const id = idOfFile(file);
  if (!id) return null;
  const root = rootOfFile(file) || (agyRoots(home)[0] || '');

  const db = summaryFromDb(root, id);
  const hist = historyMeta(root, id);
  const subDesc = subagentDescriptor(root, id);

  let fileTitle = '', fileCwd = '', modelName = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(131072);
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const head = buf.toString('utf8', 0, n);
    const reqM = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(head);
    if (reqM) fileTitle = reqM[1].replace(/\s+/g, ' ').trim().slice(0, 80);
    const modM = /Model Selection[^\r\n]*to ([^\r\n.<>]+)/i.exec(head) || /\bModel:\s*([^\s\r\n"\\]+)/i.exec(head);
    if (modM) modelName = modM[1].trim();
    const cwdM = /Active Workspaces:\r?\n-\s*([^\r\n]+)/.exec(head);
    if (cwdM) fileCwd = cwdM[1].trim();
  } catch {}

  const parent = (db && db.parentConversationId) || (subDesc && subDesc.parent) || null;
  const agentName = (db && db.agentName) || (subDesc && subDesc.role) || null;
  const title = (db && db.title) || (hist && hist.title) || fileTitle || null;
  const cwd = (db && db.cwd) || (hist && hist.cwd) || (subDesc && subDesc.cwd) || fileCwd || null;
  const modelObj = modelName ? { providerID: providerOfModel(modelName), id: modelName } : null;

  const meta = {
    id,
    cwd: cwd || null,
    title: title || null,
    model: modelObj || null,
    ai: aiOf(modelObj),
    sub: Boolean(parent),
    parent: parent || null,
    agentName: agentName || null,
  };

  metaCache.set(file, { mtime: st.mtimeMs, meta });
  return meta;
}

function metaOf(file, home) {
  const m = metadataOf(file, home);
  if (!m) return null;
  return {
    id: m.id,
    cwd: m.cwd,
    title: m.title,
    model: m.model,
    ai: m.ai,
    sub: m.sub,
    parent: m.parent,
    agentName: m.agentName,
  };
}

function titleOf(id, home) {
  const rawId = String(id || '').replace(/^agy:/, '');
  if (!rawId) return null;
  const file = fileOf(rawId, home);
  const root = file ? rootOfFile(file) : (agyRoots(home)[0] || '');

  if (root) {
    const db = summaryFromDb(root, rawId);
    if (db && db.title) return short(db.title, 80);
    const hist = historyMeta(root, rawId);
    if (hist && hist.title) return short(hist.title, 80);
  }

  if (file) {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(65536);
      let n = 0;
      try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
      const head = buf.toString('utf8', 0, n);
      const reqM = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(head);
      if (reqM) return short(reqM[1], 80);
    } catch {}
  }

  return null;
}

function toolExtra(name, args = {}) {
  const n = String(name || '');
  const a = args || {};
  if (n === 'run_command' || n === 'Bash') {
    const cmd = a.CommandLine || a.command || '';
    return cmd ? { op: 'cmd', cmd: String(cmd).slice(0, 600) } : undefined;
  }
  if (n === 'write_file' || n === 'write_to_file' || n === 'Write') {
    const p = a.Path || a.TargetFile || a.file_path || '';
    return p ? { op: 'write', p: [String(p)].slice(0, 50) } : undefined;
  }
  if (n === 'edit_file' || n === 'replace_file_content' || n === 'multi_replace_file_content' || n === 'Edit') {
    const p = a.Path || a.TargetFile || a.file_path || '';
    return p ? { op: 'edit', p: [String(p)].slice(0, 50) } : undefined;
  }
  if (n === 'read_file' || n === 'view_file' || n === 'view_file_outline' || n === 'view_code_item' || n === 'Read') {
    const p = a.Path || a.AbsolutePath || a.FilePath || a.file_path || '';
    return p ? { op: 'read', p: [String(p)].slice(0, 50) } : undefined;
  }
  return undefined;
}

function recordsOf(o, st) {
  const out = [];
  if (!o || typeof o !== 'object') return out;

  o.uuid = o.uuid || (o.step_index != null ? 'step-' + o.step_index : (o.stepIdx != null ? 'step-' + o.stepIdx : undefined));
  o.timestamp = o.timestamp || o.created_at || o.createdAt;
  const t = o.timestamp ? Date.parse(o.timestamp) : Date.now();

  if (o.type === 'USER_INPUT') {
    const raw = o.content || '';
    if (/<(?:EPHEMERAL_MESSAGE|TASK_NOTIFICATION)>/i.test(raw) && !/<USER_REQUEST>/i.test(raw)) {
      return out;
    }
    const text = cleanUserRequest(raw);
    if (text) {
      out.push({ role: 'user', text, t });
    }
    return out;
  }

  if (o.type === 'PLANNER_RESPONSE') {
    if (Array.isArray(o.tool_calls)) {
      for (const tc of o.tool_calls) {
        if (!tc) continue;
        const name = tc.name || '';
        const args = parseArgs(tc.args || tc.input || tc.arguments);
        const line = describeTool(name, args);
        const x = toolExtra(name, args);
        out.push(x ? { role: 'tool', items: [line], t, x } : { role: 'tool', items: [line], t });
      }
    }

    if (o.content && typeof o.content === 'string' && o.content.trim()) {
      out.push({
        role: 'assistant',
        text: o.content.trim(),
        t,
        mid: o.step_index != null ? 'step-' + o.step_index : undefined,
      });
    }

    const tu = o.token_usage || {};
    const used = (Number(o.input_tokens || tu.input_tokens || tu.inputTokens || tu.prompt_tokens) || 0) +
                 (Number(o.output_tokens || tu.output_tokens || tu.outputTokens || tu.completion_tokens) || 0) +
                 (Number(o.cache_read_tokens || tu.cache_read_tokens || tu.cacheReadTokens) || 0);
    if (used > 0) {
      out.push({ role: 'ctx', text: `${used}/1000000`, t });
    }
    return out;
  }

  return out;
}

module.exports = {
  agyRoots,
  allFiles,
  recentFiles,
  fileOf,
  metadataOf,
  metaOf,
  titleOf,
  recordsOf,
  fileUriToPath,
  idOfFile,
  rootOfFile,
};
