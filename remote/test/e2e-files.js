// e2e: file explorer relay -- roots / list / chunked read (hash-checked), access rules, >100 MB refusal, cancel
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process'), crypto = require('crypto');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-fs-'));
const HOME = path.join(T, 'home'); fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
const ROOT = path.join(T, 'share'), OUTSIDE = path.join(T, 'outside');
fs.mkdirSync(path.join(ROOT, 'docs', 'img'), { recursive: true }); fs.mkdirSync(path.join(ROOT, '.ssh')); fs.mkdirSync(OUTSIDE);
fs.writeFileSync(path.join(ROOT, 'docs', 'readme.md'), '# 标题\n\n![图](img/a.png)\n');
fs.writeFileSync(path.join(ROOT, 'docs', 'img', 'a.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
fs.writeFileSync(path.join(ROOT, '.ssh', 'id_rsa'), 'SECRET');
fs.writeFileSync(path.join(ROOT, '.env'), 'TOKEN=SECRET');
fs.writeFileSync(path.join(ROOT, 'server.pem'), 'SECRET');
fs.writeFileSync(path.join(OUTSIDE, 'x.txt'), 'outside');
const big = crypto.randomBytes(30 * 1024 * 1024); fs.writeFileSync(path.join(ROOT, 'big.bin'), big);
const huge = path.join(ROOT, 'huge.bin'); fs.closeSync(fs.openSync(huge, 'w')); fs.truncateSync(huge, 101 * 1024 * 1024);   // sparse
let linked = false;
try { fs.symlinkSync(OUTSIDE, path.join(ROOT, 'escape'), 'junction'); linked = true; } catch {}

const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18791;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'box']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'box', control: false, files: { roots: [ROOT] } }));
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

