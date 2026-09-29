// Google Calendar for the connected account (primary calendar):
//   - diary(report): the day's report as an all-day event on its date ("日报：…", free time, a link back to Windose);
//     found again by a private property, so a regenerated report updates its event instead of adding another
//   - events(from, to): what is on the calendar, for the Windose calendar window (kept for a few minutes)
'use strict';

const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const CACHE_MS = 5 * 60e3;
const NAMES = { research: '科研', personal: '个人小项目', chore: '杂活' };

function createCalendar({ account, origin, log = () => {} }) {
  const cache = new Map();                            // "from|to" -> { at, items }

  function body(r) {
    const next = new Date(r.date + 'T12:00:00'); next.setDate(next.getDate() + 1);
    const end = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    const lines = (r.projects || []).filter((p) => p.category !== 'chore').map((p) => `· [${NAMES[p.category] || ''}] ${p.name}：${p.summary || ''}`);
    const chores = (r.projects || []).filter((p) => p.category === 'chore').length;
    const done = (r.todosDone || []).map((t) => `✓ ${t.text}`);
    return {
      summary: '日报：' + (r.headline || '（无）'),
      description: [...lines, chores ? `· 杂活 ${chores} 件` : '', ...done, '', `完整日报：${String(origin || '').replace(/\/$/, '')}/#report=${r.date}`].filter((x, i, a) => x || a[i - 1]).join('\n'),
      start: { date: r.date }, end: { date: end }, transparency: 'transparent',
      extendedProperties: { private: { ameReport: r.date } },
    };
  }

  async function diary(r) {
    if (!r || r.draft || !r.date) return null;
    const q = new URLSearchParams({ privateExtendedProperty: 'ameReport=' + r.date, showDeleted: 'false', maxResults: '5' });
    const found = await account.api(BASE + '?' + q);
    const ev = found && found.items && found.items[0];
    const res = ev ? await account.api(`${BASE}/${encodeURIComponent(ev.id)}`, { method: 'PATCH', json: body(r) })
      : await account.api(BASE, { method: 'POST', json: body(r) });
    cache.clear();
    log(`Google 日历：${ev ? '更新' : '写入'} ${r.date} 的日报`);
    return res;
  }

  // [{ id, title, start, end, allDay, location, diary }] between two dates (YYYY-MM-DD, end exclusive)
  async function events(from, to) {
    const key = from + '|' + to, c = cache.get(key);
    if (c && Date.now() - c.at < CACHE_MS) return c.items;
    const items = [];
    let page = '';
    for (let n = 0; n < 5; n++) {
      const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
        timeMin: new Date(from + 'T00:00:00').toISOString(), timeMax: new Date(to + 'T00:00:00').toISOString(), ...(page ? { pageToken: page } : {}) });
      const r = await account.api(BASE + '?' + q);
      for (const e of (r && r.items) || []) {
        if (e.status === 'cancelled') continue;
        items.push({ id: e.id, title: e.summary || '（无标题）', allDay: !!(e.start && e.start.date), start: (e.start && (e.start.dateTime || e.start.date)) || '',
          end: (e.end && (e.end.dateTime || e.end.date)) || '', location: e.location || '', link: e.htmlLink || '',
          diary: !!(e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.ameReport) });
      }
      page = r && r.nextPageToken; if (!page) break;
    }
    cache.set(key, { at: Date.now(), items });
    return items;
  }
  return { diary, events, clear: () => cache.clear() };
}

module.exports = { createCalendar };
