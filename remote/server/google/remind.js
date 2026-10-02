// Mail alerts to the phone through Google Calendar (mail/triage.js finds them): a calendar of its own, "Windose 提醒"
// (made once with calendar.app.created; it can be hidden or coloured), and per alert of something to do / a notice
// that matters (not recommended papers):
//   - an event two minutes ahead with a popup at its start: Google's app tells the phone, Windose open or not
//   - with a deadline: an all-day event on that day 「截止：…」, its popup at 9:00 the day before
// Both carry the alert's id (private property ameMail = <id>:now | <id>:due), so an alert never makes them twice.
'use strict';

const API = 'https://www.googleapis.com/calendar/v3';
const evUrl = (cal) => `${API}/calendars/${encodeURIComponent(cal)}/events`;
const NAME = 'Windose 提醒';
const TZ = 'Asia/Shanghai';
const pad = (n) => String(n).padStart(2, '0');
const nextDay = (date) => { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function createRemind({ account, origin, log = () => {} }) {
  let making = null;
  async function target() {
    const id = account.get('remindCalendar');
    if (id) return id;
    if (!making) making = (async () => {
      const c = await account.api(`${API}/calendars`, { method: 'POST', json: { summary: NAME, timeZone: TZ,
        description: 'Windose 读过新邮件后觉得要提醒你的事（要办的通知、截止日期）。可以在 Google 日历里隐藏这个日历。' } });
      account.remember('remindCalendar', c.id);
      log(`Google 日历：建了「${NAME}」日历`);
      return c.id;
    })().finally(() => { making = null; });
    return making;
  }

  async function upsert(tag, body) {
    for (let attempt = 0; ; attempt++) {
      const cal = await target();
      try {
        const q = new URLSearchParams({ privateExtendedProperty: 'ameMail=' + tag, maxResults: '2' });
        const found = await account.api(evUrl(cal) + '?' + q);
        if (found && found.items && found.items.length) return found.items[0];       // (already there)
        return await account.api(evUrl(cal), { method: 'POST', json: { ...body, extendedProperties: { private: { ameMail: tag } } } });
      } catch (e) {
        if (e.status === 404 && attempt === 0) { account.remember('remindCalendar', ''); continue; }       // the calendar was deleted: again
        throw e;
      }
    }
  }

  // alert: triage.js's { id, kind, subject, from, summary, todo, deadline, deadlineText, key }
  async function mail(alert) {
    if (!alert || alert.kind === 'reading') return null;
    const link = `${String(origin || '').replace(/\/$/, '')}/#mail=${encodeURIComponent(alert.key)}`;
    const text = [alert.summary, alert.todo ? '要做：' + alert.todo : '', alert.deadline ? '截止：' + alert.deadline : '',
      alert.deadlineText ? '原文：' + alert.deadlineText : '', '', `邮件：${alert.subject}（${alert.from}）`, `在 Windose 里看：${link}`].filter((x, i, a) => x || a[i - 1]).join('\n');
    const label = alert.kind === 'action' ? '要办' : '通知';
    const start = new Date(Date.now() + 2 * 60e3), end = new Date(start.getTime() + 15 * 60e3);
    const now = await upsert(alert.id + ':now', { summary: `📩 ${label}：${alert.summary || alert.subject}`, description: text,
      start: { dateTime: start.toISOString(), timeZone: TZ }, end: { dateTime: end.toISOString(), timeZone: TZ }, transparency: 'transparent',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] } });
    let due = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(alert.deadline || '')) {
      due = await upsert(alert.id + ':due', { summary: `⏰ 截止：${alert.todo || alert.summary || alert.subject}`, description: text,
        start: { date: alert.deadline }, end: { date: nextDay(alert.deadline) }, transparency: 'transparent',
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 * 60 }] } });          // (an all-day event's start is 0:00: 9:00 the day before)
    }
    log(`Google 日历：邮件提醒「${alert.summary || alert.subject}」${due ? '，截止 ' + alert.deadline : ''}`);
    return { now, due };
  }

  return { mail, target, NAME };
}

module.exports = { createRemind };
