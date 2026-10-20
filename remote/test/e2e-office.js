// 在线编辑 (server/office): the real server against a stand-in for the OnlyOffice container. /office only for a logged-in
// browser, the container told its address as the browser sees it and never given the login cookie, what only the server
// may ask for not served; the editor's socket proxied; the editor config signed; the file handed to the container only
// with its URL's token; a callback only with a good signature; a saved version fetched from the container (its /office
// link), announced to the page and served to it, the same version again not announced; closing announced.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process'), crypto = require('crypto');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const { sign, verify, readSecret } = require(R + '/server/office/jwt');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-office-'));
const PORT = 18897, HOOK = 18898, SECRET = crypto.randomBytes(24).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 500)}`); };
function req(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { const bs = []; res.on('data', (c) => bs.push(c)); res.on('end', () => resolve({ status: res.statusCode, h: res.headers, body: Buffer.concat(bs) })); });
    r.on('error', () => resolve({ status: 0, h: {}, body: Buffer.alloc(0) }));
    r.end(body);
  });
}
const jsonOf = (r) => { try { return JSON.parse(r.body); } catch { return null; } };

(async () => {
  // the stand-in container: health, an echo of what it was sent, a saved version under /cache, a socket that echoes
  const seen = [];
  let version = Buffer.from('PK-saved-version-1');
  const fake = http.createServer((q, s) => {
    seen.push({ url: q.url, h: q.headers });
    if (q.url === '/healthcheck') return s.end('true');
    if (q.url.startsWith('/echo')) { s.writeHead(200, { 'Content-Type': 'application/json', 'X-Frame-Options': 'SAMEORIGIN' }); return s.end(JSON.stringify({ url: q.url, h: q.headers })); }
    if (q.url.startsWith('/cache/files/')) return s.end(version);
    s.writeHead(200); s.end('container ' + q.url);
  });
  const wss = new WebSocket.Server({ server: fake });
  wss.on('connection', (ws, q) => ws.on('message', (m) => ws.send('echo:' + m + ':' + q.url)));
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const FAKE = fake.address().port;
  const hits = (re) => seen.filter((x) => re.test(x.url)).length;

  fs.writeFileSync(path.join(T, 'jwt.env'), `JWT_ENABLED=true\nJWT_SECRET=${SECRET}\nJWT_HEADER=AuthorizationJwt\n`);
  ok('the secret is read from the container\'s env file', readSecret(path.join(T, 'jwt.env')) === SECRET && readSecret(path.join(T, 'none')) === null);
  const tk = sign({ a: 1 }, SECRET);
  ok('a signature checks out with the secret only, and not when changed', verify(tk, SECRET).a === 1 && verify(tk, 'x'.repeat(30)) === null && verify(tk.slice(0, -2) + 'AA', SECRET) === null && verify(sign({ exp: 1 }, SECRET), SECRET) === null);

  const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000' };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG));
  Object.assign(cfg, { origin: 'https://ame.example', summary: { enabled: false },
    office: { url: `http://127.0.0.1:${FAKE}`, jwtEnv: path.join(T, 'jwt.env'), hook: { host: '127.0.0.1', port: HOOK }, hookUrl: `http://127.0.0.1:${HOOK}` } });
  cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
  const proc = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  let sock = null;
  try {
    for (let i = 0; i < 60 && (await req(PORT, '/login')).status !== 200; i++) await sleep(250);
    const lr = await req(PORT, '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}` },
      body: JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(cfg.totpSecret, Math.floor(Date.now() / 30000)) }) });
    const cookie = String(lr.h['set-cookie'] || '').split(';')[0];
    const H = { Cookie: cookie }, O = { Cookie: cookie, Origin: `http://127.0.0.1:${PORT}` };

    ok('not logged in: no /api/office, the editor\'s pages send to the login', (await req(PORT, '/api/office')).status === 401 && (await req(PORT, '/office/echo')).status === 302 && hits(/^\/echo/) === 0);
    const st = jsonOf(await req(PORT, '/api/office', { headers: H }));
    ok('logged in: editing on, the container answers', st && st.on === true && st.up === true, st);

    const e = await req(PORT, '/office/echo?x=1', { headers: { ...H, Authorization: 'Basic eA==', 'X-Forwarded-Host': 'evil' } });
    const ej = jsonOf(e) || { h: {} };
    ok('a page through /office: the path without /office, the address as the browser sees it, no cookie or Authorization',
      e.status === 200 && ej.url === '/echo?x=1' && ej.h['x-forwarded-host'] === 'ame.example/office' && ej.h['x-forwarded-proto'] === 'https' && !ej.h.cookie && !ej.h.authorization, ej);
    ok('its own headers, not the dashboard\'s (no CSP of ours but frame-ancestors \'self\')',
      e.h['x-frame-options'] === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(String(e.h['content-security-policy'])) && !/default-src/.test(String(e.h['content-security-policy'])), e.h);
    const blocked = await Promise.all(['/office/converter', '/office/ConvertService.ashx', '/office/coauthoring/CommandService.ashx', '/office/9.4.0-1a2b/example/', '/office/internal/cluster/inactive', '/office/info/info.json'].map((p) => req(PORT, p, { headers: H })));
    ok('what only the server may ask for is not served', blocked.every((b) => b.status === 404) && hits(/^\/(converter|ConvertService|coauthoring|9\.4|internal|info)/) === 0, blocked.map((b) => b.status));

    // the editor's socket
    const wsOpen = (headers) => new Promise((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}/office/doc/k1/c/?EIO=4&transport=websocket`, { headers });
      w.on('open', () => { w.send('hi'); w.on('message', (m) => { resolve(String(m)); w.close(); }); });
      w.on('error', () => resolve('refused')); w.on('unexpected-response', () => resolve('refused'));
    });
    ok('the editor\'s socket goes through for a logged-in page of the site', await wsOpen(O) === 'echo:hi:/doc/k1/c/?EIO=4&transport=websocket');
    ok('... not without the login, nor from another site', await wsOpen({ Origin: O.Origin }) === 'refused' && await wsOpen({ Cookie: cookie, Origin: 'https://evil.example' }) === 'refused');

    // opening a file
    const DOC = Buffer.from('PK\x03\x04 a word document');
    const q = new URLSearchParams({ machine: 'dell97', path: '/home/u/报告.docx', name: '报告.docx' });
    ok('opening needs a page of this site', (await req(PORT, '/api/office/open?' + q, { method: 'POST', headers: H, body: DOC })).status === 403);
    const bad = await req(PORT, '/api/office/open?' + new URLSearchParams({ machine: 'dell97', path: '/a.txt', name: 'a.txt' }), { method: 'POST', headers: O, body: DOC });
    ok('a file the editor would not save in its own format is refused', bad.status === 400, bad.status);
    const op = jsonOf(await req(PORT, '/api/office/open?' + q, { method: 'POST', headers: { ...O, 'Content-Type': 'application/octet-stream' }, body: DOC })) || {};
    const c = op.config || {}, signed = verify(c.token, SECRET) || {};
    const id = op.id, docUrl = (c.document || {}).url || '', cbUrl = (c.editorConfig || {}).callbackUrl || '';
    ok('opened: an id, the editor\'s script under /office, a config signed with the secret', op.ok && /^[a-f0-9]{24}$/.test(id) && op.api === '/office/web-apps/apps/api/documents/api.js' &&
      signed.document && signed.document.key === id && signed.documentType === 'word' && signed.document.title === '报告.docx', op);
    ok('the config: the file and the callback on the container\'s own listener, macros and plugins off, the Save button saves',
      docUrl.startsWith(`http://127.0.0.1:${HOOK}/doc/${id}/`) && cbUrl.startsWith(`http://127.0.0.1:${HOOK}/cb/${id}/`) &&
      c.editorConfig.customization.macros === false && c.editorConfig.customization.plugins === false && c.editorConfig.customization.forcesave === true, c);
    const tok = docUrl.split('/').pop();
    const got = await req(HOOK, `/doc/${id}/${tok}`);
    ok('the container gets the file with its URL', got.status === 200 && got.body.equals(DOC), got.status);
    ok('... not with another token, nor another id', (await req(HOOK, `/doc/${id}/${'A'.repeat(tok.length)}`)).status === 404 && (await req(HOOK, `/doc/${'0'.repeat(24)}/${tok}`)).status === 404);
    ok('the dashboard does not serve the container\'s listener', (await req(PORT, `/doc/${id}/${tok}`, { headers: H })).status === 404);

    // what the page is told
    const told = [];
    sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: O });
    await new Promise((r) => sock.on('open', r));
    sock.on('message', (m) => { const d = JSON.parse(m); if (d.t === 'office') told.push(d); });
    const cb = (body, headers = {}) => req(HOOK, `/cb/${id}/${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

    const forged = await cb({ status: 6, url: 'http://127.0.0.1:1/x', token: sign({ status: 6, key: id, url: 'http://127.0.0.1:1/x' }, 'not-the-secret-0123456789') });
    const unsigned = await cb({ status: 2, url: 'http://127.0.0.1:1/x' });
    ok('a callback without the right signature is turned away', forged.status === 403 && unsigned.status === 403 && hits(/^\/cache/) === 0, [forged.status, unsigned.status]);
    const s1 = await cb({ token: sign({ status: 1, key: id, users: ['ame'] }, SECRET) });
    ok('being edited: acknowledged', s1.status === 200 && (jsonOf(s1) || {}).error === 0);

    const link = `https://ame.example/office/cache/files/data/${id}_1/output.docx/output.docx?md5=abc&expires=9`;
    const s6 = await cb({ status: 6, url: link }, { AuthorizationJwt: 'Bearer ' + sign({ payload: { status: 6, key: id, url: link } }, SECRET) });
    await sleep(300);
    ok('saved with the Save button (signed in the header): fetched from the container by its /office link',
      s6.status === 200 && (jsonOf(s6) || {}).error === 0 && seen.some((x) => x.url === `/cache/files/data/${id}_1/output.docx/output.docx?md5=abc&expires=9`), [s6.status, String(s6.body)]);
    ok('... and the page told: version 1, not the last one', told.length === 1 && told[0].id === id && told[0].v === 1 && told[0].final === false, told);
    const v1 = await req(PORT, `/api/office/file?id=${id}&v=1`, { headers: H });
    ok('the page gets that version (as an attachment, not kept by the browser)', v1.status === 200 && v1.body.equals(version) && v1.h['cache-control'] === 'no-store', v1.status);
    ok('... a version not there, or without the login: none', (await req(PORT, `/api/office/file?id=${id}&v=2`, { headers: H })).status === 404 && (await req(PORT, `/api/office/file?id=${id}&v=1`)).status === 401);

    const s2 = await cb({ token: sign({ status: 2, key: id, url: link }, SECRET) });
    await sleep(300);
    ok('closed with nothing new since: no new version, the page told it is closed', s2.status === 200 && told.length === 2 && told[1].closed === true && !told[1].v, told);

    // a second file: closed with changes never saved -> the last version, final
    const op2 = jsonOf(await req(PORT, '/api/office/open?' + new URLSearchParams({ machine: 'dell97', path: 'C:\\d\\表.xlsx', name: '表.xlsx' }), { method: 'POST', headers: O, body: DOC })) || {};
    const c2 = op2.config || {}, cb2 = (c2.editorConfig || {}).callbackUrl || '';
    ok('a workbook opens in the spreadsheet editor', op2.ok && (verify(c2.token, SECRET) || {}).documentType === 'cell', op2);
    version = Buffer.from('PK-closed-with-changes');
    const r2 = await req(HOOK, new URL(cb2).pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: sign({ status: 2, key: op2.id, url: link }, SECRET) }) });
    await sleep(300);
    const last = told[told.length - 1] || {};
    ok('closed with changes: the last version, marked final', r2.status === 200 && last.id === op2.id && last.v === 1 && last.final === true, told);
    ok('saving failed in the container: the page told why', await (async () => {
      await req(HOOK, new URL(cb2).pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: sign({ status: 7, key: op2.id }, SECRET) }) });
      await sleep(300); const l = told[told.length - 1] || {}; return l.id === op2.id && /保存失败/.test(l.msg || '');
    })(), told.slice(-1));
    const audit = fs.readFileSync(path.join(T, 'srv', 'audit.log'), 'utf8');
    ok('opening and each saved version are in the audit log', /office-open \S+ dell97 \/home\/u\/报告\.docx/.test(audit) && /office-saved dell97 \/home\/u\/报告\.docx v1/.test(audit), audit.slice(-400));
    const kept = fs.readdirSync(path.join(T, 'srv', 'data', 'office'));
    ok('what is being edited is kept on disk (a restart keeps it)', kept.includes(id) && kept.includes(op2.id) && fs.existsSync(path.join(T, 'srv', 'data', 'office', id, 'meta.json')), kept);
  } catch (e) { ok('no exception', false, e.stack); }
  finally { try { sock && sock.close(); } catch {} proc.kill(); fake.close(); wss.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
