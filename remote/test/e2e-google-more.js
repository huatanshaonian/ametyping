// Google, the rest: reports that did not make it into the calendar wait and are retried (google/retry.js), also when
// the sign-in had run out at report time; today's agenda for 糖糖's morning bubble (google/index.js agenda); the
// tray's status (pending). Google is a stand-in for google/http.js request (routed per test).
const fs = require('fs'), path = require('path'), os = require('os');
const R = path.resolve(__dirname, '..');
const http = require(R + '/server/google/http');
let route = () => ({ status: 404, json: { error: { message: 'no route' } } });
const calls = [];
http.request = async (url, opts = {}) => { calls.push((opts.method || 'GET') + ' ' + url); const r = await route(url, opts); return { status: 200, body: Buffer.from(''), ...r }; };
const { createGoogle } = require(R + '/server/google/index');      // (account.js takes the request above as it loads)
const { createRetry } = require(R + '/server/google/retry');
const { createTodos } = require(R + '/server/todos');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 800)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

async function retryUnit() {
  const mem = {};
  const account = { get: (k) => mem[k], remember: (k, v) => { mem[k] = v; } };
  let down = true;
  const written = [];
  const calendar = { diary: async (r) => { if (down) throw new Error('代理不通'); written.push('day ' + r.date); }, week: async (w) => { if (down) throw new Error('代理不通'); written.push('week ' + w.start); } };
  const reports = { get: (d) => (d === 'gone' ? null : { date: d }), getWeek: (s) => ({ start: s }) };
  let on = true;
  const rt = createRetry({ account, calendar, reports: () => reports, wanted: () => on });
  rt.stop();
  rt.add('day', '2026-10-01', new Error('代理不通')); rt.add('day', '2026-10-01', new Error('还是不通')); rt.add('week', '2026-09-28', 'x'); rt.add('day', 'gone', 'x');
  ok('retry: what failed is kept once each, with the latest reason', rt.list().length === 3 && rt.list().find((p) => p.key === '2026-10-01').error === '还是不通', rt.list());
  await rt.run();
  ok('retry: still down -> still waiting (a report no longer there is dropped)', rt.list().length === 2 && !written.length, rt.list());
  on = false; down = false;
  await rt.run();
  ok('retry: not connected / diary off -> not tried', rt.list().length === 2 && !written.length);
  on = true;
  await rt.run();
  ok('retry: back up -> written, nothing waiting', rt.list().length === 0 && written.join(',') === 'day 2026-10-01,week 2026-09-28', [written, rt.list()]);
  rt.add('day', '2026-10-02', 'x'); rt.done('day', '2026-10-02');
  ok('retry: written another way (补写) -> no longer waiting', rt.list().length === 0);
}

