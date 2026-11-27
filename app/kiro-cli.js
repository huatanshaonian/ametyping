// What differs when the session in the terminal is Kiro CLI (kiro-cli) and not Claude Code (remote-control.js, main.js).
'use strict';
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { sleep, findCliInChain, sendMultiline, waitCliStarted, findWinCommand } = require('./cli-common');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIRO_EXE = /^kiro-cli(?:\.exe)?$/i;
const SHIM = /^(node|cmd)\.exe$/i;

function findKiro(chain, ownPid) {
  return findCliInChain(chain, ownPid, { exeMatch: KIRO_EXE, shimRe: SHIM });
}

function send(bridge, pid, text) {
  return sendMultiline(bridge, pid, text);
}

async function greet(bridge, pid, prompt) {
  for (let n = 0; n < 45; n++) {
    await sleep(700);
    const text = await bridge.screen(pid);
    if (text == null) return;
    if (/Do you trust the contents of this (?:directory|project|folder)/i.test(text)) {
      if (/[›❯]\s*(\d\.\s*)?No/i.test(text)) await bridge.key(pid, 'up');
      await bridge.key(pid, 'enter');
    } else if (/Ask (?:Kiro|anything)|Type your|shift\+tab|›\s/i.test(text)) {
      if (prompt) await send(bridge, pid, prompt);
      return;
    }
  }
}

function started(bridge, pid, tries = 40) {
  return waitCliStarted(bridge, pid, { primaryMatch: (n) => /^kiro-cli\.exe$/i.test(n), fallbackRe: KIRO_EXE }, tries);
}

function command(env) {
  const p = env || process.env;
  const localApp = p.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return findWinCommand('kiro-cli', p, [path.join(localApp, 'kiro-cli', 'bin', 'kiro-cli.exe')]);
}

function resumeArgs(id, text) {
  const rawId = String(id || '').replace(/^kiro:/, '');
  if (!ID.test(rawId)) return null;
  return ['chat', '--resume-id', rawId, '--no-interactive', '--trust-all-tools', String(text)];
}

function resume(id, cwd, text) {
  const c = command();
  const args = resumeArgs(id, text);
  if (!c || !args) return null;
  const p = spawn(c.exe, [...c.args, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  p.on('error', () => {});
  return p;
}

module.exports = { KIRO_EXE, findKiro, send, greet, started, command, resume, resumeArgs };
