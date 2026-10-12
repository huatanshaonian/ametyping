// e2e: 画板. Boards on the NAS: save / read / list / rename / delete, a save from an older version kept as a copy,
// what a page sends cleaned; 「交给 AI」: the picture goes to the model (a fake Codex), the answer comes back as a
// 还原稿 (cleaned: unknown kinds dropped, places kept within the page) with a text档; a 设计稿 is made from it and
// belongs to that 还原稿 only; a failing model leaves the error; not logged in = no.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createCanvas } = require(R + '/node_modules/@napi-rs/canvas');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-board-'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const LOG = path.join(T, 'codex.log'), FAIL = path.join(T, 'fail');
const PORT = 18846;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 700)}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG, FAKE_CODEX_LOG: LOG, FAKE_CODEX_FAIL_FILE: FAIL };
cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')] };
fs.writeFileSync(CFG, JSON.stringify(cfg));
const req = (method, p, body, cookie, raw) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    const bufs = []; res.on('data', (c) => bufs.push(c));
    res.on('end', () => { const b = Buffer.concat(bufs); let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, buf: raw ? b : null, type: res.headers['content-type'], cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.end(data);
});
const png = (w, h) => { const c = createCanvas(w, h), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.fillStyle = '#222'; x.fillRect(20, 20, w / 2, 6); return 'data:image/png;base64,' + c.toBuffer('image/png').toString('base64'); };
const stroke = (n, more = {}) => ({ t: 'pencil', c: '#222222', w: 2.2, p: Array.from({ length: n * 3 }, (_, i) => (i % 3 === 2 ? 0.5 : i * 1.23456)), ...more });

