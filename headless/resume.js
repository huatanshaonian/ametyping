// A session whose process is gone is continued in the background with `claude -p --resume <id>`; its hooks
// report back like any other session and it appends to the same transcript the dashboard shows.
// A Codex thread the same way, with `codex exec resume` (codex.js).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { codexBin, execResumeArgs } = require('./codex');
const { agyBin, execResumeArgs: agyResumeArgs } = require('./agy');
const { kiroBin, execResumeArgs: kiroResumeArgs } = require('./kiro');

function claudeBin(env) {
  for (const dir of ((env || process.env).PATH || '').split(path.delimiter)) {
    const f = dir && path.join(dir, 'claude');
    if (f && fs.existsSync(f)) return f;
  }
  const f = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(f) ? f : null;
}

// env: the environment the session was started with (null = this service's own); onExit: the run ended;
// codex: id is a Codex thread's ('codex'/true), 'agy' for Antigravity, 'kiro' for Kiro; settingsFile: the alias
// settings for this one resume
function resume(id, cwd, env, text, onExit, codex = false, settingsFile = '', launchPlan = null) {
  const isAgy = codex === 'agy';
  const isKiro = codex === 'kiro';
  const isCodex = codex === true || codex === 'codex';
  const bin = launchPlan ? launchPlan.exe : isAgy ? agyBin(env) : isKiro ? kiroBin(env) : isCodex ? codexBin(env) : claudeBin(env);
  if (!bin) return { ok: false, msg: `找不到 ${isAgy ? 'agy' : isKiro ? 'kiro-cli' : isCodex ? 'codex' : 'claude'}，没法在后台续聊` };
  // Kiro takes the prompt as an argument (not on stdin); everything else reads stdin.
  const args = launchPlan ? launchPlan.args : isAgy ? agyResumeArgs(id) : isKiro ? kiroResumeArgs(id, text) : isCodex ? execResumeArgs(id) : [...(settingsFile ? ['--settings', settingsFile] : []), '-p', '--resume', id];
  const p = spawn(bin, args, { cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
    env: env || process.env, stdio: [isKiro ? 'ignore' : 'pipe', 'ignore', 'ignore'] });
  p.on('error', () => {});
  if (!isKiro) { p.stdin.on('error', () => {}); p.stdin.end(text); }   // prompt on stdin: never parsed as an option
  p.once('close', onExit); // close also fires after a failed spawn; never leave the session permanently busy.
  return { ok: true, pid: p.pid };
}

module.exports = { resume };
