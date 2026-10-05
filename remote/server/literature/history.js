// 问题演化: the history of the research line and its questions -- where each question came from and what became of it.
// Every change is an event: made by the user on the 画像 page, by a 梳理 (which rewrites the questions), or by a
// review's change the user approved (review.js).
//   <dataDir>/literature/history.json  { events: [{ id, at, type, by, qid, text, before, dim, from: [qid], reason,
//                                                   evidence, review }] }
//   type: 提出 新增 修改 细化 分叉 合并 搁置 解决 重开 删除 主线     by: user | organize | review
// 分叉: one event per child (from: [the parent], the parent's own event says 分叉 too); 合并: the new question's event
// carries from: [the merged ones], each of which gets its own 合并 event. A question no longer in the profile lives on
// here. graph() is what the window draws; mermaid() the same for the knowledge base (Obsidian draws it).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = ['提出', '新增', '修改', '细化', '分叉', '合并', '搁置', '解决', '重开', '删除', '主线'];
const ENDED = { 分叉: 'split', 合并: 'merged', 搁置: 'shelved', 解决: 'done', 删除: 'gone' };
const STATUS = { open: '在研', done: '已解决', shelved: '搁置', split: '已分叉', merged: '已合并', gone: '已删除' };
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function createHistory({ dir, now = () => Date.now(), onChange = () => {} }) {
  const file = path.join(dir, 'history.json');
  let st = { events: [] };
  try { st = { events: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st)); fs.renameSync(file + '.tmp', file); try { onChange(); } catch {} };

  function add(list) {
    const at = now();
    for (const e of list) {
      if (!TYPES.includes(e.type)) continue;
      st.events.push({ id: crypto.randomBytes(5).toString('hex'), at: e.at || at, type: e.type, by: e.by || 'user', qid: e.qid || '', text: cut(e.text, 600), before: e.before ? cut(e.before, 600) : undefined,
        dim: e.dim || undefined, from: e.from && e.from.length ? e.from : undefined, reason: e.reason ? cut(e.reason, 500) : undefined, evidence: e.evidence ? cut(e.evidence, 500) : undefined, review: e.review || undefined });
    }
    if (list.length) save();
  }
  // nothing recorded yet: the questions as they stand are where the history starts
  function seed(profile) {
    if (st.events.length || !profile) return;
    const at = profile.organizedAt || profile.updated || now();
    const list = [];
    if (profile.line) list.push({ at, type: '主线', by: 'organize', text: profile.line });
    for (const q of profile.questions || []) {
      list.push({ at, type: '提出', by: 'organize', qid: q.id, text: q.text, dim: q.dim });
      if (q.status === 'done') list.push({ at, type: '解决', by: 'user', qid: q.id, text: q.text });
    }
    add(list);
  }
  // the questions (and the line) before and after an edit: what changed, as events
  function track(before, after, by = 'user') {
    const list = [], old = new Map((before.questions || []).map((q) => [q.id, q])), cur = new Map((after.questions || []).map((q) => [q.id, q]));
    if (String(before.line || '').trim() !== String(after.line || '').trim() && String(after.line || '').trim()) list.push({ type: '主线', by, text: after.line, before: before.line || undefined });
    for (const q of cur.values()) {
      const o = old.get(q.id);
      if (!o) { list.push({ type: by === 'organize' ? '提出' : '新增', by, qid: q.id, text: q.text, dim: q.dim }); continue; }
      if (o.text.trim() !== q.text.trim()) list.push({ type: '修改', by, qid: q.id, text: q.text, before: o.text, dim: q.dim });
      if (o.status !== q.status) list.push({ type: q.status === 'done' ? '解决' : q.status === 'shelved' ? '搁置' : '重开', by, qid: q.id, text: q.text });
    }
    for (const o of old.values()) if (!cur.has(o.id)) list.push({ type: '删除', by, qid: o.id, text: o.text, reason: by === 'organize' ? '重新梳理' : undefined });
    add(list);
    return list.length;
  }

  // every question there ever was: { id, text, dim, status, born, from: [ids], to: [ids], events: [...] }, oldest first
  function graph() {
    const nodes = new Map(), line = [];
    const node = (id) => { if (!nodes.has(id)) nodes.set(id, { id, text: '', dim: '', status: 'open', born: 0, from: [], to: [], events: [] }); return nodes.get(id); };
    for (const e of st.events.slice().sort((a, b) => a.at - b.at)) {
      if (e.type === '主线') { line.push({ at: e.at, by: e.by, text: e.text, before: e.before, reason: e.reason, review: e.review }); continue; }
      if (!e.qid) continue;
      const n = node(e.qid);
      if (!n.born) n.born = e.at;
      n.events.push({ at: e.at, type: e.type, by: e.by, text: e.text, before: e.before, reason: e.reason, evidence: e.evidence, review: e.review });
      if (e.dim) n.dim = e.dim;
      if (e.type in ENDED) n.status = ENDED[e.type];
      else { if (e.text) n.text = e.text; if (e.type === '重开' || e.type === '提出' || e.type === '新增') n.status = 'open'; }
      if (!n.text) n.text = e.text;
      for (const f of e.from || []) { const p = node(f); if (!n.from.includes(f)) n.from.push(f); if (!p.to.includes(n.id)) p.to.push(n.id); }
    }
    return { line, nodes: [...nodes.values()].filter((n) => n.text).sort((a, b) => a.born - b.born) };
  }
  // the same as a Mermaid flowchart (the knowledge base's 问题演化.md): the line, the questions, what came of what
  function mermaid() {
    const g = graph(), esc = (s) => cut(s, 44).replace(/["\[\](){}<>|#;]/g, ' ');
    const out = ['flowchart LR', '  L(["研究主线"])'];
    const ids = new Map(g.nodes.map((n, i) => [n.id, 'q' + (i + 1)]));
    for (const n of g.nodes) {
      if (n.status === 'gone') continue;
      out.push(`  ${ids.get(n.id)}["${esc(n.text)}<br/>${STATUS[n.status] || ''}"]:::${n.status}`);
      const from = n.from.filter((f) => ids.has(f));
      if (!from.length) out.push(`  L --> ${ids.get(n.id)}`);
      for (const f of from) out.push(`  ${ids.get(f)} -->|${g.nodes.find((x) => x.id === f).status === 'merged' ? '合并' : '分叉'}| ${ids.get(n.id)}`);
    }
    out.push('  classDef open fill:#e8f0ff,stroke:#4a6fd8;', '  classDef done fill:#e6f6e6,stroke:#3a9a3a;', '  classDef shelved fill:#f2f2f2,stroke:#999,stroke-dasharray:4 3;',
      '  classDef split fill:#fff6e0,stroke:#c9962a;', '  classDef merged fill:#fff6e0,stroke:#c9962a;');
    return out.join('\n');
  }
  const since = (t) => st.events.filter((e) => e.at >= t);
  const first = () => (st.events.length ? Math.min(...st.events.map((e) => e.at)) : 0);

  return { add, seed, track, graph, mermaid, since, first, count: () => st.events.length };
}

module.exports = { createHistory, STATUS, TYPES };
