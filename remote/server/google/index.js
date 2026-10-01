// Google on the Windose page: the account window (client, connect, disconnect, diary / tasks on/off, past reports into
// the calendar), the events the daily and weekly reports become, calendar events and tasks for the calendar window,
// 重要计划 mirrored to Google Tasks, notes copied to Drive. Changing anything about the account needs a code entered within the hour (like remote control); the callback from Google's consent screen is
// public (the login cookie is SameSite=Strict, so Google's redirect arrives without it) and checked by its one-time state.
'use strict';
const { createAccount } = require('./account');
const { createCalendar } = require('./calendar');
const { createDrive } = require('./drive');
const { createTasks } = require('./tasks');
const { createTasksSync } = require('./tasks-sync');
const { createBackfill } = require('./backfill');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// reports(): the daily reports' store (summary/reports.js), or null -- for writing past ones into the calendar
function createGoogle({ dataDir, origin, egress, notes, todos, reports = () => null, log = console.log, audit = () => {} }) {
  const account = createAccount({ dataDir, origin, egress, log });
  const calendar = createCalendar({ account, origin, log });
  const drive = createDrive({ account, log });
  const tasks = createTasks({ account });
  const sync = todos ? createTasksSync({ dataDir, account, tasks, todos, log }) : null;
  const backfill = createBackfill({ calendar, reports, log });
  const connected = () => account.status().connected;
  const status = () => ({ ...account.status(), ...(sync ? { sync: sync.status() } : {}),
    diaryLast: account.get('diaryLast') || null, ownCalendar: !!account.get('diaryCalendar'), backfill: backfill.status() });

  // a finished daily / weekly report becomes its event (when connected and wanted); the outcome is shown in the
  // account window (calendar.js keeps it)
  const wanted = () => connected() && account.status().diary;
  function onReport(r) {
    if (!r || r.draft || !wanted()) return;
    calendar.diary(r).catch((e) => log('Google 日历写入失败：' + e.message));
  }
  function onWeek(w) {
    if (!w || !wanted()) return;
    calendar.week(w).catch((e) => log('Google 日历写入周报失败：' + e.message));
  }
  // the calendar window's month: events, and tasks due (not those of the 重要计划 list: they are the items themselves);
  // force: ask Google again (opening the window, 刷新), which also picks up 重要计划 changed in Google
  async function events(from, to, force) {
    if (!connected()) return { connected: false, items: [], tasks: [] };
    const r = { connected: true, items: [], tasks: [] }, errs = [];
    // the sync runs on its own: 重要计划 it changes are broadcast, and the window loads again
    if (force) { calendar.clear(); if (sync) sync.run(); }
    await Promise.all([
      calendar.events(from, to).then((x) => { r.items = x; }, (e) => errs.push(e.message)),
      account.has('tasks') ? tasks.due(from, to, sync && sync.listId(), force).then((x) => { r.tasks = x; }, (e) => errs.push('任务：' + e.message)) : null,
    ]);
    if (errs.length) r.error = errs.join('；');
    return r;
  }
  // a 重要计划 changed in Windose
  function onTodos() { if (sync) sync.kick(); }
  // before a daily report of [from, to) (ms): the 重要计划 ticked off in Google first, then the events in that window for
  // the report to mention ([{ title, start, end, allDay, location }]; empty when not connected or Google cannot be reached)
  async function forReport(from, to) {
    if (!connected()) return [];
    if (sync) await sync.run();
    const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const d0 = ymd(from), d1 = ymd(to);
    try {
      return (await calendar.events(d0, ymd(to + 86400e3))).filter((e) => !e.diary && (e.allDay
        ? e.start === d0 || (e.start > d0 && e.start < d1)                     // all-day: on a day the window started
        : new Date(e.start).getTime() < to && new Date(e.end).getTime() > from))
        .map((e) => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location }));
    } catch (e) { log('读 Google 日程失败（日报照常写）：' + e.message); return []; }
  }

  // GET /api/google/callback, before the login check
  async function handleCallback(req, res, url, send) {
    let r;
    try { r = await account.callback(url.searchParams.get('code'), url.searchParams.get('state')); }
    catch (e) { r = { ok: false, msg: e.message }; }
    if (url.searchParams.get('error')) r = { ok: false, msg: '在 Google 页面上取消了' };
    audit('google-callback', '-', r.ok ? 'ok' : 'failed');
    // signed in with the calendar of our own allowed: make it (and move the old events there) right away
    if (r.ok && account.has('calendar') && account.status().diary) calendar.target().catch((e) => log('Google 日历：建日历失败：' + e.message));
    const to = r.ok ? '/#google=ok' : '/#google=fail';
    send(res, 200, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="${r.ok ? 0 : 4};url=${to}">` +
      `<title>Google</title><p style="font:14px sans-serif;padding:20px">${r.ok ? '已连接 Google，正在返回 Windose…' : '没能连接 Google：' + esc(r.msg) + '<br>几秒后返回 Windose。'}</p>`, 'text/html; charset=utf-8');
  }

  // the rest of /api/google/*; fresh(): a code was entered within the hour
  async function handle(req, res, p, ip, json, readBody, fresh) {
    if (req.method === 'GET' && p === '/api/google') { json(res, 200, status()); return true; }
    if (req.method !== 'POST' || !p.startsWith('/api/google/')) return false;
    let d = {}; try { d = JSON.parse(await readBody(req, 8192)); } catch {}
    const what = p.slice('/api/google/'.length);
    if (['client', 'connect', 'disconnect', 'diary', 'tasks', 'backfill'].includes(what) && !fresh()) { json(res, 200, { ok: false, need: 'totp', msg: '需要再输一次验证码' }); return true; }
    let r;
    try {
      if (what === 'client') r = account.setClient(d.clientId, d.clientSecret);
      else if (what === 'diary') r = account.setDiary(d.on);
      else if (what === 'tasks') { r = account.setTasks(d.on); if (d.on && sync) sync.kick(0); }
      else if (what === 'backfill') r = connected() ? backfill.start() : { ok: false, msg: '还没有连接 Google' };
      else if (what === 'connect') { const u = account.authUrl(); r = u ? { ok: true, url: u } : { ok: false, msg: '先填好客户端 ID 和密钥' }; }
      else if (what === 'disconnect') r = await account.disconnect();
      else if (what === 'drive-note') {
        const n = notes && notes.get(String(d.id || ''));
        if (!n) r = { ok: false, msg: '找不到这篇笔记' };
        else if (!connected()) r = { ok: false, msg: '还没有连接 Google（开始菜单 →「Google 账户」）' };
        else { const f = await drive.saveNote(n); notes.setDrive(n.id, { fileId: f.fileId, at: Date.now() }); r = { ok: true, name: f.name }; }
      } else { json(res, 404, { ok: false }); return true; }
    } catch (e) { r = { ok: false, msg: e.message }; }
    if (r.ok) audit('google-' + what, ip);
    json(res, 200, r);
    return true;
  }

  return { handle, handleCallback, onReport, onWeek, onTodos, forReport, events, connected, status };
}

module.exports = { createGoogle };
