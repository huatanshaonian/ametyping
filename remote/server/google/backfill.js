// 「把过去的日报补进日历」: every daily report there is (backfilled short ones too) and every weekly one, oldest first,
// written to the reports' calendar. Each is found again by its private property, so running it twice updates
// instead of doubling. One run at a time, in the background; the account window polls status().
'use strict';

// onWritten(kind, key): one is in the calendar now (no longer waiting for a retry)
function createBackfill({ calendar, reports, onWritten = () => {}, log = () => {} }) {
  let st = { running: false, done: 0, total: 0, failed: 0, error: '', at: 0 };

  async function work(rs) {
    const days = rs.list().map((x) => x.date).sort();
    const weeks = rs.listWeeks().map((w) => w.start).sort();
    st.total = days.length + weeks.length;
    await calendar.target();                          // the calendar first (made, old events moved, once)
    for (const date of days) {
      try { await calendar.diary(rs.get(date)); onWritten('day', date); } catch (e) { st.failed++; st.error = `${date}：${e.message}`; }
      st.done++;
    }
    for (const start of weeks) {
      try { await calendar.week(rs.getWeek(start)); onWritten('week', start); } catch (e) { st.failed++; st.error = `${start} 这一周：${e.message}`; }
      st.done++;
    }
  }

  function start() {
    const rs = reports();
    if (!rs) return { ok: false, msg: '日报功能没有开启' };
    if (st.running) return { ok: true, already: true };
    st = { running: true, done: 0, total: 0, failed: 0, error: '', at: Date.now() };
    work(rs).catch((e) => { st.error = e.message; st.failed++; })
      .finally(() => { st.running = false; st.at = Date.now(); log(`Google 日历：补写完成，${st.done - st.failed}/${st.total} 份${st.failed ? '，失败 ' + st.failed + ' 份' : ''}`); });
    return { ok: true };
  }
  return { start, status: () => ({ ...st }) };
}

module.exports = { createBackfill };
