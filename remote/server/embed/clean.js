// Pure text cleaning and chunking rules for conversation lines before embedding.
// Based on measured noise in docs/embedding-plan.md §3.6 & §3.7.
'use strict';
const crypto = require('crypto');

const RULE_VERSION = '1';
const MIN_EFFECTIVE_CHARS = 8;
const DEFAULT_MAX_CHARS = 600;
const DEFAULT_OVERLAP_MAX = 150;

const ALLOWED_ROLES = new Set(['user', 'assistant']);

// Noise lines to drop completely
const DROP_LINE_PATTERNS = [
  /^\s*<skill(?:\s|>)/i,
  /^\s*<recommended_plugins(?:\s|>)/i,
  /^\s*<image(?:\s|>)/i,
  /^\s*This session is being continued from a previous conversation\b/i,
];

// Inline blocks to strip out of otherwise valid messages
const STRIP_BLOCK_PATTERNS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<skill(?:\s[^>]*)?>[\s\S]*?<\/skill>/gi,
  /<recommended_plugins(?:\s[^>]*)?>[\s\S]*?<\/recommended_plugins>/gi,
  /<image(?:\s[^>]*)?>[\s\S]*?<\/image>/gi,
];

function detectTag(text) {
  if (/<pasted_content(?:\s|>)/i.test(text)) return 'pasted';
  if (/<cross-session-message(?:\s|>)/i.test(text)) return 'cross-session';
  if (/<agent-message(?:\s|>)/i.test(text)) return 'agent';
  return '';
}

// Returns { text, tag } or null if the line should not be embedded.
function cleanLine(text, role) {
  if (!ALLOWED_ROLES.has(String(role || ''))) return null;
  let s = String(text || '').replace(/\r\n/g, '\n');
  if (!s.trim()) return null;

  for (const re of DROP_LINE_PATTERNS) {
    if (re.test(s)) return null;
  }

  const tag = detectTag(s);

  for (const re of STRIP_BLOCK_PATTERNS) {
    s = s.replace(re, '');
  }

  // Collapse excessive blank lines while preserving paragraph breaks
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  // Check effective non-whitespace length (drops short acks like "ok", "继续", "好的")
  const effectiveLen = s.replace(/\s+/g, '').length;
  if (effectiveLen < MIN_EFFECTIVE_CHARS) return null;

  return { text: s, tag };
}

// Split a single paragraph into sentence-like units, preserving punctuation.
function splitSentences(para) {
  const parts = [];
  const re = /[^。！？!?\n]+[。！？!?\n]*/g;
  let m;
  while ((m = re.exec(para)) !== null) {
    const piece = m[0].trim();
    if (piece) parts.push(piece);
  }
  return parts.length ? parts : [para];
}

// Hard-split a piece that is still longer than maxChars (e.g., long unbroken line/code).
function hardSplit(s, maxChars) {
  const out = [];
  for (let i = 0; i < s.length; i += maxChars) {
    const sub = s.slice(i, i + maxChars).trim();
    if (sub) out.push(sub);
  }
  return out;
}

function lastSentenceOf(text, maxLen = DEFAULT_OVERLAP_MAX) {
  const sents = splitSentences(text);
  const last = sents[sents.length - 1] || '';
  if (!last) return '';
  return last.length <= maxLen ? last : last.slice(-maxLen);
}

// Split cleaned text into chunks of roughly maxChars, overlapping by one sentence between adjacent chunks.
function chunkText(text, { maxChars = DEFAULT_MAX_CHARS, overlapMax = DEFAULT_OVERLAP_MAX } = {}) {
  const s = String(text || '').trim();
  if (!s) return [];
  if (s.length <= maxChars) return [s];

  const paragraphs = s.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const units = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      units.push(p);
    } else {
      for (const sent of splitSentences(p)) {
        if (sent.length <= maxChars) units.push(sent);
        else units.push(...hardSplit(sent, maxChars));
      }
    }
  }

  const chunks = [];
  let cur = '';
  for (const u of units) {
    if (!cur) {
      cur = u;
      continue;
    }
    const sep = cur.includes('\n') || u.includes('\n') ? '\n\n' : '\n';
    if (cur.length + sep.length + u.length <= maxChars) {
      cur = cur + sep + u;
    } else {
      chunks.push(cur);
      const overlap = lastSentenceOf(cur, Math.min(overlapMax, Math.floor(maxChars / 3)));
      if (overlap && overlap.length + 1 + u.length <= maxChars && overlap !== u) {
        cur = overlap + '\n' + u;
      } else {
        cur = u;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

module.exports = {
  RULE_VERSION,
  DEFAULT_MAX_CHARS,
  cleanLine,
  chunkText,
  hashText,
};
