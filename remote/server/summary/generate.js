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

// not artifacts: scratch space and the assistants' own folders (plans, memory, sessions)
const NOT_ARTIFACT = /[\\/](\.claude|\.codex|tmp|temp|node_modules|__pycache__|\.git)([\\/]|$)/i;
const MAX_ARTIFACTS = 80;

function createGenerator({ store, reports, egress, classify, codex, resumeCmd, log = () => {}, artifacts = null, todos = null, backupBytes = 5e6 }) {
  // files the sessions wrote that git does not keep (no repository with a remote, or not committed): each machine's
  // agent checks them (only files that session wrote, not secrets) and sends copies of small ones. A machine that is
  // offline: its files are listed unchecked.
  async function findArtifacts(items) {
    const byPath = new Map();
    for (const it of items) for (const f of it.digest.files) {
      if (NOT_ARTIFACT.test(f.path)) continue;
      const k = it.s.machine + '|' + f.path;
      let a = byPath.get(k);
      if (!a) { a = { machine: it.s.machine, path: f.path, op: f.op, keys: new Set(), ids: new Set() }; byPath.set(k, a); }
      if (f.op === 'write') a.op = 'write';
      a.keys.add(it.key); a.ids.add(it.s.id);
    }
    const out = [];
    const machinesOf = new Map();
    for (const a of byPath.values()) { if (!machinesOf.has(a.machine)) machinesOf.set(a.machine, []); machinesOf.get(a.machine).push(a); }
    for (const [machine, list] of machinesOf) {
      const res = artifacts ? await artifacts.check(machine, list.map((a) => ({ id: [...a.ids][0], path: a.path })), { maxBytes: backupBytes }) : null;
      const got = new Map((res || []).map((r) => [r.path, r]));
      let refused = 0;
      for (const a of list) {
        const r = got.get(a.path);
        if (res && (!r || !r.ok)) { refused++; continue; }             // not that session's, a secret, or unreadable
        if (r && !r.exists) continue;                                  // written and gone again
        if (r && r.repo && r.repo.remote && r.repo.tracked) continue;  // committed to a repository with a remote
        out.push({ machine, path: a.path, op: a.op, sessions: [...a.keys], sessionIds: [...a.ids], unchecked: !res,
          size: r ? r.size : 0, mtime: r ? r.mtime : 0, exists: r ? r.exists : null, sha: r ? r.sha : '', backed: !!(r && r.backed),
          repo: r && r.repo ? { root: r.repo.root, remote: r.repo.remote, tracked: r.repo.tracked } : null });
      }
      if (refused) log(`日报：${machine} 有 ${refused} 个文件没通过检查（不是该会话写的 / 敏感文件）`);
    }
    return out.slice(0, MAX_ARTIFACTS).map((a, i) => ({ ref: 'A' + (i + 1), ...a }));
  }
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

  // job: { from, to, date, draft, brief } -- brief: a backfilled past day (shorter, no open items carried in; a day
  // without sessions writes nothing and returns null)
  async function generate(job) {
    const { from, to, date } = job;
    const items = collect(from, to);
    if (job.brief && !items.length) return null;
    // the important items still open are checked against these conversations (not for a backfilled past day: an
    // item starred today cannot have been done back then); other loose ends are not carried from day to day
    const important = todos && !job.brief ? todos.open().slice(0, 40).map((t, i) => ({ ...t, ref: 'T' + (i + 1) })) : [];
    for (const it of items) if (it.digest.text.length > SESSION_INLINE) await summarizeSession(it, from);
    const size = () => items.reduce((n, it) => n + (it.summary ? 800 : it.digest.text.length), 0);
    for (const it of [...items].sort((a, b) => b.digest.text.length - a.digest.text.length)) {
      if (size() <= DAY_MAX) break;
      if (!it.summary && it.digest.text.length > 3000) await summarizeSession(it, from);
    }
    const arts = items.length ? await findArtifacts(items) : [];
    const ans = items.length
      ? await ask(dayPrompt({ from, to, sessions: items, todos: important, artifacts: arts, brief: !!job.brief }), DAY_SCHEMA)
      : { headline: '这段时间没有 AI 会话记录', projects: [], open: [], plans: [], keywords: [], artifacts: [], todos: [], notes: [] };
    const report = assemble(job, items, ans, arts, important);
    // what the model found done is ticked off the list, with its reason
    for (const t of report.todosDone) todos.complete(t.id, date, t.evidence);
    reports.save(report);
    if (artifacts && report.artifacts.length) artifacts.record(date, report.artifacts);
    log(`日报 ${job.draft ? '（到现在）' : date}${job.brief ? '（补录）' : ''} 已生成：${items.length} 个会话，${report.stats.minutes} 分钟`);
    return report;
  }

  function assemble({ from, to, date, draft, brief }, items, ans, arts = [], important = []) {
    const byKey = new Map(items.map((it) => [it.key, it]));
    // the model sometimes decorates a reference ("S1：/home/u/x", "O2 整理…"): only the number counts
    const ref = (v, letter) => { const m = new RegExp(letter + '\\d+').exec(String(v || '')); return m ? m[0] : ''; };
    const catOf = new Map();
    const projects = (ans.projects || []).map((p) => {
      const its = [...new Set((p.sessions || []).map((k) => ref(k, 'S')))].map((k) => byKey.get(k)).filter(Boolean);
      for (const it of its) if (!catOf.has(it.key)) catOf.set(it.key, p.category);
      const files = new Map();
      for (const it of its) for (const f of it.digest.files) files.set(it.s.machine + '|' + f.path, { machine: it.s.machine, ...f });
      return { name: p.name, category: p.category, summary: p.summary, done: p.done, decisions: p.decisions, unfinished: p.unfinished,
        sessions: its.map((it) => it.key), minutes: its.reduce((n, it) => n + it.digest.activeMin, 0), files: [...files.values()] };
    });
    // the day's own loose ends (starring one makes it an important item: todos.js)
    const openOut = (ans.open || []).map((o) => ({ text: o.text, project: o.project, status: 'open', since: date }));
    // important items the model found done in these conversations
    const byRef = new Map(important.map((t) => [t.ref, t]));
    const todosDone = [];
    for (const x of ans.todos || []) {
      const t = byRef.get(ref(x.ref, 'T'));
      if (t && x.done === true && !todosDone.some((y) => y.id === t.id)) todosDone.push({ id: t.id, text: t.text, project: t.project, evidence: x.evidence || '' });
    }
    // each conversation's own short note (the model's, matched by its S number)
    const notes = new Map();
    for (const n of ans.notes || []) {
      const k = ref(n.session, 'S');
      if (!byKey.has(k) || notes.has(k)) continue;
      notes.set(k, { did: n.did || '', open: n.open || [], status: ['done', 'ongoing', 'paused'].includes(n.status) ? n.status : '', ideas: n.ideas || [] });
    }
    const sessions = items.map((it) => {
      const d = it.digest;
      return { note: notes.get(it.key) || null, key: it.key, machine: d.machine, id: d.id, title: d.title || d.project || '', project: d.project, cwd: d.cwd,
        minutes: d.activeMin, first: d.first, last: d.last, category: catOf.get(it.key) || it.hint.cat || '',
        files: d.files, cmds: d.cmds, resume: resumeCmd ? resumeCmd(d.cwd, d.id) : '' };
    });
    return {
      date, draft: !!draft, brief: !!brief, from, to, generatedAt: Date.now(),
      headline: ans.headline || '', projects, open: openOut, todosDone,
      plans: (ans.plans || []).map((p) => ({ title: p.title, project: p.project, session: ref(p.session, 'S') })),
      keywords: ans.keywords || [], sessions,
      artifacts: arts.map((a) => ({ ...a, note: ((ans.artifacts || []).find((x) => ref(x.ref, 'A') === a.ref) || {}).note || '' })),
      stats: { minutes: sessions.reduce((n, s) => n + s.minutes, 0), sessions: sessions.length,
        machines: new Set(sessions.map((s) => s.machine)).size, files: sessions.reduce((n, s) => n + s.files.length, 0), artifacts: arts.length },
    };
  }

  return { generate, collect, ask };
}

module.exports = { createGenerator };
