// The knowledge base: plain Markdown files in a folder (literature config "kbDir"), laid out so Obsidian can open the
// same folder -- YAML front matter, [[citekey]] links:
//   papers/<citekey>.md   one card per paper (cards.js writes them)
//   topics/<slug>.md      the user's own reviews of a subject, citing cards
//   index.md              the catalogue (rewritten by this module), log.md (what changed, newest last)
//   .ame/proposals.json   changes the model suggested, waiting for the user (nothing is written before "接受")
// The files are the truth: an edit carries the hash of the text it was made from, and is refused (conflict) when the
// file changed meanwhile -- e.g. edited in Obsidian -- instead of overwriting either.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const SAFE = /^(papers|topics)\/[\p{L}\p{N}_.-]{1,120}\.md$/u;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---- front matter: a small YAML subset (key: value, values written as JSON, which YAML reads too) ----
function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const k = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!k) continue;
    let v = k[2].trim();
    try { v = JSON.parse(v); } catch { if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean); else v = v.replace(/^["']|["']$/g, ''); }
    meta[k[1]] = v;
  }
  return { meta, body: m ? text.slice(m[0].length) : text };
}
function stringify(meta, body) {
  const lines = Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body).replace(/^\n+/, '')}`;
}
// "## Heading" sections of a body -> [{ title, text }] (text before the first one: title '')
function sections(body) {
  const out = []; let cur = { title: '', lines: [] };
  for (const line of String(body).split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { out.push(cur); cur = { title: m[1], lines: [] }; } else cur.lines.push(line);
  }
  out.push(cur);
  return out.map((s) => ({ title: s.title, text: s.lines.join('\n').trim() })).filter((s) => s.title || s.text);
}
function joinSections(list) { return list.map((s) => (s.title ? `## ${s.title}\n\n${s.text}`.trim() : s.text)).join('\n\n') + '\n'; }
// one change to a body: { type: 'append' | 'replace', section, text } (a missing section is added at the end)
function applyOp(body, op) {
  if (op.type === 'replace-all') return op.text;
  const secs = sections(body);
  let s = secs.find((x) => x.title === op.section);
  if (!s) { s = { title: op.section, text: '' }; secs.push(s); }
  s.text = op.type === 'replace' ? String(op.text).trim() : [s.text, String(op.text).trim()].filter(Boolean).join('\n');
  return joinSections(secs);
}

// a citation key as a file name: what a path cannot hold becomes _ (BibTeX keys may carry : + / ...)
const fileName = (k) => String(k || 'untitled').replace(/[^\p{L}\p{N}_.-]/gu, '_').replace(/^\.+/, '_').slice(0, 120);

