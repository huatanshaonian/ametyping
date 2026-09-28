// Linux process lookups via /proc: which process is the Claude Code session behind a hook, and which tmux
// pane (if any) it runs in. Counterpart of the pet's console-bridge.ps1 ancestor walk on Windows.
'use strict';
const fs = require('fs');

// the interactive Claude Code process: the native binary ("claude", or its version-named copy) or an npm install
const CLAUDE_COMM = /^(claude|node|bun|\d+\.\d+\.\d+)$/;

function comm(pid) {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; }
}
function ppid(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return +s.slice(s.lastIndexOf(')') + 2).split(' ')[1] || 0;      // "pid (comm) state ppid ..."; comm may hold spaces
  } catch { return 0; }
}
function environ(pid) {
  const out = {};
  try {
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
  } catch {}
  return out;
}

// walk up from the hook's parent to the Claude process; the hook may run through a shell first
function findClaude(pid) {
  for (let p = +pid, n = 0; p > 1 && n < 8; p = ppid(p), n++) {
    const c = comm(p);
    if (c == null) return null;
    if (CLAUDE_COMM.test(c)) return { pid: p, comm: c, parent: ppid(p) };
  }
  return null;
}

// tmux exports TMUX="<socket>,<server pid>,<session>" and TMUX_PANE="%N" to everything started in a pane
function tmuxPaneOf(pid) {
  const e = environ(pid);
  if (!e.TMUX || !/^%\d+$/.test(e.TMUX_PANE || '')) return null;
  return { socket: e.TMUX.split(',')[0], pane: e.TMUX_PANE };
}

// still the same Claude process (the pid was not reused by something else)
function alive(pid, expectComm) {
  const c = pid ? comm(pid) : null;
  return c != null && (!expectComm || c === expectComm);
}

module.exports = { findClaude, tmuxPaneOf, alive, comm, environ };
