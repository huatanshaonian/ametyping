// Helpers for deploy.js: running git / ssh, and telling whether files on a machine are versions git knows.
'use strict';
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

// a command's output; throws with its stderr when it fails
function run(cmd, args, { input, cwd = REPO, allowFail = false } = {}) {
  const r = cp.spawnSync(cmd, args, { cwd, input, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} 失败（${r.status}）：${String(r.stderr).trim().slice(0, 600)}`);
  return r.stdout;
}
const git = (args, o) => String(run('git', args, o)).trim();
const ssh = (host, script, o) => run('ssh', ['-o', 'BatchMode=yes', host, script], o);

// git archive <ref> <paths...> | ssh host 'cd dir && tar -xf -'
function upload(ref, paths, host, dir) {
  return new Promise((resolve, reject) => {
    const a = cp.spawn('git', ['archive', ref, '--', ...paths], { cwd: REPO, windowsHide: true });
    const s = cp.spawn('ssh', ['-o', 'BatchMode=yes', host, `cd ${dir} && tar -xf -`], { windowsHide: true });
    let err = '';
    a.stderr.on('data', (d) => { err += d; }); s.stderr.on('data', (d) => { err += d; });
    a.stdout.pipe(s.stdin);
    let codes = 0;
    const done = (who) => (code) => { if (code) return reject(new Error(`${who} 失败（${code}）：${err.trim().slice(0, 600)}`)); if (++codes === 2) resolve(); };
    a.on('close', done('git archive')); s.on('close', done('上传'));
  });
}

// the id git gives a file's content (a blob), with Windows line ends taken as git stores text (LF)
function blobId(buf) {
  if (!buf.includes(0)) buf = Buffer.from(buf.toString('binary').replace(/\r\n/g, '\n'), 'binary');
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}
// which of these blob ids are in the repository at all (any version, any branch)
function knownBlobs(ids) {
  if (!ids.length) return new Set();
  const out = String(run('git', ['cat-file', '--batch-check'], { input: ids.join('\n') + '\n' }));
  return new Set(out.split('\n').filter((l) => /^[0-9a-f]{40} blob /.test(l)).map((l) => l.slice(0, 40)));
}
// ref's files under these paths: path -> blob id
function treeOf(ref, paths) {
  const out = git(['ls-tree', '-r', ref, '--', ...paths]);
  const m = new Map();
  for (const l of out.split('\n').filter(Boolean)) { const [meta, p] = l.split('\t'); m.set(p, meta.split(' ')[2]); }
  return m;
}

// a tar of a machine's files, unpacked into a temp folder: path -> blob id
function remoteFiles(host, dir, paths, excludes = []) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ame-deploy-'));
  try {
    const ex = excludes.map((e) => `--exclude='${e}'`).join(' ');
    const tarball = ssh(host, `cd ${dir} && tar -cf - ${ex} ${paths.join(' ')} 2>/dev/null || true`);
    const tarFile = tmp + '.tar';                  // (unpacked from a file: Windows' tar does not take it on stdin here)
    fs.writeFileSync(tarFile, tarball);
    try { run('tar', ['-xf', path.basename(tarFile), '-C', path.basename(tmp)], { cwd: path.dirname(tmp), allowFail: true }); }
    finally { fs.rmSync(tarFile, { force: true }); }
    const m = new Map();
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else m.set(path.relative(tmp, p).replace(/\\/g, '/'), blobId(fs.readFileSync(p)));
      }
    })(tmp);
    return m;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// compare a machine's files with ref: { changed: paths that ref will update, local: paths edited on the machine (a
// version git never had), extra: files ref does not have }
function compare(machine, tree) {
  const known = knownBlobs([...new Set(machine.values())]);
  const changed = [], local = [], extra = [];
  for (const [p, id] of tree) if (machine.get(p) !== id) changed.push(p);
  for (const [p, id] of machine) {
    if (!tree.has(p)) extra.push(p);
    else if (id !== tree.get(p) && !known.has(id)) local.push(p);
  }
  return { changed, local, extra };
}

module.exports = { REPO, run, git, ssh, upload, blobId, treeOf, remoteFiles, compare };
