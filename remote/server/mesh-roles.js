// AmeMesh External Hot-Reload Role Library: built-in templates overlaid by <dataDir>/mesh-roles/*.md
'use strict';
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./lib/json-store');

const ROLE_NAME_RE = /^[a-z0-9_-]{1,32}$/i;
const BUILTIN_ORDER = ['master', 'worker', 'verifier', 'peer'];

function parseFrontmatter(rawText, fallbackName) {
  const normalized = String(rawText || '').replace(/\r\n/g, '\n');
  const meta = {};
  let body = normalized.trim();

  if (normalized.startsWith('---\n') || normalized.startsWith('---\r\n')) {
    const closeIdx = normalized.indexOf('\n---', 3);
    if (closeIdx !== -1) {
      const fmBlock = normalized.slice(4, closeIdx);
      const after = normalized.slice(closeIdx + 4);
      body = after.replace(/^\s*\n/, '').trim();
      for (const line of fmBlock.split('\n')) {
        const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1];
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        meta[key] = val;
      }
    }
  }

  const name = (meta.name && ROLE_NAME_RE.test(meta.name) ? meta.name : fallbackName) || 'worker';
  const summary = String(meta.summary || '').trim();
  const defaultPool = String(meta.defaultPool || 'fast-coder').trim() || 'fast-coder';
  const workspaceMode = meta.workspaceMode === 'worktree' ? 'worktree' : 'inherit';
  const readOnly = String(meta.readOnly || '').toLowerCase() === 'true';

  return {
    name,
    summary,
    defaultPool,
    workspaceMode,
    readOnly,
    body,
    raw: normalized,
  };
}

function readMdDir(dirPath) {
  const map = new Map();
  if (!dirPath) return map;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const stem = ent.name.slice(0, -3);
    if (!ROLE_NAME_RE.test(stem)) continue;
    try {
      const raw = fs.readFileSync(path.join(dirPath, ent.name), 'utf8');
      const parsed = parseFrontmatter(raw, stem);
      // Key by file stem so override <name>.md always overlays builtin <name>.md cleanly
      map.set(stem.toLowerCase(), { ...parsed, key: stem });
    } catch {}
  }
  return map;
}

function createRoleStore({ dataDir, builtinDir = path.join(__dirname, 'mesh-roles') }) {
  const userDir = path.join(dataDir, 'mesh-roles');

  function loadAll() {
    const builtins = readMdDir(builtinDir);
    const overrides = readMdDir(userDir);
    const allKeys = new Set([...builtins.keys(), ...overrides.keys()]);
    const roles = [];

    for (const k of allKeys) {
      const b = builtins.get(k);
      const u = overrides.get(k);
      const active = u || b;
      roles.push({
        name: active.key || active.name,
        summary: active.summary,
        defaultPool: active.defaultPool,
        workspaceMode: active.workspaceMode,
        readOnly: active.readOnly,
        builtin: !!b,
        overridden: !!(b && u),
        body: active.body,
        raw: active.raw,
      });
    }

    roles.sort((a, b) => {
      const ia = BUILTIN_ORDER.indexOf(a.name);
      const ib = BUILTIN_ORDER.indexOf(b.name);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.name.localeCompare(b.name);
    });

    return roles;
  }

  function list() {
    return loadAll();
  }

  function get(name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return null;
    return loadAll().find((r) => r.name.toLowerCase() === target) || null;
  }

  function save(name, rawContent) {
    const cleanName = String(name || '').trim();
    if (!ROLE_NAME_RE.test(cleanName)) {
      return { ok: false, msg: '角色名不合法，仅支持 1~32 位字母、数字、下划线或连字符' };
    }
    if (typeof rawContent !== 'string' || !rawContent.trim()) {
      return { ok: false, msg: '角色模板内容不能为空' };
    }
    if (rawContent.length > 65536) {
      return { ok: false, msg: '角色模板内容过长（上限 64KB）' };
    }
    try {
      const targetFile = path.join(userDir, `${cleanName}.md`);
      writeFileAtomic(targetFile, rawContent.replace(/\r\n/g, '\n'), { encoding: 'utf8', mode: 0o600, mkdirMode: 0o700 });
      return { ok: true, role: get(cleanName) };
    } catch (e) {
      return { ok: false, msg: `保存角色模板失败：${e.message}` };
    }
  }

  function reset(name) {
    const cleanName = String(name || '').trim();
    if (!ROLE_NAME_RE.test(cleanName)) {
      return { ok: false, msg: '角色名不合法' };
    }
    const targetFile = path.join(userDir, `${cleanName}.md`);
    try {
      if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
      return { ok: true, role: get(cleanName) };
    } catch (e) {
      return { ok: false, msg: `重置角色模板失败：${e.message}` };
    }
  }

  function catalog() {
    return loadAll().map((r) => {
      const flags = [`pool=${r.defaultPool}`, `ws=${r.workspaceMode}`];
      if (r.readOnly) flags.push('readOnly=true');
      return `${r.name} (${flags.join(', ')}): ${r.summary || '自定义协同角色'}`;
    });
  }

  return {
    list,
    get,
    save,
    reset,
    catalog,
  };
}

module.exports = {
  createRoleStore,
};
