// A session whose process is gone is continued in the background with `claude -p --resume <id>`; its hooks
// report back like any other session and it appends to the same transcript the dashboard shows.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function claudeBin(env) {
  for (const dir of ((env || process.env).PATH || '').split(path.delimiter)) {
    const f = dir && path.join(dir, 'claude');
    if (f && fs.existsSync(f)) return f;
  }
  const f = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(f) ? f : null;
}

// env: the environment the session was started with (null = this service's own); onExit: the run ended
function resume(id, cwd, env, text, onExit) {
  const bin = claudeBin(env);
  if (!bin) return { ok: false, msg: '找不到 claude，没法在后台续聊' };
  const p = spawn(bin, ['-p', '--resume', id], { cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
    env: env || process.env, stdio: ['pipe', 'ignore', 'ignore'] });
  p.on('error', () => {});
  p.stdin.on('error', () => {});
  p.stdin.end(text);                                               // prompt on stdin: never parsed as an option
  p.on('exit', onExit);
  return { ok: true, pid: p.pid };
}

module.exports = { resume };
