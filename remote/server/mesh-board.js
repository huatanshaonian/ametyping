// AmeMesh Unified Blackboard: append-only per-project JSONL log, @mention / #seq parsing,
// hybrid threshold wake formatting, and structured contract boundary verification.
'use strict';
const fs = require('fs');
const path = require('path');

function safeProjectId(projectId) {
  return String(projectId || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

// Extract @alias / @nodeId tokens; `@all` (case-insensitive) sets mentionAll=true and is excluded from mentions[]
// Ignores fenced code blocks (```...```) and inline code (`...`) so template/doc examples don't trigger false mentions.
function parseMentions(text) {
  const src = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');
  const re = /(?:^|[\s([{"'（【「，。；：、！？])[@＠]([A-Za-z0-9_\u4e00-\u9fa5-]+)/g;
  const mentions = [];
  const seen = new Set();
  let mentionAll = false;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tok = m[1];
    if (!tok) continue;
    const low = tok.toLowerCase();
    if (low === 'all') {
      mentionAll = true;
      continue;
    }
    if (!seen.has(low)) {
      seen.add(low);
      mentions.push(tok);
    }
  }
  return { mentions, mentionAll };
}

const MENTION_LEAD_RE = /[\s([{"'（【「，。；：、！？]/;
const MENTION_NAME_CHAR_RE = /[A-Za-z0-9_\u4e00-\u9fa5-]/;

// Resolve @mentions in text (plus explicit mention tokens) to node ids. Shared by wake routing and board `targets`.
// After `@`/`＠` the longest case-insensitive match among node alias (may contain spaces), label, id and role wins;
// the match must end at a non-name char. `@all` sets targetsAll. Code spans are ignored like parseMentions.
// nodes: [{ id, alias, label, role }]; options: { mentions: string[], skipText: bool, excludeId, mentionAll }
function resolveTargets(text, nodes, { mentions = [], skipText = false, excludeId = null, mentionAll = false } = {}) {
  const list = Array.isArray(nodes) ? nodes.filter((n) => n && n.id) : [];
  const names = []; // { low, ids:Set }
  const byName = new Map();
  const addName = (name, id) => {
    const low = String(name || '').trim().toLowerCase();
    if (!low) return;
    let rec = byName.get(low);
    if (!rec) {
      rec = { low, ids: new Set() };
      byName.set(low, rec);
      names.push(rec);
    }
    if (id) rec.ids.add(id);
  };
  for (const n of list) {
    addName(n.alias, n.id);
    addName(n.label, n.id);
    addName(n.id, n.id);
    addName(n.role, n.id);
  }
  if (!byName.has('all')) addName('all', null);
  names.sort((a, b) => b.low.length - a.low.length);

  const targets = new Set();
  let all = Boolean(mentionAll);
  if (!skipText) {
    const src = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]+`/g, ' ');
    const low = src.toLowerCase();
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch !== '@' && ch !== '＠') continue;
      if (i > 0 && !MENTION_LEAD_RE.test(src[i - 1])) continue;
      const start = i + 1;
      if (src[start] === '#') continue; // @#channel
      for (const rec of names) {
        if (!low.startsWith(rec.low, start)) continue;
        const next = src[start + rec.low.length];
        if (next !== undefined && MENTION_NAME_CHAR_RE.test(next)) continue;
        if (rec.low === 'all' && !rec.ids.size) all = true;
        for (const id of rec.ids) targets.add(id);
        i = start + rec.low.length - 1;
        break;
      }
    }
  }
  for (const tok of Array.isArray(mentions) ? mentions : []) {
    const lowTok = String(tok || '').trim().toLowerCase();
    if (!lowTok) continue;
    if (lowTok === 'all' && !(byName.get('all') || { ids: new Set() }).ids.size) {
      all = true;
      continue;
    }
    const rec = byName.get(lowTok);
    if (rec) for (const id of rec.ids) targets.add(id);
  }
  if (excludeId) targets.delete(excludeId);
  return { targets: [...targets], targetsAll: all };
}

// Extract @#channel tokens as a deduplicated lowercase/trimmed array
function parseChannelMentions(text) {
  const src = String(text || '');
  const re = /@#([A-Za-z0-9_\u4e00-\u9fa5-]+)/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const tok = String(m[1] || '').trim().toLowerCase();
    if (tok && !seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

// Extract `#123` floor references as a sorted, deduplicated integer array
function parseRefs(text) {
  const src = String(text || '');
  const re = /#(\d+)/g;
  const nums = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isSafeInteger(n) && n > 0) nums.add(n);
  }
  return [...nums].sort((a, b) => a - b);
}

function isWindowsLikePath(p) {
  const s = String(p || '');
  return /^[A-Za-z]:/.test(s) || /\\/.test(s);
}

function normalizeBoundaryPath(p, forceLower = false) {
  let s = String(p || '').trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  // Strip trailing slashes except bare root `/` or `C:/`
  if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) {
    s = s.replace(/\/+$/, '');
  }
  if (forceLower || /^[A-Za-z]:/.test(s)) {
    s = s.toLowerCase();
  }
  return s;
}

function compileWildcardPattern(pattern) {
  // Convert glob wildcards (`**/` / `**` / `*`) into an anchored RegExp
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  out += '$';
  return new RegExp(out);
}

function matchBoundary(rawBoundary, rawFile) {
  const winCase = isWindowsLikePath(rawBoundary) || isWindowsLikePath(rawFile);
  const b = normalizeBoundaryPath(rawBoundary, winCase);
  const f = normalizeBoundaryPath(rawFile, winCase);
  if (!b || !f) return false;
  if (b.includes('*')) {
    return compileWildcardPattern(b).test(f);
  }
  if (f === b) return true;
  const prefix = b.endsWith('/') ? b : b + '/';
  return f.startsWith(prefix);
}

// Verify changedFiles against allowed boundaries (exact file, directory prefix, or `*` wildcard)
function checkBoundaries(boundaries, changedFiles) {
  if (!Array.isArray(boundaries) || !boundaries.length) {
    return { checked: true, outOfBounds: [] };
  }
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const outOfBounds = [];
  for (const rawFile of files) {
    const fileStr = String(rawFile || '').trim();
    if (!fileStr) continue;
    const allowed = boundaries.some((b) => matchBoundary(b, fileStr));
    if (!allowed) outOfBounds.push(fileStr);
  }
  return { checked: true, outOfBounds };
}

// Build hybrid wakeup prompt: full text when < threshold, concise doorbell when >= threshold
function formatWakePrompt({ project, entry, targetNode, threshold = 500 }) {
  const projName = (project && project.name) || '';
  const sender = (entry && entry.agent) || '系统';
  const seq = (entry && entry.seq) || 0;
  const header = `[AmeMesh 黑板通知 #${seq} | 项目：${projName} | 来自：${sender}]`;
  const text = String((entry && entry.text) || '');
  const len = text.length;

  if (len < threshold) {
    const lines = [header, text];
    if (entry && Array.isArray(entry.artifacts) && entry.artifacts.length) {
      lines.push(`产出附件：${entry.artifacts.join(', ')}`);
    }
    return lines.join('\n');
  }

  const summary = text.slice(0, 120);
  const sinceSeq = Math.max(0, seq - 1);
  return `${header}\n${summary}…（正文共 ${len} 字，请调用 mesh_board_read(since=${sinceSeq}) 查看全文）`;
}

function createBoard({ dataDir, getNodes = null }) {
  const dir = path.join(dataDir, 'mesh-boards');
  const seqCache = new Map(); // projectId -> highest seq number
  const channelCache = new Map(); // projectId -> replayed channel states

  function nodesOf(projectId) {
    if (typeof getNodes !== 'function') return [];
    try {
      const list = getNodes(projectId);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // Read-time backfill for legacy entries persisted before `targets` existed (does not rewrite the JSONL)
  function withTargets(e, nodes) {
    if (Array.isArray(e.targets)) return e;
    const r = resolveTargets(e.text, nodes, {
      mentions: e.mentions,
      skipText: e.kind === 'brief' || e.kind === 'control',
      excludeId: e.nodeId || null,
      mentionAll: Boolean(e.mentionAll),
    });
    return { ...e, targets: r.targets, targetsAll: r.targetsAll };
  }

  function filePathFor(projectId) {
    return path.join(dir, `${safeProjectId(projectId)}.jsonl`);
  }

  function loadEntries(projectId) {
    const fp = filePathFor(projectId);
    let raw = '';
    try {
      raw = fs.readFileSync(fp, 'utf8');
    } catch {
      return [];
    }
    const entries = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj.seq === 'number') entries.push(obj);
      } catch {}
    }
    return entries;
  }

  function latestSeq(projectId) {
    if (seqCache.has(projectId)) return seqCache.get(projectId);
    const entries = loadEntries(projectId);
    const maxSeq = entries.reduce((mx, e) => (e.seq > mx ? e.seq : mx), 0);
    seqCache.set(projectId, maxSeq);
    return maxSeq;
  }

  function append(projectId, entry = {}) {
    const nextSeq = latestSeq(projectId) + 1;
    const text = String(entry.text || '');
    const skipTextMentionParse = entry.skipTextMentionParse === true;
    const parsedMentions = skipTextMentionParse ? { mentions: [], mentionAll: false } : parseMentions(text);
    const explicitMentions = Array.isArray(entry.mentions) ? entry.mentions.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const seen = new Set();
    const mentions = [];
    for (const tok of [...parsedMentions.mentions, ...explicitMentions]) {
      const low = tok.toLowerCase();
      if (low === 'all') continue;
      if (!seen.has(low)) {
        seen.add(low);
        mentions.push(tok);
      }
    }
    const mentionAll = Boolean(parsedMentions.mentionAll || entry.mentionAll);
    const parsedChannelMentions = skipTextMentionParse ? [] : parseChannelMentions(text);
    const explicitChannelMentions = Array.isArray(entry.mentionChannels)
      ? entry.mentionChannels.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
      : [];
    const mentionChannels = [...new Set([...parsedChannelMentions, ...explicitChannelMentions])];
    const parsedRefs = parseRefs(text);
    const explicitRefs = Array.isArray(entry.refs) ? entry.refs.map((x) => parseInt(x, 10)).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
    const refs = [...new Set([...parsedRefs, ...explicitRefs])].sort((a, b) => a - b);

    const kind = String(entry.kind || 'post') || 'post';
    const nodeId = entry.nodeId || null;
    const resolved = resolveTargets(text, nodesOf(projectId), {
      mentions: explicitMentions,
      skipText: skipTextMentionParse,
      excludeId: nodeId,
      mentionAll,
    });
    const fullEntry = {
      seq: nextSeq,
      ts: Number(entry.ts) || Date.now(),
      channel: String(entry.channel || 'main') || 'main',
      kind,
      agent: String(entry.agent || '系统') || '系统',
      nodeId,
      text,
      mentions,
      mentionAll,
      mentionChannels,
      targets: resolved.targets,
      targetsAll: resolved.targetsAll,
      refs,
      artifacts: Array.isArray(entry.artifacts) ? entry.artifacts : [],
      done: Boolean(entry.done),
      audit: entry.audit || null,
      ...(kind === 'control' && entry.control ? { control: entry.control } : {}),
    };

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePathFor(projectId), JSON.stringify(fullEntry) + '\n', { encoding: 'utf8', mode: 0o600 });
    seqCache.set(projectId, nextSeq);
    channelCache.delete(projectId);
    return fullEntry;
  }

  function computeChannels(projectId) {
    const map = new Map();
    map.set('main', {
      name: 'main',
      desc: '',
      archived: false,
      subscribers: [],
      createdAt: 0,
    });
    const entries = loadEntries(projectId);
    for (const e of entries) {
      if (e.kind !== 'control' || !e.control || typeof e.control !== 'object') continue;
      const c = e.control;
      const op = String(c.op || '');
      const ch = String(c.channel || e.channel || '').trim().toLowerCase();
      if (!ch) continue;
      if (op === 'channel_create') {
        const existing = map.get(ch);
        const initSubs = Array.isArray(c.subscribers)
          ? [...new Set(c.subscribers.map((x) => String(x || '').trim()).filter(Boolean))]
          : [];
        if (!existing) {
          map.set(ch, {
            name: ch,
            desc: String(c.desc || '').trim(),
            archived: false,
            subscribers: initSubs,
            createdAt: Number(e.ts) || 0,
          });
        } else {
          if (typeof c.desc === 'string' && c.desc.trim()) existing.desc = c.desc.trim();
          existing.archived = false;
          for (const sid of initSubs) {
            if (!existing.subscribers.includes(sid)) existing.subscribers.push(sid);
          }
        }
      } else if (op === 'channel_subscribe') {
        const nodeId = String(c.nodeId || '').trim();
        if (!nodeId) continue;
        let obj = map.get(ch);
        if (!obj) {
          obj = { name: ch, desc: '', archived: false, subscribers: [], createdAt: Number(e.ts) || 0 };
          map.set(ch, obj);
        }
        if (!obj.subscribers.includes(nodeId)) obj.subscribers.push(nodeId);
      } else if (op === 'channel_unsubscribe') {
        const nodeId = String(c.nodeId || '').trim();
        const obj = map.get(ch);
        if (obj && nodeId) {
          obj.subscribers = obj.subscribers.filter((x) => x !== nodeId);
        }
      } else if (op === 'channel_archive') {
        const obj = map.get(ch);
        if (obj && ch !== 'main') {
          obj.archived = true;
        }
      }
    }
    return [...map.values()];
  }

  function getChannels(projectId) {
    let list = channelCache.get(projectId);
    if (!list) {
      list = computeChannels(projectId);
      channelCache.set(projectId, list);
    }
    return list.map((c) => ({ ...c, subscribers: [...c.subscribers] }));
  }

  function read(projectId, { since = 0, limit = 50, channel = '', seqList = null } = {}) {
    const all = loadEntries(projectId);
    const maxSeq = all.reduce((mx, e) => (e.seq > mx ? e.seq : mx), 0);
    seqCache.set(projectId, maxSeq);

    const lim = Math.max(1, Math.min(200, Math.floor(+limit || 50)));
    const ch = String(channel || '').trim();

    let filtered;
    if (Array.isArray(seqList) && seqList.length) {
      const want = new Set(seqList.map((x) => Number(x)).filter((n) => Number.isFinite(n)));
      filtered = all.filter((e) => want.has(e.seq) && (!ch || e.channel === ch));
    } else {
      const sinceNum = Number(since) || 0;
      filtered = all.filter((e) => e.seq > sinceNum && (!ch || e.channel === ch));
    }

    const page = filtered.slice(-lim);
    const nodes = page.some((e) => !Array.isArray(e.targets)) ? nodesOf(projectId) : [];
    return {
      entries: page.map((e) => withTargets(e, nodes)),
      latestSeq: maxSeq,
    };
  }

  function removeProject(projectId) {
    seqCache.delete(projectId);
    channelCache.delete(projectId);
    const fp = filePathFor(projectId);
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
  }

  return {
    append,
    read,
    latestSeq,
    getChannels,
    removeProject,
  };
}

module.exports = {
  createBoard,
  parseMentions,
  resolveTargets,
  parseChannelMentions,
  parseRefs,
  formatWakePrompt,
  checkBoundaries,
};
