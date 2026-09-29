// When reports are written. Each morning after 4:30 -- once no machine has said anything for 30 minutes (so a late
// night is not cut in half) -- the report for the day that just ended is written, covering everything since the
// previous report ended. A failure (proxy down, codex error) is retried every 30 minutes. 「总结到现在」 writes a
// draft of the same kind on demand without moving the schedule on.
'use strict';

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function createScheduler({ reports, store, generate, log = () => {}, at = [4, 30], quietMs = 30 * 60e3, retryMs = 30 * 60e3,
  tickMs = 60e3, now = () => Date.now() }) {
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
      if (!job.draft) reports.setState({ lastTo: job.to });
      lastError = null;
      return r;
    } catch (e) {
      lastError = e.message; lastErrorAt = now();
      log(`日报${job.draft ? '（到现在）' : ' ' + job.date}失败：${e.message}`);
      throw e;
    } finally { running = null; }
  }

  async function tick() {
    const t = now();
    if (running) return 'running';
    const d = due(t);
    if (!d) return 'done';
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

  function status() {
    const t = now(), d = due(t);
    return { running: running ? { draft: !!running.draft, since: running.started } : null,
      lastError, lastErrorAt, lastTo: reports.state().lastTo || 0, waiting: !!d && !running,
      next: d ? t : cutoff(t) + 24 * 3600e3 };
  }

  // first start: reports begin from the last 4:30, not from the past (the past is for a backfill)
  if (!reports.state().lastTo) reports.setState({ lastTo: cutoff(now()) });

  const timer = tickMs ? setInterval(() => { tick().catch(() => {}); }, tickMs) : null;
  if (timer) timer.unref();
  return { tick, draft, status, due, cutoff, stop: () => timer && clearInterval(timer) };
}

module.exports = { createScheduler, dayOf };
