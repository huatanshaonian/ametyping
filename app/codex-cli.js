// What differs when the session in the terminal is Codex CLI and not Claude Code (remote-control.js, main.js):
// which process it is, how a reply of several lines is typed into it, and how a closed session is continued in the
// background (`codex exec resume`). Windows only, like the console bridge.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// the CLI's own process (an npm install starts it from a node.exe shim; the desktop app is "Codex.exe" as well, told
// apart by what started it: no shell, no terminal)
const CODEX_EXE = /^codex\.exe$/i;
const SHIM = /^node\.exe$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// chain: a process and its ancestors, nearest first ({ pid, name }) -> the Codex process in it, what started that
// (the shim skipped), and whether this app did (a background resume of ours)
function findCodex(chain, ownPid) {
  const i = chain.findIndex((p) => CODEX_EXE.test(p.name));
  if (i < 0) return null;
  let j = i + 1;
  if (chain[j] && SHIM.test(chain[j].name)) j++;
  return { pid: chain[i].pid, parent: chain[j] || null, own: chain.slice(i + 1, i + 4).some((p) => p.pid === ownPid) };
}

// A reply into Codex's input box. Codex does not take a bracketed paste from the console's input buffer (it shows the
// markers as text and drops the line breaks): lines are typed one by one with Ctrl+J -- its "new line" -- between
// them, then Enter on its own a moment later (inside a fast burst Codex takes Enter for part of a paste).
async function send(bridge, pid, text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1) return bridge.send(pid, lines[0]);
  for (let i = 0; i < lines.length; i++) {
    if (i) { const k = await bridge.key(pid, 'ctrlj'); if (!k.ok) return k; }
    if (lines[i]) { const r = await bridge.type(pid, lines[i]); if (!r.ok) return r; }
  }
  await sleep(Math.min(900, 250 + text.length / 4));
  return bridge.key(pid, 'enter');
}

// how to start Codex here: codex.exe on PATH (a standalone install), or npm's codex.cmd through cmd.exe
function command() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) { const f = path.join(d, 'codex.exe'); if (fs.existsSync(f)) return { exe: f, args: [] }; }
  for (const d of dirs) { const f = path.join(d, 'codex.cmd'); if (fs.existsSync(f)) return { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', f] }; }
  return null;
}

// the session's process is gone: its thread continued without a terminal; the prompt goes in on stdin (never parsed
// as an option). Hooks report its progress like any session's; what it would have asked you is decided by its own
// sandbox and approval settings. id: the thread's UUID. Returns the child process, or null when Codex is not found.
function resume(id, cwd, text) {
  const c = command();
  if (!c || !/^[0-9a-f-]{36}$/.test(String(id))) return null;
  const p = spawn(c.exe, [...c.args, 'exec', 'resume', '--skip-git-repo-check', id, '-'], { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  p.on('error', () => {});
  p.stdin.on('error', () => {});
  p.stdin.end(text);
  return p;
}

module.exports = { CODEX_EXE, findCodex, send, command, resume };
