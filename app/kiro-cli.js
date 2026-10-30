// What differs when the session in the terminal is Kiro CLI (kiro-cli) and not Claude Code (remote-control.js,
// main.js): which process it is, how a reply is typed into it, and how a closed session is continued in the
// background. A closed Kiro session is resumed headless with:
//     kiro-cli chat --resume-id <id> --no-interactive --trust-all-tools "<prompt>"
// Kiro's headless mode needs the query as an argument (not on stdin) and a trust flag to avoid hanging on approvals.
// Windows only, like the console bridge.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// the CLI's own process; an npm/standalone install may launch it through a node/cmd shim
const KIRO_EXE = /^kiro-cli(?:\.exe)?$/i;
const SHIM = /^(node|cmd)\.exe$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// chain: a process and its ancestors (nearest first, { pid, name }) -> the Kiro process, what started it (shim
// skipped), and whether this app did (own = a background resume of ours, not a terminal we should type into)
function findKiro(chain, ownPid) {
  if (!Array.isArray(chain)) return null;
  const boundary = ownPid ? chain.findIndex((p) => p.pid === ownPid) : -1;
  const limit = boundary < 0 ? chain.length : boundary;
  let i = -1;
  for (let n = 0; n < limit; n++) {
    const p = chain[n];
    // once a CLI is found, its shell/terminal is a boundary: a Kiro above it owns a different terminal
    if (i >= 0 && /^(powershell|pwsh|cmd|bash|sh|zsh|fish|nu|WindowsTerminal|OpenConsole|conhost)\.exe$/i.test(p.name)) break;
    if (KIRO_EXE.test(p.name)) i = n;
  }
  if (i < 0) i = chain.slice(0, limit).findIndex((p) => KIRO_EXE.test(p.name));
  if (i < 0) return null;
  let j = i + 1;
  if (chain[j] && SHIM.test(chain[j].name)) j++;
  const parents = chain.slice(i + 1, i + 4), owner = ownPid ? parents.findIndex((p) => p.pid === ownPid) : -1;
  // a PowerShell between us and the CLI means it is the console bridge's interactive launch shell: a terminal session
  const own = owner >= 0 && !parents.slice(0, owner).some((p) => /^(powershell|pwsh)\.exe$/i.test(p.name));
  return { pid: chain[i].pid, parent: chain[j] || null, own };
}

// a reply into Kiro's input box. A multi-line reply is typed line by line; Kiro's embedded TUI takes Shift+Enter (its
// "new line"), then Enter on its own a moment later submits.
async function send(bridge, pid, text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1) return bridge.send(pid, lines[0]);
  for (let i = 0; i < lines.length; i++) {
    if (i) { const k = await bridge.key(pid, 'ctrlj'); if (!k.ok) return k; }   // Ctrl+J = line feed, as Codex's
    if (lines[i]) { const r = await bridge.type(pid, lines[i]); if (!r.ok) return r; }
  }
  await sleep(Math.min(900, 250 + text.length / 4));
  return bridge.key(pid, 'enter');
}

// a Kiro just started in a new console (remote-control.js launch): it asks whether to trust the folder (starting it
// there from the dashboard is that choice) -- answered yes -- then the first message is typed in. Anything else it
// asks (hooks to review, a trust-all-tools banner) is left for you.
async function greet(bridge, pid, prompt) {
  for (let n = 0; n < 45; n++) {
    await sleep(700);
    const text = await bridge.screen(pid);
    if (text == null) return;                                        // the window is gone
    if (/Do you trust the contents of this (?:directory|project|folder)/i.test(text)) {
      // the trusting choice is the first; move the cursor up if it is parked on "No"
      if (/[›❯]\s*(\d\.\s*)?No/i.test(text)) await bridge.key(pid, 'up');
      await bridge.key(pid, 'enter');
    } else if (/Ask (?:Kiro|anything)|Type your|shift\+tab|›\s/i.test(text)) {
      if (prompt) await send(bridge, pid, prompt);
      return;
    }
  }
}

// the Kiro process of a window we started (launch): what was launched may be kiro-cli itself, or a shim that starts
// it a moment later. Looked for under it for a while; returns its pid, or 0 (window closed / never came up).
async function started(bridge, pid, tries = 40) {
  for (let n = 0; n < tries; n++) {
    const all = await bridge.descendants(pid);
    const c = all.find((p) => /^kiro-cli\.exe$/i.test(p.name)) || all.find((p) => KIRO_EXE.test(p.name));
    if (c) return c.pid;
    if (n > 3 && !all.length && !(await bridge.alive(pid))) return 0;
    await sleep(500);
  }
  return 0;
}

// how to start Kiro here: kiro-cli.exe on PATH (a standalone install), or npm's kiro-cli.cmd through cmd.exe
function command(env) {
  const p = env || process.env;
  const dirs = (p.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) { const f = path.join(d, 'kiro-cli.exe'); if (fs.existsSync(f)) return { exe: f, args: [] }; }
  for (const d of dirs) { const f = path.join(d, 'kiro-cli.cmd'); if (fs.existsSync(f)) return { exe: p.ComSpec || 'cmd.exe', args: ['/d', '/c', f] }; }
  const localApp = p.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const localF = path.join(localApp, 'kiro-cli', 'bin', 'kiro-cli.exe');
  if (fs.existsSync(localF)) return { exe: localF, args: [] };
  return null;
}

// the session's process is gone: its conversation continues without a terminal. Kiro's headless mode takes the prompt
// as an argument and needs a trust flag so a tool approval does not hang. id: the session UUID. Returns the child
// process, or null when Kiro is not found or the id is malformed.
function resume(id, cwd, text) {
  const c = command();
  const rawId = String(id || '').replace(/^kiro:/, '');
  if (!c || !ID.test(rawId)) return null;
  const p = spawn(c.exe, [...c.args, 'chat', '--resume-id', rawId, '--no-interactive', '--trust-all-tools', String(text)],
    { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  p.on('error', () => {});
  return p;
}
// the argv a background resume runs (exposed for tests and the headless service)
function resumeArgs(id, text) {
  const rawId = String(id || '').replace(/^kiro:/, '');
  if (!ID.test(rawId)) return null;
  return ['chat', '--resume-id', rawId, '--no-interactive', '--trust-all-tools', String(text)];
}

module.exports = { KIRO_EXE, findKiro, send, greet, started, command, resume, resumeArgs };
