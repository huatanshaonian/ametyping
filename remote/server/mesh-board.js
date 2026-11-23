// AmeMesh Unified Blackboard: append-only per-project JSONL log, @mention / #seq parsing,
// hybrid threshold wake formatting, and structured contract boundary verification.
'use strict';
const fs = require('fs');
const path = require('path');

function safeProjectId(projectId) {
  return String(projectId || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

// Extract @alias / @nodeId tokens; `@all` (case-insensitive) sets mentionAll=true and is excluded from mentions[]
function parseMentions(text) {
  const src = String(text || '');
  const re = /@([A-Za-z0-9_\u4e00-\u9fa5-]+)/g;
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

function createBoard({ dataDir }) {
  const dir = path.join(dataDir, 'mesh-boards');
  const seqCache = new Map(); // projectId -> highest seq number

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
    const parsedMentions = parseMentions(text);
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
    const parsedRefs = parseRefs(text);
    const explicitRefs = Array.isArray(entry.refs) ? entry.refs.map((x) => parseInt(x, 10)).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
    const refs = [...new Set([...parsedRefs, ...explicitRefs])].sort((a, b) => a - b);

    const fullEntry = {
      seq: nextSeq,
      ts: Number(entry.ts) || Date.now(),
      channel: String(entry.channel || 'main') || 'main',
      kind: String(entry.kind || 'post') || 'post',
      agent: String(entry.agent || '系统') || '系统',
      nodeId: entry.nodeId || null,
      text,
      mentions,
      mentionAll,
      refs,
      artifacts: Array.isArray(entry.artifacts) ? entry.artifacts : [],
      done: Boolean(entry.done),
      audit: entry.audit || null,
    };

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePathFor(projectId), JSON.stringify(fullEntry) + '\n', { encoding: 'utf8', mode: 0o600 });
    seqCache.set(projectId, nextSeq);
    return fullEntry;
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

    return {
      entries: filtered.slice(-lim),
      latestSeq: maxSeq,
    };
  }

  function removeProject(projectId) {
    seqCache.delete(projectId);
    const fp = filePathFor(projectId);
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
  }

  return {
    append,
    read,
    latestSeq,
    removeProject,
  };
}

module.exports = {
  createBoard,
  parseMentions,
  parseRefs,
  formatWakePrompt,
  checkBoundaries,
};
