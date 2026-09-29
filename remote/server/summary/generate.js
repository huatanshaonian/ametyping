// Writes one report for [from, to): every stored session that said something in that window is condensed
// (digest.js), hinted (classify.js); long ones get a summary of their own first (cached), then the model writes the
// day (prompts.js). The numbers -- minutes, files, sessions, how to resume them -- are counted here, not by the model.
'use strict';
const path = require('path');
const { digest } = require('./digest');
const { runCodex } = require('./codex');
const { DAY_SCHEMA, SESSION_SCHEMA, sessionPrompt, dayPrompt } = require('./prompts');

const SESSION_INLINE = 20000;      // a session longer than this (chars) is summarized on its own first
const SESSION_MAX = 120000;        // what one session summary may be given at most
const DAY_MAX = 150000;            // the day's prompt: summarize more sessions until it fits

function createGenerator({ store, reports, egress, classify, codex, resumeCmd, log = () => {} }) {
  // one question to the model, through whichever proxy gets through (none configured: direct)
  async function ask(prompt, schema) {
    let env = { ...process.env };
    if (egress) {
      const proxy = await egress.pick('chatgpt.com');
      if (!proxy) throw new Error('连不上 OpenAI：电脑上的代理和 AWS 备用线路都不通');
      env = egress.env(proxy);
    }
    if (codex.pathPrefix) env.PATH = codex.pathPrefix + path.delimiter + (env.PATH || '');
    try { return await runCodex({ bin: codex.bin, model: codex.model, prompt, schema, env, timeoutMs: codex.timeoutMs }); }
    catch (e) { if (egress) egress.forget(); throw e; }
  }

  // the sessions active in the window, oldest first, as S1, S2, ...
  function collect(from, to) {
    const items = [];
    for (const [machine, list] of Object.entries(store.sessions())) {
      for (const e of list) {
        if (e.last < from || e.first >= to) continue;
        const recs = store.records(machine, e.id, from, to).filter((r) => r.role !== 'title');
        if (!recs.some((r) => r.role === 'user' || r.role === 'assistant')) continue;
        const s = { machine, id: e.id, title: e.title, project: e.project, cwd: e.cwd };
        const d = digest(s, recs);
        items.push({ s, recs, digest: d, hint: classify(d) });
      }
    }
    items.sort((a, b) => a.digest.first - b.digest.first);
    items.forEach((it, i) => { it.key = 'S' + (i + 1); });
    return items;
  }

  async function summarizeSession(it, from) {
    const key = `${it.s.machine}|${it.s.id}|${from}|${it.digest.last}`;
    const cached = reports.cacheGet(key);
    if (cached) { it.summary = cached; return; }
    let d = it.digest;
    if (d.text.length > SESSION_MAX) d = digest(it.s, it.recs, { userMax: 600, replyMax: 150 });
    if (d.text.length > SESSION_MAX) d = { ...d, text: d.text.slice(0, SESSION_MAX * 0.25) + '\n……（中间省略）……\n' + d.text.slice(-SESSION_MAX * 0.75) };
    log(`日报：先总结长会话 ${it.key}（${it.s.title || it.s.id}，${d.text.length} 字）`);
    it.summary = await ask(sessionPrompt(d, it.hint), SESSION_SCHEMA);
    reports.cachePut(key, it.summary);
  }

  // job: { from, to, date, draft }
  async function generate(job) {
    const { from, to, date } = job;
    const items = collect(from, to);
    const prev = reports.latest();
    const open = prev ? (prev.open || []).filter((o) => o.status === 'open') : [];
    for (const it of items) if (it.digest.text.length > SESSION_INLINE) await summarizeSession(it, from);
    const size = () => items.reduce((n, it) => n + (it.summary ? 800 : it.digest.text.length), 0);
    for (const it of [...items].sort((a, b) => b.digest.text.length - a.digest.text.length)) {
      if (size() <= DAY_MAX) break;
      if (!it.summary && it.digest.text.length > 3000) await summarizeSession(it, from);
    }
    const ans = items.length
      ? await ask(dayPrompt({ from, to, sessions: items, open }), DAY_SCHEMA)
      : { headline: '这段时间没有 AI 会话记录', projects: [], open: open.map((o, i) => ({ ref: 'O' + (i + 1), text: o.text, project: o.project, status: 'open' })), plans: [], keywords: [] };
    const report = assemble(job, items, open, ans);
    reports.save(report);
    log(`日报 ${job.draft ? '（到现在）' : date} 已生成：${items.length} 个会话，${report.stats.minutes} 分钟`);
    return report;
  }

  function assemble({ from, to, date, draft }, items, open, ans) {
    const byKey = new Map(items.map((it) => [it.key, it]));
    const catOf = new Map();
    const projects = (ans.projects || []).map((p) => {
      const its = (p.sessions || []).map((k) => byKey.get(k)).filter(Boolean);
      for (const it of its) if (!catOf.has(it.key)) catOf.set(it.key, p.category);
      const files = new Map();
      for (const it of its) for (const f of it.digest.files) files.set(it.s.machine + '|' + f.path, { machine: it.s.machine, ...f });
      return { name: p.name, category: p.category, summary: p.summary, done: p.done, decisions: p.decisions, unfinished: p.unfinished,
        sessions: its.map((it) => it.key), minutes: its.reduce((n, it) => n + it.digest.activeMin, 0), files: [...files.values()] };
    });
    // the rolling open list: the model's answer, earlier items keep the day they were first written down; one the
    // model left out stays open
    const prevByRef = new Map(open.map((o, i) => ['O' + (i + 1), o]));
    const seen = new Set();
    const openOut = (ans.open || []).map((o) => {
      const p = prevByRef.get(o.ref); if (p) seen.add(o.ref);
      return { text: o.text, project: o.project, status: o.status, since: p ? p.since : date };
    });
    for (const [ref, o] of prevByRef) if (!seen.has(ref)) openOut.push(o);
    const sessions = items.map((it) => {
      const d = it.digest;
      return { key: it.key, machine: d.machine, id: d.id, title: d.title || d.project || '', project: d.project, cwd: d.cwd,
        minutes: d.activeMin, first: d.first, last: d.last, category: catOf.get(it.key) || it.hint.cat || '',
        files: d.files, cmds: d.cmds, resume: resumeCmd ? resumeCmd(d.cwd, d.id) : '' };
    });
    return {
      date, draft: !!draft, from, to, generatedAt: Date.now(),
      headline: ans.headline || '', projects, open: openOut,
      plans: (ans.plans || []).map((p) => ({ title: p.title, project: p.project, session: p.session })),
      keywords: ans.keywords || [], sessions,
      stats: { minutes: sessions.reduce((n, s) => n + s.minutes, 0), sessions: sessions.length,
        machines: new Set(sessions.map((s) => s.machine)).size, files: sessions.reduce((n, s) => n + s.files.length, 0) },
    };
  }

  return { generate, collect };
}

module.exports = { createGenerator };
