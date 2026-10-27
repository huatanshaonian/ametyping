'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'SessionEnd'];
// The hook's command line. Codex runs it through the shell -- PowerShell on Windows, where a command that begins with
// a quoted path ("C:/Program Files/nodejs/node.exe" ...) is not a call but an error (exit 1, "Hook failed"). So no
// quotes where there is no space, and a Node whose path has one is called by its name when PATH leads to it.
function commandFor(node, script, onPath = nodeOnPath) {
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  const fwd = (s) => s.replace(/\\/g, '/');
  return `${/\s/.test(node) && onPath(node) ? 'node' : q(fwd(node))} ${q(fwd(script))}`;
}
function nodeOnPath(node) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && same(path.join(d, path.basename(node)), node));
}
// script: the hook's path; a command naming it is ours too, however an earlier install wrote it
function removeHooks(existing, command, script) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Invalid hooks configuration');
  const out = JSON.parse(JSON.stringify(existing));
  if (out.hooks == null) return out;
  if (typeof out.hooks !== 'object' || Array.isArray(out.hooks)) throw new Error('Invalid hooks object');
  for (const event of Object.keys(out.hooks)) {
    const groups = out.hooks[event] || [];
    if (!Array.isArray(groups)) throw new Error(`Invalid ${event} hooks`);
    // Only replace our own command. Keep all unrelated hooks and settings intact.
    const ours = (h) => [h.command, h.command_windows].some((c) => typeof c === 'string' &&
      ((command && c === command) || (script && c.replace(/\\/g, '/').includes(script.replace(/\\/g, '/'))) || /(?:[\\/]|\s)codex-hook\.js["']?\s*$/.test(c)));
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
    if (kept.length) out.hooks[event] = kept; else delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}
function mergeHooks(existing, command, script, commandWindows) {
  const out = removeHooks(existing, command, script);
  out.hooks ||= {};
  for (const event of EVENTS) out.hooks[event] = [...(out.hooks[event] || []), { hooks: [{ type: 'command', command,
    ...(commandWindows ? { command_windows: commandWindows } : {}), timeout: event === 'PermissionRequest' ? 120 : 3 }] }];
  return out;
}
function install(target = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'), remove = false) {
  const script = path.join(__dirname, 'codex-hook.js');
  const command = commandFor(process.execPath, script);
  const exists = fs.existsSync(target);
  const previous = exists ? fs.readFileSync(target, 'utf8') : '{}';
  const existing = JSON.parse(previous.replace(/^\uFEFF/, ''));
  // Codex uses PowerShell on Windows. The call operator also handles a Node installation outside PATH.
  const psq = (s) => "'" + s.replace(/'/g, "''") + "'";
  const commandWindows = process.platform === 'win32' ? `& ${psq(process.execPath)} ${psq(script)}` : undefined;
  const cfg = remove ? removeHooks(existing, command, script) : mergeHooks(existing, command, script, commandWindows);
  const next = JSON.stringify(cfg, null, 2) + '\n';
  if ((!exists && remove) || JSON.stringify(existing) === JSON.stringify(cfg)) { console.log(`Already ${remove ? 'removed' : 'installed'}: ${target}`); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (exists) fs.copyFileSync(target, target + '.ame-backup-' + Date.now());
  fs.writeFileSync(target, next);
  console.log(remove ? `Removed AmeTyping hooks: ${target}` : `Installed: ${target}\nReview and trust the AmeTyping hooks using /hooks in Codex CLI.`);
}
if (require.main === module) {
  const args = process.argv.slice(2), target = args.find((a) => a !== '--remove');
  install(target, args.includes('--remove'));
}
module.exports = { mergeHooks, removeHooks, install, commandFor, EVENTS };
