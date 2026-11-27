'use strict';
// Shared helpers for AmeTyping hook & MCP installers
// (install-agy-hooks.js, install-codex-hooks.js, install-kiro-hooks.js,
//  install-mesh-mcp.js, install-opencode-plugin.js, headless/install-hooks.js).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fwdSlash = (s) => String(s || '').replace(/\\/g, '/');

// PowerShell single-quote literal escaping (`'` -> `''`)
const psQuote = (s) => "'" + String(s || '').replace(/'/g, "''") + "'";

// Windows CommandLineToArgvW double-quote escaping (handles trailing backslashes and internal quotes)
function winCmdQuote(arg) {
  const s = String(arg ?? '');
  if (s && !/[\s"&|<>^()]/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

function nodeOnPath(node) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return (process.env.PATH || '')
    .split(path.delimiter)
    .some((d) => d && same(path.join(d, path.basename(node)), node));
}

// Shell & PowerShell-safe hook command builder:
// Never begins with a quoted executable when `node` is on PATH (avoids PowerShell `"C:/.../node.exe" ...` parse error),
// and quotes paths containing whitespace or shell metacharacters.
function hookCommandFor(node, script, extraArg = '', onPath = nodeOnPath) {
  const needsQuote = (s) => /[\s&();'"`|$<>]/.test(s);
  const q = (s) => (needsQuote(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);
  const nodeFwd = fwdSlash(node);
  const scriptFwd = fwdSlash(script);
  const nodePart = /\s/.test(node) && onPath(node) ? 'node' : q(nodeFwd);
  const scriptPart = q(scriptFwd);
  return extraArg ? `${nodePart} ${scriptPart} ${extraArg}` : `${nodePart} ${scriptPart}`;
}

function psCallCommand(node, ...args) {
  return `& ${psQuote(node)}${args.length ? ' ' + args.map(psQuote).join(' ') : ''}`;
}

// Recognise a hook command written by current or earlier AmeTyping installs.
function isOurHookCommand(cmd, { scriptPath = '', scriptName = '', exactCommand = '', allowTrailingArg = false } = {}) {
  if (typeof cmd !== 'string' || !cmd) return false;
  if (exactCommand && cmd === exactCommand) return true;
  const norm = fwdSlash(cmd);
  if (scriptPath && norm.includes(fwdSlash(scriptPath))) return true;
  if (!scriptName) return false;
  const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = allowTrailingArg ? '(?:\\s+[^"\'\\s]+)?["\']?\\s*$' : '["\']?(?:\\s|$)';
  return new RegExp(`(?:[\\\\/]|\\s)${escaped}${tail}`).test(norm);
}

function readJsonFile(filePath, { allowEmpty = true } = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const clean = raw.replace(/^\uFEFF/, '').trim();
  const obj = !clean && allowEmpty ? {} : JSON.parse(clean);
  return { raw, obj };
}

function atomicWriteText(filePath, content, { mode, backupExt = '', backupOnce = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (backupExt && fs.existsSync(filePath)) {
    const backupFile = filePath + backupExt;
    if (!backupOnce || !fs.existsSync(backupFile)) {
      fs.copyFileSync(filePath, backupFile);
    }
  }
  const tmpFile = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpFile, content, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8');
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    throw err;
  }
}

module.exports = {
  fwdSlash,
  psQuote,
  winCmdQuote,
  nodeOnPath,
  hookCommandFor,
  psCallCommand,
  isOurHookCommand,
  readJsonFile,
  atomicWriteText,
};