(async () => {
  try {
    spawn([R + '/server/server.js']); await sleep(3000);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG }); await sleep(2000);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: await login() } });
    const handlers = new Map(); let snap = [];
    ws.on('message', (m) => { const d = JSON.parse(m); if (d.t === 'sessions') snap = d.data; if (d.rid && handlers.has(d.rid)) handlers.get(d.rid)(d); });
    await new Promise((r) => ws.on('open', r)); await sleep(300);
    let n = 0;
    const req = (op, p) => new Promise((resolve) => { const rid = 'q' + (++n); handlers.set(rid, (d) => { handlers.delete(rid); resolve(d); }); ws.send(JSON.stringify({ t: 'fs', rid, machine: 'box', op, path: p })); });
    const read = (p, cancelAfter) => new Promise((resolve) => {
      const rid = 'q' + (++n), parts = []; let head = null;
      handlers.set(rid, (d) => {
        if (d.t === 'fs-res') { if (!d.ok) { handlers.delete(rid); resolve({ ok: false, msg: d.msg }); } else head = d; }
        else if (d.t === 'fs-chunk') { parts.push(Buffer.from(d.data, 'base64')); if (cancelAfter && parts.length === cancelAfter) { ws.send(JSON.stringify({ t: 'fs-cancel', rid })); setTimeout(() => { handlers.delete(rid); resolve({ cancelled: true, chunks: parts.length }); }, 1500); } }
        else if (d.t === 'fs-end') { handlers.delete(rid); resolve({ ok: true, head, buf: Buffer.concat(parts), chunks: parts.length }); }
      });
      ws.send(JSON.stringify({ t: 'fs', rid, machine: 'box', op: 'read', path: p }));
    });

    const box = snap.find((m) => m.machine === 'box');
    ok('machine reports files enabled', box && box.files === true, JSON.stringify(box));
    const roots = await req('roots');
    ok('roots = the configured folder', roots.ok && roots.roots.length === 1 && fs.realpathSync(roots.roots[0].path) === fs.realpathSync(ROOT), JSON.stringify(roots));
    const rootReal = roots.roots[0].path;
    const l = await req('list', rootReal);
    const names = (l.entries || []).map((e) => e.name);
    ok('listing: folders first, secrets hidden', l.ok && names[0] === 'docs' && !names.includes('.ssh') && !names.includes('.env') && !names.includes('server.pem') && names.includes('big.bin'), JSON.stringify(names));
    ok('root has no parent', l.parent === null);
    const sub = await req('list', path.join(rootReal, 'docs'));
    ok('subfolder parent is the root', sub.ok && sub.parent === rootReal, JSON.stringify(sub.parent));
    const md = await read(path.join(rootReal, 'docs', 'readme.md'));
    ok('small file read', md.ok && md.buf.toString() === '# 标题\n\n![图](img/a.png)\n');
    const t0 = Date.now(); const b = await read(path.join(rootReal, 'big.bin'));
    ok(`30 MB read in ${b.chunks} chunks, identical (${Date.now() - t0} ms)`, b.ok && b.buf.equals(big), b.msg || '');
    for (const [name, p] of [['id_rsa in .ssh', path.join(rootReal, '.ssh', 'id_rsa')], ['.env', path.join(rootReal, '.env')], ['*.pem', path.join(rootReal, 'server.pem')]]) {
      const r = await read(p); ok(`secret refused: ${name} (${r.msg})`, r.ok === false && /受保护/.test(r.msg || ''), JSON.stringify(r));
    }
    const dd = await read(path.join(rootReal, 'docs', '..', '..', 'outside', 'x.txt'));
    ok(`.. out of the root refused (${dd.msg})`, dd.ok === false && /范围/.test(dd.msg || ''), JSON.stringify(dd));
    if (linked) { const s = await read(path.join(rootReal, 'escape', 'x.txt')); ok(`symlink out of the root refused (${s.msg})`, s.ok === false && /范围/.test(s.msg || ''), JSON.stringify(s)); }
    const sysp = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    const sy = await read(sysp); ok(`system file refused (${sy.msg})`, sy.ok === false, JSON.stringify(sy));
    const hg = await read(huge); ok(`101 MB refused (${hg.msg})`, hg.ok === false && /100 MB/.test(hg.msg || ''), JSON.stringify(hg));
    const rel = await req('list', 'relative/path'); ok(`relative path refused (${rel.msg})`, rel.ok === false);
    const c = await read(path.join(rootReal, 'big.bin'), 3);
    ok(`cancel stops the stream (got ${c.chunks} chunks of 60)`, c.cancelled && c.chunks < 45, JSON.stringify(c));   // (well before all 60, even on a busy machine)
    const after = await read(path.join(rootReal, 'docs', 'readme.md'));
    ok('works after a cancel', after.ok);
    // a root with rules of its own (as a home folder is opened): nothing whose name starts with ".", some folders
    // left out with all they hold; the innermost root's rules count where roots overlap; plain roots as before
    {
      const { createFiles } = require(R + '/agent/files');
      const H = path.join(T, 'home2');
      for (const d of ['Desktop', 'AppData/Local/Google', '.claude', '.codex', 'Documents/.hidden', 'Documents/AppData', 'Work/sub'])
        fs.mkdirSync(path.join(H, d), { recursive: true });
      for (const f of ['Desktop/a.txt', 'AppData/Local/Google/Login Data', '.claude/x.jsonl', '.codex/auth.json', '.gitconfig', 'Documents/b.txt', 'Documents/.hidden/c.txt', 'Documents/AppData/d.txt', 'Work/.keep.txt', 'Work/sub/.note'])
        fs.writeFileSync(path.join(H, f), 'x');
      const fz = createFiles({ roots: [path.join(H, 'Work'), { path: H, hideDot: true, deny: ['AppData', 'documents/appdata/'] }] });
      const names = async (p) => (await fz.list(p)).entries.map((e) => e.name).sort().join();
      const refused = async (p, op = 'list') => { try { await fz[op](p); return ''; } catch (e) { return e.message; } };
      const win = process.platform === 'win32';
      ok('a home folder opened: its folders, not the ones starting with ".", not AppData', (await names(H)) === 'Desktop,Documents,Work', await names(H));
      ok('... and they cannot be opened by their path either (.claude, .codex/auth.json, .gitconfig, AppData and what is in it)',
        /受保护/.test(await refused(path.join(H, '.claude'))) && /受保护/.test(await refused(path.join(H, '.codex', 'auth.json'), 'open')) && /受保护/.test(await refused(path.join(H, '.gitconfig'), 'open')) &&
        /受保护/.test(await refused(path.join(H, 'AppData'))) && /受保护/.test(await refused(path.join(H, 'AppData', 'Local', 'Google', 'Login Data'), 'open')),
        [await refused(path.join(H, '.claude')), await refused(path.join(H, 'AppData', 'Local', 'Google', 'Login Data'), 'open')]);
      ok('deeper down as well: a "." folder inside Documents is hidden; a folder left out by its path' + (win ? ' (the case does not matter on Windows)' : ''),
        (await names(path.join(H, 'Documents'))) === (win ? 'b.txt' : 'AppData,b.txt') && /受保护/.test(await refused(path.join(H, 'Documents', '.hidden', 'c.txt'), 'open')), await names(path.join(H, 'Documents')));
      ok('a folder cannot be started in from there either', /受保护/.test(await refused(path.join(H, 'AppData', 'Local'), 'folder')) && (await fz.folder(path.join(H, 'Desktop'))) === fs.realpathSync(path.join(H, 'Desktop')), 0);
      ok('a root inside it without those rules: its own rules count (dot files shown there, secrets still not)', (await names(path.join(H, 'Work'))) === '.keep.txt,sub' && (await names(path.join(H, 'Work', 'sub'))) === '.note', [await names(path.join(H, 'Work')), await names(path.join(H, 'Work', 'sub'))]);
      ok('outside every root: refused as before', /不在允许浏览的范围内/.test(await refused(T)), await refused(T));
    }
    ws.close();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
