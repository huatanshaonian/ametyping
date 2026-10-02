// 重要计划 <-> Google Tasks (server/google/tasks-sync.js) against an in-memory Google Tasks, with the real todos.js;
// plus the daily report's prompt with Google Calendar events (summary/prompts.js) and google/index.js forReport's window.
const fs = require('fs'), path = require('path'), os = require('os');
const R = path.resolve(__dirname, '..');
const { createTodos } = require(R + '/server/todos');
const { createTasksSync, LIST_TITLE } = require(R + '/server/google/tasks-sync');
const { createTasks } = require(R + '/server/google/tasks');
const { dayPrompt } = require(R + '/server/summary/prompts');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 800)}`); };

// ---- the fake Google Tasks (same calls as google/tasks.js) ----
function fakeTasks() {
  const G = { lists: [], tasks: {}, writes: 0, n: 0 };
  const err404 = () => Object.assign(new Error('Google API 404'), { status: 404 });
  const real = createTasks({ account: {} });
  const f = {
    G, day: real.day, dueOf: real.dueOf,
    lists: async () => G.lists.slice(),
    all: async (l) => { if (!G.tasks[l]) throw err404(); return G.tasks[l].map((t) => ({ ...t })); },
    createList: async (title) => { G.writes++; const l = { id: 'L' + ++G.n, title }; G.lists.push(l); G.tasks[l.id] = []; return l; },
    create: async (l, t) => { G.writes++; const x = { id: 'T' + ++G.n, ...t, due: t.due || undefined }; G.tasks[l].push(x); return x; },
    patch: async (l, id, t) => { G.writes++; const x = (G.tasks[l] || []).find((y) => y.id === id); if (!x) throw err404(); Object.assign(x, t); if (t.due === null) delete x.due; return x; },
    remove: async (l, id) => { G.writes++; const a = G.tasks[l] || []; const i = a.findIndex((y) => y.id === id); if (i < 0) throw err404(); a.splice(i, 1); },
  };
  return f;
}

async function syncTests() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-gtasks-'));
  try {
    const todos = createTodos({ dataDir: T });
    const tasks = fakeTasks(), G = tasks.G;
    const account = { status: () => ({ connected: true, tasks: true }), has: () => true };
    const sync = createTasksSync({ dataDir: T, account, tasks, todos });
    sync.stop();
    const list = () => G.tasks[sync.listId()] || [];
    const find = (title) => list().find((t) => t.title === title);
    const item = (text) => todos.list().find((t) => t.text === text);

    const a = todos.add({ text: '交报告', due: '2026-10-05', project: '科研' }).item;
    const b = todos.add({ text: '修代理' }).item;
    const c = todos.add({ text: '旧事' }).item; todos.update({ id: c.id, done: true });
    await sync.run();
    ok('first sync: a list of its own, the open items in it (not the finished one), due date carried',
      G.lists.length === 1 && G.lists[0].title === LIST_TITLE && list().length === 2 && find('交报告').due === '2026-10-05T00:00:00.000Z' &&
      find('交报告').status === 'needsAction' && /项目：科研/.test(find('交报告').notes) && !find('旧事'), [G.lists, list()]);
    ok('sync status: when, no error', sync.status().last > 0 && !sync.status().error, sync.status());

    let w = G.writes; await sync.run();
    ok('nothing changed: a second sync writes nothing', G.writes === w, G.writes - w);

    // ticked off in Google's app (it also hides it)
    Object.assign(find('交报告'), { status: 'completed', completed: new Date().toISOString(), hidden: true });
    await sync.run();
    ok('ticked off in Google: done in Windose', item('交报告').done === true && item('交报告').doneBy === 'user', item('交报告'));

    // edited in Windose
    todos.update({ id: b.id, text: '修 AWS 代理', due: '2026-10-08' });
    await sync.run();
    ok('edited in Windose: the task follows', find('修 AWS 代理') && find('修 AWS 代理').due === '2026-10-08T00:00:00.000Z' && list().length === 2, list());
    // due cleared, then undone in Windose
    todos.update({ id: a.id, done: false });
    todos.update({ id: b.id, due: '' });
    await sync.run();
    ok('not done again in Windose: open in Google; a due date removed there too', find('交报告').status === 'needsAction' && find('交报告').completed === null &&
      !find('修 AWS 代理').due, list());

    // added in Google
    G.tasks[sync.listId()].push({ id: 'g1', title: '手机上加的  事', status: 'needsAction', due: '2026-10-09T00:00:00.000Z' });
    G.tasks[sync.listId()].push({ id: 'g2', title: '早就做完的', status: 'completed' });
    await sync.run();
    ok('added in Google: a new 重要计划 (spaces tidied, due kept); a finished one not brought in',
      item('手机上加的 事') && item('手机上加的 事').due === '2026-10-09' && !item('早就做完的'), todos.list());

    // both sides changed: different things merge, the same thing -> Windose
    find('交报告').title = '交报告（终稿）';
    todos.update({ id: a.id, due: '2026-10-06' });
    find('修 AWS 代理').title = 'Google 改的';
    todos.update({ id: b.id, text: 'Windose 改的' });
    await sync.run();
    ok('changed on both sides: different fields both kept, the same field -> Windose', item('交报告（终稿）') && item('交报告（终稿）').due === '2026-10-06' &&
      find('交报告（终稿）').due === '2026-10-06T00:00:00.000Z' && item('Windose 改的') && find('Windose 改的') && !find('Google 改的'), [todos.list(), list()]);

    // deleted on either side
    todos.remove(item('Windose 改的').id);
    const g1 = list().find((t) => t.id === 'g1'); G.tasks[sync.listId()] = list().filter((t) => t !== g1);
    await sync.run();
    ok('deleted in Windose: gone from Google; deleted in Google: gone from Windose', !find('Windose 改的') && !item('手机上加的 事') && list().length === 2, [list(), todos.list()]);

    // the list deleted in Google: made again, the open items back in it, nothing doubled in Windose
    const n = todos.list().length;
    delete G.tasks[sync.listId()]; G.lists = [];
    await sync.run();
    ok('the list deleted in Google: made again with the open items, no doubles', G.lists.length === 1 && list().length === 1 && find('交报告（终稿）') && todos.list().length === n, [G.lists, list(), todos.list()]);

    // the sync state lost (e.g. another NAS folder) but the list is still there: matched by text, not doubled
    fs.rmSync(path.join(T, 'google-tasks.json'));
    const sync2 = createTasksSync({ dataDir: T, account, tasks, todos }); sync2.stop();
    await sync2.run();
    ok('state lost, list still there: found by name, items matched by text, nothing doubled', G.lists.length === 1 && G.tasks[G.lists[0].id].length === 1 &&
      todos.list().length === n, [G.lists, G.tasks, todos.list().length, n]);

    // off, or no permission: no calls
    w = G.writes;
    const off = createTasksSync({ dataDir: T, account: { status: () => ({ connected: true, tasks: false }), has: () => true }, tasks, todos }); off.stop();
    todos.add({ text: '关掉同步时加的' });
    await off.run();
    const noScope = createTasksSync({ dataDir: T, account: { status: () => ({ connected: true, tasks: true }), has: () => false }, tasks, todos }); noScope.stop();
    await noScope.run();
    ok('switched off / not permitted: Google is not touched', G.writes === w, G.writes - w);

    // Google down: the error is kept for the account window, nothing lost
    const broken = { ...tasks, all: async () => { throw new Error('连不上 Google'); } };
    const s3 = createTasksSync({ dataDir: T, account, tasks: broken, todos }); s3.stop();
    await s3.run();
    ok('Google unreachable: the error is shown, items untouched', /连不上/.test(s3.status().error) && todos.list().length === n + 1, s3.status());
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
}

function promptTests() {
  const t0 = new Date('2026-10-01T04:30:00+08:00').getTime(), t1 = t0 + 86400e3;
  const sess = [{ key: 'S1', hint: {}, digest: { title: 'x', machine: 'pc', cwd: 'D:/x', activeMin: 10, files: [], plans: [], text: '用户：改代码' } }];
  const p = dayPrompt({ from: t0, to: t1, sessions: sess, events: [{ title: '组会', start: '2026-10-01T14:00:00+08:00', end: '2026-10-01T15:30:00+08:00', allDay: false, location: '305' }, { title: '国庆', allDay: true, start: '2026-10-01' }] });
  ok('report prompt: the day\'s events listed, as background only', /## 日程（Google 日历）/.test(p) && /10月1日 14:00–15:30 组会（305）/.test(p) && /- 全天 国庆/.test(p) && /只作背景/.test(p), p.slice(-600));
  const q = dayPrompt({ from: t0, to: t1, sessions: sess });
  ok('report prompt: no events, no 日程 section', !/日程/.test(q));
}

// forReport: which events fall in a report's window
async function windowTests() {
  const http = require(R + '/server/google/http');
  const orig = http.request;
  const calls = [];
  let evs = [];
  http.request = async (url) => { calls.push(url); return { status: 200, json: { items: evs }, body: Buffer.from('') }; };
  const { createGoogle } = require(R + '/server/google/index');           // (account.js takes request when loaded)
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-gwin-'));
  try {
    fs.writeFileSync(path.join(T, 'google.json'), JSON.stringify({ clientId: 'a.apps.googleusercontent.com', clientSecret: 's', token: { refresh: 'r', access: 'x', expiry: Date.now() + 3600e3, scope: '' }, tasks: false }));
    const g = createGoogle({ dataDir: T, origin: 'http://x', log: () => {} });
    // calendar.events is reached through account.api: answer the events list
    evs = [
      { summary: '前一天的会', start: { dateTime: '2026-09-30T15:00:00+08:00' }, end: { dateTime: '2026-09-30T16:00:00+08:00' } },
      { summary: '组会', start: { dateTime: '2026-10-01T14:00:00+08:00' }, end: { dateTime: '2026-10-01T15:00:00+08:00' } },
      { summary: '凌晨还在', start: { dateTime: '2026-10-02T03:00:00+08:00' }, end: { dateTime: '2026-10-02T04:00:00+08:00' } },
      { summary: '第二天上午', start: { dateTime: '2026-10-02T09:00:00+08:00' }, end: { dateTime: '2026-10-02T10:00:00+08:00' } },
      { summary: '国庆', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } },
      { summary: '第二天全天', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } },
      { summary: '日报：…', start: { date: '2026-10-01' }, end: { date: '2026-10-02' }, extendedProperties: { private: { ameReport: '2026-10-01' } } },
    ];
    try {
      const t0 = new Date('2026-10-01T04:30:00+08:00').getTime();
      const got = (await g.forReport(t0, t0 + 86400e3)).map((e) => e.title);
      ok('report window 04:30–04:30: that day\'s events and all-day ones, not the diary, not the next day', got.join(',') === '组会,凌晨还在,国庆', got);
      const draft = (await g.forReport(t0, new Date('2026-10-01T20:00:00+08:00').getTime())).map((e) => e.title);
      ok('「总结到现在」 within one day: its all-day events too', draft.includes('国庆') && draft.includes('组会') && !draft.includes('凌晨还在'), draft);
    } finally { http.request = orig; }
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
  ok('(Google was asked)', calls.length > 0);
}

(async () => {
  try { await syncTests(); promptTests(); await windowTests(); } catch (e) { fail++; console.log('ERROR', e); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
