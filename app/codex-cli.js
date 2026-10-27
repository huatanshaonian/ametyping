// What differs when the session in the terminal is Codex CLI and not Claude Code (remote-control.js, main.js):
// which process it is, how a reply of several lines is typed into it, and how a closed session is continued in the
// background (`codex exec resume`). Windows only, like the console bridge.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// the CLI's own process (an npm install starts it from a node.exe shim; the desktop app is "Codex.exe" as well, told
// apart by what started it: no shell, no terminal)
const CODEX_EXE = /^codex\.exe$/i;
const SHIM = /^node\.exe$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// chain: a process and its ancestors, nearest first ({ pid, name }) -> the Codex process in it, what started that
// (the shim skipped), and whether this app did (a background resume of ours).
// The session's process is the outermost codex.exe: Codex starts more of itself under it (`codex.exe sandbox` around
// a command, an app-server for its node REPL), and a hook run from inside one of those has that short-lived helper
// nearest. Taken for the session, its ending would look like the session's own. (The desktop app's "Codex.exe", with
// a capital, is not one of them: it is what started the session there.)
function findCodex(chain, ownPid) {
  // A CLI launched by our bridge is below our service. Never walk past that boundary and select a Codex host
  // running Ame's test runner (or a parent automation session): its console belongs to a different conversation.
  const boundary = chain.findIndex((p) => p.pid === ownPid);
  const limit = boundary < 0 ? chain.length : boundary;
  let i = -1;
  for (let n = 0; n < limit; n++) {
    const p = chain[n];
    // Once a CLI is found, its shell/terminal is a boundary too. Another Codex above that shell owns a different
    // terminal; selecting it would send this session's reply into that unrelated conversation.
    if (i >= 0 && (/^(powershell|pwsh|cmd|bash|sh|zsh|fish|nu|WindowsTerminal|OpenConsole|conhost)\.exe$/i.test(p.name) || p.name === 'Codex.exe')) break;
    if (p.name === 'codex.exe') i = n;
  }
  if (i < 0) i = chain.slice(0, limit).findIndex((p) => CODEX_EXE.test(p.name));
  if (i < 0) return null;
  let j = i + 1;
  if (chain[j] && SHIM.test(chain[j].name)) j++;
  const parents = chain.slice(i + 1, i + 4), owner = parents.findIndex((p) => p.pid === ownPid);
  // Background resumes are direct children (optionally via npm's node/cmd shims). A PowerShell in between is our
  // console bridge or its interactive launch shell, so it is a terminal session even though we started it.
  const own = owner >= 0 && !parents.slice(0, owner).some((p) => /^(powershell|pwsh)\.exe$/i.test(p.name));
  return { pid: chain[i].pid, parent: chain[j] || null, own };
}

// A reply into Codex's input box. Codex does not take a bracketed paste from the console's input buffer (it shows the
// markers as text and drops the line breaks): lines are typed one by one with Ctrl+J -- its "new line" -- between
// them, then Enter on its own a moment later (inside a fast burst Codex takes Enter for part of a paste).
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

// A Codex just started in a new console (remote-control.js launch): what it asks before it is ready is answered --
// whether to trust the folder (starting it there from the dashboard is that choice) and whether to update now (not
// now) -- then the first message is typed in. Anything else it asks (hooks to review ...) is left for you.
async function greet(bridge, pid, prompt) {
  for (let n = 0; n < 45; n++) {
    await sleep(700);
    const text = await bridge.screen(pid);
    if (text == null) return;                                        // the window is gone
    if (/Do you trust the contents of this directory/.test(text)) {
      if (/›\s*2\.\s*No/.test(text)) await bridge.key(pid, 'up');
      await bridge.key(pid, 'enter');
    } else if (/Update available/.test(text) && /\d\.\s*Skip/.test(text)) {
      if (/›\s*1\./.test(text)) await bridge.key(pid, 'down');
      await sleep(200); await bridge.key(pid, 'enter');
    } else if (/enter confirm|Press enter to continue/i.test(text)) return;
    else if (/›\s+Ask Codex to do anything/.test(text)) { if (prompt) await send(bridge, pid, prompt); return; }
  }
}

// The Codex process of a window we started (launch): what was launched may be Codex itself, or a PowerShell / cmd.exe
// / npm's node.exe that starts it a moment later. Looked for under it for a while; the nearest codex.exe is the
// session's (its helpers are started under it). Returns its pid, or 0: the window closed, or Codex never came up.
async function started(bridge, pid, tries = 40) {
  for (let n = 0; n < tries; n++) {
    const all = await bridge.descendants(pid);
    const c = all.find((p) => p.name === 'codex.exe') || all.find((p) => CODEX_EXE.test(p.name));
    if (c) return c.pid;
    if (n > 3 && !all.length && !(await bridge.alive(pid))) return 0;
    await sleep(500);
  }
  return 0;
}

// how to start Codex here: codex.exe on PATH (a standalone install), or npm's codex.cmd through cmd.exe
function command() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) { const f = path.join(d, 'codex.exe'); if (fs.existsSync(f)) return { exe: f, args: [] }; }
  for (const d of dirs) { const f = path.join(d, 'codex.cmd'); if (fs.existsSync(f)) return { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', f] }; }
  return null;
}

// the session's process is gone: its thread continued without a terminal; the prompt goes in on stdin (never parsed
// as an option). Hooks report its progress like any session's; what it would have asked you is decided by its own
// sandbox and approval settings. id: the thread's UUID. Returns the child process, or null when Codex is not found.
function resume(id, cwd, text) {
  const c = command();
  if (!c || !/^[0-9a-f-]{36}$/.test(String(id))) return null;
  const p = spawn(c.exe, [...c.args, 'exec', 'resume', '--skip-git-repo-check', id, '-'], { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  p.on('error', () => {});
  p.stdin.on('error', () => {});
  p.stdin.end(text);
  return p;
}

module.exports = { CODEX_EXE, findCodex, send, greet, started, command, resume };
