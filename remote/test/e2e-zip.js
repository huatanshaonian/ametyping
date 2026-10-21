// The .zip made in the browser for a folder download (public/js/apps/zip.js): read back field by field here, its CRCs
// against zlib's, and opened by the unzip programs at hand (Python's zipfile, Windows' tar) when there are any.
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const { createZip, crc32 } = require(path.resolve(__dirname, '..', 'public', 'js', 'apps', 'zip.js'));
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));

// a reader of what zip.js writes: the central directory, each entry's local header and data
function readZip(buf) {
  const end = buf.length - 22;
  if (buf.readUInt32LE(end) !== 0x06054b50) throw new Error('no end record');
  const n = buf.readUInt16LE(end + 10), cdAt = buf.readUInt32LE(end + 16), cdSize = buf.readUInt32LE(end + 12);
  const out = [];
  let p = cdAt;
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header ' + i);
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), time = buf.readUInt16LE(p + 12), date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), attr = buf.readUInt32LE(p + 38), at = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    if (buf.readUInt32LE(at) !== 0x04034b50 || buf.readUInt32LE(at + 14) !== crc || buf.readUInt16LE(at + 26) !== nl) throw new Error('local header differs: ' + name);
    const data = buf.slice(at + 30 + nl, at + 30 + nl + size);
    out.push({ name, flags, method, time, date, crc, attr, data });
    p += 46 + nl;
  }
  if (p !== cdAt + cdSize) throw new Error('central directory size');
  return out;
}

(async () => {
  chk('crc32 as zlib has it', crc32(Buffer.from('123456789')) === 0xcbf43926 && crc32(Buffer.from('网格 mesh')) === zlib.crc32(Buffer.from('网格 mesh')), crc32(Buffer.from('123456789')).toString(16));
  const big = Buffer.alloc(300000); for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
  const when = new Date(2026, 9, 15, 13, 45, 31).getTime();
  const z = createZip();
  z.dir('docs', when); z.dir('docs/空文件夹', when); z.dir('docs/img/', when);
  z.file('docs/说明.txt', Buffer.from('中文\r\nline 2\n'), when);
  z.file('docs/img/a.bin', big, when);
  z.file('docs/empty.txt', new Uint8Array(0), new Date(1970, 0, 1).getTime());
  const buf = Buffer.from(await z.blob().arrayBuffer());
  chk('the size so far is where the central directory starts', buf.readUInt32LE(buf.length - 6) === z.size && z.count === 6, [z.size, z.count]);
  const ents = readZip(buf);
  chk('entries in order, folders ending in "/", names in UTF-8 (flag 11)', ents.map((e) => e.name).join('|') === 'docs/|docs/空文件夹/|docs/img/|docs/说明.txt|docs/img/a.bin|docs/empty.txt' && ents.every((e) => e.flags === 0x0800 && e.method === 0), ents.map((e) => e.name));
  chk('folders: no data, the folder attribute', ents.slice(0, 3).every((e) => e.data.length === 0 && e.attr === 0x10), 0);
  const byName = Object.fromEntries(ents.map((e) => [e.name, e]));
  chk('files: their bytes as they are, CRC as zlib computes it', byName['docs/img/a.bin'].data.equals(big) && byName['docs/img/a.bin'].crc === zlib.crc32(big) && byName['docs/说明.txt'].data.toString() === '中文\r\nline 2\n', 0);
  const d = byName['docs/说明.txt'];
  chk('the date and time (local, two-second steps)', d.date === (((2026 - 1980) << 9) | (10 << 5) | 15) && d.time === ((13 << 11) | (45 << 5) | 15), [d.date, d.time]);
  chk('before 1980: 1980-01-01', byName['docs/empty.txt'].date === ((1 << 5) | 1) && byName['docs/empty.txt'].data.length === 0, byName['docs/empty.txt'].date);

  // the programs people unzip with
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-zip-')), Z = path.join(T, 'a.zip');
  fs.writeFileSync(Z, buf);
  const py = ['python', 'py'].find((x) => { try { cp.execFileSync(x, ['-c', '1'], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (py) {
    const out = cp.execFileSync(py, ['-I', '-c', 'import sys,zipfile;sys.stdout.reconfigure(encoding="utf-8");z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print("|".join(z.namelist()))', Z]).toString('utf8').trim().split(/\r?\n/);
    chk('Python zipfile: every CRC good, the names as written', out[0] === 'None' && out[1] === ents.map((e) => e.name).join('|'), out);
  } else res.push('SKIP Python zipfile (no python)');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : null;
  if (tar && fs.existsSync(tar)) {
    const X = path.join(T, 'x'); fs.mkdirSync(X);
    cp.execFileSync(tar, ['-xf', Z, '-C', X]);
    chk('Windows tar unpacks it: the files, the empty folder', fs.readFileSync(path.join(X, 'docs', 'img', 'a.bin')).equals(big) && fs.statSync(path.join(X, 'docs', '空文件夹')).isDirectory() && fs.readFileSync(path.join(X, 'docs', '说明.txt'), 'utf8') === '中文\r\nline 2\n', fs.readdirSync(path.join(X, 'docs')));
  } else res.push('SKIP Windows tar');
  fs.rmSync(T, { recursive: true, force: true });

  console.log(res.join('\n'));
  const failed = res.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${res.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
