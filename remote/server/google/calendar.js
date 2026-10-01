// Google Calendar for the connected account:
//   - diary(report) / week(weekly): a daily report as an all-day event on its date ("日报：…"), a weekly one on the
//     week's Sunday ("周报：…"); free time, a summary and a link back to Windose (the full report is there). Found again
//     by a private property (ameReport / ameWeek), so a rewritten report updates its event instead of adding another.
//     They go to a calendar of their own, "Windose 日报" (made once; it can be hidden or coloured in Google Calendar),
//     when the sign-in allows it (calendar.app.created), else to the primary calendar; the first time, events the
//     primary calendar already has are moved over. The last write's outcome is kept for the account window.
//   - events(from, to): the primary calendar's events, for the Windose calendar window and the daily report (kept a
//     minute)
'use strict';

const API = 'https://www.googleapis.com/calendar/v3';
const evUrl = (cal) => `${API}/calendars/${encodeURIComponent(cal)}/events`;
const OWN_NAME = 'Windose 日报';
const CACHE_MS = 60e3;                                // only for loads in a row; opening the window / 刷新 asks again
const NAMES = { research: '科研', personal: '个人小项目', chore: '杂活' };

const nextDay = (date) => {
  const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const join = (lines) => lines.filter((x, i, a) => x || a[i - 1]).join('\n');      // no blank line twice
const isOurs = (e) => !!(e.extendedProperties && e.extendedProperties.private && (e.extendedProperties.private.ameReport || e.extendedProperties.private.ameWeek));

function createCalendar({ account, origin, log = () => {} }) {
  const cache = new Map();                            // "from|to" -> { at, items }
  const link = (what) => `${String(origin || '').replace(/\/$/, '')}/#report=${what}`;

  function dayBody(r) {
    const lines = (r.projects || []).filter((p) => p.category !== 'chore').map((p) => `· [${NAMES[p.category] || ''}] ${p.name}：${p.summary || ''}`);
    const chores = (r.projects || []).filter((p) => p.category === 'chore').length;
    const done = (r.todosDone || []).map((t) => `✓ ${t.text}`);
    return {
      summary: '日报：' + (r.headline || '（无）'),
      description: join([...lines, chores ? `· 杂活 ${chores} 件` : '', ...done, '', `完整日报：${link(r.date)}`]),
      start: { date: r.date }, end: { date: nextDay(r.date) }, transparency: 'transparent',
      extendedProperties: { private: { ameReport: r.date } },
    };
  }
  function weekBody(w) {
    const h = Math.round(((w.stats && w.stats.minutes) || 0) / 6) / 10;
    return {
      summary: '周报：' + (w.headline || '（无）'),
      description: join([...(w.projects || []).map((p) => `· [${NAMES[p.category] || ''}] ${p.name}：${p.summary || ''}`),
        ...(w.highlights || []).map((x) => `★ ${x}`), '', `${w.start} ~ ${w.end}，约 ${h} 小时`, `完整周报：${link('week-' + w.start)}`]),
      start: { date: w.end }, end: { date: nextDay(w.end) }, transparency: 'transparent',
      extendedProperties: { private: { ameWeek: w.start } },
    };
  }

  // the calendar the reports go to; made (and the old events moved there) the first time
  let making = null;
  async function target() {
    if (!account.has('calendar')) return 'primary';
    const id = account.get('diaryCalendar');
    if (id) return id;
    if (!making) making = (async () => {
      const c = await account.api(`${API}/calendars`, { method: 'POST', json: { summary: OWN_NAME, timeZone: 'Asia/Shanghai',
        description: 'Windose 每天的工作日报和每周的周报（摘要）。完整内容在 Windose 里看；可以在 Google 日历里隐藏这个日历。' } });
      account.remember('diaryCalendar', c.id);
      log(`Google 日历：建了「${OWN_NAME}」日历`);
      try { await moveOld(c.id); } catch (e) { log('Google 日历：搬旧的日报事件失败：' + e.message); }
      return c.id;
    })().finally(() => { making = null; });
    return making;
  }
  // the report events written to the primary calendar before it had a calendar of its own
  async function moveOld(cal) {
    const old = [];
    let page = '';
    for (let n = 0; n < 10; n++) {
      const q = new URLSearchParams({ maxResults: '2500', singleEvents: 'true', timeMin: new Date(Date.now() - 2 * 365 * 86400e3).toISOString(),
        timeMax: new Date(Date.now() + 14 * 86400e3).toISOString(), ...(page ? { pageToken: page } : {}) });
      const r = await account.api(evUrl('primary') + '?' + q);
      old.push(...((r && r.items) || []).filter(isOurs));
      page = r && r.nextPageToken; if (!page) break;
    }
    for (const e of old) {
      const { summary, description, start, end, transparency, extendedProperties } = e;
      await account.api(evUrl(cal), { method: 'POST', json: { summary, description, start, end, transparency, extendedProperties } });
      await account.api(`${evUrl('primary')}/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
    }
    if (old.length) log(`Google 日历：${old.length} 个日报事件从主日历搬到了「${OWN_NAME}」`);
    return old.length;
  }

  // write (or update) the event whose private property `prop` is `value`
  async function upsert(prop, value, body) {
    for (let attempt = 0; ; attempt++) {
      const cal = await target();
      try {
        const q = new URLSearchParams({ privateExtendedProperty: `${prop}=${value}`, showDeleted: 'false', maxResults: '5' });
        const found = await account.api(evUrl(cal) + '?' + q);
        const ev = found && found.items && found.items[0];
        const res = ev ? await account.api(`${evUrl(cal)}/${encodeURIComponent(ev.id)}`, { method: 'PATCH', json: body })
          : await account.api(evUrl(cal), { method: 'POST', json: body });
        return { res, updated: !!ev };
      } catch (e) {
        // the calendar was deleted in Google: make it again (once)
        if (e.status === 404 && cal !== 'primary' && attempt === 0) { account.remember('diaryCalendar', ''); continue; }
        throw e;
      }
    }
  }
  // remembered for the account window: { at, what, ok, error }
  async function written(what, fn) {
    try { const r = await fn(); account.remember('diaryLast', { at: Date.now(), what, ok: true }); cache.clear(); return r; }
    catch (e) { account.remember('diaryLast', { at: Date.now(), what, ok: false, error: e.message }); throw e; }
  }

  async function diary(r) {
    if (!r || r.draft || !r.date) return null;
    return written(`${r.date} 的日报`, async () => {
      const { res, updated } = await upsert('ameReport', r.date, dayBody(r));
      log(`Google 日历：${updated ? '更新' : '写入'} ${r.date} 的日报`);
      return res;
    });
  }
  async function week(w) {
    if (!w || !w.start || !w.end) return null;
    return written(`${w.start} 这一周的周报`, async () => {
      const { res, updated } = await upsert('ameWeek', w.start, weekBody(w));
      log(`Google 日历：${updated ? '更新' : '写入'} ${w.start} 这一周的周报`);
      return res;
    });
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
      const r = await account.api(evUrl('primary') + '?' + q);
      for (const e of (r && r.items) || []) {
        if (e.status === 'cancelled') continue;
        items.push({ id: e.id, title: e.summary || '（无标题）', allDay: !!(e.start && e.start.date), start: (e.start && (e.start.dateTime || e.start.date)) || '',
          end: (e.end && (e.end.dateTime || e.end.date)) || '', location: e.location || '', link: e.htmlLink || '', diary: isOurs(e) });
      }
      page = r && r.nextPageToken; if (!page) break;
    }
    cache.set(key, { at: Date.now(), items });
    return items;
  }
  return { diary, week, events, target, clear: () => cache.clear() };
}

module.exports = { createCalendar, OWN_NAME };
