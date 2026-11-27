'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  nodeOnPath,
  hookCommandFor,
  isOurHookCommand,
  readJsonFile,
  atomicWriteText,
} = require('./remote/agent/hook-installer-common');

const EVENTS = [
  'SessionStart',
  'PreInvocation',
  'PreToolUse',
  'PostToolUse',
  'PostInvocation',
  'Stop',
];
const GROUPED_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

function commandFor(node, script, event = '', onPath = nodeOnPath) {
  return hookCommandFor(node, script, event, onPath);
}

function removeHooks(existing, script = path.join(__dirname, 'agy-hook.js')) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Invalid hooks configuration');
  const out = JSON.parse(JSON.stringify(existing));
  delete out.ametyping;

  const isOurs = (c) => isOurHookCommand(c, { scriptPath: script, scriptName: 'agy-hook.js', allowTrailingArg: true });

  for (const key of Object.keys(out)) {
    const val = out[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const ev of Object.keys(val)) {
        const list = val[ev];
        if (Array.isArray(list)) {
          const kept = [];
          for (const g of list) {
            if (g && Array.isArray(g.hooks)) {
              const hs = g.hooks.filter((h) => !isOurs(h.command) && !isOurs(h.command_windows));
              if (hs.length) kept.push({ ...g, hooks: hs });
            } else if (g && typeof g === 'object') {
              if (!isOurs(g.command) && !isOurs(g.command_windows)) kept.push(g);
            }
          }
          if (kept.length) val[ev] = kept;
          else delete val[ev];
        }
      }
      if (!Object.keys(val).length && key === 'hooks') delete out[key];
    }
  }
  return out;
}

function mergeHooks(existing, node = process.execPath, script = path.join(__dirname, 'agy-hook.js'), onPath = nodeOnPath) {
  const out = removeHooks(existing, script);
  const group = {};
  for (const event of EVENTS) {
    const command = commandFor(node, script, event, onPath);
    if (GROUPED_EVENTS.has(event)) {
      // Only intercept ask_question on PreToolUse so normal tools keep AGY's native permissions and can never be fail-closed denied.
      const matcher = event === 'PreToolUse' ? 'ask_question|AskUserQuestion' : '*';
      group[event] = [{ matcher, hooks: [{ type: 'command', command, timeout: event === 'PreToolUse' ? 120 : 3 }] }];
    } else {
      // AGY hooks.json requires flat handler arrays for non-tool events (SessionStart/PreInvocation/PostInvocation/Stop)
      group[event] = [{ type: 'command', command, timeout: 3 }];
    }
  }
  out.ametyping = group;
  return out;
}

function defaultTarget() {
  const configDir = process.env.AGY_CONFIG_DIR || path.join(os.homedir(), '.gemini', 'config');
  return path.join(configDir, 'hooks.json');
}

function resolveTarget(target = defaultTarget()) {
  if (!target) return defaultTarget();
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      return path.join(target, 'hooks.json');
    }
  } catch {}
  if (!target.toLowerCase().endsWith('.json')) {
    return path.join(target, 'hooks.json');
  }
  return target;
}

function install(target = defaultTarget(), remove = false) {
  const filePath = resolveTarget(target);
  const script = path.join(__dirname, 'agy-hook.js');
  const exists = fs.existsSync(filePath);
  const existing = exists ? readJsonFile(filePath).obj : {};
  const cfg = remove ? removeHooks(existing, script) : mergeHooks(existing, process.execPath, script);
  const next = JSON.stringify(cfg, null, 2) + '\n';
  if ((!exists && remove) || JSON.stringify(existing) === JSON.stringify(cfg)) {
    console.log(`Already ${remove ? 'removed' : 'installed'}: ${filePath}`);
    return;
  }
  atomicWriteText(filePath, next, { backupExt: `.ame-backup-${Date.now()}` });
  console.log(remove ? `Removed AmeTyping hooks: ${filePath}` : `Installed: ${filePath}`);
}

function uninstall(target = defaultTarget()) {
  return install(target, true);
}

if (require.main === module) {
  const args = process.argv.slice(2), target = args.find((a) => a !== '--remove');
  install(target, args.includes('--remove'));
}

module.exports = { mergeHooks, removeHooks, install, uninstall, commandFor, EVENTS };
