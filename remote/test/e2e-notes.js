// e2e: 记事本. Notes on the NAS: save / read / list / delete; a save made from an older version (the note changed on
// another device meanwhile) is kept as a 「冲突副本」 instead of overwriting; the search finds notes; not logged in = no.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-notes-'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18812;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 500)}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')] };
fs.writeFileSync(CFG, JSON.stringify(cfg));
const req = (method, p, body, cookie) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.end(data);
});

(async () => {
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  try {
    await sleep(900);
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    ok('not logged in: refused', (await req('GET', '/api/notes')).status === 401 && (await req('POST', '/api/notes/save', { text: 'x' })).status === 401);
    const s1 = await req('POST', '/api/notes/save', { text: 'RCS 画图笔记\nmatplotlib 用 loglog，误差棒用 errorbar' }, cookie);
    ok('a new note is saved', s1.j && s1.j.ok && /^[0-9a-f]{12}$/.test(s1.j.id), s1.j);
    const g1 = (await req('GET', '/api/note?id=' + s1.j.id, null, cookie)).j || {};
    ok('read back, the first line is the title', g1.title === 'RCS 画图笔记' && /errorbar/.test(g1.text), g1);
    const s2 = await req('POST', '/api/notes/save', { id: s1.j.id, text: 'RCS 画图笔记\n改过一次', base: s1.j.updated }, cookie);
    ok('saved again from the version it was edited from', s2.j && s2.j.ok && s2.j.id === s1.j.id && !s2.j.conflict, s2.j);
    await sleep(5);
    const s3 = await req('POST', '/api/notes/save', { id: s1.j.id, text: 'RCS 画图笔记\n另一台设备上的旧版本', base: s1.j.updated }, cookie);
    ok('edited from an older version: kept as a conflict copy, the note itself untouched', s3.j && s3.j.ok && s3.j.conflict && s3.j.id !== s1.j.id &&
      /改过一次/.test(((await req('GET', '/api/note?id=' + s1.j.id, null, cookie)).j || {}).text), s3.j);
    const list = ((await req('GET', '/api/notes', null, cookie)).j || {}).items || [];
    ok('the list: both, newest first, the copy marked', list.length === 2 && list[0].id === s3.j.id && /冲突副本/.test(list[0].title), list);
    const f = ((await req('GET', '/api/search?q=' + encodeURIComponent('errorbar'), null, cookie)).j || {});
    const f2 = ((await req('GET', '/api/search?q=' + encodeURIComponent('改过一次'), null, cookie)).j || {});
    ok('the search finds notes', !(f.notes || []).length && (f2.notes || []).some((x) => x.id === s1.j.id && /改过一次/.test(x.snippet)), [f.notes, f2.notes]);
    const d = await req('POST', '/api/notes/delete', { id: s3.j.id }, cookie);
    ok('deleted', d.j && d.j.ok && (((await req('GET', '/api/notes', null, cookie)).j || {}).items || []).length === 1 && (await req('GET', '/api/note?id=' + s3.j.id, null, cookie)).status === 404);
    ok('saving a deleted note is refused', !((await req('POST', '/api/notes/save', { id: s3.j.id, text: 'x' }, cookie)).j || {}).ok);
    ok('files on disk are private', process.platform === 'win32' || (fs.statSync(path.join(T, 'srv', 'data', 'notes', s1.j.id + '.txt')).mode & 0o777) === 0o600);
    // 问一问 can use a note as its source
    const a0 = await req('POST', '/api/ask', { q: '画图的笔记' }, cookie);
    let job = null; for (let i = 0; i < 60; i++) { job = ((await req('GET', '/api/ask', null, cookie)).j || {}).job; if (job && !job.running) break; await sleep(250); }
    ok('问一问 reads notes (found count)', a0.j && a0.j.ok && job && job.found && job.found.notes >= 0, job);
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
