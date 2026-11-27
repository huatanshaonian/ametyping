#!/usr/bin/env node
// Deterministic whole-repo static AST/token audit for AmeTyping overhaul:
//   node tools/audit-codebase.js [--out <path>] [--shared <path>] [--no-shared]
// Scans production JS/MJS/CJS/CSS/HTML (excluding node_modules, vendor, remote/test, *.test.js)
// and outputs:
//   1. Cross-file duplicate/similar function clusters + 5 targeted duplication patterns (incl. atomic renameSync writes)
//   2. CJS module.exports & ESM export symbol reference counts (highlighting 0-prod-ref dead/zombie exports)
//   3. Oversized files (>500 lines) & oversized functions (>80 lines) hotspots
//   4. Hardcoded #hex color audit across remote/public/css/*.css and app/bubble.html
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(REPO, 'docs', 'overhaul', '00-codebase-audit.md');
const DEFAULT_SHARED = 'D:/ametyping-refactor/docs/overhaul/shots-baseline/00-codebase-audit.md';

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const getOpt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const OUT_PATH = path.resolve(REPO, getOpt('--out', DEFAULT_OUT));
const SHARED_PATH = getOpt('--shared', DEFAULT_SHARED);
const NO_SHARED = hasFlag('--no-shared');

const EXCLUDE_DIRS = new Set([
  '.git',
  '.ame-worktrees',
  'node_modules',
  'vendor',
  'data',
  'out',
  'dist',
  'release',
  'docs',
  'skills',
]);

const JS_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false',
  'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
  'with', 'yield',
]);

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof',
  'in', 'of', 'new', 'yield', 'await', 'else', 'do',
]);

const CONTROL_PARENS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

const PRESERVED_GLOBALS = new Set([
  'fs', 'path', 'os', 'cp', 'child_process', 'crypto', 'http', 'https', 'net',
  'tls', 'url', 'util', 'zlib', 'stream', 'events', 'readline', 'vm', 'assert',
  'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise',
  'Buffer', 'Error', 'TypeError', 'RangeError', 'RegExp', 'Set', 'Map', 'WeakMap',
  'WeakSet', 'Date', 'Symbol', 'BigInt', 'Intl', 'Reflect', 'Proxy',
  'process', 'console', 'require', 'module', 'exports', '__dirname', '__filename',
  'window', 'document', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'fetch', 'URL', 'URLSearchParams', 'FormData', 'Blob',
  'AbortController', 'WebSocket', 'EventSource', 'CustomEvent', 'MutationObserver',
  'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'ipcMain', 'ipcRenderer', 'contextBridge', 'BrowserWindow', 'app', 'shell', 'clipboard',
]);

function classifyDomain(rel) {
  if (rel.startsWith('remote/server/') || rel.startsWith('remote/mcp/')) return 'Server';
  if (rel.startsWith('remote/public/')) return 'Web';
  if (rel.startsWith('remote/agent/') || rel.startsWith('headless/') || rel.startsWith('remote/deploy/')) return 'Agent/Headless';
  if (rel.startsWith('app/')) return 'Pet(app)';
  if (/^(?:install-|.*hook.*\.js$|opencode-plugin\/)/.test(rel)) return 'Hooks/Installers';
  if (rel.startsWith('tools/')) return 'Tools';
  return 'Other';
}

function isTestFile(rel) {
  return (
    rel.startsWith('remote/test/') ||
    /\.test\.[cm]?js$/.test(rel)
  );
}

function walkRepo() {
  const prodJs = [];
  const testJs = [];
  const cssFiles = [];
  const htmlFiles = [];

  function walk(relDir) {
    const absDir = relDir ? path.join(REPO, relDir) : REPO;
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        if (rel === 'remote/public/vendor') continue;
        walk(rel);
      } else if (e.isFile()) {
        if (rel === 'tools/audit-codebase.js') continue;
        if (/\.[cm]?js$/.test(e.name)) {
          if (isTestFile(rel)) testJs.push(rel);
          else prodJs.push(rel);
        } else if (e.name.endsWith('.css')) {
          cssFiles.push(rel);
        } else if (e.name.endsWith('.html')) {
          htmlFiles.push(rel);
        }
      }
    }
  }
  walk('');
  return { prodJs, testJs, cssFiles, htmlFiles };
}

function canStartRegex(prevTok) {
  if (!prevTok) return true;
  if (prevTok.type === 'punct') {
    return prevTok.value !== ')' && prevTok.value !== ']' && prevTok.value !== '}' &&
      prevTok.value !== '++' && prevTok.value !== '--';
  }
  if (prevTok.type === 'id') {
    return REGEX_PRECEDING_KEYWORDS.has(prevTok.value);
  }
  return false;
}

