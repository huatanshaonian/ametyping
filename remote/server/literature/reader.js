// 深读: one paper read together with the model.
//   understand  the user writes what they understood (or want from it) first -- kept in the card's 我的理解 -- and the
//               model compares it with the paper: what is right, what was missed, one question back
//   chat        questions about the paper; every turn is sent with the card, the pages that matter (by the question's
//               words, the selected text, a page asked for) and the talk so far -- nothing relies on the model's memory
//   distill     沉淀: what the talk found worth keeping becomes proposed additions to the card (accepted one by one)
// Topics (专题): a review page built from cards, and a related-work paragraph with \cite{citekey} for a thesis.
//   <dataDir>/literature/chats/<key>.json  { turns: [{ q, a, askBack, sel, page, at }], feedback }
'use strict';
const fs = require('fs');
const path = require('path');
const { FEEDBACK_SCHEMA, CHAT_SCHEMA, DISTILL_SCHEMA, TOPIC_SCHEMA, RELATED_SCHEMA, CARD_SECTIONS, feedbackPrompt, chatPrompt, distillPrompt, topicPrompt, relatedPrompt } = require('./prompts/reader');
const { pickPages, fitPages } = require('./fulltext');

const KEY = /^[A-Z0-9]{8}$/;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };   // (local date)

