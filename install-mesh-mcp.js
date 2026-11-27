'use strict';
// Registers Windose's MCP servers with every coding agent found on this computer (Claude Code, Antigravity, Codex,
// OpenCode, Kiro), and removes them again with --remove.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonFile, atomicWriteText } = require('./remote/agent/hook-installer-common');

const MESH_SCRIPT = path.join(__dirname, 'tools', 'ame-mesh.js');
const CLIENT_SCRIPT = path.join(__dirname, 'remote', 'mcp', 'client.js');
const NAMES = ['ame-mesh', 'windose-literature', 'windose-research', 'windose-hpc'];

function entriesOf({ script = MESH_SCRIPT, entries = null } = {}) {
  return entries || [{ name: 'ame-mesh', args: [script, 'mcp'] }];
}
function allEntries({ script = MESH_SCRIPT, client = CLIENT_SCRIPT } = {}) {
  return [
    { name: 'ame-mesh', args: [script, 'mcp'] },
    { name: 'windose-literature', args: [client, 'literature'] },
    { name: 'windose-research', args: [client, 'research'] },
    { name: 'windose-hpc', args: [client, 'hpc'] },
  ];
}
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const clone = (o) => (isObj(o) ? JSON.parse(JSON.stringify(o)) : {});

function mergeMap(existingObj, opts, key, shape) {
  const out = clone(existingObj);
  const list = entriesOf(opts);
  if (opts.remove) {
    if (isObj(out[key])) for (const n of opts.entries ? list.map((e) => e.name) : NAMES) delete out[key][n];
  } else {
    out[key] = isObj(out[key]) ? out[key] : {};
    for (const e of list) out[key][e.name] = shape(opts.node || process.execPath, e);
  }
  return out;
}
const mergeClaudeJson = (o, opts = {}) => mergeMap(o, opts, 'mcpServers', (node, e) => ({ type: 'stdio', command: node, args: e.args, env: {} }));
const mergeAgyJson = (o, opts = {}) => mergeMap(o, opts, 'mcpServers', (node, e) => ({ command: node, args: e.args }));
const mergeKiroJson = (o, opts = {}) => mergeMap(o, opts, 'mcpServers', (node, e) => ({ command: node, args: e.args }));
const mergeOpenCodeJson = (o, opts = {}) => mergeMap(o, opts, 'mcp', (node, e) => ({ type: 'local', command: [node, ...e.args], enabled: true }));

function mergeCodexToml(existingText = '', opts = {}) {
  const list = entriesOf(opts), node = opts.node || process.execPath;
  const ours = new Set(opts.remove && !opts.entries ? NAMES : [...NAMES, ...list.map((e) => e.name)]);
  const lines = String(existingText || '').split(/\r?\n/);
  const outLines = [];
  let inSection = false;
  for (const line of lines) {
    const m = /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([\w-]+))\]\s*$/.exec(line);
    if (m && ours.has(m[1] || m[2] || m[3])) { inSection = true; continue; }
    if (inSection) {
      if (/^\s*\[.+\]\s*$/.test(line)) { inSection = false; outLines.push(line); }
      continue;
    }
    outLines.push(line);
  }
  const cleaned = outLines.join('\n').trimEnd();
  if (opts.remove) return cleaned ? cleaned + '\n' : '';
  const blocks = list.map((e) => `[mcp_servers.${e.name}]\ncommand = ${JSON.stringify(node)}\nargs = [${e.args.map((a) => JSON.stringify(a)).join(', ')}]`).join('\n\n');
  return cleaned ? `${cleaned}\n\n${blocks}\n` : `${blocks}\n`;
}

function targets(home = os.homedir()) {
  const agyDir = process.env.AGY_CONFIG_DIR || path.join(home, '.gemini', 'config');
  const codexDir = process.env.CODEX_HOME || path.join(home, '.codex');
  const openCodeDir = process.env.OPENCODE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  const kiroBase = process.env.KIRO_HOME || path.join(home, '.kiro');
  return [
    { id: 'claude', label: 'Claude Code', file: path.join(home, '.claude.json'), present: (f) => fs.existsSync(f) || fs.existsSync(path.join(home, '.claude')), kind: 'json', key: 'mcpServers', merge: mergeClaudeJson },
    { id: 'agy', label: 'Antigravity', file: path.join(agyDir, 'mcp_config.json'), present: () => !!process.env.AGY_CONFIG_DIR || fs.existsSync(path.join(home, '.gemini')), kind: 'json', key: 'mcpServers', merge: mergeAgyJson },
    { id: 'codex', label: 'Codex', file: path.join(codexDir, 'config.toml'), present: (f) => fs.existsSync(f) || fs.existsSync(codexDir), kind: 'toml', merge: mergeCodexToml },
    { id: 'opencode', label: 'OpenCode', file: path.join(openCodeDir, 'opencode.json'), present: (f) => fs.existsSync(f) || fs.existsSync(openCodeDir), kind: 'json', key: 'mcp', merge: mergeOpenCodeJson },
    { id: 'kiro', label: 'Kiro', file: path.join(kiroBase, 'settings', 'mcp.json'), present: () => !!process.env.KIRO_HOME || fs.existsSync(kiroBase), kind: 'json', key: 'mcpServers', merge: mergeKiroJson },
  ];
}

