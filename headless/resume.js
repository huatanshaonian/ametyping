// Continues a session whose terminal process is gone in the background (`claude -p --resume`, `codex exec resume`, etc.).
'use strict';
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { findUnixBin } = require('./cli-bin');
const { codexBin, execResumeArgs } = require('./codex');
const { agyBin, execResumeArgs: agyResumeArgs } = require('./agy');
const { kiroBin, execResumeArgs: kiroResumeArgs } = require('./kiro');

const claudeBin = (env) => findUnixBin('claude', env);

function resume(id, cwd, env, text, onExit, codex = false, settingsFile = '', launchPlan = null) {
  const isAgy = codex === 'agy';
  const isKiro = codex === 'kiro';
  const isCodex = codex === true || codex === 'codex';
  const bin = launchPlan ? launchPlan.exe : isAgy ? agyBin(env) : isKiro ? kiroBin(env) : isCodex ? codexBin(env) : claudeBin(env);
  if (!bin) return { ok: false, msg: `找不到 ${isAgy ? 'agy' : isKiro ? 'kiro-cli' : isCodex ? 'codex' : 'claude'}，没法在后台续聊` };
  const args = launchPlan
    ? launchPlan.args
    : isAgy ? agyResumeArgs(id)
    : isKiro ? kiroResumeArgs(id, text)
    : isCodex ? execResumeArgs(id)
    : [...(settingsFile ? ['--settings', settingsFile] : []), '-p', '--resume', id];
  const p = spawn(bin, args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
    env: env || process.env,
    stdio: [isKiro ? 'ignore' : 'pipe', 'ignore', 'ignore'],
  });
  p.on('error', () => {});
  if (!isKiro) { p.stdin.on('error', () => {}); p.stdin.end(text); }
  p.once('close', onExit);
  return { ok: true, pid: p.pid };
}

module.exports = { resume };
