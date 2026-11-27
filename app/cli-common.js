'use strict';
// Shared process-chain, console input, executable lookup, and mesh env helpers
// across app/agy-cli.js, app/codex-cli.js, app/kiro-cli.js, app/remote-control.js, and headless/launch.js.

const fs = require('fs');
const path = require('path');

const SHELL_BOUNDARY_RE = /^(powershell|pwsh|cmd|bash|sh|zsh|fish|nu|WindowsTerminal|OpenConsole|conhost)\.exe$/i;
const PS_SHIM_RE = /^(powershell|pwsh)\.exe$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanMeshEnv(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const k of ['AME_PROJECT_ID', 'AME_NODE_ID']) {
    if (typeof v[k] === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(v[k])) out[k] = v[k];
  }
  return Object.keys(out).length ? out : null;
}

// Walk ancestor chain (nearest first) to locate the outermost CLI process below any shell/service boundary.
function findCliInChain(chain, ownPid, { exeMatch, exactMatch = null, shimRe, extraBoundary = null }) {
  if (!Array.isArray(chain)) return null;
  const boundary = ownPid ? chain.findIndex((p) => p.pid === ownPid) : -1;
  const limit = boundary < 0 ? chain.length : boundary;
  let i = -1;
  for (let n = 0; n < limit; n++) {
    const p = chain[n];
    if (i >= 0 && (SHELL_BOUNDARY_RE.test(p.name) || (extraBoundary && extraBoundary(p.name)))) break;
    if (exactMatch ? exactMatch(p.name) : exeMatch.test(p.name)) i = n;
  }
  if (i < 0) i = chain.slice(0, limit).findIndex((p) => exeMatch.test(p.name));
  if (i < 0) return null;
  let j = i + 1;
  if (chain[j] && shimRe.test(chain[j].name)) j++;
  const parents = chain.slice(i + 1, i + 4);
  const owner = ownPid ? parents.findIndex((p) => p.pid === ownPid) : -1;
  const own = owner >= 0 && !parents.slice(0, owner).some((p) => PS_SHIM_RE.test(p.name));
  return { pid: chain[i].pid, parent: chain[j] || null, own };
}

// Type a single or multi-line message into an interactive TUI input box (Ctrl+J between lines, Enter after settle).
async function sendMultiline(bridge, pid, text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1) return bridge.send(pid, lines[0]);
  for (let i = 0; i < lines.length; i++) {
    if (i) {
      const k = await bridge.key(pid, 'ctrlj');
      if (!k.ok) return k;
    }
    if (lines[i]) {
      const r = await bridge.type(pid, lines[i]);
      if (!r.ok) return r;
    }
  }
  await sleep(Math.min(900, 250 + text.length / 4));
  return bridge.key(pid, 'enter');
}

// Poll descendants of a launched window PID until the target CLI executable appears.
async function waitCliStarted(bridge, pid, { primaryMatch, fallbackRe }, tries = 40) {
  for (let n = 0; n < tries; n++) {
    const all = await bridge.descendants(pid);
    const c = all.find((p) => primaryMatch(p.name)) || all.find((p) => fallbackRe.test(p.name));
    if (c) return c.pid;
    if (n > 3 && !all.length && !(await bridge.alive(pid))) return 0;
    await sleep(500);
  }
  return 0;
}

// Locate `<base>.exe` or `<base>.cmd` on PATH, falling back to optional extra executable paths.
function findWinCommand(baseName, env = process.env, extraExeCandidates = []) {
  const p = env || process.env;
  const dirs = (p.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, `${baseName}.exe`);
    if (fs.existsSync(f)) return { exe: f, args: [] };
  }
  for (const d of dirs) {
    const f = path.join(d, `${baseName}.cmd`);
    if (fs.existsSync(f)) return { exe: p.ComSpec || 'cmd.exe', args: ['/d', '/c', f] };
  }
  for (const cand of extraExeCandidates) {
    if (cand && fs.existsSync(cand)) return { exe: cand, args: [] };
  }
  return null;
}

module.exports = {
  sleep,
  cleanMeshEnv,
  findCliInChain,
  sendMultiline,
  waitCliStarted,
  findWinCommand,
};
