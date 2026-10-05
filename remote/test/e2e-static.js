// The page's files as the server sends them (server/static.js): an ETag and "304 Not Modified" for a copy the browser
// already has, gzip for text when the browser takes it (not for pictures, not for tiny files), a changed file sent
// anew; and through the real server: a script comes compressed with its ETag and "no-cache", asked again -> 304.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), zlib = require('zlib'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const { sendFile } = require(R + '/server/static');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-static-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 500)}`); };
const get = (port, p, headers = {}) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { const bs = []; res.on('data', (c) => bs.push(c)); res.on('end', () => resolve({ status: res.statusCode, h: res.headers, body: Buffer.concat(bs) })); })
    .on('error', () => resolve({ status: 0, h: {}, body: Buffer.alloc(0) }));
});

(async () => {
  const JS = path.join(T, 'a.js'), PNG = path.join(T, 'p.png'), TINY = path.join(T, 't.js');
  const text = '// 一个脚本\n' + 'const x = 1; console.log(x);\n'.repeat(200);
  fs.writeFileSync(JS, text); fs.writeFileSync(PNG, Buffer.alloc(5000, 7)); fs.writeFileSync(TINY, 'x=1');
  const TYPES = { '.js': 'application/javascript; charset=utf-8', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    const f = path.join(T, req.url.slice(1));
    sendFile(req, res, f, { 'X-Sec': '1', 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, () => { res.writeHead(404); res.end('nf'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const P = srv.address().port;

  const a = await get(P, '/a.js', { 'Accept-Encoding': 'gzip, br' });
  ok('a script: gzip when the browser takes it, the text intact, an ETag, the given headers kept', a.status === 200 && a.h['content-encoding'] === 'gzip' && zlib.gunzipSync(a.body).toString() === text &&
    /^".+"$/.test(a.h.etag || '') && a.h['cache-control'] === 'no-cache' && a.h['x-sec'] === '1' && /Accept-Encoding/i.test(a.h.vary || '') && a.body.length < text.length / 5, [a.status, a.h, a.body.length]);
  const b = await get(P, '/a.js');
  ok('not asked for gzip: sent as it is, the same ETag', b.status === 200 && !b.h['content-encoding'] && b.body.toString() === text && b.h.etag === a.h.etag, [b.status, b.h]);
  const c = await get(P, '/a.js', { 'If-None-Match': a.h.etag, 'Accept-Encoding': 'gzip' });
  ok('the browser has that copy: 304, nothing sent', c.status === 304 && c.body.length === 0 && c.h.etag === a.h.etag, [c.status, c.body.length]);
  const c2 = await get(P, '/a.js', { 'If-None-Match': '"other", ' + a.h.etag });
  ok('one of several ETags matches: 304', c2.status === 304, c2.status);
  const p = await get(P, '/p.png', { 'Accept-Encoding': 'gzip' }), t = await get(P, '/t.js', { 'Accept-Encoding': 'gzip' });
  ok('a picture and a tiny file: not compressed', p.status === 200 && !p.h['content-encoding'] && p.body.length === 5000 && t.status === 200 && !t.h['content-encoding'] && t.body.toString() === 'x=1', [p.h, t.h]);
  await sleep(30);
  fs.writeFileSync(JS, text + '// changed\n');
  const d = await get(P, '/a.js', { 'If-None-Match': a.h.etag, 'Accept-Encoding': 'gzip' });
  ok('the file changed: the old ETag no longer answers 304, the new text comes (not the kept compressed copy)', d.status === 200 && d.h.etag !== a.h.etag && zlib.gunzipSync(d.body).toString().endsWith('// changed\n'), [d.status, d.h.etag, a.h.etag]);
  ok('a file that is not there: the caller\'s 404', (await get(P, '/nope.js')).status === 404 && (await get(P, '/')).status === 404);
  srv.close();

  // the real server
  const PORT = 18899, CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000' };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; cfg.summary = { enabled: false }; fs.writeFileSync(CFG, JSON.stringify(cfg));
  const proc = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60 && (await get(PORT, '/login')).status !== 200; i++) await sleep(250);
    const l = await get(PORT, '/login.js', { 'Accept-Encoding': 'gzip' });
    const src = fs.readFileSync(path.join(R, 'public', 'login.js'), 'utf8');
    ok('the server: a script compressed, with its ETag and the security headers', l.status === 200 && l.h['content-encoding'] === 'gzip' && zlib.gunzipSync(l.body).toString() === src && !!l.h.etag && !!l.h['content-security-policy'], [l.status, l.h]);
    const l2 = await get(PORT, '/login.js', { 'If-None-Match': l.h.etag, 'Accept-Encoding': 'gzip' });
    ok('asked again with the ETag: 304', l2.status === 304 && l2.body.length === 0, l2.status);
    const pg = await get(PORT, '/login', { 'Accept-Encoding': 'gzip' });
    ok('the login page itself too', pg.status === 200 && pg.h['content-encoding'] === 'gzip' && /<html/i.test(zlib.gunzipSync(pg.body).toString()), [pg.status, pg.h]);
    ok('a page of the logged-in part without logging in: still refused (not a file served)', [302, 401, 303].includes((await get(PORT, '/js/main.js')).status), (await get(PORT, '/js/main.js')).status);
  } finally { proc.kill(); }
  await sleep(400);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
