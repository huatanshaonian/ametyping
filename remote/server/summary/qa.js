// 问一问: a question answered from what the NAS keeps. The model first turns the question into search words (a Chinese
// question has no spaces to split on), each word is searched (search.js), results found by more words rank higher;
// then the model answers from the best reports, conversation passages and artifacts only, naming its sources.
// One question at a time; the latest answer is kept for the window to show.
'use strict';

const str = { type: 'string' }, strs = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });
const TERMS_SCHEMA = obj({ terms: strs });
const ANSWER_SCHEMA = obj({ answer: str, sources: strs });

const fmt = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function createQA({ search, reports, notes = null, ask, log = () => {} }) {
  let job = null;

  // every word searched on its own; a result scores one point per word that found it
  function gather(terms) {
    const R = new Map(), C = new Map(), F = new Map(), N = new Map();
    for (const t of terms) {
      const r = search.search(t, { maxSessions: 20, hitsPerSession: 2 });
      for (const x of r.reports) { const e = R.get(x.date) || { ...x, score: 0 }; e.score++; R.set(x.date, e); }
      for (const x of r.sessions) {
        const k = x.machine + '|' + x.id;
        const e = C.get(k) || { ...x, hits: [], score: 0 };
        e.score++; for (const h of x.hits) if (e.hits.length < 4 && !e.hits.some((y) => y.snippet === h.snippet)) e.hits.push(h);
        C.set(k, e);
      }
      for (const x of r.artifacts) { const k = x.machine + '|' + x.path; const e = F.get(k) || { ...x, score: 0 }; e.score++; F.set(k, e); }
      for (const x of r.notes || []) { const e = N.get(x.id) || { ...x, score: 0 }; e.score++; N.set(x.id, e); }
    }
    const top = (m, n, by) => [...m.values()].sort((a, b) => b.score - a.score || by(b) - by(a)).slice(0, n);
    return { reports: top(R, 6, (x) => Date.parse(x.date)), sessions: top(C, 15, (x) => x.last), artifacts: top(F, 10, (x) => Date.parse(x.last || 0) || 0), notes: top(N, 6, (x) => x.updated) };
  }

  function context(found) {
    const parts = [];
    found.reports.forEach((x, i) => {
      const r = reports.get(x.date) || {};
      const projects = (r.projects || []).map((p) => `${p.name}：${p.summary || ''}${(p.done || []).length ? ' 做成：' + p.done.join('；') : ''}`).join('\n');
      parts.push(`[R${i + 1}] ${x.date} 的日报：${r.headline || ''}\n${projects}`.slice(0, 1800));
    });
    found.sessions.forEach((s, i) => parts.push(`[C${i + 1}] 会话「${s.title}」（电脑 ${s.machine}，最近 ${fmt(s.last)}）\n` +
      s.hits.map((h) => `  ${fmt(h.t)} ${h.role === 'user' ? '我' : h.role === 'assistant' ? '助手' : '工具'}：${h.snippet}`).join('\n')));
    found.notes.forEach((n, i) => { const full = notes ? notes.get(n.id) : null; parts.push(`[N${i + 1}] 笔记「${n.title}」（${fmt(n.updated)} 改过）\n${(full ? full.text : n.snippet).slice(0, 1500)}`); });
    found.artifacts.forEach((a, i) => parts.push(`[F${i + 1}] 文件 ${a.path}（电脑 ${a.machine}，${a.last || a.first || ''}${a.note ? '，' + a.note : ''}${a.backed ? '，群晖有副本' : ''}）`));
    return parts.join('\n\n');
  }

  async function run(j) {
    const t = await ask([
      '用户想从自己过去和 AI 编程助手的对话、工作日报、产出的文件里找东西。把下面的问题变成 3～8 个搜索词：',
      '关键名词、文件名、技术名词，中文和英文写法都给（如「画图」和 plot、matplotlib），每个词尽量短（2～6 个字或一个英文单词），不要整句。',
      '', '问题：' + j.q,
    ].join('\n'), TERMS_SCHEMA);
    j.terms = [...new Set((t.terms || []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 10);
    const found = gather(j.terms);
    j.found = { reports: found.reports.length, sessions: found.sessions.length, artifacts: found.artifacts.length, notes: found.notes.length };
    if (!found.reports.length && !found.sessions.length && !found.artifacts.length && !found.notes.length) {
      Object.assign(j, { answer: `没有找到相关的记录（搜了：${j.terms.join('、')}）。可以换个说法再问，或者直接在上面的搜索框里搜关键词。`, sources: [] });
      return;
    }
    const a = await ask([
      '根据下面找到的资料回答用户的问题。只用资料里的信息；资料里没有的就说没找到，不要编造。',
      '回答用简体中文，直接给结论（例如文件在哪、哪天做的、怎么做的），提到的内容在句末标出处编号，如 [C2]、[F1]、[R3]、[N1]。',
      'sources 列出用到的编号（如 C2）。', '', '问题：' + j.q, '', '资料：', context(found),
    ].join('\n'), ANSWER_SCHEMA);
    const pick = (ref) => {
      const m = /^([RCFN])(\d+)$/.exec(String(ref).replace(/[[\]\s]/g, '')); if (!m) return null;
      const i = +m[2] - 1;
      if (m[1] === 'R' && found.reports[i]) return { ref: m[0], kind: 'report', date: found.reports[i].date, headline: found.reports[i].headline };
      if (m[1] === 'C' && found.sessions[i]) { const s = found.sessions[i]; return { ref: m[0], kind: 'session', machine: s.machine, id: s.id, title: s.title }; }
      if (m[1] === 'N' && found.notes[i]) return { ref: m[0], kind: 'note', id: found.notes[i].id, title: found.notes[i].title };
      if (m[1] === 'F' && found.artifacts[i]) { const f = found.artifacts[i]; return { ref: m[0], kind: 'artifact', machine: f.machine, path: f.path, sha: f.backed ? f.sha : '', note: f.note || '' }; }
      return null;
    };
    Object.assign(j, { answer: a.answer || '', sources: [...new Set(a.sources || [])].map(pick).filter(Boolean) });
  }

  function start(q) {
    if (job && job.running) return { ok: false, msg: '上一个问题还在回答' };
    q = String(q || '').trim().slice(0, 300);
    if (!q) return { ok: false, msg: '问题是空的' };
    const j = job = { q, running: true, started: Date.now() };
    run(j).catch((e) => { j.error = e.message; log('问一问失败：' + e.message); }).finally(() => { j.running = false; j.at = Date.now(); });
    return { ok: true };
  }
  const state = () => job && { q: job.q, running: job.running, terms: job.terms || [], found: job.found || null, answer: job.answer || '', sources: job.sources || [], error: job.error || '' };
  return { start, state };
}

module.exports = { createQA, TERMS_SCHEMA, ANSWER_SCHEMA };