function installOne(t, opts) {
  if (!t.present(t.file)) return 'skipped';
  const exists = fs.existsSync(t.file);
  if (!exists && opts.remove) return 'unchanged';
  let raw = '', next;
  if (t.kind === 'toml') {
    raw = exists ? fs.readFileSync(t.file, 'utf8') : '';
    next = t.merge(raw, opts);
  } else {
    let obj = {};
    if (exists) {
      try { ({ raw, obj } = readJsonFile(t.file)); } catch { return 'skipped'; }
    }
    next = JSON.stringify(t.merge(obj, opts), null, 2) + '\n';
  }
  if (exists && raw === next) return 'unchanged';
  atomicWriteText(t.file, next, { backupExt: '.ame-backup-mcp', backupOnce: true });
  return 'updated';
}

function installKiro({ home = os.homedir(), node = process.execPath, script = MESH_SCRIPT, remove = false, entries = null } = {}) {
  const t = targets(home).find((x) => x.id === 'kiro');
  if (!t.present(t.file)) return { status: 'skipped', path: t.file };
  if (fs.existsSync(t.file)) {
    try { readJsonFile(t.file); } catch { return { status: 'skipped', path: t.file, error: 'json_parse_error' }; }
  }
  return { status: installOne(t, { node, script, remove, entries }), path: t.file };
}

function installAll({ home = os.homedir(), node = process.execPath, script = MESH_SCRIPT, client = CLIENT_SCRIPT, entries = null, remove = false, quiet = false } = {}) {
  const updated = [], unchanged = [], skipped = [];
  const opts = { node, script, remove, entries: entries || allEntries({ script, client }) };
  if (remove && !entries) opts.entries = null;
  let kiro = null;
  for (const t of targets(home)) {
    const s = installOne(t, opts);
    (s === 'updated' ? updated : s === 'unchanged' ? unchanged : skipped).push(t.id);
    if (t.id === 'kiro') kiro = { status: s, path: t.file };
  }
  if (!quiet) {
    if (updated.length) console.log(`[ame-mcp] updated: ${updated.join(', ')}`);
    if (unchanged.length) console.log(`[ame-mcp] unchanged: ${unchanged.join(', ')}`);
    if (skipped.length) console.log(`[ame-mcp] skipped: ${skipped.join(', ')}`);
  }
  return { updated, unchanged, skipped, kiro };
}

function status({ home = os.homedir() } = {}) {
  return targets(home).map((t) => {
    const present = t.present(t.file), out = { id: t.id, label: t.label, present, file: t.file, servers: [] };
    if (!present || !fs.existsSync(t.file)) return out;
    try {
      if (t.kind === 'toml') {
        const text = fs.readFileSync(t.file, 'utf8');
        out.servers = NAMES.filter((n) => new RegExp(`^\\s*\\[mcp_servers\\.(?:"${n}"|'${n}'|${n})\\]\\s*$`, 'm').test(text));
      } else {
        const { obj } = readJsonFile(t.file);
        out.servers = NAMES.filter((n) => isObj(obj[t.key]) && obj[t.key][n]);
      }
    } catch { out.error = '配置文件读不了（可能带注释），没有改动'; }
    return out;
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    for (const s of status()) console.log(`${s.label.padEnd(12)} ${!s.present ? '（没装）' : s.error ? s.error : s.servers.length ? s.servers.join(', ') : '（还没登记）'}  ${s.present ? s.file : ''}`);
  } else installAll({ remove: args.includes('--remove') });
}

module.exports = { mergeClaudeJson, mergeAgyJson, mergeCodexToml, mergeOpenCodeJson, mergeKiroJson, installKiro, installAll, status, allEntries, NAMES, CLIENT_SCRIPT, MESH_SCRIPT };