(async () => {
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) {                                   // (until the server listens)
      if (await new Promise((r) => { const s = require('net').connect(PORT, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })) break;
      await sleep(150);
    }
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const out = async (id) => (await req('GET', '/api/board/out?id=' + id, null, cookie)).j || {};
    const done = async (id) => { let o = {}; for (let i = 0; i < 80; i++) { o = await out(id); if (!o.job) break; await sleep(150); } return o; };
    ok('not logged in: refused', (await req('GET', '/api/boards')).status === 401 && (await req('POST', '/api/boards/save', { doc: { strokes: [] } })).status === 401 && (await req('GET', '/api/board/shot?id=000000000000')).status === 401);

    // ---- the boards themselves
    const s1 = await req('POST', '/api/boards/save', { title: '  雷达  方程 ', doc: { strokes: [stroke(4), stroke(3, { t: 'marker', c: '#FFD400', w: 18 }),
      { t: 'spray', c: 'red; background:url(x)', w: 9999, p: [1, 2, 0.5, 'x', null, 3, 7, 8] }, { t: 'pencil', p: [1, 2] }, 'junk'] } }, cookie);
    ok('a new board is saved', s1.j && s1.j.ok && /^[0-9a-f]{12}$/.test(s1.j.id) && s1.j.title === '雷达 方程', s1.j);
    const id = s1.j.id;
    const g1 = (await req('GET', '/api/board?id=' + id, null, cookie)).j || {};
    const st = (g1.doc || {}).strokes || [];
    ok('read back: numbers rounded, an unknown tool / colour / width put right, broken strokes dropped', st.length === 3 && st[0].p.length === 12 && st[0].p[1] === 1.23 &&
      st[1].t === 'marker' && st[1].c === '#ffd400' && st[2].t === 'pencil' && st[2].c === '#222222' && st[2].w === 80 && st[2].p.join() === '1,2,0.5,0,0,3', st);
    const s2 = await req('POST', '/api/boards/save', { id, doc: { strokes: [stroke(5)] }, base: s1.j.updated }, cookie);
    ok('saved again from the version it was drawn on (the name stays)', s2.j && s2.j.ok && s2.j.id === id && !s2.j.conflict && s2.j.title === '雷达 方程' && s2.j.updated > s1.j.updated, s2.j);
    const s3 = await req('POST', '/api/boards/save', { id, doc: { strokes: [stroke(2), stroke(2)] }, base: s1.j.updated }, cookie);
    ok('drawn on from an older version: kept as a copy, the board itself untouched', s3.j && s3.j.ok && s3.j.conflict && s3.j.id !== id && /冲突副本/.test(s3.j.title) &&
      ((await req('GET', '/api/board?id=' + id, null, cookie)).j || {}).doc.strokes.length === 1, s3.j);
    const rn = await req('POST', '/api/boards/rename', { id: s3.j.id, title: '草稿' }, cookie);
    let list = ((await req('GET', '/api/boards', null, cookie)).j || {});
    ok('renamed; the list: both, newest first, with how many strokes', rn.j && rn.j.ok && list.ai === true && list.items.length === 2 && list.items[0].id === s3.j.id && list.items[0].title === '草稿' && list.items[0].strokes === 2 && list.items[1].strokes === 1, [rn.j, list]);
    ok('an empty name is refused; a board that is not there is not found', !(await req('POST', '/api/boards/rename', { id, title: '   ' }, cookie)).j.ok && (await req('GET', '/api/board?id=aaaaaaaaaaaa', null, cookie)).status === 404 &&
      (await req('GET', '/api/board?id=../index', null, cookie)).status === 404 && !(await req('POST', '/api/boards/save', { id: 'aaaaaaaaaaaa', doc: { strokes: [] } }, cookie)).j.ok);
    ok('files on disk are private', process.platform === 'win32' || (fs.statSync(path.join(T, 'srv', 'data', 'boards', id + '.json')).mode & 0o777) === 0o600);

    // ---- 交给 AI
    ok('what is not a picture is refused', !(await req('POST', '/api/boards/read', { id, png: 'data:image/png;base64,' + Buffer.from('not a png at all, just some text here').toString('base64') }, cookie)).j.ok &&
      !(await req('POST', '/api/boards/read', { id, png: 'data:text/html;base64,PGI+' }, cookie)).j.ok && !(await req('POST', '/api/boards/read', { id: 'aaaaaaaaaaaa', png: png(400, 300) }, cookie)).j.ok);
    ok('no 设计稿 before there is a 还原稿', !(await req('POST', '/api/boards/design', { id }, cookie)).j.ok);
    const r1 = await req('POST', '/api/boards/read', { id, png: png(800, 600), note: '第二行是英文' }, cookie);
    const busy = await req('POST', '/api/boards/read', { id, png: png(800, 600) }, cookie);
    const during = await out(id);
    ok('started; a second request meanwhile is refused; the board says what the model is doing', r1.j && r1.j.ok && busy.j && !busy.j.ok && during.job && during.job.kind === 'restore' &&
      ((await req('GET', '/api/boards', null, cookie)).j.items.find((b) => b.id === id) || {}).job, [r1.j, busy.j, during]);
    const o1 = await done(id), r = o1.restore || {}, items = r.items || [];
    ok('the 还原稿: the grid is 1000 wide and as high as the picture; title tidied; the text档 kept', r.w === 1000 && r.h === 750 && r.title === '雷达方程 推导' && /\$\$P_r/.test(r.markdown) && r.unsure.length === 1 && r.px && r.px.w === 800, r);
    ok('its pieces: the unknown kind dropped, a box given backwards put right, the one outside the page pulled in', items.length === 8 && !items.some((i) => i.kind === 'blob') &&
      items[4].kind === 'round' && items[4].x === 300 && items[4].x2 === 520 && items[4].y === 400 && items[4].y2 === 480 && items[7].x2 === 1000 && items[7].y2 === 750 && items[2].color === '#d93025' && items[5].dashed === true, items);
    const logged = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.prompt);
    ok('the model was given the picture, the size of the grid and the note', logged.length === 1 && logged[0].args.some((a) => a.startsWith('--image=') && a.endsWith(id + '.png')) && /高是 750/.test(logged[0].prompt) && /用户的补充说明：第二行是英文/.test(logged[0].prompt), logged[0] && logged[0].args);
    const shot = await req('GET', '/api/board/shot?id=' + id, null, cookie, true);
    ok('the picture it was given can be seen again', shot.status === 200 && shot.type === 'image/png' && shot.buf.subarray(1, 4).toString() === 'PNG' && shot.buf.readUInt32BE(16) === 800);

    // ---- 设计稿
    const d1 = await req('POST', '/api/boards/design', { id, note: '深色' }, cookie);
    const o2 = await done(id);
    ok('a 设计稿 made from the 还原稿, with the wish and the designer\'s remark', d1.j && d1.j.ok && o2.design && /<style>/.test(o2.design.html) && o2.design.from === r.at && /深色/.test(o2.design.note) && o2.restore.at === r.at, o2.design);
    const dl = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.prompt).pop();
    ok('the designer got the text档, the pieces with their places and the picture', /# 文字档/.test(dl.prompt) && /round \(300,400\)-\(520,480\)/.test(dl.prompt) && /誊清时拿不准/.test(dl.prompt) && dl.args.some((a) => a.startsWith('--image=')), dl.prompt.slice(-600));
    list = (await req('GET', '/api/boards', null, cookie)).j;
    ok('the list says which boards have a 还原稿 / 设计稿', list.items.find((b) => b.id === id).restore === r.at && list.items.find((b) => b.id === id).design > 0 && list.items.find((b) => b.id === s3.j.id).restore === 0, list.items);

    // ---- a failing model; a new 还原稿 puts the old 设计稿 away
    fs.writeFileSync(FAIL, '1');
    await req('POST', '/api/boards/read', { id, png: png(600, 600) }, cookie);
    const o3 = await done(id);
    ok('the model fails: the error is kept, the earlier results stay', o3.error && o3.error.kind === 'restore' && o3.restore && o3.restore.at === r.at && o3.design, o3.error);
    fs.unlinkSync(FAIL);
    await req('POST', '/api/boards/read', { id, png: png(600, 600) }, cookie);
    const o4 = await done(id);
    ok('read again: a new 还原稿, the error gone, the 设计稿 of the old one gone', o4.restore && o4.restore.at > r.at && o4.restore.h === 1000 && !o4.error && !o4.design, o4);

    // ---- delete
    const del = await req('POST', '/api/boards/delete', { id }, cookie);
    ok('deleted with everything made from it', del.j && del.j.ok && (await req('GET', '/api/board?id=' + id, null, cookie)).status === 404 && (await req('GET', '/api/board/out?id=' + id, null, cookie)).status === 404 &&
      (await req('GET', '/api/board/shot?id=' + id, null, cookie)).status === 404 && !fs.readdirSync(path.join(T, 'srv', 'data', 'boards')).some((f) => f.startsWith(id)), fs.readdirSync(path.join(T, 'srv', 'data', 'boards')));
    const tasks = ((await req('GET', '/api/ai', null, cookie)).j || {}).tasks || [];
    ok('AI 模型 lists the two jobs', tasks.some((t) => t.id === 'board') && tasks.some((t) => t.id === 'boardDesign'));
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
