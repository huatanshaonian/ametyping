'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  nodeOnPath,
  hookCommandFor,
  psCallCommand,
  isOurHookCommand,
  readJsonFile,
  atomicWriteText,
} = require('./remote/agent/hook-installer-common');

const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart',
  'SubagentStop', 'Stop', 'Interrupt', 'SessionEnd',
];

function commandFor(node, script, onPath = nodeOnPath) {
  return hookCommandFor(node, script, '', onPath);
}

function removeHooks(existing, command, script) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Invalid hooks configuration');
  const out = JSON.parse(JSON.stringify(existing));
  if (out.hooks == null) return out;
  if (typeof out.hooks !== 'object' || Array.isArray(out.hooks)) throw new Error('Invalid hooks object');
  for (const event of Object.keys(out.hooks)) {
    const groups = out.hooks[event] || [];
    if (!Array.isArray(groups)) throw new Error(`Invalid ${event} hooks`);
    const ours = (h) => [h.command, h.command_windows].some((c) =>
      isOurHookCommand(c, { scriptPath: script, scriptName: 'codex-hook.js', exactCommand: command })
    );
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
    if (kept.length) out.hooks[event] = kept; else delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

function mergeHooks(existing, command, script, commandWindows) {
  const out = removeHooks(existing, command, script);
  out.hooks ||= {};
  for (const event of EVENTS) {
    out.hooks[event] = [
      ...(out.hooks[event] || []),
      {
        hooks: [{
          type: 'command',
          command,
          ...(commandWindows ? { command_windows: commandWindows } : {}),
          timeout: event === 'PermissionRequest' ? 120 : 3,
        }],
      },
    ];
  }
  return out;
}

function install(target = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'), remove = false) {
  const script = path.join(__dirname, 'codex-hook.js');
  const command = commandFor(process.execPath, script);
  const exists = fs.existsSync(target);
  const existing = exists ? readJsonFile(target).obj : {};
  const commandWindows = process.platform === 'win32' ? psCallCommand(process.execPath, script) : undefined;
  const cfg = remove ? removeHooks(existing, command, script) : mergeHooks(existing, command, script, commandWindows);
  const next = JSON.stringify(cfg, null, 2) + '\n';
  if ((!exists && remove) || JSON.stringify(existing) === JSON.stringify(cfg)) {
    console.log(`Already ${remove ? 'removed' : 'installed'}: ${target}`);
    return;
  }
  atomicWriteText(target, next, { backupExt: `.ame-backup-${Date.now()}` });
  console.log(remove ? `Removed AmeTyping hooks: ${target}` : `Installed: ${target}\nReview and trust the AmeTyping hooks using /hooks in Codex CLI.`);
}

if (require.main === module) {
  const args = process.argv.slice(2), target = args.find((a) => a !== '--remove');
  install(target, args.includes('--remove'));
}

module.exports = { mergeHooks, removeHooks, install, commandFor, EVENTS };
