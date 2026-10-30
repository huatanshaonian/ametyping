// What differs on Linux when the session is Kiro CLI (kiro-cli) and not Claude Code: where its program is, and how a
// conversation is continued -- in the background (`kiro-cli chat --resume-id <id> --no-interactive --trust-all-tools
// "<prompt>"`, the prompt as an argument) or in a terminal again (`kiro-cli chat --resume-id <id>`).
// Replies go into its tmux pane like Claude Code's (tmux.js).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function kiroBin(env) {
  for (const dir of ((env && env.PATH) || process.env.PATH || '').split(path.delimiter)) {
    const f = dir && path.join(dir, 'kiro-cli');
    if (f && fs.existsSync(f)) return f;
  }
  const f = path.join(os.homedir(), '.local', 'bin', 'kiro-cli');
  return fs.existsSync(f) ? f : null;
}

// "kiro:<session id>" (how its sessions are named here) -> the session id, or null when it is not one
const threadOf = (id) => { const m = /^kiro:(.+)$/.exec(String(id)); return m && ID.test(m[1]) ? m[1] : null; };

// the arguments that continue a session without a terminal. Kiro's headless mode takes the prompt as an argument (not
// on stdin) and needs --trust-all-tools so a tool approval does not hang.
const execResumeArgs = (session, text) => ['chat', '--resume-id', session, '--no-interactive', '--trust-all-tools', String(text == null ? '' : text)];
// the arguments that open a session in a terminal again
const terminalResumeArgs = (session) => ['chat', '--resume-id', session];

module.exports = { kiroBin, bin: kiroBin, threadOf, execResumeArgs, terminalResumeArgs };
