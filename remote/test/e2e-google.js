// e2e: Google (calendar diary, events in the calendar window, notes to Drive) against a fake Google: the server's
// proxy list points at a fake CONNECT proxy that sends every tunnel to a local HTTPS server (self-signed; certificate
// checks are off in this test's server only) which plays oauth2 / calendar / drive.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), https = require('https'), net = require('net'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createCalendar } = require(R + '/server/google/calendar');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-google-'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18814, PROXY = 18815, FAKE = 18816;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 600)}`); };
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// ---- the fake Google ----
cp.execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(T, 'k.pem'), '-out', path.join(T, 'c.pem'), '-days', '1', '-subj', '/CN=fake-google'], { stdio: 'ignore' });
const G = { tokens: [], events: [], files: [], uploads: [], revoked: [], refreshFails: false, expiresIn: 3600, hosts: new Set(),
  scope: 'openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file',     // a sign-in from before Tasks
  tlists: [{ id: 'mine', title: '我的任务' }], ttasks: { mine: [] }, eventReads: 0, cals: {}, calInfo: [], evn: 0 };
const own = () => G.cals[Object.keys(G.cals)[0]] || [];           // the "Windose 日报" calendar
const idToken = 'x.' + Buffer.from(JSON.stringify({ email: 'me@gmail.com' })).toString('base64url') + '.y';
const fake = https.createServer({ key: fs.readFileSync(path.join(T, 'k.pem')), cert: fs.readFileSync(path.join(T, 'c.pem')) }, (req, res) => {
  let b = []; req.on('data', (c) => b.push(c)); req.on('end', () => {
    const body = Buffer.concat(b), u = new URL(req.url, 'https://x'), send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    G.hosts.add(req.headers.host);
    if (/:\d+$/.test(req.headers.host || '')) return send(404, { error: 'invalid_request' });   // like Google: "Host: x:80" is not found
    const authed = req.headers.authorization === 'Bearer at-' + G.tokens.length;
    if (u.pathname === '/token') {
      const p = new URLSearchParams(body.toString());
      G.tokens.push(Object.fromEntries(p));
      if (p.get('grant_type') === 'refresh_token' && G.refreshFails) return send(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return send(200, { access_token: 'at-' + G.tokens.length, refresh_token: p.get('grant_type') === 'authorization_code' ? 'rt-secret' : undefined, expires_in: G.expiresIn, id_token: idToken, scope: G.scope });
    }
    if (u.pathname === '/revoke') { G.revoked.push(u.searchParams.get('token')); return send(200, {}); }
    if (!authed) return send(401, { error: { message: 'bad token' } });
    if (u.pathname === '/calendar/v3/calendars' && req.method === 'POST') { const c = { id: 'cal' + (Object.keys(G.cals).length + 1) + '@group.calendar.google.com', ...JSON.parse(body) }; G.cals[c.id] = []; G.calInfo.push(c); return send(200, c); }
    const cm = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (cm) {
      const id = decodeURIComponent(cm[1]), list = id === 'primary' ? G.events : G.cals[id];
      if (!list) return send(404, { error: { message: 'Not Found' } });
      if (!cm[2] && req.method === 'GET') {
        if (id === 'primary' && !u.searchParams.get('privateExtendedProperty')) G.eventReads++;
        const prop = u.searchParams.get('privateExtendedProperty');
        const pv = (e) => e.extendedProperties && e.extendedProperties.private || {};
        return send(200, { items: prop ? list.filter((e) => `ameReport=${pv(e).ameReport}` === prop || `ameWeek=${pv(e).ameWeek}` === prop) : list });
      }
      if (!cm[2] && req.method === 'POST') { const e = { id: 'ev' + ++G.evn, ...JSON.parse(body) }; list.push(e); return send(200, e); }
      const e = list.find((x) => x.id === decodeURIComponent(cm[2] || ''));
      if (!e) return send(404, { error: { message: 'Not Found' } });
      if (req.method === 'PATCH') { Object.assign(e, JSON.parse(body)); e.patched = (e.patched || 0) + 1; return send(200, e); }
      if (req.method === 'DELETE') { list.splice(list.indexOf(e), 1); res.writeHead(204); return res.end(); }
    }
    // Google Tasks
    if (u.pathname === '/tasks/v1/users/@me/lists' && req.method === 'GET') return send(200, { items: G.tlists });
    if (u.pathname === '/tasks/v1/users/@me/lists' && req.method === 'POST') { const l = { id: 'list' + G.tlists.length, ...JSON.parse(body) }; G.tlists.push(l); G.ttasks[l.id] = []; return send(200, l); }
    const tm = /^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(u.pathname);
    if (tm) {
      const l = G.ttasks[decodeURIComponent(tm[1])];
      if (!l) return send(404, { error: { message: 'no list' } });
      if (req.method === 'GET') { const lo = u.searchParams.get('dueMin'), hi = u.searchParams.get('dueMax'); return send(200, { items: l.filter((t) => !lo || (t.due && t.due >= lo && t.due <= hi)) }); }
      if (req.method === 'POST') { const t = { id: 't' + Date.now() + l.length, ...JSON.parse(body) }; l.push(t); return send(200, t); }
      const t = l.find((x) => x.id === decodeURIComponent(tm[2] || ''));
      if (!t) return send(404, { error: { message: 'no task' } });
      if (req.method === 'PATCH') { Object.assign(t, JSON.parse(body)); return send(200, t); }
      if (req.method === 'DELETE') { l.splice(l.indexOf(t), 1); res.writeHead(204); return res.end(); }
    }
    if (u.pathname === '/drive/v3/files' && req.method === 'POST') { const f = { id: 'folder1', ...JSON.parse(body) }; G.files.push(f); return send(200, f); }
    if (u.pathname.startsWith('/drive/v3/files/') && req.method === 'GET') return send(200, { id: u.pathname.split('/').pop(), trashed: false });
    if (u.pathname.startsWith('/drive/v3/files/') && req.method === 'PATCH') return send(200, { id: u.pathname.split('/').pop() });
    if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') { G.uploads.push({ kind: 'new', body: body.toString('utf8') }); return send(200, { id: 'file1', name: 'n.txt' }); }
    if (u.pathname.startsWith('/upload/drive/v3/files/') && req.method === 'PATCH') { G.uploads.push({ kind: 'update', id: u.pathname.split('/').pop(), body: body.toString('utf8') }); return send(200, { id: 'file1' }); }
    send(404, { error: { message: 'no route ' + req.method + ' ' + u.pathname } });
  });
}).listen(FAKE, '127.0.0.1');
// the fake proxy: every CONNECT (whatever host) goes to the fake Google
const tunnels = [];
const proxy = http.createServer();
proxy.on('connect', (req, sock) => { tunnels.push(req.url); const up = net.connect(FAKE, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock).pipe(up); }); up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy()); });
proxy.listen(PROXY, '127.0.0.1');

