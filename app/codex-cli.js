// What differs when the session in the terminal is Codex CLI and not Claude Code (remote-control.js, main.js).
'use strict';
const { spawn } = require('child_process');
const { sleep, findCliInChain, sendMultiline, waitCliStarted, findWinCommand } = require('./cli-common');

const CODEX_EXE = /^codex\.exe$/i;
const SHIM = /^node\.exe$/i;

function findCodex(chain, ownPid) {
  return findCliInChain(chain, ownPid, {
    exeMatch: CODEX_EXE,
    exactMatch: (name) => name === 'codex.exe',
    shimRe: SHIM,
    extraBoundary: (name) => name === 'Codex.exe',
  });
}

function send(bridge, pid, text) {
  return sendMultiline(bridge, pid, text);
}

async function greet(bridge, pid, prompt, onUpdate = null) {
  let updateNotified = false;
  for (let n = 0; n < 45; n++) {
    await sleep(700);
    const text = await bridge.screen(pid);
    if (text == null) return;
    if (/Do you trust the contents of this directory/i.test(text)) {
      if (/[›>❯]\s*2\.\s*No/i.test(text)) await bridge.key(pid, 'up');
      await bridge.key(pid, 'enter');
    } else if (/Update available|New version available/i.test(text) && /(\d)\.\s*(?:Skip|Not now|Ignore|Dismiss|Later|Continue without)/i.test(text)) {
      if (!updateNotified && typeof onUpdate === 'function') {
        updateNotified = true;
        const verLine = String(text).split(/\r?\n/).find((l) => /Update available|New version available/i.test(l)) || 'Update available';
        try { onUpdate({ tool: 'codex', detail: verLine.trim().slice(0, 160), at: Date.now() }); } catch {}
      }
      const skipM = /(\d)\.\s*(?:Skip|Not now|Ignore|Dismiss|Later|Continue without)/i.exec(text);
      const curM = /[›>❯]\s*(\d)\./.exec(text);
      const diff = (skipM ? Number(skipM[1]) : 2) - (curM ? Number(curM[1]) : 1);
      for (let k = 0; k < Math.abs(diff); k++) {
        await bridge.key(pid, diff > 0 ? 'down' : 'up');
        await sleep(120);
      }
      await sleep(180);
      await bridge.key(pid, 'enter');
    } else if (/enter confirm|Press enter to continue/i.test(text) && !/Update available|New version available/i.test(text)) {
      return;
    } else if (/›\s+Ask Codex to do anything/.test(text)) {
      if (prompt) await send(bridge, pid, prompt);
      return;
    }
  }
}

function started(bridge, pid, tries = 40) {
  return waitCliStarted(bridge, pid, { primaryMatch: (n) => n === 'codex.exe', fallbackRe: CODEX_EXE }, tries);
}

function command(env) {
  return findWinCommand('codex', env || process.env);
}

function resume(id, cwd, text) {
  const c = command();
  if (!c || !/^[0-9a-f-]{36}$/.test(String(id))) return null;
  const p = spawn(c.exe, [...c.args, 'exec', 'resume', '--skip-git-repo-check', id, '-'], {
    cwd,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  p.on('error', () => {});
  p.stdin.on('error', () => {});
  p.stdin.end(text);
  return p;
}

module.exports = { CODEX_EXE, findCodex, send, greet, started, command, resume };
