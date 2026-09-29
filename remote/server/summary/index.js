// The daily work summary (日报): wiring and the web API. Settings are config.json "summary" (all optional):
//   enabled     false turns it off
//   codex       the Codex CLI (default ~/.local/bin/codex on Linux, "codex" elsewhere), or [command, ...args]
//   model       default "gpt-6-luna"
//   proxies     HTTP proxies tried in order, e.g. ["http://<PC>:10810", "http://127.0.0.1:1057"] (the PC's v2rayN,
//               then the AWS way out, deploy/nas/egress.sh); none = direct
//   categories  [{ match, cat }] folder rules for 科研 / 个人小项目 / 杂活 (see classify.js)
//   at "04:30", quietMin 30: when the morning report is written
//   backupMaxMB 5: artifacts (files made outside a tracked repository) up to this size are copied to the NAS
'use strict';
const os = require('os');
const path = require('path');
const { createReports } = require('./reports');
const { createGenerator } = require('./generate');
const { createScheduler } = require('./scheduler');
const { createClassifier } = require('./classify');
const { createEgress } = require('../egress');
const { createSearch } = require('./search');
const { createQA } = require('./qa');
const { createWeekly, mondayOf } = require('./weekly');

function readBody(req, cap = 4096) {
  return new Promise((resolve, reject) => {
    let b = ''; req.setEncoding('utf8');
    req.on('data', (c) => { b += c; if (b.length > cap) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(b)); req.on('error', reject);
  });
}

// onNote(note): a new daily / weekly report is there -- the server passes the short note on to each machine's agent
// (the pet's morning bubble)
function createSummary({ store, dir, cfg = {}, resumeCmd, artifacts = null, todos = null, onNote = () => {}, log = console.log, audit = () => {} }) {
  if (cfg.enabled === false) return null;
  const reports = createReports(dir);
  const linux = process.platform === 'linux';
  const codex = {
    bin: cfg.codex || (linux ? path.join(os.homedir(), '.local', 'bin', 'codex') : 'codex'),
    model: cfg.model || 'gpt-6-luna',
    // Synology: Entware's busybox ps (earlier in PATH) breaks codex; the system's tools first
    pathPrefix: cfg.pathPrefix != null ? cfg.pathPrefix : (linux ? '/usr/bin' : ''),
    timeoutMs: (+cfg.timeoutMin || 20) * 60e3,
  };
  const egress = Array.isArray(cfg.proxies) && cfg.proxies.length ? createEgress({ proxies: cfg.proxies, log }) : null;
  const gen = createGenerator({ store, reports, egress, classify: createClassifier(cfg.categories), codex, resumeCmd, log,
    artifacts, todos, backupBytes: (cfg.backupMaxMB != null ? +cfg.backupMaxMB : 5) * 1e6 });
  const weekly = createWeekly({ reports, ask: gen.ask, todos, log });
  // the short note for the pet: the latest daily report that is not a backfill, and its week when that is written
  function latestNote() {
    const r = reports.latest();
    if (!r) return null;
    const ps = r.projects || [];
    const w = reports.getWeek(mondayOf(r.date));
    return { date: r.date, headline: r.headline || '', projects: ps.filter((p) => p.category !== 'chore').map((p) => p.name).slice(0, 5),
      open: todos ? todos.open().length : 0, done: (r.todosDone || []).length, chores: ps.filter((p) => p.category === 'chore').length,
      week: w && w.end === r.date ? { start: w.start, end: w.end, headline: w.headline || '' } : undefined };
  }
  const [hh, mm] = String(cfg.at || '04:30').split(':').map(Number);
  const scheduler = createScheduler({ reports, store, generate: gen.generate, weekly, notify: () => { const n = latestNote(); if (n) onNote(n); }, log,
    at: [hh || 0, mm || 0], quietMs: (cfg.quietMin != null ? +cfg.quietMin : 30) * 60e3, tickMs: +process.env.AME_SUMMARY_TICK_MS || 60e3 });

  // search over reports, artifacts and every stored conversation; 问一问 on top of it
  const search = createSearch({ storeDir: path.dirname(dir), reports, artifacts, sessions: () => store.sessions() });
  const qa = createQA({ search, reports, ask: gen.ask, log });

  // the web API; true when the request was one of ours
  async function handle(req, res, url, ip, json) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/search') {
      json(res, 200, search.search(String(url.searchParams.get('q') || '').slice(0, 200)));
      return true;
    }
    if (req.method === 'GET' && p === '/api/ask') { json(res, 200, { job: qa.state() }); return true; }
    if (req.method === 'POST' && p === '/api/ask') {
      let d = {}; try { d = JSON.parse(await readBody(req)); } catch {}
      const r = qa.start(d.q);
      if (r.ok) audit('ask', ip, `len=${String(d.q || '').length}`);
      json(res, 200, r);
      return true;
    }
    if (req.method === 'GET' && p === '/api/reports') {
      const d = reports.get('draft');
      json(res, 200, { items: reports.list(), weeks: reports.listWeeks(), status: scheduler.status(), draft: d ? { headline: d.headline, from: d.from, to: d.to } : null });
      return true;
    }
    if (req.method === 'GET' && p === '/api/report') {
      const r = reports.get(url.searchParams.get('date'));
      json(res, r ? 200 : 404, r || { error: 'not found' });
      return true;
    }
    if (req.method === 'GET' && p === '/api/report/backfill') {       // what a backfill would do (asked before starting it)
      json(res, 200, { days: scheduler.backfillDays(30).map((j) => j.date) });
      return true;
    }
    if (req.method === 'POST' && p === '/api/report/backfill') {
      const r = scheduler.backfill(30);
      if (r.ok) audit('report-backfill', ip, `days=${r.total}`);
      json(res, 200, r);
      return true;
    }
    if (req.method === 'POST' && p === '/api/report/draft') {
      const started = scheduler.draft();
      if (started) audit('report-draft', ip);
      json(res, 200, { ok: started, msg: started ? '' : '正在生成，请稍等' });
      return true;
    }
    return false;
  }

  return { handle, scheduler, reports, generate: gen.generate, latestNote };
}

module.exports = { createSummary };
