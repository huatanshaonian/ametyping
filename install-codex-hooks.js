'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'];
function mergeHooks(existing, command) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Invalid hooks configuration');
  const out = JSON.parse(JSON.stringify(existing));
  out.hooks ||= {};
  if (typeof out.hooks !== 'object' || Array.isArray(out.hooks)) throw new Error('Invalid hooks object');
  for (const event of EVENTS) {
    const groups = out.hooks[event] || [];
    if (!Array.isArray(groups)) throw new Error(`Invalid ${event} hooks`);
    // Only replace our exact command. Keep all unrelated hooks and settings intact.
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => h.command !== command) })).filter((g) => g.hooks.length);
    kept.push({ hooks: [{ type: 'command', command, timeout: event === 'PermissionRequest' ? 120 : 3 }] });
    out.hooks[event] = kept;
  }
  return out;
}
function install(target = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json')) {
  const command = `"${process.execPath.replace(/\\/g, '/')}" "${path.join(__dirname, 'codex-hook.js').replace(/\\/g, '/')}"`;
  const exists = fs.existsSync(target);
  const previous = exists ? fs.readFileSync(target, 'utf8') : '{}';
  const next = JSON.stringify(mergeHooks(JSON.parse(previous.replace(/^\uFEFF/, '')), command), null, 2) + '\n';
  if (previous === next) { console.log(`Already installed: ${target}`); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (exists) fs.copyFileSync(target, target + '.ame-backup-' + Date.now());
  fs.writeFileSync(target, next);
  console.log(`Installed: ${target}\nReview and trust the AmeTyping hooks using /hooks in Codex CLI.`);
}
if (require.main === module) install(process.argv[2]);
module.exports = { mergeHooks, EVENTS };