// ---- unit: a regenerated report updates its diary event ----
async function unit() {
  const evs = [];
  const account = { api: async (url, o = {}) => {
    if (/privateExtendedProperty/.test(url)) {
      const want = new URL(url).searchParams.get('privateExtendedProperty'), pv = (e) => e.extendedProperties.private;
      return { items: evs.filter((e) => want === 'ameReport=' + pv(e).ameReport || want === 'ameWeek=' + pv(e).ameWeek) };
    }
    if (o.method === 'POST') { const e = { id: 'e' + evs.length, ...o.json }; evs.push(e); return e; }
    if (o.method === 'PATCH') { const e = evs.find((x) => url.endsWith(x.id)); Object.assign(e, o.json); return e; }
    return { items: evs };
  }, has: () => false, get: (k) => mem[k], remember: (k, v) => { mem[k] = v; } };
  const mem = {};
  const cal = createCalendar({ account, origin: 'https://win98.example' });
  const r = { date: '2026-09-29', headline: '改了日报', projects: [{ name: 'Windose', category: 'personal', summary: '加了日历' }, { name: '代理', category: 'chore' }], todosDone: [{ text: '做日历' }] };
  await cal.diary(r); await cal.diary({ ...r, headline: '改了日报（重写）' });
  ok('diary: one event per day, a rewrite updates it', evs.length === 1 && evs[0].summary === '日报：改了日报（重写）', evs);
  ok('diary: all-day, free, link back, chores only counted', evs[0].start.date === '2026-09-29' && evs[0].end.date === '2026-09-30' && evs[0].transparency === 'transparent' &&
    /#report=2026-09-29/.test(evs[0].description) && /杂活 1 件/.test(evs[0].description) && /✓ 做日历/.test(evs[0].description) && !/代理：/.test(evs[0].description), evs[0]);
  ok('diary: drafts never go to the calendar', (await cal.diary({ ...r, draft: true })) === null && evs.length === 1);
  ok('diary: the last write is kept for the account window', mem.diaryLast && mem.diaryLast.ok && /2026-09-29/.test(mem.diaryLast.what), mem);
  // the weekly report: the week's Sunday, its link
  const w = { start: '2026-09-21', end: '2026-09-27', headline: '重画 RCS 图', projects: [{ name: '论文', category: 'research', summary: '图定稿' }], highlights: ['投稿'], stats: { minutes: 600 } };
  await cal.week(w); await cal.week({ ...w, headline: '重画 RCS 图（改）' });
  const we = evs.filter((e) => e.extendedProperties.private.ameWeek);
  ok('week: one all-day event on the Sunday, rewritten in place, linked to the weekly report', we.length === 1 && we[0].start.date === '2026-09-27' && we[0].end.date === '2026-09-28' &&
    we[0].summary === '周报：重画 RCS 图（改）' && /#report=week-2026-09-21/.test(we[0].description) && /★ 投稿/.test(we[0].description) && /约 10 小时/.test(we[0].description), we);
}

const req = (method, p, body, cookie, raw) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => { let j = null; if (!raw) try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, b, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.end(data);
});

async function e2e() {
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; cfg.origin = `http://127.0.0.1:${PORT}`;
  cfg.summary = { proxies: [`http://127.0.0.1:${PROXY}`], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')], quietMin: 0 };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  // a scheduled report is due at once (the last one ended two days ago): it becomes a diary event once connected
  const RD = path.join(T, 'srv', 'data', 'reports'); fs.mkdirSync(RD, { recursive: true });
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env: { ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0', AME_SUMMARY_TICK_MS: '600000' }, stdio: 'ignore' });
  try {
    await sleep(1000);
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    let s = (await req('GET', '/api/google', null, cookie)).j || {};
    ok('not set up yet; the redirect address to register', !s.configured && !s.connected && s.redirect === `http://127.0.0.1:${PORT}/api/google/callback`, s);
    ok('bad client id refused', !((await req('POST', '/api/google/client', { clientId: 'nope', clientSecret: 'x' }, cookie)).j || {}).ok);
    ok('client saved', ((await req('POST', '/api/google/client', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' }, cookie)).j || {}).ok);
    const c = (await req('POST', '/api/google/connect', {}, cookie)).j || {};
    const au = new URL(c.url || 'http://x');
    ok('connect: the consent screen with offline access, calendar events + drive.file + tasks only', c.ok && au.host === 'accounts.google.com' && au.searchParams.get('access_type') === 'offline' &&
      /calendar\.events/.test(au.searchParams.get('scope')) && /drive\.file/.test(au.searchParams.get('scope')) && /auth\/tasks\b/.test(au.searchParams.get('scope')) &&
      !/auth\/drive /.test(au.searchParams.get('scope') + ' ') && au.searchParams.get('state'), c);
    const state = au.searchParams.get('state');
    ok('callback with a made-up state refused', /没能连接/.test((await req('GET', '/api/google/callback?code=abc&state=forged', null, null, true)).b));
    const cb = await req('GET', `/api/google/callback?code=abc&state=${state}`, null, null, true);        // no login cookie, like Google's redirect
    ok('callback (without the login cookie) finishes on the one-time state, then back to Windose', cb.status === 200 && /url=\/#google=ok/.test(cb.b), cb.b);
    ok('the same state cannot be used twice', /没能连接/.test((await req('GET', `/api/google/callback?code=abc&state=${state}`, null, null, true)).b));
    ok('traffic to Google went through the proxy', tunnels.some((t) => t.startsWith('oauth2.googleapis.com:443')), tunnels);
    s = (await req('GET', '/api/google', null, cookie)).j || {};
    ok('connected as the account\'s e-mail; no secret or token in the answer', s.connected && s.email === 'me@gmail.com' && !JSON.stringify(s).includes('GOCSPX') && !JSON.stringify(s).includes('rt-secret'), s);
    ok('a sign-in from before Tasks and the calendar of our own: asked to connect once more', JSON.stringify(s.missing) === '["tasks","calendar"]' && !s.ownCalendar, s);
    // connect again, now granting Tasks too
    G.scope += ' https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar.app.created';
    G.events.push({ id: 'old', summary: '日报：九月一日', start: { date: '2026-09-01' }, end: { date: '2026-09-02' }, transparency: 'transparent', extendedProperties: { private: { ameReport: '2026-09-01' } } });
    const c2u = new URL(((await req('POST', '/api/google/connect', {}, cookie)).j || {}).url || 'http://x');
    await req('GET', `/api/google/callback?code=abc2&state=${c2u.searchParams.get('state')}`, null, null, true);
    s = (await req('GET', '/api/google', null, cookie)).j || {};
    ok('connected again: nothing missing, Tasks sync on', s.connected && s.missing.length === 0 && s.tasks === true && s.sync && s.sync.list === 'Windose 重要计划', s);
    for (let i = 0; i < 40 && !own().length; i++) await sleep(150);
    s = (await req('GET', '/api/google', null, cookie)).j || {};
    ok('the reports get a calendar of their own; the old diary event moved there from the primary calendar', G.calInfo.length === 1 && G.calInfo[0].summary === 'Windose 日报' &&
      own().length === 1 && own()[0].summary === '日报：九月一日' && !G.events.some((e) => e.id === 'old') && s.ownCalendar === true, [G.calInfo, G.cals, G.events]);
    ok('kept privately on the NAS', process.platform === 'win32' || (fs.statSync(path.join(T, 'srv', 'data', 'google.json')).mode & 0o777) === 0o600);
    // the scheduled report now: restart with a due report so the tick writes it (and its diary event)
    srv.kill(); await sleep(500);
    fs.writeFileSync(path.join(RD, 'state.json'), JSON.stringify({ lastTo: Date.now() - 2 * 86400e3 }));
    const srv2 = cp.spawn(process.execPath, [R + '/server/server.js'], { env: { ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0', AME_SUMMARY_TICK_MS: '500' }, stdio: 'ignore' });
    try {
      for (let i = 0; i < 60 && own().length < 2; i++) await sleep(250);
      const ev = own()[1] || {};
      const rep = fs.readdirSync(RD).find((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
      ok('the scheduled report became that day\'s diary event', ev.extendedProperties && ev.extendedProperties.private.ameReport === (rep || '').slice(0, 10) && /^日报：/.test(ev.summary) && !G.events.length, [G.cals, G.events, rep]);
      const { cookie: c2 } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + 1) });
      // an event of your own, and the calendar window's month
      const d = rep.slice(0, 10);
      G.events.push({ id: 'mine', summary: '组会', start: { dateTime: d + 'T14:00:00+08:00' }, end: { dateTime: d + 'T15:00:00+08:00' } });
      G.ttasks.mine.push({ id: 'buy', title: '买菜', due: d + 'T00:00:00.000Z', status: 'needsAction' });
      const t1 = await req('POST', '/api/todos/add', { text: '交报告', due: d }, c2);
      for (let i = 0; i < 40 && !Object.values(G.ttasks).flat().some((t) => t.title === '交报告'); i++) await sleep(250);
      const mirror = G.tlists.find((l) => l.title === 'Windose 重要计划');
      ok('a new 重要计划 is in Google Tasks a few seconds later (its own list, due date)', mirror && G.ttasks[mirror.id].some((t) => t.title === '交报告' && t.due === d + 'T00:00:00.000Z'), [G.tlists, G.ttasks]);
      const m = (await req('GET', '/api/calendar?month=' + d.slice(0, 7), null, c2)).j || {};
      const day = (m.days || {})[d] || {};
      ok('calendar month: the report, the item due, your event (not the diary event twice), your task (not the mirrored item twice)', day.report && day.todos.some((t) => t.text === '交报告') &&
        day.events.length === 1 && day.events[0].title === '组会' && m.google.connected && !m.google.error &&
        day.tasks.length === 1 && day.tasks[0].title === '买菜' && day.tasks[0].list === '我的任务', [day, m.google, t1.j]);
      // within the minute: the copy; fresh=1 (opening the window, 刷新): Google again
      const reads = G.eventReads;
      await req('GET', '/api/calendar?month=' + d.slice(0, 7), null, c2);
      const r1 = G.eventReads;
      G.events.push({ id: 'new', summary: '刚加的', start: { dateTime: d + 'T09:00:00+08:00' }, end: { dateTime: d + 'T10:00:00+08:00' } });
      const mf = (await req('GET', '/api/calendar?month=' + d.slice(0, 7) + '&fresh=1', null, c2)).j || {};
      ok('the month again within a minute: not asked again; fresh=1: asked again, the new event there', r1 === reads && G.eventReads === reads + 1 &&
        ((mf.days || {})[d] || { events: [] }).events.some((e) => e.title === '刚加的'), [reads, r1, G.eventReads]);
      G.events = G.events.filter((e) => e.id !== 'new');
      // a note to Drive, twice: one file, updated
      const n = (await req('POST', '/api/notes/save', { text: 'RCS 笔记\nloglog' }, c2)).j;
      const d1 = (await req('POST', '/api/google/drive-note', { id: n.id }, c2)).j || {};
      await req('POST', '/api/notes/save', { id: n.id, text: 'RCS 笔记\nloglog + errorbar', base: n.updated }, c2);
      const d2 = (await req('POST', '/api/google/drive-note', { id: n.id }, c2)).j || {};
      ok('note to Drive: into a folder of its own, then the same file updated', d1.ok && d2.ok && G.files.some((f) => f.name === 'Windose 记事本') &&
        G.uploads[0].kind === 'new' && /RCS 笔记/.test(G.uploads[0].body) && G.uploads[1] && G.uploads[1].kind === 'update' && /errorbar/.test(G.uploads[1].body), [d1, d2, G.uploads.map((u) => u.kind)]);
      const nl = ((await req('GET', '/api/notes', null, c2)).j || {}).items || [];
      ok('the note remembers its Drive copy', nl[0] && nl[0].drive && nl[0].drive.fileId === 'file1', nl);
      // 把过去的日报补进日历: a backfilled short report and a weekly one too; twice = no doubles
      const past = { date: '2026-09-02', brief: true, headline: '补录的一天', projects: [], stats: { minutes: 30 } };
      fs.writeFileSync(path.join(RD, '2026-09-02.json'), JSON.stringify(past));
      fs.writeFileSync(path.join(RD, 'week-2026-08-31.json'), JSON.stringify({ start: '2026-08-31', end: '2026-09-06', headline: '那一周', projects: [], highlights: [], stats: { minutes: 30 } }));
      const runBackfill = async () => {
        const b = (await req('POST', '/api/google/backfill', {}, c2)).j || {};
        let st = {};
        for (let i = 0; i < 80; i++) { st = ((await req('GET', '/api/google', null, c2)).j || {}).backfill || {}; if (!st.running) break; await sleep(150); }
        return { b, st };
      };
      const b1 = await runBackfill();
      const n1 = own().length;
      const b2 = await runBackfill();
      const pv = (e) => e.extendedProperties.private;
      ok('past reports into the calendar: every daily (backfilled ones too) and weekly report, once', b1.b.ok && !b1.st.running && b1.st.failed === 0 && b1.st.total === 3 &&
        own().some((e) => pv(e).ameReport === '2026-09-02' && e.summary === '日报：补录的一天') && own().some((e) => pv(e).ameWeek === '2026-08-31' && e.start.date === '2026-09-06') &&
        own().some((e) => pv(e).ameReport === rep.slice(0, 10)) && b2.st.done === 3 && own().length === n1, [b1, b2, own().map((e) => e.summary)]);
      const sl = ((await req('GET', '/api/google', null, c2)).j || {}).diaryLast || {};
      ok('the account window shows the last write', sl.ok === true && sl.at > 0 && /周报|日报/.test(sl.what), sl);
      // the access token runs out: renewed with the refresh token
      const before = G.tokens.length;
      const gj = JSON.parse(fs.readFileSync(path.join(T, 'srv', 'data', 'google.json'), 'utf8'));
      ok('an access token is renewed when it runs out', gj.token && gj.token.refresh === 'rt-secret' && before >= 1);
      // refresh refused (revoked on Google's side): shown as needing a new connection
      G.refreshFails = true;
      const google = (await req('GET', '/api/google', null, c2)).j;
      srv2.kill(); await sleep(400);
      const g2 = JSON.parse(fs.readFileSync(path.join(T, 'srv', 'data', 'google.json'), 'utf8'));
      g2.token.expiry = 0; fs.writeFileSync(path.join(T, 'srv', 'data', 'google.json'), JSON.stringify(g2));
      const srv3 = cp.spawn(process.execPath, [R + '/server/server.js'], { env: { ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0', AME_SUMMARY_TICK_MS: '600000' }, stdio: 'ignore' });
      try {
        await sleep(1000);
        let c3 = '';                                                   // a code not used yet (each is good once)
        for (const off of [-1, 0, 1]) { const l = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + off) }); if (l.status === 200 && l.cookie) { c3 = l.cookie; break; } }
        const m2 = (await req('GET', '/api/calendar?month=' + d.slice(0, 7), null, c3)).j || {};
        const s3 = (await req('GET', '/api/google', null, c3)).j || {};
        ok('a revoked authorization: the calendar says so, the account asks to reconnect', /授权失效|invalid_grant|expired/.test(m2.google.error || '') && !s3.connected && /重新连接/.test(s3.error), [m2.google, s3, google]);
        G.refreshFails = false;
        ok('disconnect', ((await req('POST', '/api/google/disconnect', {}, c3)).j || {}).ok && !((await req('GET', '/api/google', null, c3)).j || {}).connected);
      } finally { srv3.kill(); }
    } finally { srv2.kill(); }
  } finally { srv.kill(); }
}

(async () => {
  try { await unit(); await e2e(); } catch (e) { fail++; console.log('ERROR', e); }
  fake.close(); proxy.close(); await sleep(500);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
