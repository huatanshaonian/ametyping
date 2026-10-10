// What differs on Linux when the session is Codex CLI and not Claude Code: where its program is, and how a thread is
// continued -- in the background (`codex exec resume`, the prompt on stdin) or in a terminal again (`codex resume`).
// Replies go into its tmux pane like Claude Code's (tmux.js): Codex takes the bracketed paste there.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function codexBin(env) {
  for (const dir of ((env && env.PATH) || process.env.PATH || '').split(path.delimiter)) {
    const f = dir && path.join(dir, 'codex');
    if (f && fs.existsSync(f)) return f;
  }
  const f = path.join(os.homedir(), '.local', 'bin', 'codex');
  return fs.existsSync(f) ? f : null;
}

// "codex:<thread id>" (how its sessions are named here) -> the thread id, or null when it is not one
const threadOf = (id) => { const m = /^codex:(.+)$/.exec(String(id)); return m && ID.test(m[1]) ? m[1] : null; };

// the arguments that continue a thread without a terminal; what it would have asked you is decided by its own sandbox
// and approval settings
const execResumeArgs = (thread) => ['exec', 'resume', '--skip-git-repo-check', thread, '-'];

module.exports = { codexBin, threadOf, execResumeArgs };
