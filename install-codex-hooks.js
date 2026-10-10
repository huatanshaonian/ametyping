'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'];
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
function mergeHooks(existing, command, script) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Invalid hooks configuration');
  const out = JSON.parse(JSON.stringify(existing));
  out.hooks ||= {};
  if (typeof out.hooks !== 'object' || Array.isArray(out.hooks)) throw new Error('Invalid hooks object');
  for (const event of EVENTS) {
    const groups = out.hooks[event] || [];
    if (!Array.isArray(groups)) throw new Error(`Invalid ${event} hooks`);
    // Only replace our own command. Keep all unrelated hooks and settings intact.
    const ours = (h) => h.command === command || (!!script && String(h.command || '').includes(script));
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
    kept.push({ hooks: [{ type: 'command', command, timeout: event === 'PermissionRequest' ? 120 : 3 }] });
    out.hooks[event] = kept;
  }
  return out;
}
function install(target = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json')) {
  const script = path.join(__dirname, 'codex-hook.js');
  const command = commandFor(process.execPath, script);
  const exists = fs.existsSync(target);
  const previous = exists ? fs.readFileSync(target, 'utf8') : '{}';
  const next = JSON.stringify(mergeHooks(JSON.parse(previous.replace(/^\uFEFF/, '')), command, script.replace(/\\/g, '/')), null, 2) + '\n';
  if (previous === next) { console.log(`Already installed: ${target}`); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (exists) fs.copyFileSync(target, target + '.ame-backup-' + Date.now());
  fs.writeFileSync(target, next);
  console.log(`Installed: ${target}\nReview and trust the AmeTyping hooks using /hooks in Codex CLI.`);
}
if (require.main === module) install(process.argv[2]);
module.exports = { mergeHooks, commandFor, EVENTS };
