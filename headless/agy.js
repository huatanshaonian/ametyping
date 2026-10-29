// What differs on Linux when the session is Antigravity CLI (agy) and not Claude Code: where its program is, and how a
// conversation is continued -- in the background (`agy --conversation <id> -p --dangerously-skip-permissions`, prompt on
// stdin) or in a terminal again (`agy --conversation <id>`).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function agyBin(env) {
  for (const dir of ((env && env.PATH) || process.env.PATH || '').split(path.delimiter)) {
    const f = dir && path.join(dir, 'agy');
    if (f && fs.existsSync(f)) return f;
  }
  const f = path.join(os.homedir(), '.local', 'bin', 'agy');
  return fs.existsSync(f) ? f : null;
}

const threadOf = (id) => { const m = /^agy:(.+)$/.exec(String(id)); return m && ID.test(m[1]) ? m[1] : null; };

const execResumeArgs = (thread) => ['--conversation', thread, '-p', '--dangerously-skip-permissions'];

module.exports = { agyBin, bin: agyBin, threadOf, execResumeArgs };
