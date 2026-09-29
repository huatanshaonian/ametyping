// When reports are written. Each morning after 4:30 -- once no machine has said anything for 30 minutes (so a late
// night is not cut in half) -- the report for the day that just ended is written, covering everything since the
// previous report ended. A failure (proxy down, codex error) is retried every 30 minutes. 「总结到现在」 writes a
// draft of the same kind on demand without moving the schedule on.
'use strict';

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// weekly (weekly.js, optional): after a Sunday's report, the week's; notify(): a new report or week is there
// (the pet's morning bubble hears of it)
function createScheduler({ reports, store, generate, weekly = null, notify = () => {}, log = () => {}, at = [4, 30], quietMs = 30 * 60e3,
  retryMs = 30 * 60e3, tickMs = 60e3, now = () => Date.now() }) {
  let running = null, lastError = null, lastErrorAt = 0;

  // the latest 4:30 at or before t
  function cutoff(t) {
    const d = new Date(t); d.setHours(at[0], at[1], 0, 0);
    if (d.getTime() > t) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  // the scheduled report that should exist by now: { cut, date } or null
  function due(t) {
    const cut = cutoff(t), last = reports.state().lastTo || 0;
    return last < cut ? { cut, date: dayOf(cut - 12 * 3600e3) } : null;
  }

  async function run(job) {
    running = { ...job, started: now() };
    try {
      const r = await generate(job);
      if (!job.draft) { reports.setState({ lastTo: job.to }); notify(); }
      lastError = null;
      if (!job.draft && weekly && weekly.pendingWeek()) await makeWeek(weekly.pendingWeek());   // Sunday done: the week
      return r;
    } catch (e) {
      lastError = e.message; lastErrorAt = now();
      log(`日报${job.draft ? '（到现在）' : ' ' + job.date}失败：${e.message}`);
      throw e;
    } finally { running = null; }
  }

  // the weekly report of the week starting on `start` (errors are kept like a daily report's)
  async function makeWeek(start) {
    if (running) running.week = start;
    try { const w = await weekly.generateWeek(start); if (w) notify(); lastError = null; return w; }
    catch (e) { lastError = `周报 ${start}：${e.message}`; lastErrorAt = now(); log(`周报 ${start} 失败：${e.message}`); return null; }
  }

  async function tick() {
    const t = now();
    if (running) return 'running';
    const d = due(t);
    if (!d) {
      // the daily report is done; a finished week still without its weekly report (a failure, a restart) gets it now
      const w = weekly && weekly.pendingWeek();
      if (!w || (lastError && t - lastErrorAt < retryMs)) return 'done';
      running = { weekly: true, started: t };
      try { await makeWeek(w); } finally { running = null; }
      return 'week';
    }
    if (store.lastActivity() > t - quietMs) return 'busy';          // still working: wait for a quiet half hour
    if (lastError && t - lastErrorAt < retryMs) return 'retry-wait';
    const from = reports.state().lastTo || d.cut - 24 * 3600e3;
    await run({ from, to: t, date: d.date }).catch(() => {});
    return 'ran';
  }

  // 「总结到现在」: from where the last report ended (or this morning's 4:30) until now
  function draft() {
    if (running) return false;
    const t = now();
    run({ from: reports.state().lastTo || cutoff(t), to: t, date: dayOf(t), draft: true }).catch(() => {});
    return true;
  }

  // 补录: past days without a report, oldest first, each from 4:30 to the next 4:30 (filed under the day it starts),
  // up to where the scheduled reports begin
  function backfillDays(days, t = now()) {
    const until = reports.state().lastTo || cutoff(t);
    const d = new Date(cutoff(t)); d.setDate(d.getDate() - days);
    const out = [];
    for (;;) {
      const from = d.getTime(); d.setDate(d.getDate() + 1); const to = d.getTime();
      if (to > until) break;
      if (!reports.has(dayOf(from))) out.push({ from, to, date: dayOf(from), brief: true });
    }
    return out;
  }
  function backfill(days = 30) {
    if (running) return { ok: false, msg: '正在生成，请稍等' };
    const jobs = backfillDays(days);
    if (!jobs.length) return { ok: false, msg: '最近 ' + days + ' 天都有日报了，没有要补的' };
    running = { backfill: true, total: jobs.length, done: 0, started: now() };
    (async () => {
      let failures = 0;
      try {
        for (const j of jobs) {
          running.date = j.date;
          try { await generate(j); failures = 0; lastError = null; }
          catch (e) {
            lastError = `补录 ${j.date}：${e.message}`; lastErrorAt = now(); log(`日报补录 ${j.date} 失败：${e.message}`);
            if (++failures >= 2) break;                               // the proxy / codex is down: stop, try again later
          }
          running.done++;
        }
        // and the weeks those days make up (a week still running on into the scheduled reports is left to them)
        if (weekly && failures < 2) {
          const until = dayOf(reports.state().lastTo || cutoff(now()));
          for (const start of [...new Set(jobs.map((j) => weekly.mondayOf(j.date)))]) {
            if (!reports.hasWeek(start) && weekly.datesOf(start)[6] < until) await makeWeek(start);
          }
        }
      } finally { running = null; }
    })();
    return { ok: true, total: jobs.length };
  }

  function status() {
    const t = now(), d = due(t);
    return { running: running ? { draft: !!running.draft, since: running.started, backfill: !!running.backfill, done: running.done, total: running.total, date: running.date,
      weekly: !!running.weekly, week: running.week || '' } : null,
      lastError, lastErrorAt, lastTo: reports.state().lastTo || 0, waiting: !!d && !running,
      next: d ? t : cutoff(t) + 24 * 3600e3 };
  }

  // first start: reports begin from the last 4:30, not from the past (the past is for a backfill)
  if (!reports.state().lastTo) reports.setState({ lastTo: cutoff(now()) });

  const timer = tickMs ? setInterval(() => { tick().catch(() => {}); }, tickMs) : null;
  if (timer) timer.unref();
  return { tick, draft, backfill, backfillDays, status, due, cutoff, stop: () => timer && clearInterval(timer) };
}

module.exports = { createScheduler, dayOf };
