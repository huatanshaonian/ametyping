// e2e: uploads through the relay into a machine's folder (agent/fs-upload.js, server/fs-relay.js): a file in pieces
// with its CRC, a file over 100 MB, the same name (refused / replaced), names and places refused, a machine that does
// not allow uploads, an upload cut off and carried on, a wrong CRC, a cancel.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process'), crypto = require('crypto'), zlib = require('zlib');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-up-'));
const HOME = path.join(T, 'home'); fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
const ROOT = path.join(T, 'share'), OUTSIDE = path.join(T, 'outside');
fs.mkdirSync(path.join(ROOT, 'in'), { recursive: true }); fs.mkdirSync(path.join(ROOT, '.ssh')); fs.mkdirSync(OUTSIDE);
fs.writeFileSync(path.join(ROOT, 'in', 'old.txt'), 'old');
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18793, CHUNK = 256 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const token = (name) => node([R + '/server/setup.js', 'add-agent', name]).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json'), ACFG2 = path.join(T, 'agent2.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: token('box'), name: 'box', control: false, files: { roots: [ROOT], upload: true } }));
fs.writeFileSync(ACFG2, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: token('box2'), name: 'box2', control: false, files: { roots: [ROOT] } }));
const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0]); });
    req.end(body);
  });
}
// a page's socket: messages by rid, the latest session list
async function page(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie, Origin: `http://127.0.0.1:${PORT}` } });
  const handlers = new Map(), p = { ws, handlers, snap: [] };
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.t === 'sessions') p.snap = d.data; if (d.rid && handlers.has(d.rid)) handlers.get(d.rid)(d); });
  await new Promise((r) => ws.on('open', r)); await sleep(300);
  return p;
}
let n = 0;
// an upload as the page does it: open, pieces with WINDOW in flight, end with the CRC.
// opts: { stopAfter: pieces (then leave it hanging), crc: a wrong one, off: a wrong offset for piece 1 }
function upload(p, machine, dir, name, buf, opts = {}) {
  return new Promise((resolve) => {
    const rid = 'u' + (++n);
    let sent = 0, acked = 0, pieces = 0, open = null, ended = false;
    const crc = zlib.crc32(buf);
    const pump = () => {
      while (sent < buf.length && sent - acked < 8 * CHUNK && !(opts.stopAfter && pieces >= opts.stopAfter)) {
        const part = buf.subarray(sent, sent + CHUNK);
        p.ws.send(JSON.stringify({ t: 'fs-up', rid, off: opts.off && pieces === 1 ? sent + 1 : sent, data: part.toString('base64') }));
        sent += part.length; pieces++;
      }
      if (opts.stopAfter && pieces >= opts.stopAfter && acked === sent) { p.handlers.delete(rid); return resolve({ hanging: true, rid, acked, open }); }
      if (!ended && acked === buf.length) { ended = true; p.ws.send(JSON.stringify({ t: 'fs-up-end', rid, crc: opts.crc != null ? opts.crc : crc })); }
    };
    p.handlers.set(rid, (d) => {
      if (d.t === 'fs-res') { if (!d.ok) { p.handlers.delete(rid); return resolve({ ok: false, msg: d.msg, exists: d.exists }); } open = d; sent = acked = d.have; pump(); }
      else if (d.t === 'fs-up-ack') { if (!d.checking) { acked = Math.max(acked, d.have); pump(); } }
      else if (d.t === 'fs-up-done') { p.handlers.delete(rid); resolve({ ...d, open }); }
    });
    p.ws.send(JSON.stringify({ t: 'fs', rid, machine, op: 'up-open', path: dir, name, size: buf.length, mtime: opts.mtime || 0, overwrite: opts.overwrite === true }));
  });
}

