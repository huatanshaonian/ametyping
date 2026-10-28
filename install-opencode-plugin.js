#!/usr/bin/env node
// Installs AmeTyping's OpenCode plugin into OpenCode's global configuration.
//
//   node install-opencode-plugin.js             add (or refresh) the plugin entry
//   node install-opencode-plugin.js --remove    take the entry out
//   node install-opencode-plugin.js --config <path>   a specific opencode.json(c)
//
// The plugin lives in this repository (opencode-plugin/); the config gets its absolute path. Nothing is copied, so
// `git pull` updates it. Because OpenCode configs may be JSONC, the edit is textual: comments and formatting stay,
// the original file is backed up first, and the entry is recognised again on a re-run (idempotent).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_DIR = path.join(__dirname, 'opencode-plugin');
const ENTRY = PLUGIN_DIR.split(path.sep).join('/');

// ---------- a tiny JSONC scanner: strings, // and /* */ comments are understood ----------
function scan(text) {
  const strings = [];              // [start, end) of every string literal, quotes included
  const comments = [];             // [start, end) of every comment
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '"') { i++; break; }
        i++;
      }
      strings.push([start, i]);
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { const s = i; i = text.indexOf('\n', i); if (i < 0) i = text.length; comments.push([s, i]); continue; }
    if (c === '/' && text[i + 1] === '*') { const s = i; i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; comments.push([s, i]); continue; }
    i++;
  }
  return { strings, comments };
}
const inRanges = (i, ranges) => ranges.some(([a, b]) => i >= a && i < b);
function strip(text, { keepStrings = true } = {}) {
  const { comments } = scan(text);
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = comments.find(([a, b]) => i >= a && i < b);
    if (c) { out += text.slice(i, c[0]).replace(/[^\n]/g, ' '); i = c[1]; continue; }
    out += text[i++];
  }
  return keepStrings ? out : out;
}
function parseJsonc(text) {
  const bare = strip(text).replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(bare);
}

// the position of `"key"` used as an object key (not inside a string or comment)
function keyPos(text, key) {
  const { strings, comments } = scan(text);
  const needle = '"' + key + '"';
  let i = -1;
  while ((i = text.indexOf(needle, i + 1)) >= 0) {
    if (inRanges(i, comments)) continue;
    if (inRanges(i, strings) && !strings.some(([a, b]) => a === i && b === i + needle.length)) continue;
    let j = i + needle.length;
    while (/\s/.test(text[j] || '')) j++;
    if (text[j] === ':') return { at: i, colon: j };
  }
  return null;
}
// the index of the object's opening brace (the first `{` outside strings/comments)
function firstBrace(text) {
  const { strings, comments } = scan(text);
  for (let i = 0; i < text.length; i++) if (text[i] === '{' && !inRanges(i, strings) && !inRanges(i, comments)) return i;
  return -1;
}
function arraySpan(text, open) {
  const { strings, comments } = scan(text);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (inRanges(i, strings) || inRanges(i, comments)) continue;
    if (text[i] === '[') depth++;
    else if (text[i] === ']') { depth--; if (depth === 0) return [open, i]; }
  }
  return null;
}

// ---------- the config ----------
function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config'), 'opencode');
}
function findConfig(arg) {
  if (arg) return path.resolve(arg);
  const dir = configDir();
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
  }
  return path.join(dir, 'opencode.json');
}
const same = (a) => String(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === ENTRY.toLowerCase();

function addEntry(text) {
  const cfg = text.trim() ? parseJsonc(text) : null;
  const list = cfg && Array.isArray(cfg.plugins) ? cfg.plugins : [];
  if (list.some((p) => typeof p === 'string' && same(p))) return { text, changed: false, already: true };
  const key = keyPos(text, 'plugins');
  if (key) {
    let open = key.colon + 1;
    while (/\s/.test(text[open] || '')) open++;
    if (text[open] !== '[') throw new Error('配置里的 "plugins" 不是数组');
    let next = open + 1;
    while (/\s/.test(text[next] || '')) next++;
    const comma = text[next] === ']' ? '' : ',';
    return { text: text.slice(0, open + 1) + JSON.stringify(ENTRY) + comma + text.slice(open + 1), changed: true };
  }
  const brace = firstBrace(text);
  if (brace < 0) throw new Error('配置不是一个 JSON 对象');
  const body = text.slice(brace + 1);
  const empty = !body.trim();
  return { text: text.slice(0, brace + 1) + `\n  "plugins": [${JSON.stringify(ENTRY)}]${empty ? '' : ','}` + body, changed: true };
}
function removeEntry(text) {
  const cfg = parseJsonc(text);
  const list = cfg && Array.isArray(cfg.plugins) ? cfg.plugins : [];
  if (!list.some((p) => typeof p === 'string' && same(p))) return { text, changed: false };
  const left = list.filter((p) => !(typeof p === 'string' && same(p)));
  const key = keyPos(text, 'plugins');
  if (!key) return { text, changed: false };
  let open = key.colon + 1;
  while (/\s/.test(text[open] || '')) open++;
  const span = arraySpan(text, open);
  if (!span) throw new Error('读不懂 "plugins" 数组');
  return { text: text.slice(0, span[0]) + JSON.stringify(left) + text.slice(span[1] + 1), changed: true };
}

function main() {
  const args = process.argv.slice(2);
  const remove = args.includes('--remove');
  const ci = args.indexOf('--config');
  const file = findConfig(ci >= 0 ? args[ci + 1] : '');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!text.trim()) text = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  let result;
  try { result = remove ? removeEntry(text) : addEntry(text); }
  catch (e) {
    console.error(`改不了 ${file}：${e.message}`);
    console.error(`请手动在 "plugins" 里${remove ? '删掉' : '加上'} "${ENTRY}"。`);
    process.exit(1);
  }
  if (!result.changed) {
    console.log(result.already ? `已经装好了：${file}` : `没有需要改的：${file}`);
    return;
  }
  if (!fs.existsSync(file)) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  else fs.copyFileSync(file, `${file}.ame-backup-${Math.floor(Date.now() / 1000)}`);
  fs.writeFileSync(file, result.text.replace(/^\uFEFF/, ''), 'utf8');
  console.log(`${remove ? '已移除' : '已装入'}：${ENTRY}`);
  console.log(`配置：${file}（原文件已备份）`);
  if (!remove) console.log('打开（或 /reload）OpenCode 后生效；事件会发到本机 127.0.0.1:3940 的糖糖 / 无头服务。');
}

if (require.main === module) main();
module.exports = { addEntry, removeEntry, parseJsonc, keyPos, ENTRY };
