#!/usr/bin/env node
// Fast static verification gate for AmeTyping (working tree or a specific git ref):
//   node remote/test/check-static.js [--ref <commit>]
// 1. Parses every backend CJS/MJS file (remote/server, agent, deploy, mcp) and classic public script (login.js, sw.js)
//    via V8's real parser (vm.Script / vm.SourceTextModule).
// 2. Parses and V8-links EVERY frontend ES module under remote/public/js/**/*.js, catching:
//    - Syntax errors (e.g. stray ')' that node --check misses without --input-type=module)
//    - Missing import targets (broken relative paths)
//    - Missing named/default exports (import { foo } from './bar.js' when bar.js doesn't export foo)
// 3. Checks namespace imports (import * as ns from './bar.js') so ns.missingProp() is also caught statically.
'use strict';

const cp = require('child_process');
const vm = require('vm');

// Re-exec ourselves once with --experimental-vm-modules so callers just run `node remote/test/check-static.js`.
if (typeof vm.SourceTextModule !== 'function') {
  const r = cp.spawnSync(
    process.execPath,
    ['--experimental-vm-modules', '--no-warnings', __filename, ...process.argv.slice(2)],
    { stdio: 'inherit' }
  );
  process.exit(r.status === null ? 1 : r.status);
}

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const refIdx = argv.indexOf('--ref');
const REF = refIdx >= 0 && argv[refIdx + 1] ? argv[refIdx + 1] : null;

const CJS_ROOTS = ['remote/server', 'remote/agent', 'remote/deploy', 'remote/mcp'];
const CLASSIC_PUBLIC = ['remote/public/login.js', 'remote/public/sw.js'];
const ESM_ROOT = 'remote/public/js';

function loadFilesFromFs() {
  const files = new Map();
  function walk(rel) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isFile()) {
      files.set(rel.replace(/\\/g, '/'), fs.readFileSync(abs, 'utf8'));
      return;
    }
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'data' || e.name === '.git') continue;
      const child = rel + '/' + e.name;
      if (e.isDirectory()) walk(child);
      else if (/\.[cm]?js$/.test(e.name)) {
        files.set(child.replace(/\\/g, '/'), fs.readFileSync(path.join(REPO, child), 'utf8'));
      }
    }
  }
  for (const r of [...CJS_ROOTS, 'remote/public']) walk(r);
  return files;
}

function loadFilesFromGit(ref) {
  const listOut = cp.execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', ref, '--', ...CJS_ROOTS, 'remote/public'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const paths = listOut.split('\n').map((s) => s.trim()).filter((p) => p && /\.[cm]?js$/.test(p));
  const files = new Map();
  if (!paths.length) return files;

  // Read all blobs in a single `git cat-file --batch` call for speed.
  const input = paths.map((p) => `${ref}:${p}`).join('\n') + '\n';
  const buf = cp.execFileSync('git', ['cat-file', '--batch'], {
    cwd: REPO,
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  let off = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, off);
    const header = buf.slice(off, nl).toString('utf8');
    off = nl + 1;
    const parts = header.split(' ');
    const size = parseInt(parts[2], 10);
    if (Number.isNaN(size)) continue;
    files.set(p, buf.slice(off, off + size).toString('utf8'));
    off += size + 1; // trailing LF
  }
  return files;
}

function stripCommentsAndStrings(src) {
  // Replace comments and string/template literals with spaces so regex scans for exports/namespace accesses
  // don't trip on commented-out code or string contents.
  return src.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (m) => (m.startsWith('//') || m.startsWith('/*') ? m.replace(/[^\n]/g, ' ') : '""')
  );
}

