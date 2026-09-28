#!/usr/bin/env node
// Adds (or with --remove, takes out) the AmeTyping hooks in ~/.claude/settings.json on this machine:
// hook-relay.js on the progress events, permission-hook.js on PermissionRequest. Other hooks and settings are
// left alone; the previous file is kept as settings.json.bak-<time>. Running it twice changes nothing.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude', 'settings.json');
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;                                     // absolute: hooks do not depend on the shell's PATH (nvm)
const RELAY = path.join(ROOT, 'hook-relay.js');
const PERM = path.join(ROOT, 'permission-hook.js');
const q = (s) => `"${s}"`;
const MARK = /[\\/](hook-relay|permission-hook)\.js"?$/;           // how our own entries are recognised

const RELAY_EVENTS = { SessionStart: false, UserPromptSubmit: false, PreToolUse: true, PostToolUse: true,
  PostToolUseFailure: true, Notification: false, Stop: false, SessionEnd: false };   // true = needs a "*" matcher

const remove = process.argv.includes('--remove');
let cfg = {};
if (fs.existsSync(FILE)) cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};

// drop our previous entries everywhere (so paths / node version can change), keep everybody else's
for (const ev of Object.keys(hooks)) {
  hooks[ev] = (hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !MARK.test(String(h.command || ''))) }))
    .filter((g) => g.hooks.length);
  if (!hooks[ev].length) delete hooks[ev];
}
if (!remove) {
  for (const [ev, star] of Object.entries(RELAY_EVENTS)) {
    (hooks[ev] = hooks[ev] || []).push({ ...(star ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: `${q(NODE)} ${q(RELAY)}`, timeout: 5, async: true }] });
  }
  // not async: the decision is this hook's output; timeout above permission-hook.js's own 110 s wait
  (hooks.PermissionRequest = hooks.PermissionRequest || []).push({ matcher: '*',
    hooks: [{ type: 'command', command: `${q(NODE)} ${q(PERM)}`, timeout: 120 }] });
}
if (Object.keys(hooks).length) cfg.hooks = hooks; else delete cfg.hooks;

if (fs.existsSync(FILE)) fs.copyFileSync(FILE, `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n');
console.log(remove ? `已从 ${FILE} 移除 AmeTyping hook` : `已写入 ${FILE}：${Object.keys(RELAY_EVENTS).length + 1} 个事件 → ${RELAY} / ${PERM}`);
