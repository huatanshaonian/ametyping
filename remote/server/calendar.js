// The calendar window's month: GET /api/calendar?month=YYYY-MM -> per day the daily report (headline, minutes),
// the important items due that day, and the Google Calendar events (when connected); weeks with a weekly report.
'use strict';

const pad = (n) => String(n).padStart(2, '0');

function createCalendarView({ reports, todos, google }) {
  async function month(ym) {
    if (!/^\d{4}-\d{2}$/.test(ym)) return null;
    const [y, m] = ym.split('-').map(Number);
    const from = `${ym}-01`, next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
    const days = {};
    const day = (d) => (days[d] = days[d] || { events: [], todos: [] });
    for (const it of reports ? reports.list() : []) if (it.date >= from && it.date < next) day(it.date).report = { headline: it.headline, minutes: it.minutes, brief: !!it.brief };
    for (const t of todos ? todos.list() : []) if (t.due && t.due >= from && t.due < next) day(t.due).todos.push({ id: t.id, text: t.text, done: t.done });
    // a few days either side, for events that cross the month's edge
    const g = google ? await google.events(from, next) : { connected: false, items: [] };
    for (const e of g.items) {
      const d = e.start.slice(0, 10);
      if (d >= from && d < next && !e.diary) day(d).events.push(e);           // (diary events are the reports themselves)
    }
    const weeks = reports ? reports.listWeeks().filter((w) => w.end >= from && w.start < next) : [];
    return { month: ym, days, weeks, google: { connected: g.connected, error: g.error || '' } };
  }
  async function handle(req, res, url, json) {
    if (req.method !== 'GET' || url.pathname !== '/api/calendar') return false;
    const r = await month(String(url.searchParams.get('month') || ''));
    json(res, r ? 200 : 400, r || { error: 'bad month' });
    return true;
  }
  return { month, handle };
}

module.exports = { createCalendarView };