function resolveImport(fromFile, spec) {
  if (/^(https?:|data:|blob:)/.test(spec)) return null;
  const clean = spec.split(/[?#]/)[0];
  if (clean.startsWith('/')) return path.posix.normalize('remote/public' + clean);
  if (clean.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
  return null;
}

function collectDirectExports(src) {
  const clean = stripCommentsAndStrings(src);
  const names = new Set();
  const starFrom = [];
  const reexportFrom = [];

  for (const m of clean.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of clean.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  // Destructured exports: export const { a, b: c } = ...
  for (const m of clean.matchAll(/\bexport\s+(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().split('=')[0].trim();
      const alias = seg.includes(':') ? seg.split(':')[1].trim() : seg;
      if (/^[A-Za-z_$][\w$]*$/.test(alias)) names.add(alias);
    }
  }
  if (/\bexport\s+default\b/.test(clean)) names.add('default');

  // export { a, b as c } [from '...']  (use original src to keep the from specifier string)
  const noComments = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of noComments.matchAll(/\bexport\s*\{([^}]+)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    for (const item of m[1].split(',')) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
      names.add(asMatch ? asMatch[2] : trimmed);
    }
    if (m[2]) reexportFrom.push(m[2]);
  }
  for (const m of noComments.matchAll(/\bexport\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) names.add(m[1]);
    else starFrom.push(m[2]);
  }
  return { names, starFrom, reexportFrom };
}

function getAllExports(file, files, cache, visiting = new Set()) {
  if (cache.has(file)) return cache.get(file);
  if (visiting.has(file)) return new Set();
  visiting.add(file);
  const src = files.get(file);
  if (src == null) return new Set();
  const { names, starFrom } = collectDirectExports(src);
  for (const spec of starFrom) {
    const target = resolveImport(file, spec);
    if (target && files.has(target)) {
      for (const n of getAllExports(target, files, cache, visiting)) {
        if (n !== 'default') names.add(n);
      }
    }
  }
  cache.set(file, names);
  return names;
}

function checkNamespaceImports(file, src, files, exportCache, errors) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  const clean = stripCommentsAndStrings(src);
  const nsImports = [];
  for (const m of noComments.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g)) {
    nsImports.push({ alias: m[1], spec: m[2] });
  }
  for (const { alias, spec } of nsImports) {
    const target = resolveImport(file, spec);
    if (!target || !files.has(target)) continue; // already reported by linker
    if (target.startsWith('remote/public/vendor/')) continue;
    const exports = getAllExports(target, files, exportCache);
    const re = new RegExp(`(?<![.\\w$])${alias}\\.([A-Za-z_$][\\w$]*)`, 'g');
    const reported = new Set();
    for (const m of clean.matchAll(re)) {
      const prop = m[1];
      if (exports.has(prop) || reported.has(prop)) continue;
      reported.add(prop);
      const line = clean.slice(0, m.index).split('\n').length;
      errors.push(`${file}:${line}: ${alias}.${prop} 未在 ${target} 中导出（可用导出：${[...exports].slice(0, 12).join(', ') || '无'}）`);
    }
  }
}

async function main() {
  const t0 = Date.now();
  const files = REF ? loadFilesFromGit(REF) : loadFilesFromFs();
  const errors = [];

  let cjsCount = 0;
  let esmCount = 0;
  const esmFiles = [];

  for (const [file, src] of files) {
    const isBackend = CJS_ROOTS.some((r) => file.startsWith(r + '/'));
    const isClassicPublic = CLASSIC_PUBLIC.includes(file);
    const isPublicJs = file.startsWith(ESM_ROOT + '/');

    if (isBackend) {
      if (file.endsWith('.mjs')) {
        esmCount++;
        try {
          new vm.SourceTextModule(src, { identifier: file });
        } catch (e) {
          errors.push(`${file}: ${e.message}`);
        }
      } else {
        cjsCount++;
        try {
          // Strip optional shebang before vm.Script
          const body = src.startsWith('#!') ? '//' + src.slice(2) : src;
          new vm.Script(body, { filename: file });
        } catch (e) {
          errors.push(`${file}: ${e.message}`);
        }
      }
    } else if (isClassicPublic) {
      cjsCount++;
      try {
        new vm.Script(src, { filename: file });
      } catch (e) {
        errors.push(`${file}: ${e.message}`);
      }
    } else if (isPublicJs) {
      esmFiles.push(file);
    }
  }

  // Parse all frontend ESM modules via V8 SourceTextModule
  const context = vm.createContext({});
  const modCache = new Map();
  function getModule(file) {
    if (modCache.has(file)) return modCache.get(file);
    const src = files.get(file);
    if (src == null) return null;
    try {
      const mod = new vm.SourceTextModule(src, { identifier: file, context });
      modCache.set(file, mod);
      return mod;
    } catch (e) {
      modCache.set(file, null);
      errors.push(`${file}: ${e.message}`);
      return null;
    }
  }

  for (const file of esmFiles) {
    esmCount++;
    getModule(file);
  }

  // Link every parsed frontend ESM module so V8 natively validates all import paths & named/default exports
  const missingSpecs = new Set();
  for (const file of esmFiles) {
    const mod = modCache.get(file);
    if (!mod || mod.status !== 'unlinked') continue;
    try {
      await mod.link(async (specifier, referencingModule) => {
        const refFile = referencingModule.identifier;
        const target = resolveImport(refFile, specifier);
        if (!target) {
          // External URL or bare specifier: stub empty synthetic module
          return new vm.SyntheticModule([], () => {}, { context, identifier: specifier });
        }
        if (!files.has(target)) {
          const key = `${refFile} -> ${specifier}`;
          if (!missingSpecs.has(key)) {
            missingSpecs.add(key);
            errors.push(`${refFile}: 找不到导入文件 '${specifier}'（解析为 ${target}）`);
          }
          throw new Error(`Missing module ${target}`);
        }
        const dep = getModule(target);
        if (!dep) throw new Error(`Syntax error in ${target}`);
        return dep;
      });
    } catch (e) {
      // Ignore cascading errors we already recorded (missing module / syntax error in dependency)
      if (!/^(Missing module |Syntax error in )/.test(e.message)) {
        errors.push(`${file}: ESM 链接失败 — ${e.message}`);
      }
    }
  }

  // Static namespace-import property check (catches `import * as mesh ...; mesh.nonExistent()`)
  const exportCache = new Map();
  for (const file of esmFiles) {
    checkNamespaceImports(file, files.get(file), files, exportCache, errors);
  }

  const ms = Date.now() - t0;
  if (errors.length) {
    console.error(`FAIL check-static (${REF || 'working-tree'}): ${errors.length} 个问题（耗时 ${ms}ms）`);
    for (const err of errors) console.error('  ✗ ' + err);
    process.exit(1);
  }
  console.log(`PASS check-static (${REF || 'working-tree'}): ${cjsCount} CJS + ${esmCount} ESM 全量语法与导入导出校验通过（${ms}ms）`);
}

main().catch((e) => {
  console.error('FAIL check-static:', e);
  process.exit(1);
});