// a google.json signed in (or not), in a folder of its own
function account(dir, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'google.json'), JSON.stringify({ clientId: 'a.apps.googleusercontent.com', clientSecret: 's', diary: true, tasks: true,
    token: { refresh: 'r', access: 'x', expiry: Date.now() + 3600e3, scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks' }, ...extra }));
}

async function onReportTests(T) {
  const reportsStore = { get: (d) => ({ date: d, headline: '那天', projects: [] }), getWeek: (s) => ({ start: s, end: s, headline: '周' }), list: () => [], listWeeks: () => [] };
  // Google answers 503 to every write: the report waits
  const D1 = path.join(T, 'g1'); account(D1);
  let down = true;
  const events = [];
  route = (url, o) => {
    if (/calendar\/v3\/calendars\/primary\/events/.test(url) && (o.method || 'GET') === 'GET') return { json: { items: events } };
    if (/calendar\/v3\/calendars\/primary\/events/.test(url) && o.method === 'POST') { if (down) return { status: 503, json: { error: { message: 'Service Unavailable' } } }; const e = JSON.parse(o.body); events.push(e); return { json: e }; }
    return { status: 404, json: { error: { message: 'no route' } } };
  };
  let changed = 0;
  const g = createGoogle({ dataDir: D1, origin: 'http://x', reports: () => reportsStore, onChange: () => changed++, log: () => {} });
  g.onReport({ date: '2026-10-01', headline: '那天', projects: [] });
  await sleep(300);
  let s = g.status();
  ok('a write that fails waits for a retry (the tray and the account window show it)', s.pending.length === 1 && s.pending[0].key === '2026-10-01' && /503/.test(s.pending[0].error) &&
    s.diaryLast && s.diaryLast.ok === false, s);
  down = false;
  g.onReport({ date: '2026-10-01', headline: '那天', projects: [] });
  await sleep(300);
  s = g.status();
  ok('written later: no longer waiting', s.pending.length === 0 && events.length === 1 && s.diaryLast.ok === true, s);
  g.stop();

  // the sign-in had run out at report time: waits for connecting again
  const D2 = path.join(T, 'g2'); account(D2, { token: undefined, error: 'Google 的授权失效了（被撤销或过期），请重新连接' });
  const g2 = createGoogle({ dataDir: D2, origin: 'http://x', reports: () => reportsStore, log: () => {} });
  g2.onReport({ date: '2026-10-02', headline: 'x', projects: [] });
  g2.onWeek({ start: '2026-09-28', end: '2026-10-04' });
  s = g2.status();
  ok('signed out at report time: the day and the week wait for connecting again (shown with the sign-in error)', !s.connected && s.pending.length === 2 &&
    /重新连接/.test(s.pending[0].error) && /授权失效/.test(s.error), s);
  g2.stop();
  // never set up: nothing kept
  const D3 = path.join(T, 'g3'); fs.mkdirSync(D3);
  const g3 = createGoogle({ dataDir: D3, origin: 'http://x', reports: () => reportsStore, log: () => {} });
  g3.onReport({ date: '2026-10-02', headline: 'x', projects: [] });
  ok('Google never set up: nothing waits', g3.status().pending.length === 0);
  g3.stop();
}

async function agendaTests(T) {
  const today = ymd(Date.now()), tomorrow = ymd(Date.now() + 86400e3);
  const D = path.join(T, 'ga'); account(D);
  const todos = createTodos({ dataDir: D });
  todos.add({ text: '交报告', due: today }); todos.add({ text: '明天交', due: tomorrow }); todos.add({ text: '没日期' });
  const t9 = new Date(); t9.setHours(9, 0, 0, 0); const t14 = new Date(); t14.setHours(14, 30, 0, 0);
  route = (url) => {
    if (/calendar\/v3\/calendars\/primary\/events/.test(url)) return { json: { items: [
      { summary: '和导师讨论', start: { dateTime: t14.toISOString() }, end: { dateTime: t14.toISOString() } },
      { summary: '组会', start: { dateTime: t9.toISOString() }, end: { dateTime: t9.toISOString() } },
      { summary: '国庆', start: { date: today }, end: { date: tomorrow } },
      { summary: '日报：昨天', start: { date: today }, end: { date: tomorrow }, extendedProperties: { private: { ameReport: today } } },
    ] } };
    if (/tasks\/v1\/users\/@me\/lists/.test(url)) return { json: { items: [{ id: 'L1', title: '我的任务' }] } };
    if (/tasks\/v1\/lists\/L1\/tasks/.test(url)) return { json: { items: [{ id: 't1', title: '买菜', due: today + 'T00:00:00.000Z', status: 'needsAction' }, { id: 't2', title: '做完了', due: today + 'T00:00:00.000Z', status: 'completed' }] } };
    return { status: 404, json: { error: { message: 'no route' } } };
  };
  const g = createGoogle({ dataDir: D, origin: 'http://x', todos, log: () => {} });
  const a = await g.agenda();
  ok('agenda: today\'s events (all-day first, then by time; not the diary), open tasks due, 重要计划 due', a.date === today && a.google === true &&
    a.events.map((e) => (e.time ? e.time + ' ' : '') + e.title).join('，') === '国庆，09:00 组会，14:30 和导师讨论' && JSON.stringify(a.tasks) === '["买菜"]' &&
    JSON.stringify(a.todos) === '["交报告"]', a);
  route = () => ({ status: 503, json: { error: { message: 'down' } } });
  g.events('2000-01-01', '2000-01-02', true);                       // (clears the minute's copy)
  const b = await g.agenda();
  ok('agenda: Google unreachable -> the 重要计划 still there, events left out', JSON.stringify(b.todos) === '["交报告"]' && b.events.length === 0, b);
  g.stop();
}

// mail alerts to the phone: the 「Windose 提醒」 calendar (google/remind.js through mailAlert)
async function remindTests(T) {
  const D = path.join(T, 'gr'); account(D);
  const g0 = JSON.parse(fs.readFileSync(path.join(D, 'google.json'), 'utf8'));
  g0.token.scope += ' https://www.googleapis.com/auth/calendar.app.created';
  fs.writeFileSync(path.join(D, 'google.json'), JSON.stringify(g0));
  const cals = {}, made = [];
  route = (url, o = {}) => {
    const u = new URL(url);
    if (u.pathname === '/calendar/v3/calendars' && o.method === 'POST') { const c = { id: 'rem' + made.length + '@group', ...JSON.parse(o.body) }; made.push(c); cals[c.id] = []; return { json: c }; }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(u.pathname);
    if (m) {
      const list = cals[decodeURIComponent(m[1])];
      if (!list) return { status: 404, json: { error: { message: 'Not Found' } } };
      if (o.method === 'POST') { const e = { id: 'e' + list.length, ...JSON.parse(o.body) }; list.push(e); return { json: e }; }
      const want = u.searchParams.get('privateExtendedProperty');
      return { json: { items: list.filter((e) => 'ameMail=' + e.extendedProperties.private.ameMail === want) } };
    }
    return { status: 404, json: { error: { message: 'no route' } } };
  };
  const g = createGoogle({ dataDir: D, origin: 'https://win98.example', log: () => {} });
  const due = ymd(Date.now() + 10 * 86400e3);
  const act = { id: 'al1', kind: 'action', key: 'a1:7:3', subject: '报销通知', from: '财务处', summary: '年度报销截止', todo: '提交报销单', deadline: due, deadlineText: `请于 ${due} 前提交` };
  g.mailAlert(act);
  await sleep(300);
  const own = made[0] ? cals[made[0].id] : [];
  const now = own.find((e) => /:now$/.test(e.extendedProperties.private.ameMail)), dl = own.find((e) => /:due$/.test(e.extendedProperties.private.ameMail));
  ok('a calendar of its own, 「Windose 提醒」', made.length === 1 && made[0].summary === 'Windose 提醒', made);
  ok('at once: an event a couple of minutes ahead with a popup at its start, the link back to the mail', now && now.reminders.overrides[0].minutes === 0 && now.reminders.useDefault === false &&
    new Date(now.start.dateTime) > Date.now() && /要办/.test(now.summary) && /#mail=a1%3A7%3A3/.test(now.description) && /提交报销单/.test(now.description), now);
  ok('the deadline: an all-day event on that day, its popup 9:00 the day before (15 h before 0:00)', dl && dl.start.date === due && dl.reminders.overrides[0].minutes === 900 && /截止：提交报销单/.test(dl.summary), dl);
  g.mailAlert(act); await sleep(300);
  ok('the same alert again: nothing doubled', own.length === 2, own.length);
  g.mailAlert({ ...act, id: 'al2', kind: 'reading', picks: [{ title: 'x' }] }); await sleep(300);
  ok('recommended papers: not put in the calendar', own.length === 2);
  // the calendar deleted in Google: made again
  delete cals[made[0].id];
  g.mailAlert({ ...act, id: 'al3', deadline: '' }); await sleep(400);
  ok('the calendar deleted: made again; no deadline: only the at-once event', made.length === 2 && cals[made[1].id].length === 1, [made.length, cals]);
  // switched off / no permission: nothing
  const before = made.length + Object.values(cals).flat().length;
  const g2 = JSON.parse(fs.readFileSync(path.join(D, 'google.json'), 'utf8')); g2.remind = false; fs.writeFileSync(path.join(D, 'google.json'), JSON.stringify(g2));
  const gOff = createGoogle({ dataDir: D, origin: 'x', log: () => {} });
  gOff.mailAlert({ ...act, id: 'al4' }); await sleep(200);
  ok('switched off: nothing written', made.length + Object.values(cals).flat().length === before);
  g.stop(); gOff.stop();
}

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-gmore-'));
  try { await retryUnit(); await onReportTests(T); await agendaTests(T); await remindTests(T); } catch (e) { fail++; console.log('ERROR', e); }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
