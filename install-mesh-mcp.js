'use strict';
// Registers Windose's MCP servers with every coding agent found on this computer (Claude Code, Antigravity, Codex,
// OpenCode, Kiro), and removes them again with --remove. Run by the agent when it starts (remote/agent/agent.js), by the
// deploy, or by hand:  node install-mesh-mcp.js [--remove] [--status]
//   ame-mesh            tools/ame-mesh.js mcp              协同：拓扑、派活、汇报、后台作业
//   windose-literature  remote/mcp/client.js literature    文献：按 DOI 下载（共用图书馆通道队列）
//   windose-research    remote/mcp/client.js research      研究档案：只读查询
// All three talk only to this computer's agent (127.0.0.1:3941, its token in ~/.ametyping), which passes them on over
// its own connection to the dashboard server: nothing here needs SSH or any key of its own. Other entries in the
// agents' configs are left as they are; the first change to a file keeps a copy beside it (.ame-backup-mcp).
const fs = require('fs');
const os = require('os');
const path = require('path');

const MESH_SCRIPT = path.join(__dirname, 'tools', 'ame-mesh.js');
const CLIENT_SCRIPT = path.join(__dirname, 'remote', 'mcp', 'client.js');
const NAMES = ['ame-mesh', 'windose-literature', 'windose-research', 'windose-hpc'];

// the entries to write: [{ name, args }] (command is node); only ame-mesh unless asked (the older callers)
function entriesOf({ script = MESH_SCRIPT, client = CLIENT_SCRIPT, entries = null } = {}) {
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

// one JSON config with a map of servers under `key`; shape(entry) is that agent's form of one
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

// Codex's TOML: our [mcp_servers.<name>] sections taken out, then written again at the end
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

function safeAtomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backupFile = filePath + '.ame-backup-mcp';
  if (fs.existsSync(filePath) && !fs.existsSync(backupFile)) { try { fs.copyFileSync(filePath, backupFile); } catch {} }
  const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, content, 'utf8');
  fs.renameSync(tmpFile, filePath);
}
const readJson = (file) => { const raw = fs.readFileSync(file, 'utf8'); const clean = raw.replace(/^\uFEFF/, '').trim(); return { raw, obj: clean ? JSON.parse(clean) : {} }; };

// where each agent keeps its MCP servers, and whether it is there at all
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

// one agent: -> 'updated' | 'unchanged' | 'skipped'
function installOne(t, opts) {
  if (!t.present(t.file)) return 'skipped';
  const exists = fs.existsSync(t.file);
  if (!exists && opts.remove) return 'unchanged';
  let raw = '', next;
  if (t.kind === 'toml') { raw = exists ? fs.readFileSync(t.file, 'utf8') : ''; next = t.merge(raw, opts); }
  else {
    let obj = {};
    if (exists) { try { ({ raw, obj } = readJson(t.file)); } catch { return 'skipped'; } }        // (JSONC and the like: left alone)
    next = JSON.stringify(t.merge(obj, opts), null, 2) + '\n';
  }
  if (exists && raw === next) return 'unchanged';
  safeAtomicWrite(t.file, next);
  return 'updated';
}

function installKiro({ home = os.homedir(), node = process.execPath, script = MESH_SCRIPT, remove = false, entries = null } = {}) {
  const t = targets(home).find((x) => x.id === 'kiro');
  if (!t.present(t.file)) return { status: 'skipped', path: t.file };
  if (fs.existsSync(t.file)) { try { readJson(t.file); } catch { return { status: 'skipped', path: t.file, error: 'json_parse_error' }; } }
  return { status: installOne(t, { node, script, remove, entries }), path: t.file };
}

// installAll(): every agent found, the three servers (entries: just these; script / client: other paths)
function installAll({ home = os.homedir(), node = process.execPath, script = MESH_SCRIPT, client = CLIENT_SCRIPT, entries = null, remove = false, quiet = false } = {}) {
  const updated = [], unchanged = [], skipped = [];
  const opts = { node, script, remove, entries: entries || allEntries({ script, client }) };
  if (remove && !entries) opts.entries = null;                                   // (removing: every name of ours)
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

// what is registered where (for the dashboard's 控制面板 › MCP): [{ id, label, present, file, servers: [names], error }]
function status({ home = os.homedir() } = {}) {
  return targets(home).map((t) => {
    const present = t.present(t.file), out = { id: t.id, label: t.label, present, file: t.file, servers: [] };
    if (!present || !fs.existsSync(t.file)) return out;
    try {
      if (t.kind === 'toml') {
        const text = fs.readFileSync(t.file, 'utf8');
        out.servers = NAMES.filter((n) => new RegExp(`^\\s*\\[mcp_servers\\.(?:"${n}"|'${n}'|${n})\\]\\s*$`, 'm').test(text));
      } else { const { obj } = readJson(t.file); out.servers = NAMES.filter((n) => isObj(obj[t.key]) && obj[t.key][n]); }
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
