#!/usr/bin/env node
'use strict';
// Installs the AmeTyping hooks into a Kiro CLI agent configuration (~/.kiro/agents/<name>.json by default).
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

const TRIGGERS = ['agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop'];
const SCRIPT = path.join(__dirname, 'kiro-hook.js');

function commandFor(node = process.execPath, script = SCRIPT, onPath = nodeOnPath) {
  return hookCommandFor(node, script, '', onPath);
}

function isOurs(command, script = SCRIPT, ourCommand) {
  return isOurHookCommand(command, { scriptPath: script, scriptName: 'kiro-hook.js', exactCommand: ourCommand });
}

// ---- object format: hooks is { trigger: [ { command, matcher?, timeout_ms? } ] } ----
function removeObject(hooks, ourCommand) {
  const out = {};
  for (const [trigger, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) { out[trigger] = arr; continue; }
    const kept = arr.filter((h) => !(h && typeof h === 'object' && isOurs(h.command, SCRIPT, ourCommand)));
    if (kept.length) out[trigger] = kept;
  }
  return out;
}
function mergeObject(hooks, ourCommand) {
  const out = removeObject(hooks || {}, ourCommand);
  for (const trigger of TRIGGERS) {
    const entry = { command: ourCommand };
    if (trigger === 'preToolUse' || trigger === 'postToolUse') entry.matcher = '*';
    out[trigger] = [...(out[trigger] || []), entry];
  }
  return out;
}

// ---- array format: hooks is [ { name?, trigger, matcher?, action: { type, command }, timeout? } ] ----
const arrCommand = (h) => (h && h.action && typeof h.action === 'object' ? h.action.command : h && h.command);
function removeArray(hooks, ourCommand) {
  return hooks.filter((h) => !(h && typeof h === 'object' && isOurs(arrCommand(h), SCRIPT, ourCommand)));
}
function mergeArray(hooks, ourCommand) {
  const out = removeArray(Array.isArray(hooks) ? hooks : [], ourCommand);
  for (const trigger of TRIGGERS) {
    const entry = { name: 'ametyping-' + trigger, trigger, action: { type: 'command', command: ourCommand } };
    if (trigger === 'preToolUse' || trigger === 'postToolUse') entry.matcher = '*';
    out.push(entry);
  }
  return out;
}

function apply(cfg, remove, ourCommand) {
  const out = JSON.parse(JSON.stringify(cfg || {}));
  const existing = out.hooks;
  if (Array.isArray(existing)) {
    const next = remove ? removeArray(existing, ourCommand) : mergeArray(existing, ourCommand);
    if (next.length) out.hooks = next; else delete out.hooks;
  } else {
    const next = remove
      ? removeObject(existing && typeof existing === 'object' ? existing : {}, ourCommand)
      : mergeObject(existing && typeof existing === 'object' ? existing : {}, ourCommand);
    if (Object.keys(next).length) out.hooks = next; else delete out.hooks;
  }
  return out;
}

function defaultTarget() {
  const home = process.env.KIRO_HOME || path.join(os.homedir(), '.kiro');
  return path.join(home, 'agents', 'default.json');
}

function resolveTarget(arg) {
  if (!arg) return defaultTarget();
  if (arg.endsWith('.json') || arg.includes('/') || arg.includes('\\')) return path.resolve(arg);
  const home = process.env.KIRO_HOME || path.join(os.homedir(), '.kiro');
  return path.join(home, 'agents', arg + '.json');
}

function install(target = defaultTarget(), remove = false, node = process.execPath) {
  const ourCommand = commandFor(node, SCRIPT);
  const exists = fs.existsSync(target);
  let cfg;
  if (exists) {
    try { cfg = readJsonFile(target, { allowEmpty: false }).obj; }
    catch (e) { throw new Error(`${target} 不是合法 JSON，拒绝覆盖：${e.message}`); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${target} 不是 agent 配置对象`);
  } else {
    if (remove) { console.log(`Already removed: ${target}`); return { changed: false }; }
    cfg = { name: path.basename(target).replace(/\.json$/i, '') };
  }
  const next = apply(cfg, remove, ourCommand);
  const nextText = JSON.stringify(next, null, 2) + '\n';
  if (exists && JSON.stringify(cfg) === JSON.stringify(next)) {
    console.log(`Already ${remove ? 'removed' : 'installed'}: ${target}`);
    return { changed: false };
  }
  atomicWriteText(target, nextText, { backupExt: `.ame-backup-${Date.now()}` });
  console.log(remove
    ? `Removed AmeTyping hooks: ${target}`
    : `Installed AmeTyping hooks: ${target}\n用 /hooks 在 Kiro CLI 中查看，或重开会话让 agentSpawn 生效。`);
  return { changed: true, target };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const remove = args.includes('--remove');
  const target = resolveTarget(args.find((a) => a !== '--remove'));
  try { install(target, remove); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { commandFor, isOurs, apply, mergeObject, removeObject, mergeArray, removeArray, install, resolveTarget, defaultTarget, TRIGGERS };
