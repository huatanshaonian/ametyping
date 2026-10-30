// What differs when the session in the terminal is Antigravity CLI (agy) and not Claude Code (remote-control.js, main.js):
// which process it is, how a reply of several lines is typed into it, and how a closed session is continued in the
// background (`agy --conversation <id> -p --dangerously-skip-permissions` with prompt on stdin).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const AGY_EXE = /^agy(?:\.exe)?$/i;
const SHIM = /^(node|cmd)\.exe$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findAgy(chain, ownPid) {
  if (!Array.isArray(chain)) return null;
  const boundary = ownPid ? chain.findIndex((p) => p.pid === ownPid) : -1;
  const limit = boundary < 0 ? chain.length : boundary;
  let i = -1;
  for (let n = 0; n < limit; n++) {
    const p = chain[n];
    if (i >= 0 && /^(powershell|pwsh|cmd|bash|sh|zsh|fish|nu|WindowsTerminal|OpenConsole|conhost)\.exe$/i.test(p.name)) break;
    if (AGY_EXE.test(p.name)) i = n;
  }
  if (i < 0) i = chain.slice(0, limit).findIndex((p) => AGY_EXE.test(p.name));
  if (i < 0) return null;
  let j = i + 1;
  if (chain[j] && SHIM.test(chain[j].name)) j++;
  const parents = chain.slice(i + 1, i + 4), owner = ownPid ? parents.findIndex((p) => p.pid === ownPid) : -1;
  const own = owner >= 0 && !parents.slice(0, owner).some((p) => /^(powershell|pwsh)\.exe$/i.test(p.name));
  return { pid: chain[i].pid, parent: chain[j] || null, own };
}

async function send(bridge, pid, text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1) return bridge.send(pid, lines[0]);
  for (let i = 0; i < lines.length; i++) {
    if (i) { const k = await bridge.key(pid, 'ctrlj'); if (!k.ok) return k; }
    if (lines[i]) { const r = await bridge.type(pid, lines[i]); if (!r.ok) return r; }
  }
  await sleep(Math.min(900, 250 + text.length / 4));
  return bridge.key(pid, 'enter');
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

async function started(bridge, pid, tries = 40) {
  for (let n = 0; n < tries; n++) {
    const all = await bridge.descendants(pid);
    const c = all.find((p) => /^agy\.exe$/i.test(p.name)) || all.find((p) => AGY_EXE.test(p.name));
    if (c) return c.pid;
    if (n > 3 && !all.length && !(await bridge.alive(pid))) return 0;
    await sleep(500);
  }
  return 0;
}

function command(env) {
  const p = env || process.env;
  const dirs = (p.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) { const f = path.join(d, 'agy.exe'); if (fs.existsSync(f)) return { exe: f, args: [] }; }
  for (const d of dirs) { const f = path.join(d, 'agy.cmd'); if (fs.existsSync(f)) return { exe: p.ComSpec || 'cmd.exe', args: ['/d', '/c', f] }; }
  const localApp = p.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const localF = path.join(localApp, 'agy', 'bin', 'agy.exe');
  if (fs.existsSync(localF)) return { exe: localF, args: [] };
  const userLocal = path.join(os.homedir(), '.local', 'bin', 'agy.exe');
  if (fs.existsSync(userLocal)) return { exe: userLocal, args: [] };
  return null;
}

function resume(id, cwd, text) {
  const c = command();
  const rawId = String(id || '').replace(/^agy:/, '');
  if (!c || !/^[0-9a-f-]{36}$/i.test(rawId)) return null;
  const p = spawn(c.exe, [...c.args, '--conversation', rawId, '-p', '--dangerously-skip-permissions'], { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  p.on('error', () => {});
  p.stdin.on('error', () => {});
  p.stdin.end(text);
  return p;
}

module.exports = { AGY_EXE, findAgy, send, greet, started, command, resume };
