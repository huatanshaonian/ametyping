// Zero-token local Codex CLI quota reader: extracts the latest `rate_limits`
// (5h primary + 7d secondary windows with exact `resets_at`) from `~/.codex/sessions/`.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function findRecentJsonls(rootDir, maxFiles = 3, maxDepth = 4) {
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth || !fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(p);
          found.push({ file: p, mtimeMs: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  }
  walk(rootDir, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, maxFiles);
}

function readTail(filePath, maxBytes = 256 * 1024) {
  try {
    const st = fs.statSync(filePath);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    if (len <= 0) return '';
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function formatWindow(w, fallbackName) {
  if (!w || typeof w !== 'object') return null;
  const used = Number(w.used_percent);
  if (!Number.isFinite(used)) return null;
  const remaining = Math.max(0, Math.min(100, Math.round((100 - used) * 100) / 100));
  const mins = Number(w.window_minutes) || 0;
  let name = fallbackName;
  if (mins >= 10000) name = '7 days';
  else if (mins >= 1400) name = `${Math.round(mins / 1440)} days`;
  else if (mins >= 60) name = `${Math.round(mins / 60)} hours`;
  const resetsAtSec = Number(w.resets_at);
  const resetsAt = Number.isFinite(resetsAtSec) && resetsAtSec > 0
    ? new Date(resetsAtSec > 1e12 ? resetsAtSec : resetsAtSec * 1000).toISOString()
    : null;
  return {
    name,
    pool: 'codex',
    used,
    remaining,
    limit: 100,
    unit: '%',
    display: `${remaining}%`,
    resetsAt,
    windowMinutes: mins || null,
    unlimited: false,
  };
}

function parseRateLimitsFromLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || !l.includes('rate_limits')) continue;
    try {
      const obj = JSON.parse(l);
      const rl = (obj && obj.payload && obj.payload.rate_limits) || (obj && obj.rate_limits);
      if (!rl || typeof rl !== 'object') continue;
      const windows = [];
      const p = formatWindow(rl.primary, '5 hours');
      if (p) windows.push(p);
      const s = formatWindow(rl.secondary, '7 days');
      if (s) windows.push(s);
      if (!windows.length) continue;
      return {
        provider: 'codex',
        name: 'Codex (Local)',
        source: 'local-transcript',
        plan: String(rl.plan_type || '').slice(0, 40),
        status: 'ok',
        readAt: (typeof obj.timestamp === 'string' && obj.timestamp) || new Date().toISOString(),
        windows,
      };
    } catch {}
  }
  return null;
}

function readCodexRateLimits(homeDir = os.homedir()) {
  const root = path.join(homeDir, '.codex', 'sessions');
  const files = findRecentJsonls(root, 3, 4);
  for (const f of files) {
    const tail = readTail(f.file);
    const parsed = parseRateLimitsFromLines(tail);
    if (parsed) return parsed;
  }
  return null;
}

module.exports = {
  readCodexRateLimits,
  parseRateLimitsFromLines,
};
