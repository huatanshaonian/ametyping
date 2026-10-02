// A copy of the server's data on another disk, once a day: config.json and the data folder (daily / weekly reports,
// conversation archive, notes, 重要计划, Google sign-in, ...) as <dir>/ame-<YYYY-MM-DD>.tar.gz, all of them kept (or
// the newest `keep`). config.json "backup": { "dir": "/volume1/homes/<user>/ame-backup", "at": "05:30" } -- after the morning
// report. The folder and the files are readable by this user only (they hold the sign-ins). A day missed (the server
// was down at that time) is made up when it comes back.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHECK_MS = 10 * 60e3;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// serverDir: where config.json is; dataDir: the data folder (inside serverDir)
// firstMs: the first look after starting (a minute; tests shorter)
function createBackup({ serverDir, dataDir, dir, keep = 0, at = '05:30', firstMs = 60e3, log = () => {} }) {
  serverDir = path.resolve(serverDir); dataDir = path.resolve(dataDir); dir = path.resolve(dir);   // (tar runs in `dir`)
  const [hh, mm] = String(at).split(':').map(Number);
  let last = null, running = false;                   // last: { at, file, size } | { at, error }

  const files = () => { try { return fs.readdirSync(dir).filter((f) => /^ame-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f)).sort(); } catch { return []; } };

  // (run in the backup folder with a bare file name: GNU tar reads "C:\..." as host:path)
  function tar(out) {
    return new Promise((resolve, reject) => {
      const p = spawn('tar', ['-czf', path.basename(out), '--exclude=search.db*', '-C', serverDir, 'config.json', path.relative(serverDir, dataDir).replace(/\\/g, '/')],
        { cwd: path.dirname(out), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      // GNU tar exits 1 when a file changed while it was read (a conversation being archived): the copy is still good
      p.on('close', (code) => (code === 0 || (code === 1 && fs.existsSync(out)) ? resolve() : reject(new Error(`tar 退出码 ${code}：${err.trim().slice(0, 300)}`))));
    });
  }

  async function run(day = ymd(new Date())) {
    if (running) return null;
    running = true;
    const name = `ame-${day}.tar.gz`, out = path.join(dir, name), tmp = out + '.tmp';
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch {}
      await tar(tmp);
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, out);
      if (keep > 0) for (const f of files().slice(0, -keep)) fs.rmSync(path.join(dir, f), { force: true });
      last = { at: Date.now(), file: out, size: fs.statSync(out).size };
      log(`备份：${out}（${Math.round(last.size / 1024)} KB）`);
      return last;
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      last = { at: Date.now(), error: e.message };
      log('备份失败：' + e.message);
      return last;
    } finally { running = false; }
  }

  // today's copy is due once the time has come and it is not there yet
  function check() {
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() < (hh || 0) * 60 + (mm || 0)) return;
    if (last && last.error && Date.now() - last.at < 60 * 60e3) return;          // failed: again in an hour
    if (!files().includes(`ame-${ymd(now)}.tar.gz`)) run();
  }
  const timer = setInterval(check, CHECK_MS); timer.unref();
  const first = setTimeout(check, firstMs); first.unref();

  return { run, check, status: () => ({ dir, keep, last, files: files() }), stop() { clearInterval(timer); clearTimeout(first); } };
}

module.exports = { createBackup };
