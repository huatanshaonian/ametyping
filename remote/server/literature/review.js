// 回顾: every month (lightly) and every quarter (in full) the model looks back -- the work reports, the cards and the
// user's own understanding, what was taken and skipped from the push, the changes already made to the questions, and
// for a quarter the field's last year of literature -- and proposes: the progress on each question, changes to the
// questions (修改 细化 分叉 合并 搁置 解决 新增), for a quarter a change of the line, and what to do next
// (prompts/review.js). A review is a draft until the user has gone through it: each change is accepted (as it is or
// reworded) or rejected, and only 应用 writes the accepted ones into the profile and the history (history.js). The
// review itself and the questions' graph are kept in the knowledge base (reviews/<id>.md, reviews/问题演化.md).
//   <dataDir>/literature/reviews/<id>.json  { id, kind: month | quarter, period, from, to, at, auto, status: draft | done |
//       discarded, summary, qs: [{ ref, id, text }], progress: [{ qid, ref, state, note, evidence }],
//       changes: [{ id, type, qids, text, dim, children: [{ text, dim }], reason, evidence, refs, decision }],
//       line: { change, text, before, reason, decision }, next: [], fresh }
// On the 1st of a month (a quarter's first month: the full one) a review is made by itself, once the history is three
// weeks old; 现在回顾 makes one at any time. The period runs from the last review to now.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SEARCH_SCHEMA, REVIEW_SCHEMA, searchPrompt, reviewPrompt, CHANGES, PROGRESS, DIMS } = require('./prompts/review');

const DAY = 86400e3;
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const qid = () => crypto.randomBytes(4).toString('hex');
const NAME = { month: '月度回顾', quarter: '季度回顾' };
const BY = { user: '你', organize: '梳理', review: '回顾' };

