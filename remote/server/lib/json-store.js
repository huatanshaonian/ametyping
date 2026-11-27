// Shared atomic JSON & file persistence utilities for remote/server modules.
// Eliminates duplicated mkdirSync + fixed-.tmp writeFileSync + renameSync boilerplates
// and prevents concurrent/re-entrant .tmp filename collisions (especially EPERM/ENOENT on Windows).
'use strict';
const fs = require('fs');
const path = require('path');

let tmpSeq = 0;

function parseJsonSafe(raw, fallback = null) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v !== null && v !== undefined ? v : fallback;
  } catch {
    return fallback;
  }
}

function readJsonSafe(file, fallback = null) {
  if (!file) return fallback;
  try {
    return parseJsonSafe(fs.readFileSync(file, 'utf8'), fallback);
  } catch {
    return fallback;
  }
}

function writeFileAtomic(file, content, opts = {}) {
  const { mode, mkdirMode, encoding = 'utf8', chmod = false } = opts;
  fs.mkdirSync(
    path.dirname(file),
    mkdirMode !== undefined ? { recursive: true, mode: mkdirMode } : { recursive: true }
  );
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  const writeOpts = typeof content === 'string'
    ? (mode !== undefined ? { encoding, mode } : { encoding })
    : (mode !== undefined ? { mode } : undefined);
  try {
    fs.writeFileSync(tmp, content, writeOpts);
    if (chmod && mode !== undefined) {
      try { fs.chmodSync(tmp, mode); } catch {}
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

function writeJsonAtomic(file, data, opts = {}) {
  const { indent = 0, trailingNewline = false, ...rest } = opts;
  const raw = (indent ? JSON.stringify(data, null, indent) : JSON.stringify(data)) + (trailingNewline ? '\n' : '');
  writeFileAtomic(file, raw, rest);
}

module.exports = {
  parseJsonSafe,
  readJsonSafe,
  writeFileAtomic,
  writeJsonAtomic,
};
