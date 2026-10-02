// The daily copy of config.json + data to another disk (server/backup.js): what goes in, readable by the owner only,
// the newest few kept, a day missed made up; and the real server doing it from config.json "backup".
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const { createBackup } = require(R + '/server/backup');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 800)}`); };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const list = (f) => cp.execFileSync('tar', ['-tzf', path.basename(f)], { cwd: path.dirname(f) }).toString().split('\n').filter(Boolean).map((x) => x.replace(/\/$/, ''));

async function unit(T) {
  const S = path.join(T, 'srv'), D = path.join(S, 'data'), B = path.join(T, 'vol1', 'ame-backup');
  fs.mkdirSync(path.join(D, 'reports'), { recursive: true }); fs.mkdirSync(path.join(D, '2026-10-01', 'box'), { recursive: true });
  fs.writeFileSync(path.join(S, 'config.json'), '{"web":{}}');
  fs.writeFileSync(path.join(D, 'reports', '2026-10-01.json'), '{"headline":"x"}');
  fs.writeFileSync(path.join(D, '2026-10-01', 'box', 's1.jsonl'), '{"role":"user"}\n');
  fs.writeFileSync(path.join(D, 'google.json'), '{"token":{}}');
  fs.writeFileSync(path.join(S, 'server.log'), 'not this');
  const logs = [];
  const b = createBackup({ serverDir: S, dataDir: D, dir: B, keep: 2, at: '00:00', firstMs: 1e9, log: (m) => logs.push(m) });
  b.stop();
  const r = await b.run('2026-10-01');
  const inside = r.file ? list(r.file) : [];
  ok('a copy: config.json and the whole data folder (reports, archive, sign-ins), nothing else', r.file && path.basename(r.file) === 'ame-2026-10-01.tar.gz' && r.size > 0 &&
    inside.includes('config.json') && inside.includes('data/reports/2026-10-01.json') && inside.includes('data/2026-10-01/box/s1.jsonl') && inside.includes('data/google.json') &&
    !inside.some((x) => /server\.log/.test(x)), [r, inside]);
  if (process.platform !== 'win32') ok('readable by its owner only', (fs.statSync(B).mode & 0o777) === 0o700 && (fs.statSync(r.file).mode & 0o777) === 0o600);
  await b.run('2026-10-02'); await b.run('2026-10-03');
  ok('the newest `keep` copies stay', JSON.stringify(b.status().files) === '["ame-2026-10-02.tar.gz","ame-2026-10-03.tar.gz"]', b.status().files);
  ok('no half-written file left', !fs.readdirSync(B).some((f) => f.endsWith('.tmp')));
  const all = createBackup({ serverDir: S, dataDir: D, dir: B, at: '00:00', firstMs: 1e9, log: () => {} }); all.stop();
  await all.run('2026-10-04'); await all.run('2026-10-05');
  ok('no `keep` given: every copy stays', all.status().files.length === 4, all.status().files);
  b.check(); await sleep(1500);
  ok('today\'s copy made when it is due and missing', b.status().files.includes(`ame-${ymd(Date.now())}.tar.gz`), b.status());
  // the target cannot be written: an error, kept for an hour before trying again
  const bad = createBackup({ serverDir: S, dataDir: D, dir: path.join(S, 'config.json', 'x'), at: '00:00', firstMs: 1e9, log: () => {} }); bad.stop();
  const e = await bad.run();
  ok('cannot write there: the error is reported, not thrown', e && e.error, e);
}

// the real server, config.json "backup"
async function server(T) {
  const auth = require(R + '/server/auth');
  const CFG = path.join(T, 's2', 'config.json'); fs.mkdirSync(path.dirname(CFG), { recursive: true });
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const B = path.join(T, 'vol1b');
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = 18821; cfg.summary = { enabled: false };
  cfg.backup = { dir: B, at: '00:00', firstMs: 300 };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40 && !(fs.existsSync(B) && fs.readdirSync(B).some((f) => f.endsWith('.tar.gz'))); i++) await sleep(250);
    const f = fs.existsSync(B) ? fs.readdirSync(B).find((x) => x.endsWith('.tar.gz')) : null;
    ok('the server makes the day\'s copy from config.json "backup"', f === `ame-${ymd(Date.now())}.tar.gz` && list(path.join(B, f)).includes('config.json'), f);
  } finally { srv.kill(); }
  void auth;
}

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-backup-'));
  try { await unit(T); await server(T); } catch (e) { fail++; console.log('ERROR', e); }
  await sleep(300);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