function createReview({ dir, kb, profile, history, feed, reports = () => null, ask, survey = null, canWrite = () => false, auto = true, log = () => {}, onChange = () => {}, now = () => Date.now() }) {
  const rdir = path.join(dir, 'reviews');
  fs.mkdirSync(rdir, { recursive: true });
  fs.mkdirSync(path.join(kb.dir, 'reviews'), { recursive: true });
  const fileOf = (id) => path.join(rdir, id + '.json');
  const read = (id) => { try { return /^[\w-]{1,40}$/.test(id) ? JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) : null; } catch { return null; } };
  const write = (r) => { fs.writeFileSync(fileOf(r.id) + '.tmp', JSON.stringify(r, null, 1)); fs.renameSync(fileOf(r.id) + '.tmp', fileOf(r.id)); };
  const all = () => { let ns = []; try { ns = fs.readdirSync(rdir).filter((n) => n.endsWith('.json')); } catch {} return ns.map((n) => read(n.slice(0, -5))).filter(Boolean).sort((a, b) => b.at - a.at); };
  const list = () => all().map((r) => ({ id: r.id, kind: r.kind, from: r.from, to: r.to, at: r.at, auto: !!r.auto, status: r.status, changes: r.changes.length + (r.line && r.line.change ? 1 : 0),
    accepted: r.changes.filter((c) => c.decision === 'accepted').length + (r.line && r.line.decision === 'accepted' ? 1 : 0) }));
  let job = null, timer = null;
  const state = () => (job ? { running: job.running, kind: job.kind, step: job.step, error: job.error, at: job.at } : null);
  const changed = () => { try { onChange(); } catch {} };

  // ---- what the period held ----
  function material(kind, fromT, toT, qs, fresh) {
    const from = ymd(fromT), to = ymd(toT), p = profile.get();
    const R = reports();
    const weeks = [], days = [];
    if (R) {
      for (const w of (R.listWeeks ? R.listWeeks() : []).filter((w) => w.start >= from && w.start <= to).reverse().slice(-14)) {
        const full = R.getWeek(w.start) || {};
        const hi = [].concat(full.highlights || []).map((x) => (typeof x === 'string' ? x : x && (x.text || x.title || ''))).filter(Boolean).slice(0, 5);
        weeks.push(`- ${w.start} 那一周：${cut(w.headline, 200)}${hi.length ? '；' + cut(hi.join('；'), 400) : ''}`);
      }
      if (kind === 'month' || !weeks.length) for (const d of (R.list() || []).filter((x) => x.date >= from && x.date <= to).reverse().slice(-62)) if (d.headline) days.push(`- ${d.date}：${cut(d.headline, 180)}`);
    }
    const cards = kb.list('papers').filter((r) => String(r.meta.updated || '') >= from && r.meta.status && r.meta.status !== 'none').sort((a, b) => String(b.meta.updated).localeCompare(String(a.meta.updated))).slice(0, 40).map((r) => {
      const one = (/^>\s*(.+)$/m.exec(r.body) || [])[1] || '';
      const mine = (r.sections.find((s) => s.title === '我的理解') || {}).text || '';
      return `- 《${cut(r.meta.title, 110)}》${r.meta.year ? `（${r.meta.year}）` : ''}［${r.meta.status === 'quick' ? '速读' : r.meta.verified ? '深读并核对' : '深读'}］${cut(one, 160)}${mine ? `\n  用户自己的理解：${cut(mine, 220)}` : ''}`;
    });
    const es = feed.entries().filter((e) => (e.decidedAt || 0) >= fromT && (e.decidedAt || 0) <= toT && e.paper);
    const hist = history.since(fromT).filter((e) => e.at <= toT).slice(-40).map((e) => `- ${ymd(e.at)} ${BY[e.by] || e.by}${e.type}${e.type === '主线' ? '' : `：${cut(e.text, 100)}`}${e.before ? `（原：${cut(e.before, 80)}）` : ''}`);
    return { kind, from, to, line: p.line || '', questions: qs, history: hist, weeks, days, cards,
      kept: es.filter((e) => e.status === 'kept').map((e) => e.paper.title).slice(0, 30), skipped: es.filter((e) => e.status === 'skipped').map((e) => e.paper.title).slice(0, 30), fresh };
  }

  // kind: 'month' | 'quarter'; period: what an automatic one is for (e.g. "2026-10": not made twice)
  function start(kind, { auto: isAuto = false, period = '' } = {}) {
    kind = kind === 'quarter' ? 'quarter' : 'month';
    if (job && job.running) return { ok: false, msg: '正在回顾' };
    const p = profile.get();
    if (!p || !(p.questions || []).some((q) => q.status !== 'done')) return { ok: false, msg: '画像里还没有在研的问题' };
    const draft = all().find((r) => r.status === 'draft');
    if (draft) return { ok: false, msg: '上一次回顾还没处理完（先应用或放弃它）', id: draft.id };
    history.seed(p);
    job = { running: true, kind, step: '整理这段时间的记录', error: '', at: now() };
    changed();
    (async () => {
      const toT = now(), last = all().find((r) => r.status === 'done');
      const fromT = Math.max(last ? Date.parse(last.to + 'T00:00:00') : history.first() || toT - 30 * DAY, toT - (kind === 'quarter' ? 100 : 45) * DAY);
      const qs = p.questions.filter((q) => q.status !== 'done').map((q, i) => ({ ref: 'Q' + (i + 1), id: q.id, text: q.text, dim: q.dim, why: q.why, status: q.status }));
      let fresh = [];
      if (kind === 'quarter' && profile.frontier) {
        job.step = '检索近一年的文献'; changed();
        try { const s = await ask(searchPrompt(p.line || '', qs), SEARCH_SCHEMA); fresh = (await profile.frontier((s.queries || []).slice(0, 10), 1, 6, 40)).map((w, i) => ({ ref: 'N' + (i + 1), ...w })); }
        catch (e) { log('文献：回顾时检索文献失败（不带新文献继续）：' + e.message); }
      }
      job.step = '回顾进展、提出建议'; changed();
      const a = await ask(reviewPrompt(material(kind, fromT, toT, qs, fresh)), REVIEW_SCHEMA);
      const byRef = new Map(qs.map((q) => [q.ref, q])), byN = new Map(fresh.map((w) => [w.ref, w]));
      const ref = (s) => byRef.get(String(s || '').toUpperCase().replace(/[^Q\d]/g, ''));
      // (a new paper named by its number in a sentence: its short title instead)
      const named = (t) => String(t || '').replace(/\[?\b(N\d{1,3})\b\]?/g, (m, r) => { const w = byN.get(r); return w ? `《${cut(w.title, 40)}》` : m; }).trim();
      const dim = (d) => (DIMS.includes(d) ? d : '');
      const changes = [];
      for (const c of a.changes || []) {
        if (!CHANGES.includes(c.type)) continue;
        const ids = [...new Set((c.q || []).map(ref).filter(Boolean).map((q) => q.id))];
        const text = named(c.text).slice(0, 300);
        const children = (c.children || []).map((x) => ({ text: named(x.text).slice(0, 300), dim: dim(x.dim) })).filter((x) => x.text).slice(0, 4);
        if (c.type === '新增' ? !text : c.type === '合并' ? ids.length < 2 || !text : !ids.length) continue;
        if ((c.type === '修改' || c.type === '细化') && !text) continue;
        if (c.type === '分叉' && children.length < 2) continue;
        changes.push({ id: qid(), type: c.type, qids: c.type === '新增' ? [] : c.type === '合并' ? ids : ids.slice(0, 1), text: c.type === '分叉' ? '' : text, dim: dim(c.dim), children: c.type === '分叉' ? children : [],
          reason: named(c.reason).slice(0, 500), evidence: named(c.evidence).slice(0, 500),
          refs: [...new Set(c.refs || [])].map((r) => byN.get(String(r).toUpperCase().replace(/[^N\d]/g, ''))).filter(Boolean).slice(0, 4).map((w) => ({ title: w.title, year: w.year, venue: w.venue, url: w.url, doi: w.doi })), decision: '' });
      }
      const lineText = named(a.line && a.line.text).slice(0, 6000);
      const r = { id: `${ymd(toT)}-${kind}${all().some((x) => x.id === `${ymd(toT)}-${kind}`) ? '-' + qid().slice(0, 3) : ''}`, kind, period, auto: isAuto, from: ymd(fromT), to: ymd(toT), at: toT, status: 'draft',
        summary: named(a.summary).slice(0, 2000), qs: qs.map((q) => ({ ref: q.ref, id: q.id, text: q.text })),
        progress: (a.progress || []).map((x) => { const q = ref(x.q); return q && { qid: q.id, ref: q.ref, state: PROGRESS.includes(x.state) ? x.state : '未开始', note: named(x.note).slice(0, 500), evidence: named(x.evidence).slice(0, 300) }; }).filter(Boolean),
        changes, line: kind === 'quarter' && a.line && a.line.change && lineText && lineText !== String(p.line || '').trim() ? { change: true, text: lineText, before: p.line || '', reason: named(a.line.reason).slice(0, 600), decision: '' } : { change: false },
        next: (a.next || []).map((x) => named(x).slice(0, 300)).filter(Boolean).slice(0, 6), fresh: fresh.length };
      write(r);
      log(`文献：${NAME[kind]}（${r.from} ～ ${r.to}）写好了：${changes.length} 条变动建议${r.line.change ? '、主线调整 1 条' : ''}，等你审批`);
    })().catch((e) => { job.error = e.message; log(`文献：${NAME[kind]}失败：${e.message}`); }).finally(() => { job.running = false; changed(); });
    return { ok: true };
  }

  // the user's verdict on one change (cid 'line': the line's): accepted -- as it is or reworded -- or rejected ('' undoes)
  function decide(id, cid, decision, patch = {}) {
    const r = read(id);
    if (!r || r.status !== 'draft') return { ok: false, msg: '这次回顾已经处理过了' };
    const c = cid === 'line' ? (r.line.change ? r.line : null) : r.changes.find((x) => x.id === cid);
    if (!c) return { ok: false, msg: '找不到这条建议' };
    c.decision = decision === 'accepted' || decision === 'rejected' ? decision : '';
    if (typeof patch.text === 'string' && patch.text.trim() && c.type !== '分叉') { const t = patch.text.trim().slice(0, cid === 'line' ? 6000 : 300); if (t !== c.text) c.edited = true; c.text = t; }
    if (Array.isArray(patch.children) && c.type === '分叉') {
      const ch = patch.children.map((x) => ({ text: String((x && x.text) || '').trim().slice(0, 300), dim: DIMS.includes(x && x.dim) ? x.dim : '' })).filter((x) => x.text).slice(0, 4);
      if (ch.length >= 2) { if (JSON.stringify(ch) !== JSON.stringify(c.children)) c.edited = true; c.children = ch; }
    }
    write(r); changed();
    return { ok: true };
  }

  // the accepted changes into the profile and the history; the rest dropped; the review filed in the knowledge base
  function apply(id) {
    const r = read(id), p = profile.get();
    if (!r || r.status !== 'draft' || !p) return { ok: false, msg: '这次回顾已经处理过了' };
    let qs = (p.questions || []).map((q) => ({ ...q, refs: [...(q.refs || [])] }));
    const events = [], note = { review: r.id, by: 'review' };
    const addRefs = (q, refs) => { for (const x of refs || []) if (!q.refs.some((y) => (y.doi && y.doi === x.doi) || y.title === x.title)) q.refs.push(x); q.refs = q.refs.slice(0, 6); };
    let applied = 0;
    for (const c of r.changes.filter((x) => x.decision === 'accepted')) {
      const at = qs.findIndex((q) => q.id === c.qids[0]), q = qs[at];
      if (c.type !== '新增' && !q) { c.skipped = '问题已经不在画像里'; continue; }
      const base = { ...note, reason: c.reason, evidence: c.evidence };
      if (c.type === '修改' || c.type === '细化') { events.push({ ...base, type: c.type, qid: q.id, text: c.text, before: q.text, dim: c.dim || q.dim }); q.text = c.text; if (c.dim) q.dim = c.dim; addRefs(q, c.refs); }
      else if (c.type === '搁置' || c.type === '解决') { q.status = c.type === '搁置' ? 'shelved' : 'done'; events.push({ ...base, type: c.type, qid: q.id, text: q.text }); }
      else if (c.type === '分叉') {
        const kids = c.children.map((x) => ({ id: qid(), dim: x.dim || q.dim || '', text: x.text, why: `由「${cut(q.text, 60)}」分叉`, state: '', refs: [...q.refs], status: 'open' }));
        for (const k of kids) addRefs(k, c.refs);
        events.push({ ...base, type: '分叉', qid: q.id, text: q.text }, ...kids.map((k) => ({ ...note, type: '新增', qid: k.id, text: k.text, dim: k.dim, from: [q.id], reason: `由「${cut(q.text, 80)}」分叉` })));
        qs.splice(at, 1, ...kids);
      } else if (c.type === '合并') {
        const olds = qs.filter((x) => c.qids.includes(x.id));
        if (olds.length < 2) { c.skipped = '要合并的问题已经不全'; continue; }
        const k = { id: qid(), dim: c.dim || olds[0].dim || '', text: c.text, why: cut(c.reason, 300), state: '', refs: [], status: 'open' };
        for (const o of olds) addRefs(k, o.refs);
        addRefs(k, c.refs);
        events.push(...olds.map((o) => ({ ...base, type: '合并', qid: o.id, text: o.text })), { ...note, type: '新增', qid: k.id, text: k.text, dim: k.dim, from: olds.map((o) => o.id), reason: '合并而来：' + cut(c.reason, 300) });
        qs = qs.filter((x) => !c.qids.includes(x.id) || x.id === olds[0].id).map((x) => (x.id === olds[0].id ? k : x));
      } else if (c.type === '新增') {
        const k = { id: qid(), dim: c.dim || '贴合工作', text: c.text, why: cut(c.reason, 300), state: cut(c.evidence, 600), refs: [], status: 'open' };
        addRefs(k, c.refs);
        qs.push(k); events.push({ ...base, type: '新增', qid: k.id, text: k.text, dim: k.dim });
      }
      applied++;
    }
    let line = p.line;
    if (r.line.change && r.line.decision === 'accepted') { events.push({ ...note, type: '主线', text: r.line.text, before: p.line || undefined, reason: r.line.reason }); line = r.line.text; applied++; }
    profile.replace({ questions: qs, line });
    history.add(events);
    r.status = 'done'; r.appliedAt = now(); r.applied = applied;
    write(r);
    file(r);
    // (new papers the accepted changes rest on: into 调研工作, as after a 梳理)
    if (survey && canWrite() && survey.waiting().length) survey.run();
    log(`文献：${NAME[r.kind]} ${r.id} 已应用：${applied} 条变动写进了画像`);
    changed();
    return { ok: true, applied };
  }
  function discard(id) {
    const r = read(id);
    if (!r || r.status !== 'draft') return { ok: false, msg: '这次回顾已经处理过了' };
    r.status = 'discarded'; write(r); changed();
    return { ok: true };
  }

  // the knowledge base's copy: the review as it was decided, and the questions' graph (Obsidian draws the Mermaid)
  function file(r) {
    const q = (id) => { const x = r.qs.find((y) => y.id === id); return x ? `${x.ref} ${cut(x.text, 70)}` : ''; };
    const verdict = (c) => (c.decision === 'accepted' ? (c.skipped ? '（接受了，但没能应用：' + c.skipped + '）' : c.edited ? '✅ 接受（改写过）' : '✅ 接受') : '❌ 没采纳');
    const body = [`# ${NAME[r.kind]} ${r.from} ～ ${r.to}`, '', r.summary, '', '## 各问题的进展', '',
      ...r.progress.map((x) => `- **${x.state}** ${q(x.qid)}\n  - ${x.note}${x.evidence ? `\n  - 依据：${x.evidence}` : ''}`), '', '## 变动', '',
      ...(r.changes.length || r.line.change ? [] : ['（这次没有建议变动）']),
      ...r.changes.map((c) => `- ${verdict(c)} **${c.type}**${c.qids.length ? ' ' + c.qids.map(q).join('、') : ''}${c.text ? ` → ${c.text}` : ''}${c.children.length ? ' → ' + c.children.map((x) => x.text).join('；') : ''}\n  - 理由：${c.reason}${c.evidence ? `\n  - 依据：${c.evidence}` : ''}`),
      ...(r.line.change ? [`- ${verdict(r.line)} **主线调整**\n  - 理由：${r.line.reason}`] : []), '', '## 下一步', '', ...r.next.map((x) => '- ' + x), ''].join('\n');
    try {
      kb.write(`reviews/${r.id}.md`, kb.stringify({ title: `${NAME[r.kind]} ${r.from} ～ ${r.to}`, kind: r.kind, from: r.from, to: r.to, updated: ymd(now()) }, body), null, NAME[r.kind]);
      kb.write('reviews/问题演化.md', kb.stringify({ title: '问题演化', updated: ymd(now()) }, '# 问题演化\n\n主线和各个问题的来历（每次回顾应用后更新；细节在「文献 › 回顾」里）。\n\n```mermaid\n' + history.mermaid() + '\n```\n'), null, '');
    } catch (e) { log('文献：回顾写进知识库失败：' + e.message); }
  }

  // the 1st to the 3rd of a month, after 8: last month's review (a quarter's first month: the quarter's), once
  function tick() {
    if (!auto || (job && job.running)) return;
    const d = new Date(now()), p = profile.get();
    if (d.getDate() > 3 || d.getHours() < 8 || !p || !p.confirmed) return;
    const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (all().some((r) => r.period === period || r.status === 'draft')) return;
    history.seed(p);
    if (now() - history.first() < 21 * DAY) return;
    start(d.getMonth() % 3 === 0 ? 'quarter' : 'month', { auto: true, period });
  }
  function startTimer() { timer = setInterval(tick, 3600e3); timer.unref && timer.unref(); setTimeout(tick, 90e3).unref(); }

  return { start, list, get: read, decide, apply, discard, state, tick, startTimer, stop: () => timer && clearInterval(timer), drafts: () => all().filter((r) => r.status === 'draft').length };
}

module.exports = { createReview };
