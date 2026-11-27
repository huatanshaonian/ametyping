// What differs when the session in the terminal is Antigravity CLI (agy) and not Claude Code (remote-control.js, main.js).
'use strict';
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { sleep, findCliInChain, sendMultiline, waitCliStarted, findWinCommand } = require('./cli-common');

const AGY_EXE = /^agy(?:\.exe)?$/i;
const SHIM = /^(node|cmd)\.exe$/i;
const AGY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function findAgy(chain, ownPid) {
  return findCliInChain(chain, ownPid, { exeMatch: AGY_EXE, shimRe: SHIM });
}

function send(bridge, pid, text) {
  return sendMultiline(bridge, pid, text);
}

async function greet(bridge, pid, prompt) {
  for (let n = 0; n < 45; n++) {
    await sleep(700);
    const text = await bridge.screen(pid);
    if (text == null) return;
    if (/Do you trust the contents of this (?:project|directory)|Yes, I trust this folder/i.test(text)) {
      if (/❯\s*(\d\.\s*)?No, exit|›\s*2\.\s*No/.test(text)) await bridge.key(pid, 'up');
      await bridge.key(pid, 'enter');
    } else if (/Type your message|shift\+tab|Antigravity/i.test(text)) {
      if (prompt) await send(bridge, pid, prompt);
      return;
    }
  }
}

function started(bridge, pid, tries = 40) {
  return waitCliStarted(bridge, pid, { primaryMatch: (n) => /^agy\.exe$/i.test(n), fallbackRe: AGY_EXE }, tries);
}

function command(env) {
  const p = env || process.env;
  const localApp = p.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return findWinCommand('agy', p, [
    path.join(localApp, 'agy', 'bin', 'agy.exe'),
    path.join(os.homedir(), '.local', 'bin', 'agy.exe'),
  ]);
}

function resume(id, cwd, text) {
  const c = command();
  const rawId = String(id || '').replace(/^agy:/, '');
  if (!c || !AGY_UUID.test(rawId)) return null;
  const p = spawn(c.exe, [...c.args, '--conversation', rawId, '-p', '--dangerously-skip-permissions'], {
    cwd,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  p.on('error', () => {});
  p.stdin.on('error', () => {});
  p.stdin.end(text);
  return p;
}

function findRunningByConversation(rawId) {
  const id = String(rawId || '').replace(/^agy:/, '').trim();
  if (!AGY_UUID.test(id) || process.platform !== 'win32') return Promise.resolve(0);
  const psCmd = `Get-CimInstance Win32_Process -Filter "Name='agy.exe'" | Where-Object { $_.CommandLine -match '--conversation[=\\s]+${id}' -and $_.CommandLine -notmatch '(^|\\s)-p(\\s|$)' } | Select-Object -First 1 -ExpandProperty ProcessId`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(0);
      const pid = parseInt(String(stdout || '').trim(), 10);
      resolve(Number.isSafeInteger(pid) && pid > 0 ? pid : 0);
    });
  });
}

module.exports = { AGY_EXE, findAgy, send, greet, started, command, resume, findRunningByConversation };
