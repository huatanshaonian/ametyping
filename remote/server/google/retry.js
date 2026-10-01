// Reports that did not make it into Google Calendar (the proxy was down at 4:30, the sign-in had run out): kept in
// google.json ("diaryPending": [{ kind: 'day' | 'week', key: date | Monday, error, at }]) and tried again every hour,
// and right after connecting again, until they are in. The account window and the tray show what is waiting.
'use strict';

const EVERY_MS = 60 * 60e3;

function createRetry({ account, calendar, reports, wanted, log = () => {} }) {
  const list = () => account.get('diaryPending') || [];
  const put = (l) => account.remember('diaryPending', l);

  function add(kind, key, err) {
    const l = list().filter((x) => !(x.kind === kind && x.key === key));
    l.push({ kind, key, error: String((err && err.message) || err || ''), at: Date.now() });
    put(l.slice(-60));
  }
  // written after all (another way, e.g. 补写): no longer waiting
  function done(kind, key) { if (list().some((x) => x.kind === kind && x.key === key)) put(list().filter((x) => !(x.kind === kind && x.key === key))); }

  let running = false;
  async function run() {
    const rs = reports();
    if (running || !rs || !wanted() || !list().length) return;
    running = true;
    try {
      for (const p of list()) {
        const r = p.kind === 'week' ? rs.getWeek(p.key) : rs.get(p.key);
        try {
          if (r) await (p.kind === 'week' ? calendar.week(r) : calendar.diary(r));
          done(p.kind, p.key);
          if (r) log(`Google 日历：重试成功，${p.key} 的${p.kind === 'week' ? '周报' : '日报'}已写入`);
        } catch (e) { add(p.kind, p.key, e); }
      }
    } finally { running = false; }
  }
  const timer = setInterval(run, EVERY_MS); timer.unref();

  return { add, done, run, list, stop: () => clearInterval(timer) };
}

module.exports = { createRetry };