function createReader({ dir, kb, mirror, fulltext, cards, profile, ask, vision = null, log = () => {}, onChange = () => {} }) {
  const cdir = path.join(dir, 'chats');
  fs.mkdirSync(cdir, { recursive: true });
  const fileOf = (key) => path.join(cdir, key + '.json');
  const load = (key) => { try { return JSON.parse(fs.readFileSync(fileOf(key), 'utf8')); } catch { return { turns: [] }; } };
  const save = (key, c) => { fs.writeFileSync(fileOf(key) + '.tmp', JSON.stringify(c)); fs.renameSync(fileOf(key) + '.tmp', fileOf(key)); };
  const jobs = new Map();                               // key -> { what, running, error }

  function job(key, what, fn) {
    const j = jobs.get(key);
    if (j && j.running) return { ok: false, msg: '上一个问题还在回答' };
    const x = { what, running: true, error: '', at: Date.now() };
    jobs.set(key, x); onChange(key);
    fn().catch((e) => { x.error = e.message; log(`文献：深读（${what}）失败：` + e.message); }).finally(() => { x.running = false; onChange(key); });
    return { ok: true };
  }
  // the paper's text (the pages read as images in their place); a short paper starts being read as images now,
  // this question goes on with what is there
  async function textOf(key) {
    if (vision) vision.prepare(key);
    const ft = await fulltext.forItem(key);
    if (!ft.pages || !ft.pages.length) throw new Error(ft.missing === 'nofile' ? 'PDF 还没同步到群晖，稍后再试' : '这篇没有可读的 PDF 正文');
    return ft;
  }
  const cardText = (key) => { const c = cards.find(key); return c ? c.body : ''; };

  function understand(key, text) {
    if (!KEY.test(key) || !mirror.item(key)) return { ok: false, msg: '找不到这篇' };
    text = String(text || '').trim().slice(0, 6000);
    if (!text) return { ok: false, msg: '先写下你的理解' };
    const w = cards.setOwn(key, '我的理解', text);
    if (!w.ok) return w;
    return job(key, 'feedback', async () => {
      const ft = await textOf(key);
      const it = mirror.item(key);
      const a = await ask(feedbackPrompt(it, cardText(key), pickPages(ft.pages, text.split(/[\s，。,.;；]+/), 50000, ft.labels), text), FEEDBACK_SCHEMA);
      const c = load(key);
      c.feedback = { mine: text, feedback: a.feedback || '', missed: a.missed || [], askBack: a.askBack || '', at: Date.now() };
      save(key, c);
    });
  }

  function chat(key, q, { sel = '', page = 0 } = {}) {
    if (!KEY.test(key) || !mirror.item(key)) return { ok: false, msg: '找不到这篇' };
    q = String(q || '').trim().slice(0, 3000);
    if (!q) return { ok: false, msg: '问题是空的' };
    return job(key, 'chat', async () => {
      const ft = await textOf(key), pages = ft.pages;
      const c = load(key);
      const words = [...q.split(/[\s，。,.;；？?！!、（）()]+/), ...String(sel).split(/\s+/).slice(0, 40)];
      let picked = pickPages(pages, words, 45000, ft.labels);
      const at = ft.labels ? ft.labels.indexOf(page) : page - 1;                 // (the page the user is looking at)
      if (page > 0 && at >= 0 && at < pages.length && !picked.some((p) => p.page === page)) picked = [...picked, { page, text: pages[at] }];
      const it = mirror.item(key);
      const a = await ask(chatPrompt(profile.get() || {}, it, cardText(key), picked, c.turns.slice(-8), q, sel), CHAT_SCHEMA);
      c.turns.push({ q, a: a.answer || '', askBack: a.askBack || '', sel: String(sel).slice(0, 2000), page: page || 0, at: Date.now() });
      c.turns = c.turns.slice(-200);
      save(key, c);
    });
  }

  // 沉淀: the talk -> proposals on the card (only the turns since the last time, or all of them)
  function distill(key) {
    if (!KEY.test(key) || !mirror.item(key)) return { ok: false, msg: '找不到这篇' };
    const c = load(key);
    const turns = c.turns.slice(c.distilled || 0);
    if (!turns.length) return { ok: false, msg: '还没有新的对话可以沉淀' };
    return job(key, 'distill', async () => {
      const card = cards.find(key);
      if (!card) throw new Error('先生成卡片再沉淀');
      const it = mirror.item(key);
      const a = await ask(distillPrompt(it, card.body, turns), DISTILL_SCHEMA);
      let n = 0;
      for (const op of a.ops || []) {
        const section = CARD_SECTIONS.includes(op.section) ? op.section : '我的笔记';
        if (!String(op.text || '').trim()) continue;
        kb.propose({ path: card.path, op: { type: 'append', section, text: op.text }, reason: op.reason || '来自对话', source: 'distill' }); n++;
      }
      const c2 = load(key); c2.distilled = c2.turns.length; c2.lastDistill = { at: Date.now(), n }; save(key, c2);
    });
  }

  const state = (key) => ({ ...load(key), job: jobs.get(key) || null });

  // ---- topics ----
  function topics() { return kb.list('topics').map((r) => ({ path: r.path, title: r.meta.title || path.basename(r.path, '.md'), papers: (r.meta.papers || []).length, updated: r.meta.updated || '' })); }
  function createTopic(name, keywords = []) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) return { ok: false, msg: '专题名是空的' };
    const rel = `topics/${kb.slugify(name)}.md`;
    if (kb.read(rel)) return { ok: false, msg: '这个专题已经有了' };
    const body = `# ${name}\n\n## 综述\n\n（点「从卡片更新」让 AI 起草，或者自己写）\n\n## 关键证据\n\n## 分歧\n\n## 空白与机会\n\n## 我的判断\n`;
    const r = kb.write(rel, kb.stringify({ title: name, keywords: keywords.slice(0, 12), papers: [], updated: today() }, body), '', '新专题');
    if (r.ok) kb.rebuildIndex();
    return { ...r, path: rel };
  }
  // the cards that belong to a topic: linked from it, or matching its keywords / name
  function topicCards(t) {
    const linked = new Set([...(t.meta.papers || []), ...[...t.body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1])]);
    const words = [t.meta.title || '', ...(t.meta.keywords || [])].map((w) => String(w).toLowerCase()).filter((w) => w.length > 1);
    return kb.list('papers').filter((r) => linked.has(path.basename(r.path, '.md')) || words.some((w) => r.text.toLowerCase().includes(w)))
      .slice(0, 40).map((r) => ({ citekey: path.basename(r.path, '.md'), title: r.meta.title || '', text: r.body }));
  }
  function updateTopic(rel) {
    const t = kb.read(rel);
    if (!t || !rel.startsWith('topics/')) return { ok: false, msg: '找不到这个专题' };
    return job('topic:' + rel, 'topic', async () => {
      const cs = topicCards(t);
      if (!cs.length) throw new Error('还没有和这个专题相关的卡片（在专题里写 [[citekey]] 或关键词）');
      const a = await ask(topicPrompt(profile.get() || {}, t.meta.title || '', t.body, cs), TOPIC_SCHEMA);
      const mine = (t.sections.find((s) => s.title === '我的判断') || {}).text || '';
      const body = `# ${t.meta.title}\n\n## 综述\n\n${a.overview}\n\n## 关键证据\n\n${(a.evidence || []).map((x) => '- ' + x).join('\n')}\n\n## 分歧\n\n${(a.disagreements || []).map((x) => '- ' + x).join('\n')}\n\n## 空白与机会\n\n${(a.gaps || []).map((x) => '- ' + x).join('\n')}\n\n## 我的判断\n\n${mine}\n`;
      kb.propose({ path: rel, op: { type: 'replace-all', text: body }, reason: `专题「${t.meta.title}」按 ${cs.length} 张卡片更新`, source: 'topic' });
    });
  }
  async function relatedWork(rel) {
    const t = kb.read(rel);
    if (!t) throw new Error('找不到这个专题');
    const cs = topicCards(t);
    const a = await ask(relatedPrompt(t.meta.title || '', t.body, cs), RELATED_SCHEMA);
    return { paragraph: a.paragraph || '', used: a.used || [] };
  }
  const topicState = (rel) => jobs.get('topic:' + rel) || null;

  return { understand, chat, distill, state, topics, createTopic, updateTopic, relatedWork, topicState };
}

module.exports = { createReader };