function tokenizeJs(src) {
  const tokens = [];
  const len = src.length;
  let i = 0;
  let line = 1;
  // Stack of brace depths for nested `${ ... }` inside template literals
  const tplBraceStack = [];
  let braceDepth = 0;

  if (src.startsWith('#!')) {
    while (i < len && src[i] !== '\n') i++;
  }

  function scanTemplateContinuation(startIdx, startLine) {
    let val = '';
    while (i < len) {
      const ch = src[i];
      if (ch === '\\') {
        val += src.slice(i, i + 2);
        if (src[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (ch === '`') {
        i++;
        tokens.push({ type: 'str', value: '`' + val + '`', line: startLine });
        return;
      }
      if (ch === '$' && src[i + 1] === '{') {
        i += 2;
        tokens.push({ type: 'str', value: '`' + val + '${', line: startLine });
        tokens.push({ type: 'punct', value: '${', line });
        tplBraceStack.push(braceDepth);
        braceDepth++;
        return;
      }
      if (ch === '\n') line++;
      val += ch;
      i++;
    }
    tokens.push({ type: 'str', value: '`' + val, line: startLine });
  }

  while (i < len) {
    const ch = src[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    // Line comment
    if (ch === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < len && src[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    // String literal
    if (ch === '\'' || ch === '"') {
      const quote = ch;
      const startLine = line;
      let val = quote;
      i++;
      while (i < len) {
        const c = src[i];
        if (c === '\\') {
          val += src.slice(i, i + 2);
          if (src[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        val += c;
        i++;
        if (c === '\n') line++;
        if (c === quote) break;
      }
      tokens.push({ type: 'str', value: val, line: startLine });
      continue;
    }

    // Template literal start
    if (ch === '`') {
      const startLine = line;
      i++;
      scanTemplateContinuation(i, startLine);
      continue;
    }

    // Closing brace inside template expression `${ ... }`
    if (ch === '}' && tplBraceStack.length > 0 && braceDepth - 1 === tplBraceStack[tplBraceStack.length - 1]) {
      braceDepth--;
      tplBraceStack.pop();
      tokens.push({ type: 'punct', value: '}', line });
      const startLine = line;
      i++;
      scanTemplateContinuation(i, startLine);
      continue;
    }

    // Regex literal vs division operator
    if (ch === '/') {
      const prev = tokens[tokens.length - 1];
      if (canStartRegex(prev)) {
        const startLine = line;
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < len) {
          const c = src[j];
          if (c === '\n' || c === '\r') break;
          if (c === '\\') {
            j += 2;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) {
            j++;
            while (j < len && /[a-zA-Z]/.test(src[j])) j++;
            ok = true;
            break;
          }
          j++;
        }
        if (ok) {
          tokens.push({ type: 'regex', value: src.slice(i, j), line: startLine });
          i = j;
          continue;
        }
      }
    }

    // Identifier or keyword (including private #field)
    if (/[A-Za-z_$]/.test(ch) || (ch === '#' && /[A-Za-z_$]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < len && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const prev = tokens[tokens.length - 1];
      const isProp = Boolean(prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.'));
      tokens.push({ type: isProp ? 'prop' : 'id', value: word, line });
      i = j;
      continue;
    }

    // Numeric literal
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < len && /[0-9a-fA-FxXoObBeE._]/.test(src[j])) j++;
      tokens.push({ type: 'num', value: src.slice(i, j), line });
      i = j;
      continue;
    }

    // Multi-char punctuators
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (['===', '!==', '...', '>>>', '**=', '&&=', '||=', '??='].includes(three)) {
      tokens.push({ type: 'punct', value: three, line });
      i += 3;
      continue;
    }
    if (['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>'].includes(two)) {
      tokens.push({ type: 'punct', value: two, line });
      i += 2;
      continue;
    }

    if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    tokens.push({ type: 'punct', value: ch, line });
    i++;
  }

  return tokens;
}

function pairDelimiters(tokens) {
  const bracePair = new Map();
  const parenPair = new Map();
  const parenRev = new Map();
  const bStack = [];
  const pStack = [];

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.type !== 'punct') continue;
    if (t.value === '{') bStack.push(idx);
    else if (t.value === '}') {
      const open = bStack.pop();
      if (open !== undefined) bracePair.set(open, idx);
    } else if (t.value === '(') pStack.push(idx);
    else if (t.value === ')') {
      const open = pStack.pop();
      if (open !== undefined) {
        parenPair.set(open, idx);
        parenRev.set(idx, open);
      }
    }
  }
  return { bracePair, parenPair, parenRev };
}

function inferAssignedName(tokens, beforeIdx) {
  let k = beforeIdx;
  while (k >= 0 && tokens[k].type === 'id' && (tokens[k].value === 'async' || tokens[k].value === 'static' || tokens[k].value === 'get' || tokens[k].value === 'set')) {
    k--;
  }
  if (k >= 1 && tokens[k].type === 'punct' && (tokens[k].value === '=' || tokens[k].value === ':')) {
    const lhs = tokens[k - 1];
    if (lhs && (lhs.type === 'id' || lhs.type === 'prop')) {
      if (k >= 3 && tokens[k - 2].value === '.' && (tokens[k - 3].value === 'exports' || tokens[k - 3].value === 'this')) {
        return lhs.value;
      }
      return lhs.value;
    }
  }
  // Callback context label e.g. ipcMain.handle('foo', async (...) => {})
  for (let s = beforeIdx; s >= Math.max(0, beforeIdx - 8); s--) {
    if (tokens[s].type === 'str' && s >= 2 && tokens[s - 1].value === '(' && (tokens[s - 2].type === 'prop' || tokens[s - 2].type === 'id')) {
      const cleanStr = tokens[s].value.slice(1, -1).slice(0, 28);
      return `<${tokens[s - 2].value}:${cleanStr}>`;
    }
  }
  return '<anonymous>';
}

function extractFunctions(file, tokens, pairs) {
  const { bracePair, parenPair, parenRev } = pairs;
  const funcs = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Expression-bodied arrow function: `const foo = (s) => expr` (no `{` after `=>`)
    if (t.type === 'punct' && t.value === '=>' && tokens[i + 1] && tokens[i + 1].value !== '{') {
      let paramStart = i - 1;
      if (paramStart >= 0 && tokens[paramStart].value === ')') {
        const openP = parenRev.get(paramStart);
        if (openP !== undefined) paramStart = openP;
      }
      const name = inferAssignedName(tokens, paramStart - 1);
      if (name !== '<anonymous>') {
        let endIdx = i + 1;
        let depth = 0;
        while (endIdx < tokens.length) {
          const v = tokens[endIdx].value;
          if (v === '(' || v === '[' || v === '{') depth++;
          else if (v === ')' || v === ']' || v === '}') {
            if (depth === 0) break;
            depth--;
          } else if (depth === 0 && (v === ';' || v === ',')) {
            break;
          }
          endIdx++;
        }
        const bodySlice = tokens.slice(i + 1, endIdx);
        if (bodySlice.length >= 4) {
          const startLine = tokens[Math.max(0, paramStart)].line;
          const endLine = tokens[Math.max(i + 1, endIdx - 1)].line;
          funcs.push({
            file,
            name,
            kind: 'arrow-expr',
            startLine,
            endLine,
            lines: endLine - startLine + 1,
            paramTokens: tokens.slice(paramStart, i),
            bodyTokens: bodySlice,
          });
        }
      }
      continue;
    }

    if (t.type !== 'punct' || t.value !== '{') continue;
    const closeIdx = bracePair.get(i);
    if (closeIdx === undefined) continue;

    const prev = tokens[i - 1];
    if (!prev) continue;

    // Case 1: Arrow function `... => { ... }`
    if (prev.type === 'punct' && prev.value === '=>') {
      let paramStart = i - 2;
      if (paramStart >= 0 && tokens[paramStart].value === ')') {
        const openP = parenRev.get(paramStart);
        if (openP !== undefined) paramStart = openP;
      }
      const name = inferAssignedName(tokens, paramStart - 1);
      const startLine = tokens[Math.max(0, paramStart)].line;
      const endLine = tokens[closeIdx].line;
      funcs.push({
        file,
        name,
        kind: 'arrow',
        startLine,
        endLine,
        lines: endLine - startLine + 1,
        paramTokens: tokens.slice(paramStart, i - 1),
        bodyTokens: tokens.slice(i + 1, closeIdx),
      });
      continue;
    }

    // Case 2: `(...) { ... }`
    if (prev.type === 'punct' && prev.value === ')') {
      const openP = parenRev.get(i - 1);
      if (openP === undefined) continue;
      const beforeParen = tokens[openP - 1];
      if (!beforeParen) continue;

      // Skip control-flow blocks: if/for/while/switch/catch/with and `for await (...)`
      if (beforeParen.type === 'id' && CONTROL_PARENS.has(beforeParen.value)) continue;
      if (beforeParen.type === 'id' && beforeParen.value === 'await' && tokens[openP - 2]?.value === 'for') continue;

      let name = '<anonymous>';
      let headIdx = openP;

      if (beforeParen.type === 'id' && beforeParen.value === 'function') {
        headIdx = openP - 1;
        name = inferAssignedName(tokens, openP - 2);
      } else if (beforeParen.value === '*' && tokens[openP - 2]?.value === 'function') {
        headIdx = openP - 2;
        name = inferAssignedName(tokens, openP - 3);
      } else if (beforeParen.type === 'id' || beforeParen.type === 'prop') {
        name = beforeParen.value;
        headIdx = openP - 1;
        if (tokens[headIdx - 1]?.value === '*') headIdx--;
        if (tokens[headIdx - 1]?.value === 'function') headIdx--;
      } else {
        continue;
      }

      if (tokens[headIdx - 1]?.value === 'async') headIdx--;

      const startLine = tokens[headIdx].line;
      const endLine = tokens[closeIdx].line;
      funcs.push({
        file,
        name,
        kind: 'function',
        startLine,
        endLine,
        lines: endLine - startLine + 1,
        paramTokens: tokens.slice(openP, i),
        bodyTokens: tokens.slice(i + 1, closeIdx),
      });
    }
  }
  return funcs;
}

function fingerprintFunction(fn, mode) {
  const idMap = new Map();
  let nextId = 0;
  const parts = [];
  const stream = [...fn.paramTokens, { type: 'punct', value: '=>' }, ...fn.bodyTokens];

  for (const t of stream) {
    if (t.type === 'punct') {
      parts.push(t.value);
    } else if (t.type === 'prop') {
      parts.push('.' + t.value);
    } else if (t.type === 'id') {
      if (JS_KEYWORDS.has(t.value) || PRESERVED_GLOBALS.has(t.value)) {
        parts.push(t.value);
      } else {
        let mapped = idMap.get(t.value);
        if (!mapped) {
          mapped = '$' + (nextId++);
          idMap.set(t.value, mapped);
        }
        parts.push(mapped);
      }
    } else if (t.type === 'num') {
      parts.push(mode === 'strict' ? t.value : '$NUM');
    } else if (t.type === 'str') {
      if (mode === 'strict' && t.value.length <= 20) parts.push(t.value);
      else parts.push('$STR');
    } else if (t.type === 'regex') {
      parts.push(mode === 'strict' ? t.value : '$RE');
    }
  }
  const repr = parts.join(' ');
  return {
    hash: crypto.createHash('sha1').update(repr).digest('hex').slice(0, 12),
    tokenCount: fn.bodyTokens.length,
    reprSample: repr.slice(0, 100),
  };
}

function collectExportsForFile(file, src, tokens, pairs) {
  const isEsm = file.startsWith('remote/public/js/') || file.endsWith('.mjs') || file.startsWith('opencode-plugin/');
  const exported = new Map(); // symbol -> line

  if (isEsm) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'id' || t.value !== 'export') continue;
      const n1 = tokens[i + 1];
      if (!n1) continue;
      if (n1.value === 'default') {
        exported.set('default', t.line);
        continue;
      }
      if (n1.value === 'async' && (tokens[i + 2]?.value === 'function')) {
        const fnName = tokens[i + 3]?.value === '*' ? tokens[i + 4] : tokens[i + 3];
        if (fnName?.type === 'id') exported.set(fnName.value, fnName.line);
        continue;
      }
      if (n1.value === 'function' || n1.value === 'class') {
        const fnName = tokens[i + 2]?.value === '*' ? tokens[i + 3] : tokens[i + 2];
        if (fnName?.type === 'id') exported.set(fnName.value, fnName.line);
        continue;
      }
      if (n1.value === 'const' || n1.value === 'let' || n1.value === 'var') {
        const vName = tokens[i + 2];
        if (vName?.type === 'id') exported.set(vName.value, vName.line);
        else if (vName?.value === '{') {
          const close = pairs.bracePair.get(i + 2);
          if (close !== undefined) {
            let depth = 0;
            for (let k = i + 3; k < close; k++) {
              if (tokens[k].value === '{') depth++;
              else if (tokens[k].value === '}') depth--;
              else if (depth === 0 && tokens[k].type === 'id') {
                if (tokens[k + 1]?.value === ':') continue;
                exported.set(tokens[k].value, tokens[k].line);
              }
            }
          }
        }
        continue;
      }
      if (n1.value === '{') {
        const close = pairs.bracePair.get(i + 1);
        if (close !== undefined) {
          let k = i + 2;
          while (k < close) {
            if (tokens[k].type === 'id' || tokens[k].type === 'prop') {
              if (tokens[k + 1]?.value === 'as' && tokens[k + 2]) {
                exported.set(tokens[k + 2].value, tokens[k + 2].line);
                k += 3;
                continue;
              }
              exported.set(tokens[k].value, tokens[k].line);
            }
            k++;
          }
        }
      }
    }
    return { kind: 'ESM', exported };
  }

  // CommonJS exports
  for (let i = 0; i < tokens.length; i++) {
    // module.exports = { ... } or module.exports.foo = ...
    const isModExports =
      tokens[i].type === 'id' &&
      tokens[i].value === 'module' &&
      tokens[i + 1]?.value === '.' &&
      tokens[i + 2]?.value === 'exports';

    if (isModExports) {
      if (tokens[i + 3]?.value === '.' && tokens[i + 4]?.type === 'prop' && tokens[i + 5]?.value === '=') {
        exported.set(tokens[i + 4].value, tokens[i + 4].line);
        continue;
      }
      if (tokens[i + 3]?.value === '=' && tokens[i + 4]?.value === '{') {
        const close = pairs.bracePair.get(i + 4);
        if (close !== undefined) {
          extractTopLevelObjectKeys(tokens, i + 4, close, pairs, exported);
        }
      }
      continue;
    }

    // exports.foo = ...
    if (
      tokens[i].type === 'id' &&
      tokens[i].value === 'exports' &&
      tokens[i - 1]?.value !== '.' &&
      tokens[i + 1]?.value === '.' &&
      tokens[i + 2]?.type === 'prop' &&
      tokens[i + 3]?.value === '='
    ) {
      exported.set(tokens[i + 2].value, tokens[i + 2].line);
    }
  }

  return { kind: 'CJS', exported };
}

function extractTopLevelObjectKeys(tokens, openBraceIdx, closeBraceIdx, pairs, outMap) {
  let k = openBraceIdx + 1;
  while (k < closeBraceIdx) {
    const t = tokens[k];
    if (t.value === ',') {
      k++;
      continue;
    }
    if (t.value === '...') {
      // Skip spread expression at top level until next top-level comma
      k++;
      while (k < closeBraceIdx && tokens[k].value !== ',') {
        if (tokens[k].value === '{' && pairs.bracePair.has(k)) k = pairs.bracePair.get(k) + 1;
        else if (tokens[k].value === '(' && pairs.parenPair.has(k)) k = pairs.parenPair.get(k) + 1;
        else k++;
      }
      continue;
    }
    if (t.value === 'async' || t.value === 'get' || t.value === 'set') {
      if (tokens[k + 1] && (tokens[k + 1].type === 'id' || tokens[k + 1].type === 'prop') && tokens[k + 2]?.value === '(') {
        outMap.set(tokens[k + 1].value, tokens[k + 1].line);
        k = (pairs.parenPair.get(k + 2) || k + 2) + 1;
        if (tokens[k]?.value === '{' && pairs.bracePair.has(k)) k = pairs.bracePair.get(k) + 1;
        continue;
      }
    }
    if (t.type === 'id' || t.type === 'prop') {
      const next = tokens[k + 1];
      if (!next || next.value === ',' || next.value === '}') {
        outMap.set(t.value, t.line);
        k++;
        continue;
      }
      if (next.value === ':') {
        outMap.set(t.value, t.line);
        k += 2;
        while (k < closeBraceIdx && tokens[k].value !== ',') {
          if (tokens[k].value === '{' && pairs.bracePair.has(k)) k = pairs.bracePair.get(k) + 1;
          else if (tokens[k].value === '(' && pairs.parenPair.has(k)) k = pairs.parenPair.get(k) + 1;
          else k++;
        }
        continue;
      }
      if (next.value === '(') {
        outMap.set(t.value, t.line);
        k = (pairs.parenPair.get(k + 1) || k + 1) + 1;
        if (tokens[k]?.value === '{' && pairs.bracePair.has(k)) k = pairs.bracePair.get(k) + 1;
        continue;
      }
    }
    // Skip nested blocks safely
    if (t.value === '{' && pairs.bracePair.has(k)) k = pairs.bracePair.get(k) + 1;
    else if (t.value === '(' && pairs.parenPair.has(k)) k = pairs.parenPair.get(k) + 1;
    else k++;
  }
}

function collectIdentifiersSet(tokens) {
  const counts = new Map();
  for (const t of tokens) {
    if (t.type === 'id' || t.type === 'prop') {
      counts.set(t.value, (counts.get(t.value) || 0) + 1);
    }
  }
  return counts;
}

function extractInlineHtmlScripts(htmlSrc) {
  const chunks = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of htmlSrc.matchAll(re)) {
    if (m[1].trim()) chunks.push(m[1]);
  }
  return chunks.join('\n');
}

function extractInlineHtmlStyles(htmlSrc) {
  const chunks = [];
  for (const m of htmlSrc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    chunks.push(m[1]);
  }
  for (const m of htmlSrc.matchAll(/\bstyle\s*=\s*["']([^"']+)["']/gi)) {
    chunks.push(`inline { ${m[1]} }`);
  }
  return chunks.join('\n');
}

function auditCssHexColors(cssFiles, bubbleHtmlRel) {
  const targets = [...cssFiles];
  if (fs.existsSync(path.join(REPO, bubbleHtmlRel))) targets.push(bubbleHtmlRel);

  const fileStats = [];
  const globalHexCounts = new Map(); // normalized hex -> { total, varDefs, hardcoded, files: Set }
  let totalAllHex = 0;
  let totalHardcodedHex = 0;
  let totalVarDefHex = 0;

  for (const rel of targets) {
    const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const cssSrc = rel.endsWith('.html') ? extractInlineHtmlStyles(raw) : raw;
    const noComments = cssSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

    let fileTotal = 0;
    let fileVarDef = 0;
    let fileHardcoded = 0;
    const uniqueInFile = new Set();

    // Match CSS property declarations `propName : value` up to `;` or `}`
    const declRe = /([-\w]+)\s*:\s*([^;{}]+)/g;
    for (const dm of noComments.matchAll(declRe)) {
      const prop = dm[1].trim();
      const val = dm[2];
      const isCustomProp = prop.startsWith('--');
      for (const hm of val.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
        const hexRaw = hm[1];
        if (![3, 4, 6, 8].includes(hexRaw.length)) continue;
        const norm = '#' + hexRaw.toLowerCase();
        fileTotal++;
        totalAllHex++;
        if (isCustomProp) {
          fileVarDef++;
          totalVarDefHex++;
        } else {
          fileHardcoded++;
          totalHardcodedHex++;
        }
        uniqueInFile.add(norm);
        const rec = globalHexCounts.get(norm) || { total: 0, varDefs: 0, hardcoded: 0, files: new Set() };
        rec.total++;
        if (isCustomProp) rec.varDefs++;
        else rec.hardcoded++;
        rec.files.add(rel);
        globalHexCounts.set(norm, rec);
      }
    }

    // Also catch SVG fill="#..." / stroke="#..." attributes inside bubble.html if any
    if (rel.endsWith('.html')) {
      for (const sm of raw.matchAll(/\b(?:fill|stroke)\s*=\s*["']#([0-9a-fA-F]{3,8})["']/gi)) {
        const hexRaw = sm[1];
        if (![3, 4, 6, 8].includes(hexRaw.length)) continue;
        const norm = '#' + hexRaw.toLowerCase();
        fileTotal++;
        fileHardcoded++;
        totalAllHex++;
        totalHardcodedHex++;
        uniqueInFile.add(norm);
        const rec = globalHexCounts.get(norm) || { total: 0, varDefs: 0, hardcoded: 0, files: new Set() };
        rec.total++;
        rec.hardcoded++;
        rec.files.add(rel);
        globalHexCounts.set(norm, rec);
      }
    }

    fileStats.push({
      file: rel,
      total: fileTotal,
      varDefs: fileVarDef,
      hardcoded: fileHardcoded,
      unique: uniqueInFile.size,
    });
  }

  fileStats.sort((a, b) => b.hardcoded - a.hardcoded || b.total - a.total || a.file.localeCompare(b.file));
  const topColors = [...globalHexCounts.entries()]
    .map(([hex, r]) => ({ hex, total: r.total, varDefs: r.varDefs, hardcoded: r.hardcoded, fileCount: r.files.size, files: [...r.files].sort() }))
    .sort((a, b) => b.hardcoded - a.hardcoded || b.total - a.total || a.hex.localeCompare(b.hex));

  return {
    fileStats,
    topColors,
    totalAllHex,
    totalHardcodedHex,
    totalVarDefHex,
    uniqueTotal: globalHexCounts.size,
  };
}

function scanTargetedPatterns(prodParsed, allFuncs) {
  // 1. Atomic write renameSync occurrences
  const renameSites = [];
  for (const pf of prodParsed) {
    const { file, tokens } = pf;
    for (let i = 0; i < tokens.length; i++) {
      if ((tokens[i].type === 'prop' || tokens[i].type === 'id') && tokens[i].value === 'renameSync' && tokens[i + 1]?.value === '(') {
        renameSites.push({ file, line: tokens[i].line, domain: classifyDomain(file) });
      }
    }
  }

  // 2. JSON helper functions
  const jsonHelpers = allFuncs.filter((f) =>
    /^(?:readJson\w*|writeJson\w*|loadJson\w*|saveJson\w*|safeJson\w*|parseJson\w*|tryParseJson\w*)$/i.test(f.name)
  );

  // 3. HTTP / Relay / Socket request helpers
  const httpSites = [];
  for (const pf of prodParsed) {
    const { file, tokens } = pf;
    for (let i = 0; i < tokens.length; i++) {
      if (
        tokens[i].type === 'id' &&
        (tokens[i].value === 'http' || tokens[i].value === 'https') &&
        tokens[i + 1]?.value === '.' &&
        (tokens[i + 2]?.value === 'request' || tokens[i + 2]?.value === 'get')
      ) {
        httpSites.push({ file, line: tokens[i].line, call: `${tokens[i].value}.${tokens[i + 2].value}`, domain: classifyDomain(file) });
      }
    }
  }

  // 4. Shell / PowerShell / Path quoting helpers
  const quoteHelpers = allFuncs.filter((f) => {
    if (f.file.includes('/literature/')) return false;
    if (/(?:quote|escape.*arg|escape.*cmd|psQuote|shQuote|shellQuote|cmdQuote|posixPath|winPath)/i.test(f.name)) return true;
    return f.bodyTokens.some((t) => t.type === 'str' && (t.value.includes("'\\''") || t.value === `'"'"'`));
  });

  // 5. HTML escaping helpers
  const htmlEscHelpers = allFuncs.filter((f) =>
    /^(?:esc|escapeHtml|escHtml|escAttr|escapeAttr|htmlEscape)$/i.test(f.name) ||
    (f.lines <= 12 && f.bodyTokens.some((t) => t.type === 'str' && /^['"`]&amp;['"`]$/.test(t.value)))
  );

  return { renameSites, jsonHelpers, httpSites, quoteHelpers, htmlEscHelpers };
}

function main() {
  const t0 = Date.now();
  const { prodJs, testJs, cssFiles, htmlFiles } = walkRepo();

  const prodParsed = [];
  const allFuncs = [];
  const oversizedFiles = [];

  for (const rel of prodJs) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const lineCount = src.split('\n').length;
    if (lineCount > 500) {
      oversizedFiles.push({ file: rel, lines: lineCount, kind: 'JS', domain: classifyDomain(rel) });
    }
    const tokens = tokenizeJs(src);
    const pairs = pairDelimiters(tokens);
    const funcs = extractFunctions(rel, tokens, pairs);
    const expInfo = collectExportsForFile(rel, src, tokens, pairs);
    const idCounts = collectIdentifiersSet(tokens);
    prodParsed.push({ file: rel, src, lines: lineCount, tokens, pairs, funcs, expInfo, idCounts });
    for (const fn of funcs) allFuncs.push(fn);
  }

  for (const rel of [...cssFiles, ...htmlFiles]) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const lineCount = src.split('\n').length;
    if (lineCount > 500) {
      oversizedFiles.push({
        file: rel,
        lines: lineCount,
        kind: rel.endsWith('.css') ? 'CSS' : 'HTML',
        domain: classifyDomain(rel),
      });
    }
  }

  // Also parse HTML inline scripts for identifier usage (so exports used inline in HTML aren't false-flagged)
  const htmlScriptIdCounts = [];
  for (const rel of htmlFiles) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const inlineJs = extractInlineHtmlScripts(src);
    if (inlineJs) {
      htmlScriptIdCounts.push({ file: rel, idCounts: collectIdentifiersSet(tokenizeJs(inlineJs)) });
    }
  }

  // Parse test files for test-only reference detection
  const testIdCounts = [];
  for (const rel of testJs) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    testIdCounts.push({ file: rel, idCounts: collectIdentifiersSet(tokenizeJs(src)) });
  }

  // --- 1. Duplicate / Similar Function Clustering ---
  const strictBuckets = new Map();
  const skeletonBuckets = new Map();

  for (const fn of allFuncs) {
    if (fn.bodyTokens.length < 16 && fn.lines < 4) continue;
    const strict = fingerprintFunction(fn, 'strict');
    fn.strictHash = strict.hash;
    fn.tokenCount = strict.tokenCount;
    const sb = strictBuckets.get(strict.hash) || [];
    sb.push(fn);
    strictBuckets.set(strict.hash, sb);

    if (fn.bodyTokens.length >= 30 && fn.lines >= 6) {
      const skel = fingerprintFunction(fn, 'skeleton');
      fn.skelHash = skel.hash;
      const kb = skeletonBuckets.get(skel.hash) || [];
      kb.push(fn);
      skeletonBuckets.set(skel.hash, kb);
    }
  }

  const duplicateClusters = [];
  const clusteredStrictKeys = new Set();

  for (const [hash, list] of strictBuckets) {
    const distinctFiles = new Set(list.map((f) => f.file));
    if (list.length < 2) continue;
    if (distinctFiles.size < 2 && list[0].lines < 8) continue;
    clusteredStrictKeys.add(hash);
    duplicateClusters.push({
      level: 'Exact-AST',
      hash,
      count: list.length,
      fileCount: distinctFiles.size,
      avgLines: Math.round(list.reduce((s, x) => s + x.lines, 0) / list.length),
      tokens: list[0].tokenCount,
      members: list.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine),
    });
  }

  for (const [hash, list] of skeletonBuckets) {
    if (list.length < 2) continue;
    const distinctStrict = new Set(list.map((f) => f.strictHash));
    if (distinctStrict.size === 1 && clusteredStrictKeys.has([...distinctStrict][0])) continue;
    const distinctFiles = new Set(list.map((f) => f.file));
    if (distinctFiles.size < 2) continue;
    duplicateClusters.push({
      level: 'Near-Clone',
      hash,
      count: list.length,
      fileCount: distinctFiles.size,
      avgLines: Math.round(list.reduce((s, x) => s + x.lines, 0) / list.length),
      tokens: list[0].tokenCount,
      members: list.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine),
    });
  }

  duplicateClusters.sort(
    (a, b) => b.count * b.avgLines - a.count * a.avgLines || b.count - a.count || a.hash.localeCompare(b.hash)
  );

  const patterns = scanTargetedPatterns(prodParsed, allFuncs);

  // --- 2. Export Symbol Reference Audit ---
  let totalExportSymbols = 0;
  let cjsExportSymbols = 0;
  let esmExportSymbols = 0;
  const zeroProdExports = [];

  for (const pf of prodParsed) {
    const { file, expInfo } = pf;
    for (const [sym, line] of expInfo.exported) {
      totalExportSymbols++;
      if (expInfo.kind === 'ESM') esmExportSymbols++;
      else cjsExportSymbols++;

      if (sym === 'default') continue;

      let prodRefs = 0;
      let prodRefFiles = 0;
      for (const other of prodParsed) {
        if (other.file === file) continue;
        const c = other.idCounts.get(sym) || 0;
        if (c > 0) {
          prodRefs += c;
          prodRefFiles++;
        }
      }
      for (const hs of htmlScriptIdCounts) {
        const c = hs.idCounts.get(sym) || 0;
        if (c > 0) {
          prodRefs += c;
          prodRefFiles++;
        }
      }

      let testRefs = 0;
      for (const tf of testIdCounts) {
        testRefs += tf.idCounts.get(sym) || 0;
      }

      const internalRefs = Math.max(0, (pf.idCounts.get(sym) || 1) - 1);

      if (prodRefs === 0) {
        zeroProdExports.push({
          file,
          line,
          sym,
          kind: expInfo.kind,
          domain: classifyDomain(file),
          internalRefs,
          testRefs,
        });
      }
    }
  }

  zeroProdExports.sort((a, b) => a.domain.localeCompare(b.domain) || a.file.localeCompare(b.file) || a.line - b.line);

  // --- 3. Oversized Files & Functions ---
  oversizedFiles.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  const oversizedFuncs = allFuncs
    .filter((f) => f.lines > 80)
    .sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file) || a.startLine - b.startLine);

  // --- 4. Hardcoded CSS / HTML #hex Audit ---
  const hexAudit = auditCssHexColors(cssFiles, 'app/bubble.html');

  // --- Render Deterministic Markdown Report ---
  const md = [];
  md.push('# AmeTyping 全仓代码静态审计基线报告 (`00-codebase-audit.md`)');
  md.push('');
  md.push('> 由确定性静态 AST/Token 扫描器 `node tools/audit-codebase.js` 生成（排除 `node_modules`、`vendor`、`remote/test` 及 `*.test.js` 业务噪声；单测仅用于辅助区分「纯死代码」与「仅单测引用导出」）。');
  md.push('');
  md.push('## 全局概览指标');
  md.push('');
  md.push('| 指标维度 | 数值 | 说明 |');
  md.push('| --- | ---: | --- |');
  md.push(`| 生产 JS/MJS 文件数 | ${prodJs.length} | 扫描总行数 ${prodParsed.reduce((s, p) => s + p.lines, 0).toLocaleString()} 行，提取具名/回调块函数 ${allFuncs.length.toLocaleString()} 个 |`);
  md.push(`| 测试 JS 文件数（参照集） | ${testJs.length} | 含 \`remote/test/**\` 与根目录/\`app/*.test.js\` |`);
  md.push(`| 跨文件重复/近似函数簇 | ${duplicateClusters.length} | Exact-AST 归一化克隆 ${duplicateClusters.filter((c) => c.level === 'Exact-AST').length} 簇 + Near-Clone 结构克隆 ${duplicateClusters.filter((c) => c.level === 'Near-Clone').length} 簇 |`);
  md.push(`| \`renameSync\` 原子写盘散落点 | ${patterns.renameSites.length} | 跨 ${new Set(patterns.renameSites.map((x) => x.file)).size} 个生产文件重复实现写临时文件再 rename |`);
  md.push(`| 导出符号总数 (CJS + ESM) | ${totalExportSymbols} | CJS \`module.exports\` ${cjsExportSymbols} 个 + ESM \`export\` ${esmExportSymbols} 个 |`);
  md.push(`| 零外部生产引用导出符号 | ${zeroProdExports.length} | 其中纯零引用（连测试也未引用）${zeroProdExports.filter((x) => x.testRefs === 0).length} 个，仅单测引用 ${zeroProdExports.filter((x) => x.testRefs > 0).length} 个 |`);
  md.push(`| 超长文件（>500 行） | ${oversizedFiles.length} | JS ${oversizedFiles.filter((x) => x.kind === 'JS').length} 个 / CSS ${oversizedFiles.filter((x) => x.kind === 'CSS').length} 个 / HTML ${oversizedFiles.filter((x) => x.kind === 'HTML').length} 个 |`);
  md.push(`| 超长函数（>80 行） | ${oversizedFuncs.length} | 最大单函数 ${oversizedFuncs[0] ? `${oversizedFuncs[0].lines} 行 (${oversizedFuncs[0].file})` : '无'} |`);
  md.push(`| CSS + \`bubble.html\` \`#hex\` 色值 | ${hexAudit.totalAllHex} | 业务规则硬编码 **${hexAudit.totalHardcodedHex}** 处 + \`--*\` 变量定义 ${hexAudit.totalVarDefHex} 处（去重后 ${hexAudit.uniqueTotal} 种色值） |`);
  md.push('');

  // Section 1
  md.push('---');
  md.push('');
  md.push('## 1. 跨文件相似/重复函数聚类与高频重复模式');
  md.push('');
  md.push('### 1.1 归一化函数块指纹聚类（Top 重复簇）');
  md.push('');
  md.push('| # | 级别 | 指纹 | 出现次数 | 均行 | 代表函数名 | 分布位置（文件:起止行） |');
  md.push('| ---: | --- | --- | ---: | ---: | --- | --- |');
  duplicateClusters.forEach((c, idx) => {
    const names = [...new Set(c.members.map((m) => m.name))].slice(0, 3).join(', ');
    const locs = c.members.map((m) => `\`${m.file}:L${m.startLine}-L${m.endLine}\` (${m.name})`).join('<br>');
    md.push(`| ${idx + 1} | ${c.level} | \`${c.hash}\` | ${c.count} | ${c.avgLines} | \`${names}\` | ${locs} |`);
  });
  md.push('');

  md.push(`### 1.2 原子写盘 \`renameSync\` 全仓分布（共 ${patterns.renameSites.length} 处）`);
  md.push('');
  const renameByDomain = new Map();
  for (const r of patterns.renameSites) {
    const list = renameByDomain.get(r.domain) || [];
    list.push(r);
    renameByDomain.set(r.domain, list);
  }
  md.push('| 子域 | 处数 | 具体文件与行号 |');
  md.push('| --- | ---: | --- |');
  for (const [dom, list] of [...renameByDomain.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const byFile = new Map();
    for (const item of list) {
      const lines = byFile.get(item.file) || [];
      lines.push(`L${item.line}`);
      byFile.set(item.file, lines);
    }
    const detail = [...byFile.entries()].map(([f, ls]) => `\`${f}\` (${ls.join(', ')})`).join('; ');
    md.push(`| **${dom}** | ${list.length} | ${detail} |`);
  }
  md.push('');

  md.push('### 1.3 四类典型跨目录复制粘贴辅助函数清单');
  md.push('');
  md.push(`- **JSON 安全读写辅助函数（${patterns.jsonHelpers.length} 处定义）**：` +
    patterns.jsonHelpers.map((f) => `\`${f.file}:L${f.startLine}\` (\`${f.name}\`, ${f.lines}行)`).join('、'));
  md.push(`- **HTTP/HTTPS 原生请求调用点（${patterns.httpSites.length} 处）**：` +
    patterns.httpSites.map((h) => `\`${h.file}:L${h.line}\` (\`${h.call}\`)`).join('、'));
  md.push(`- **路径 / Shell / PowerShell 引号转义函数（${patterns.quoteHelpers.length} 处定义）**：` +
    patterns.quoteHelpers.map((f) => `\`${f.file}:L${f.startLine}\` (\`${f.name}\`, ${f.lines}行)`).join('、'));
  md.push(`- **HTML 转义函数（${patterns.htmlEscHelpers.length} 处定义）**：` +
    patterns.htmlEscHelpers.map((f) => `\`${f.file}:L${f.startLine}\` (\`${f.name}\`, ${f.lines}行)`).join('、'));
  md.push('');

  // Section 2
  md.push('---');
  md.push('');
  md.push('## 2. 全量 CJS `module.exports` 与 ESM `export` 零生产引用符号清单');
  md.push('');
  md.push('> 说明：`prodRefs = 0` 表示该导出符号名在全仓所有**其他生产源码文件（含 HTML 内联脚本）**中出现次数为 0。若 `testRefs > 0` 说明仅供单测白盒调用（可评估是否保留供单测或收敛内部接口）；若 `testRefs = 0` 且非框架动态反射钩子，属于高置信度可清理死导出/可降级文件私有函数。');
  md.push('');
  md.push('| 子域 | 模块体制 | 文件与行号 | 导出符号 | 文件内自引 | 单测引用 (`testRefs`) | 判定建议 |');
  md.push('| --- | --- | --- | --- | ---: | ---: | --- |');
  for (const z of zeroProdExports) {
    let tag = '死导出 / 可彻底移除';
    if (z.testRefs > 0 && z.internalRefs > 0) tag = '内部函数（仅额外导出给单测）';
    else if (z.testRefs > 0 && z.internalRefs === 0) tag = '仅单测调用（生产未用）';
    else if (z.internalRefs > 0) tag = '仅文件内部自用（无需导出）';
    md.push(`| ${z.domain} | ${z.kind} | \`${z.file}:L${z.line}\` | \`${z.sym}\` | ${z.internalRefs} | ${z.testRefs} | ${tag} |`);
  }
  md.push('');

  // Section 3
  md.push('---');
  md.push('');
  md.push('## 3. 超长文件（>500 行）与超长函数（>80 行）热点榜');
  md.push('');
  md.push(`### 3.1 超长文件榜（>500 行，共 ${oversizedFiles.length} 个）`);
  md.push('');
  md.push('| 排名 | 子域 | 类型 | 行数 | 文件路径 |');
  md.push('| ---: | --- | --- | ---: | --- |');
  oversizedFiles.forEach((f, idx) => {
    md.push(`| ${idx + 1} | ${f.domain} | ${f.kind} | **${f.lines}** | \`${f.file}\` |`);
  });
  md.push('');

  md.push(`### 3.2 超长函数榜（>80 行，共 ${oversizedFuncs.length} 个）`);
  md.push('');
  md.push('| 排名 | 子域 | 行数 | 函数名 / 回调标识 | 位置 (`文件:起止行`) |');
  md.push('| ---: | --- | ---: | --- | --- |');
  oversizedFuncs.forEach((fn, idx) => {
    md.push(`| ${idx + 1} | ${classifyDomain(fn.file)} | **${fn.lines}** | \`${fn.name}\` | \`${fn.file}:L${fn.startLine}-L${fn.endLine}\` |`);
  });
  md.push('');

  // Section 4
  md.push('---');
  md.push('');
  md.push('## 4. `remote/public/css/*.css` 与 `app/bubble.html` 硬编码 `#hex` 色值统计');
  md.push('');
  md.push('### 4.1 按文件统计（区分业务规则硬编码 vs `--*` 变量定义）');
  md.push('');
  md.push('| 文件路径 | 业务硬编码 `#hex` | `--*` 变量定义 `#hex` | 总出现次数 | 去重色值数 |');
  md.push('| --- | ---: | ---: | ---: | ---: |');
  for (const fsRow of hexAudit.fileStats) {
    md.push(`| \`${fsRow.file}\` | **${fsRow.hardcoded}** | ${fsRow.varDefs} | ${fsRow.total} | ${fsRow.unique} |`);
  }
  md.push(`| **合计** | **${hexAudit.totalHardcodedHex}** | **${hexAudit.totalVarDefHex}** | **${hexAudit.totalAllHex}** | **${hexAudit.uniqueTotal}** |`);
  md.push('');

  md.push('### 4.2 高频硬编码 `#hex` 色值 Top 30（按非变量硬编码次数降序）');
  md.push('');
  md.push('| 排名 | 色值 | 业务硬编码次数 | `--*` 定义次数 | 涉及文件数 | 主要分布文件 |');
  md.push('| ---: | --- | ---: | ---: | ---: | --- |');
  hexAudit.topColors.slice(0, 30).forEach((c, idx) => {
    const sampleFiles = c.files.slice(0, 4).map((f) => `\`${f}\``).join(', ') + (c.files.length > 4 ? ` 等${c.files.length}个` : '');
    md.push(`| ${idx + 1} | \`${c.hex}\` | **${c.hardcoded}** | ${c.varDefs} | ${c.fileCount} | ${sampleFiles} |`);
  });
  md.push('');

  const content = md.join('\n') + '\n';
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, content, 'utf8');

  let sharedWritten = false;
  if (!NO_SHARED && SHARED_PATH) {
    const sharedDir = path.dirname(SHARED_PATH);
    if (fs.existsSync(sharedDir)) {
      fs.writeFileSync(SHARED_PATH, content, 'utf8');
      sharedWritten = true;
    }
  }

  const ms = Date.now() - t0;
  console.log(
    `PASS audit-codebase (${ms}ms): scanned ${prodJs.length} JS + ${cssFiles.length} CSS + ${htmlFiles.length} HTML | ` +
    `${duplicateClusters.length} dup clusters, ${patterns.renameSites.length} renameSync, ` +
    `${zeroProdExports.length}/${totalExportSymbols} 0-prod-ref exports, ` +
    `${oversizedFiles.length} files>500L, ${oversizedFuncs.length} funcs>80L, ` +
    `${hexAudit.totalHardcodedHex} hardcoded #hex -> ${path.relative(REPO, OUT_PATH)}` +
    (sharedWritten ? ` (+ synced to ${SHARED_PATH})` : '')
  );
}

main();
