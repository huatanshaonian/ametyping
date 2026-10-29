'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const EVENTS = [
  'SessionStart',
  'PreInvocation',
  'PreToolUse',
  'PostToolUse',
  'PostInvocation',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
];

function nodeOnPath(node) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && same(path.join(d, path.basename(node)), node));
}

function commandFor(node, script, event = '', onPath = nodeOnPath) {
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  const fwd = (s) => s.replace(/\\/g, '/');
  const nodePart = /\s/.test(node) && onPath(node) ? 'node' : q(fwd(node));
  const scriptPart = q(fwd(script));
  return event ? `${nodePart} ${scriptPart} ${event}` : `${nodePart} ${scriptPart}`;
}

function removeHooks(existing, script = path.join(__dirname, 'agy-hook.js')) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Invalid hooks configuration');
  const out = JSON.parse(JSON.stringify(existing));
  delete out.ametyping;

  const scriptPattern = script ? script.replace(/\\/g, '/') : 'agy-hook.js';
  const isOurs = (c) => typeof c === 'string' && (c.replace(/\\/g, '/').includes(scriptPattern) || /(?:[\\/]|\s)agy-hook\.js(?:\s+[^"'\s]+)?["']?\s*$/.test(c));

  for (const key of Object.keys(out)) {
    const val = out[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const ev of Object.keys(val)) {
        const list = val[ev];
        if (Array.isArray(list)) {
          const kept = list.map((g) => ({
            ...g,
            hooks: (g.hooks || []).filter((h) => !isOurs(h.command) && !isOurs(h.command_windows)),
          })).filter((g) => g.hooks && g.hooks.length);
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
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      group[event] = [{ matcher: '*', hooks: [{ type: 'command', command, timeout: event === 'PreToolUse' ? 120 : 3 }] }];
    } else {
      group[event] = [{ hooks: [{ type: 'command', command, timeout: 3 }] }];
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
  const previous = exists ? fs.readFileSync(filePath, 'utf8') : '{}';
  const cleanPrev = previous.replace(/^\uFEFF/, '').trim();
  const existing = cleanPrev ? JSON.parse(cleanPrev) : {};
  const cfg = remove ? removeHooks(existing, script) : mergeHooks(existing, process.execPath, script);
  const next = JSON.stringify(cfg, null, 2) + '\n';
  if ((!exists && remove) || JSON.stringify(existing) === JSON.stringify(cfg)) {
    console.log(`Already ${remove ? 'removed' : 'installed'}: ${filePath}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (exists) fs.copyFileSync(filePath, filePath + '.ame-backup-' + Date.now());
  fs.writeFileSync(filePath, next);
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
