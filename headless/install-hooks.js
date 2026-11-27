#!/usr/bin/env node
// Adds (or with --remove, takes out) the AmeTyping hooks in ~/.claude/settings.json on this machine:
// hook-relay.js on the progress events, permission-hook.js on PermissionRequest. Other hooks and settings are
// left alone; the previous file is kept as settings.json.bak-<time>. Running it twice changes nothing.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fwdSlash, readJsonFile, atomicWriteText } = require('../remote/agent/hook-installer-common');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const FILE = path.join(CLAUDE_DIR, 'settings.json');
const ROOT = path.resolve(__dirname, '..');
const NODE = fwdSlash(process.execPath);
const RELAY = fwdSlash(path.join(ROOT, 'hook-relay.js'));
const PERM = fwdSlash(path.join(ROOT, 'permission-hook.js'));
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const MARK = /[\\/](hook-relay|permission-hook)\.js"?$/;

const RELAY_EVENTS = {
  SessionStart: false, UserPromptSubmit: false, PreToolUse: true, PostToolUse: true,
  PostToolUseFailure: true, Notification: false, Stop: false, SessionEnd: false,
};

const remove = process.argv.includes('--remove');
const exists = fs.existsSync(FILE);
const existing = exists ? readJsonFile(FILE).obj : {};
const cfg = JSON.parse(JSON.stringify(existing));
const hooks = cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) ? cfg.hooks : {};

for (const ev of Object.keys(hooks)) {
  hooks[ev] = (hooks[ev] || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !MARK.test(String(h.command || ''))) }))
    .filter((g) => g.hooks.length);
  if (!hooks[ev].length) delete hooks[ev];
}
if (!remove) {
  for (const [ev, star] of Object.entries(RELAY_EVENTS)) {
    (hooks[ev] = hooks[ev] || []).push({
      ...(star ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: `${q(NODE)} ${q(RELAY)}`, timeout: 5, async: true }],
    });
  }
  (hooks.PermissionRequest = hooks.PermissionRequest || []).push({
    matcher: '*',
    hooks: [{ type: 'command', command: `${q(NODE)} ${q(PERM)}`, timeout: 3660 }],
  });
}
if (Object.keys(hooks).length) cfg.hooks = hooks; else delete cfg.hooks;

if ((!exists && remove) || JSON.stringify(existing) === JSON.stringify(cfg)) {
  console.log(`Already ${remove ? 'removed' : 'installed'}: ${FILE}`);
} else {
  const next = JSON.stringify(cfg, null, 2) + '\n';
  atomicWriteText(FILE, next, { backupExt: `.bak-${new Date().toISOString().replace(/[:.]/g, '-')}` });
  console.log(remove ? `已从 ${FILE} 移除 AmeTyping hook` : `已写入 ${FILE}：${Object.keys(RELAY_EVENTS).length + 1} 个事件 → ${RELAY} / ${PERM}`);
}