function slugify(s) {
  const t = String(s || '').trim().toLowerCase().replace(/[\s/\\:*?"<>|#^[\]]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (t || 'topic').slice(0, 60);
}

function createKb({ dir, log = () => {}, onChange = () => {} }) {
  for (const d of ['papers', 'topics', '.ame']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const propFile = path.join(dir, '.ame', 'proposals.json');
  let proposals = []; try { proposals = JSON.parse(fs.readFileSync(propFile, 'utf8')); } catch {}
  const saveProps = () => { fs.writeFileSync(propFile + '.tmp', JSON.stringify(proposals)); fs.renameSync(propFile + '.tmp', propFile); };
  const abs = (rel) => { if (!SAFE.test(rel)) throw new Error('无效的路径'); return path.join(dir, rel); };

  function read(rel) {
    let text; try { text = fs.readFileSync(abs(rel), 'utf8'); } catch { return null; }      // (an invalid path: none)
    const { meta, body } = parse(text);
    let mtime = 0; try { mtime = fs.statSync(abs(rel)).mtimeMs; } catch {}
    return { path: rel, text, hash: hash(text), meta, body, sections: sections(body), mtime };
  }
  // write the whole text; base: the hash it was edited from ('' = must not exist yet, null = no check)
  function write(rel, text, base = null, why = '') {
    const cur = read(rel);
    if (base !== null && (cur ? cur.hash : '') !== base) return { ok: false, conflict: true, msg: '文件在别处被改过了（比如 Obsidian），请重新打开再改', current: cur };
    const f = abs(rel);
    fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f);
    if (why) appendLog(`${why} [[${path.basename(rel, '.md')}]]`);
    onChange(rel);
    return { ok: true, hash: hash(text) };
  }
  function appendLog(line) {
    try { fs.appendFileSync(path.join(dir, 'log.md'), `- ${today()} ${line}\n`); } catch {}
  }
  function list(kind) {
    let names = []; try { names = fs.readdirSync(path.join(dir, kind)).filter((f) => f.endsWith('.md')); } catch {}
    return names.map((f) => read(`${kind}/${f}`)).filter(Boolean);
  }
  function remove(rel) { try { fs.unlinkSync(abs(rel)); onChange(rel); return { ok: true }; } catch { return { ok: false, msg: '删不掉' }; } }

  // ---- proposals: the model's suggested changes, applied only when accepted ----
  function propose({ path: rel, op, reason = '', source = '' }) {
    if (!SAFE.test(rel)) return null;
    const cur = read(rel);
    const p = { id: crypto.randomBytes(5).toString('hex'), path: rel, op, reason: String(reason).slice(0, 300), source, base: cur ? cur.hash : '', created: Date.now() };
    proposals.unshift(p); proposals = proposals.slice(0, 200); saveProps(); onChange('proposals');
    return p;
  }
  // preview: the text before and after (against the file as it is now)
  function preview(id) {
    const p = proposals.find((x) => x.id === id); if (!p) return null;
    const cur = read(p.path);
    const before = cur ? cur.text : '';
    let after;
    if (p.op.type === 'create') after = p.op.text;
    else { const { meta, body } = parse(before); after = stringify({ ...meta, updated: today() }, applyOp(body, p.op)); }
    return { ...p, before, after, changed: !!cur && cur.hash !== p.base };
  }
  function accept(id, edited) {
    const v = preview(id); if (!v) return { ok: false, msg: '找不到这条建议' };
    if (v.op.type === 'create' && v.before && !edited) return { ok: false, msg: '这个文件已经存在了' };
    // (section edits re-apply onto the current text; a whole rewrite needs the file unchanged)
    if (v.op.type === 'replace-all' && v.changed) return { ok: false, conflict: true, msg: '文件在建议之后被改过，这条整篇改写不能直接套用' };
    const r = write(v.path, typeof edited === 'string' ? edited : v.after, null, '接受建议：' + (v.reason || v.op.section || ''));
    if (r.ok) { proposals = proposals.filter((x) => x.id !== id); saveProps(); onChange('proposals'); }
    return r;
  }
  function reject(id) { const n = proposals.length; proposals = proposals.filter((x) => x.id !== id); if (n !== proposals.length) { saveProps(); onChange('proposals'); } return { ok: n !== proposals.length }; }

  // index.md: topics, then papers by status (rewritten whenever asked; Obsidian sees it as a normal note)
  function rebuildIndex() {
    const topics = list('topics'), papers = list('papers');
    const line = (r) => `- [[${path.basename(r.path, '.md')}]] ${r.meta.title || ''}${r.meta.year ? `（${r.meta.year}）` : ''}`;
    const by = (s) => papers.filter((p) => (p.meta.status || 'quick') === s).sort((a, b) => String(b.meta.updated || '').localeCompare(String(a.meta.updated || '')));
    const deep = [...by('deep'), ...by('reviewed')], quick = by('quick');
    const text = ['# 文献知识库', '', `更新：${today()} · ${papers.length} 张卡片 · ${topics.length} 个专题`, '', '## 专题', '', ...(topics.length ? topics.map(line) : ['（还没有）']),
      '', '## 深读过的', '', ...(deep.length ? deep.map(line) : ['（还没有）']),
      '', '## 速读卡', '', ...(quick.length ? quick.map(line) : ['（还没有）']), ''].join('\n');
    try { fs.writeFileSync(path.join(dir, 'index.md'), text); } catch {}
  }

  // search over every card and topic: all words in the one file
  function search(q, limit = 40) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    const out = [];
    for (const r of [...list('topics'), ...list('papers')]) {
      const low = r.text.toLowerCase();
      if (!terms.every((t) => low.includes(t))) continue;
      const i = low.indexOf(terms[0]);
      out.push({ path: r.path, title: r.meta.title || path.basename(r.path, '.md'), snippet: (i > 40 ? '…' : '') + r.text.slice(Math.max(0, i - 40), i + 120).replace(/\s+/g, ' ') });
      if (out.length >= limit) break;
    }
    return out;
  }

  return { dir, fileName, read, write, list, remove, propose, preview, accept, reject, proposals: () => proposals, rebuildIndex, search, appendLog, parse, stringify, sections, applyOp, slugify, hash };
}

module.exports = { createKb, fileName, parse, stringify, sections, applyOp, slugify, hash };