(async () => {
  try {
    spawn([R + '/server/server.js']); await sleep(3000);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG });
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG2 }); await sleep(2500);
    const cookie = await login();
    let p = await page(cookie);
    const box = p.snap.find((m) => m.machine === 'box'), box2 = p.snap.find((m) => m.machine === 'box2');
    ok('the machines say whether they take uploads', box && box.upload === true && box2 && box2.upload === false, JSON.stringify([box && box.upload, box2 && box2.upload]));
    const IN = fs.realpathSync(path.join(ROOT, 'in'));

    const small = crypto.randomBytes(700 * 1024 + 13), when = new Date(2025, 4, 6, 7, 8, 10).getTime();
    let r = await upload(p, 'box', IN, '新文件.bin', small, { mtime: when });
    ok('a file in pieces: in place, byte for byte, its time kept, no part file left', r.ok && fs.readFileSync(path.join(IN, '新文件.bin')).equals(small) && Math.abs(fs.statSync(path.join(IN, '新文件.bin')).mtimeMs - when) < 2000 && fs.readdirSync(IN).every((x) => !x.endsWith('.ame-upload')), JSON.stringify(r) + fs.readdirSync(IN));
    r = await upload(p, 'box', IN, 'empty.txt', Buffer.alloc(0));
    ok('an empty file', r.ok && fs.statSync(path.join(IN, 'empty.txt')).size === 0, JSON.stringify(r));
    const big = crypto.randomBytes(120 * 1024 * 1024);
    const t0 = Date.now(); r = await upload(p, 'box', IN, 'big.bin', big);
    ok(`over 100 MB: 120 MB in ${Date.now() - t0} ms, whole`, r.ok && fs.statSync(path.join(IN, 'big.bin')).size === big.length && crypto.createHash('sha256').update(fs.readFileSync(path.join(IN, 'big.bin'))).digest('hex') === crypto.createHash('sha256').update(big).digest('hex'), JSON.stringify(r));

    r = await upload(p, 'box', IN, 'old.txt', Buffer.from('new'));
    ok(`the same name: refused, said so (${r.msg})`, r.ok === false && r.exists === true && fs.readFileSync(path.join(IN, 'old.txt'), 'utf8') === 'old', JSON.stringify(r));
    r = await upload(p, 'box', IN, 'old.txt', Buffer.from('new'), { overwrite: true });
    ok('the same name, replace: replaced', r.ok && fs.readFileSync(path.join(IN, 'old.txt'), 'utf8') === 'new', JSON.stringify(r));

    for (const [what, dir, name] of [['a path for a name', IN, '../x.txt'], ['a slash in the name', IN, 'a/b.txt'], ['a secret\'s name', IN, '.env'], ['a key\'s name', IN, 'id_rsa'],
      ['a part file\'s name', IN, 'x.ame-upload'], ['into a protected folder', path.join(fs.realpathSync(ROOT), '.ssh'), 'authorized_keys'], ['outside the roots', fs.realpathSync(OUTSIDE), 'x.txt'],
      ['over a folder', fs.realpathSync(ROOT), 'in']]) {
      r = await upload(p, 'box', dir, name, Buffer.from('x'));
      ok(`refused: ${what} (${r.msg})`, r.ok === false && !r.exists, JSON.stringify(r));
    }
    ok('nothing written by those', !fs.existsSync(path.join(fs.realpathSync(ROOT), '.ssh', 'authorized_keys')) && !fs.existsSync(path.join(OUTSIDE, 'x.txt')) && !fs.existsSync(path.join(ROOT, 'x.txt')));
    r = await upload(p, 'box2', IN, 'x.txt', Buffer.from('x'));
    ok(`a machine that does not take uploads (${r.msg})`, r.ok === false && /没开放上传/.test(r.msg || '') && !fs.existsSync(path.join(IN, 'x.txt')), JSON.stringify(r));

    // cut off: the page goes away after 5 pieces; the part stays; uploaded again, it carries on from there
    const resume = crypto.randomBytes(3 * 1024 * 1024 + 77);
    r = await upload(p, 'box', IN, 'resume.bin', resume, { stopAfter: 5 });
    p.ws.close(); await sleep(800);
    const partName = `.resume.bin.${resume.length}.ame-upload`;
    ok('cut off: the part file stays, as much as was written', r.hanging && fs.statSync(path.join(IN, partName)).size === 5 * CHUNK && !fs.existsSync(path.join(IN, 'resume.bin')), JSON.stringify(r));
    p = await page(cookie);
    r = await upload(p, 'box', IN, 'resume.bin', resume);
    ok('uploaded again: carries on from there (have), the file whole', r.ok && r.open.have === 5 * CHUNK && fs.readFileSync(path.join(IN, 'resume.bin')).equals(resume) && !fs.existsSync(path.join(IN, partName)), JSON.stringify({ ok: r.ok, have: r.open && r.open.have, msg: r.msg }));

    r = await upload(p, 'box', IN, 'crc.bin', crypto.randomBytes(600 * 1024), { crc: 12345 });
    ok(`a wrong CRC: refused, nothing left (${r.msg})`, r.ok === false && /校验/.test(r.msg || '') && !fs.existsSync(path.join(IN, 'crc.bin')) && fs.readdirSync(IN).every((x) => !x.includes('crc.bin')), JSON.stringify(r) + fs.readdirSync(IN));
    r = await upload(p, 'box', IN, 'order.bin', crypto.randomBytes(600 * 1024), { off: true });
    ok(`a piece out of place: stopped (${r.msg})`, r.ok === false && !fs.existsSync(path.join(IN, 'order.bin')), JSON.stringify(r));
    r = await upload(p, 'box', IN, 'cancel.bin', crypto.randomBytes(2 * 1024 * 1024), { stopAfter: 3 });
    p.ws.send(JSON.stringify({ t: 'fs-cancel', rid: r.rid, drop: true })); await sleep(800);
    ok('cancelled: what came thrown away', fs.readdirSync(IN).every((x) => !x.includes('cancel.bin')), fs.readdirSync(IN).join());
    p.ws.close();
  } catch (e) { fail++; console.log('FAIL script ' + e.stack); }
  finally {
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(800);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
