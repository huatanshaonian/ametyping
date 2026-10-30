#!/usr/bin/env node
'use strict';
// Installs the AmeTyping hooks into a Kiro CLI agent configuration (~/.kiro/agents/<name>.json by default).
// Unlike Codex (a standalone hooks.json), Kiro keeps hooks inside the agent config, in one of two shapes:
//   - object format: { "hooks": { "agentSpawn": [ { "command": "..." } ], "preToolUse": [ { "matcher": "*", ... } ] } }
//   - array  format: { "hooks": [ { "name": "...", "trigger": "agentSpawn", "action": { "type": "command", "command": "..." } } ] }
// We read whichever the file already uses (object by default for a new file) and write it back in the same shape, so a
// hand-maintained array-format file stays an array. Only our own hooks are added or removed; everything else is kept.
//
//   node install-kiro-hooks.js                     -> ~/.kiro/agents/default.json (or $KIRO_HOME/agents/default.json)
//   node install-kiro-hooks.js my-agent            -> ~/.kiro/agents/my-agent.json
//   node install-kiro-hooks.js /abs/path/agent.json
//   node install-kiro-hooks.js --remove [target]
const fs = require('fs');
const path = require('path');
const os = require('os');

// the five triggers Kiro offers; matchers only make sense for pre/postToolUse
const TRIGGERS = ['agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop'];
const SCRIPT = path.join(__dirname, 'kiro-hook.js');

// the command line a hook runs: `node <path>` with forward slashes (Kiro runs it through the shell); quoted only when
// a path has a space, and when node itself has one and is on PATH, call it by name.
function commandFor(node = process.execPath, script = SCRIPT, onPath = nodeOnPath) {
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  const fwd = (s) => s.replace(/\\/g, '/');
  return `${/\s/.test(node) && onPath(node) ? 'node' : q(fwd(node))} ${q(fwd(script))}`;
}
function nodeOnPath(node) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && same(path.join(d, path.basename(node)), node));
}
// is this one of ours? our exact command, or any command naming kiro-hook.js (an earlier install, a moved node)
function isOurs(command, script = SCRIPT, ourCommand) {
  if (typeof command !== 'string') return false;
  const c = command.replace(/\\/g, '/');
  return (ourCommand && command === ourCommand) || c.includes(script.replace(/\\/g, '/')) || /(?:[\\/]|\s)kiro-hook\.js["']?(?:\s|$)/.test(c);
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

// cfg: the whole agent config; returns a new config with our hooks added or removed, preserving its hooks shape
function apply(cfg, remove, ourCommand) {
  const out = JSON.parse(JSON.stringify(cfg || {}));
  const existing = out.hooks;
  const isArray = Array.isArray(existing);
  if (isArray) {
    const next = remove ? removeArray(existing, ourCommand) : mergeArray(existing, ourCommand);
    if (next.length) out.hooks = next; else delete out.hooks;
  } else {
    const next = remove ? removeObject(existing && typeof existing === 'object' ? existing : {}, ourCommand)
      : mergeObject(existing && typeof existing === 'object' ? existing : {}, ourCommand);
    if (Object.keys(next).length) out.hooks = next; else delete out.hooks;
  }
  return out;
}

function defaultTarget() {
  const home = process.env.KIRO_HOME || path.join(os.homedir(), '.kiro');
  return path.join(home, 'agents', 'default.json');
}
// a bare name -> ~/.kiro/agents/<name>.json; a path (has a separator or .json) -> as given
function resolveTarget(arg) {
  if (!arg) return defaultTarget();
  if (arg.endsWith('.json') || arg.includes('/') || arg.includes('\\')) return path.resolve(arg);
  const home = process.env.KIRO_HOME || path.join(os.homedir(), '.kiro');
  return path.join(home, 'agents', arg + '.json');
}

function install(target = defaultTarget(), remove = false, node = process.execPath) {
  const ourCommand = commandFor(node, SCRIPT);
  const exists = fs.existsSync(target);
  const previous = exists ? fs.readFileSync(target, 'utf8') : '';
  let cfg;
  if (exists) {
    try { cfg = JSON.parse(previous.replace(/^\uFEFF/, '')); }
    catch (e) { throw new Error(`${target} 不是合法 JSON，拒绝覆盖：${e.message}`); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${target} 不是 agent 配置对象`);
  } else {
    if (remove) { console.log(`Already removed: ${target}`); return { changed: false }; }
    cfg = { name: path.basename(target).replace(/\.json$/i, '') };
  }
  const next = apply(cfg, remove, ourCommand);
  const nextText = JSON.stringify(next, null, 2) + '\n';
  if (exists && JSON.stringify(JSON.parse(previous.replace(/^\uFEFF/, ''))) === JSON.stringify(next)) {
    console.log(`Already ${remove ? 'removed' : 'installed'}: ${target}`); return { changed: false };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (exists) fs.copyFileSync(target, target + '.ame-backup-' + Date.now());
  fs.writeFileSync(target, nextText);
  console.log(remove ? `Removed AmeTyping hooks: ${target}`
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
