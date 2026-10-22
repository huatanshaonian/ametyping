// e2e: 重要计划 with lists and steps (server/todos.js, todo-lists.js, todo-steps.js) through the real server's API:
// plans written before lists existed appear unchanged in the first list; lists added, renamed, moved, deleted (with
// their plans); steps added, ticked, edited, moved, deleted; what other parts call (update from Google Tasks, the
// report's complete) leaves the steps alone.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createTodos } = require(R + '/server/todos');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-todos-'));
const PORT = 18860;
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x))}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// plans as an older version wrote them
const OLD = [
  { id: 'a1', text: '写完第三章', project: '论文', due: '2026-11-01', created: 1, from: { date: '2026-10-01' }, done: false },
  { id: 'a2', text: '读 Taflove 第 7 章', project: '文献', due: '', created: 2, from: null, lit: { key: 'ABCD1234', page: 12 }, done: false },
  { id: 'a3', text: '已做完的', project: '', due: '', created: 3, from: null, done: true, doneAt: 5, doneBy: 'report:2026-10-02', evidence: '在会话里做了' },
];

(async () => {
  const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.join(T, 'srv', 'data'), { recursive: true });
  fs.writeFileSync(path.join(T, 'srv', 'data', 'todos.json'), JSON.stringify(OLD));
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
  const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
  node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  const up = () => new Promise((res) => http.get(`http://127.0.0.1:${PORT}/login`, (x) => { x.resume(); res(true); }).on('error', () => res(false)));
  try {
    for (let i = 0; i < 75 && !(await up()); i++) await sleep(200);
    const cookie = await new Promise((resolve) => {
      const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
        (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0]); });
      req.end(body);
    });
    const api = (p, body) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: data ? 'POST' : 'GET',
        headers: { Cookie: cookie, Origin: `http://127.0.0.1:${PORT}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ status: res.statusCode, body: b }); } }); });
      req.on('error', reject); req.end(data);
    });
    const get = () => api('/api/todos');
    const find = async (id) => (await get()).items.find((t) => t.id === id);

    // ---- old data ----
    let g = await get();
    ok('old plans are all there, unchanged', g.items.length === 3 && JSON.stringify(g.items) === JSON.stringify(OLD), g.items);
    ok('one list to start with: 重要计划 (main), holding them', g.lists.length === 1 && g.lists[0].id === 'main' && g.lists[0].name === '重要计划', g.lists);
    ok('nothing written just by reading', JSON.parse(fs.readFileSync(path.join(T, 'srv', 'data', 'todos.json'))).every((t) => !('list' in t) && !('steps' in t)));

    // ---- lists ----
    let r = await api('/api/todos/list', { op: 'add', name: '  实验  ' });
    const L1 = r.list && r.list.id;
    ok('a list added (name trimmed)', r.ok && r.list.name === '实验', r);
    r = await api('/api/todos/list', { op: 'add', name: '实验' });
    ok('the same name twice: refused', !r.ok && /已经有/.test(r.msg), r);
    r = await api('/api/todos/list', { op: 'add', name: '生活' }); const L2 = r.list.id;
    r = await api('/api/todos/list', { op: 'rename', id: L2, name: '日常' });
    ok('renamed', r.ok && (await get()).lists.find((l) => l.id === L2).name === '日常', r);
    r = await api('/api/todos/list', { op: 'move', id: L2, to: 1 });
    g = await get();
    ok('moved; the first list stays first', r.ok && g.lists.map((l) => l.id).join() === ['main', L2, L1].join(), g.lists);
    r = await api('/api/todos/list', { op: 'delete', id: 'main' });
    ok('the first list cannot be deleted', !r.ok, r);
    r = await api('/api/todos/list', { op: 'rename', id: 'main', name: '收件箱' });
    ok('…but can be renamed', r.ok, r);

    // ---- plans in lists ----
    r = await api('/api/todos/add', { text: '扫频仿真', list: L1, star: true, steps: ['建模', '划网格', { text: '跑', done: true }] });
    const P = r.item;
    ok('a plan in a list, starred, with steps given', r.ok && P.list === L1 && P.star === true && P.steps.length === 3 && P.steps[2].done === true && P.steps.every((s) => s.id), r);
    r = await api('/api/todos/add', { text: '没有分类的', list: 'nope' });
    ok('an unknown list: put in the first one (no "list" field)', r.ok && !('list' in r.item), r.item);
    r = await api('/api/todos/update', { id: 'a1', list: L1 });
    ok('an old plan moved into a list', r.ok && (await find('a1')).list === L1, r);
    r = await api('/api/todos/update', { id: 'a1', list: 'main' });
    ok('…and back: the field goes again', r.ok && !('list' in (await find('a1'))), await find('a1'));
    r = await api('/api/todos/update', { id: P.id, star: false });
    ok('unstarred: the field goes', r.ok && !('star' in (await find(P.id))));

    // ---- steps ----
    r = await api('/api/todos/step', { id: 'a1', op: 'add', text: '第一节' });
    const S1 = r.step && r.step.id;
    ok('a step under an old plan', r.ok && (await find('a1')).steps.length === 1, r);
    for (const t of ['第二节', '第三节', '第四节']) await api('/api/todos/step', { id: 'a1', op: 'add', text: t });
    let st = (await find('a1')).steps;
    ok('steps 1 2 3 4 in order', st.map((s) => s.text).join() === '第一节,第二节,第三节,第四节', st);
    r = await api('/api/todos/step', { id: 'a1', op: 'add', text: '插在第二', at: 1 });
    st = (await find('a1')).steps;
    ok('a step put in at a place', st[1].text === '插在第二' && st.length === 5, st);
    r = await api('/api/todos/step', { id: 'a1', op: 'update', sid: S1, done: true });
    ok('ticked', r.ok && (await find('a1')).steps[0].done === true, r);
    r = await api('/api/todos/step', { id: 'a1', op: 'update', sid: S1, text: '  第一节：引言 ' });
    ok('edited (trimmed), still ticked', (await find('a1')).steps[0].text === '第一节：引言' && (await find('a1')).steps[0].done, (await find('a1')).steps[0]);
    r = await api('/api/todos/step', { id: 'a1', op: 'update', sid: S1, text: '   ' });
    ok('emptied: refused', !r.ok, r);
    r = await api('/api/todos/step', { id: 'a1', op: 'move', sid: S1, to: 3 });
    st = (await find('a1')).steps;
    ok('moved down to the 4th place', r.ok && st[3].id === S1 && st.length === 5, st.map((s) => s.text));
    r = await api('/api/todos/step', { id: 'a1', op: 'delete', sid: st[1].id });
    ok('deleted', r.ok && (await find('a1')).steps.length === 4, r);
    r = await api('/api/todos/step', { id: 'a1', op: 'update', sid: 'nope', done: true });
    ok('an unknown step: said so', !r.ok && /找不到/.test(r.msg), r);
    r = await api('/api/todos/step', { id: 'a1', op: 'add', text: 'x'.repeat(500) });
    ok('a long step cut at 200', r.ok && r.step.text.length === 200, r.step && r.step.text.length);

    // ---- deleting a list deletes its plans ----
    await api('/api/todos/add', { text: '实验里另一个', list: L1 });
    r = await api('/api/todos/list', { op: 'delete', id: L1 });
    g = await get();
    ok('a list deleted with its plans', r.ok && r.removed === 2 && !g.lists.some((l) => l.id === L1) && !g.items.some((t) => t.list === L1), r);
    ok('…the others untouched', g.items.some((t) => t.id === 'a1') && g.items.some((t) => t.id === 'a2'), g.items.map((t) => t.text));
    ok('lists kept in their own file', JSON.parse(fs.readFileSync(path.join(T, 'srv', 'data', 'todo-lists.json'))).map((l) => l.name).join() === '收件箱,日常');
  } catch (e) { fail++; console.log('ERROR', e); }
  finally { srv.kill(); }

  // ---- what other parts call (Google Tasks sync, the morning report) leaves steps and lists alone ----
  try {
    const D = path.join(T, 'direct'); fs.mkdirSync(D);
    const td = createTodos({ dataDir: D });
    const l = td.changeList({ op: 'add', name: '论文' }).list;
    const t = td.add({ text: '投稿', list: l.id, steps: ['改格式', '写 cover letter'] }).item;
    td.update({ id: t.id, text: '投稿 IEEE', due: '2026-12-01', done: false });
    let x = td.list().find((y) => y.id === t.id);
    ok('Google Tasks style update: steps and list stay', x.text === '投稿 IEEE' && x.steps.length === 2 && x.list === l.id, x);
    td.complete(t.id, '2026-10-22', '会话里投了');
    x = td.list().find((y) => y.id === t.id);
    ok('the report ticks it off: steps stay', x.done && x.doneBy === 'report:2026-10-22' && x.steps.length === 2, x);
    ok('open() and list() as before', td.open().length === 0 && td.list().length === 1);
    const again = createTodos({ dataDir: D });
    ok('read back from disk', again.lists().map((y) => y.name).join() === '重要计划,论文' && again.list()[0].steps.length === 2);
  } catch (e) { fail++; console.log('ERROR', e); }
  await sleep(300); fs.rmSync(T, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
