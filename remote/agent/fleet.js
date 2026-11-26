// 设备更新 (server/fleet): this copy's code version for the dashboard, and the update the server pushes after a deploy.
//   version()        -> { mode: 'git'|'files', commit, branch, auto, why, last, ... }  sent as "fleet-version"
//   have(files)      -> { path: blob id | null }       what this machine has of the bundle's files ("fleet-check")
//   stage(items)     the bundle's files as the server sends them, each checked against its blob id, into a staging folder
//   apply(d)         files mode: the current files backed up, the staged ones moved in, .ame-version.json written;
//                    git mode: git pull --ff-only to the commit -- then update-guard.js restarts the agent and waits for
//                    the new one to reach the server (markHealthy), and puts the old version back when it does not
// A development checkout is never updated: a git copy with more than one worktree, a linked worktree, a branch other
// than main, files changed and not committed, or agent.json "autoUpdate": false. The guard runs outside the agent
// (systemd-run on Linux, WMI on Windows) so that restarting the agent does not end it.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
// a bundle path: relative, no .., nothing inside a .git folder
const SAFE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!(?:.*\/)?\.git(?:\/|$))[A-Za-z0-9._\-/]{1,200}$/;
const run = (cmd, args, cwd, timeout = 120e3, env = undefined) => new Promise((res) => execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 8e6, ...(env ? { env } : {}) },
  (e, out, err) => res({ ok: !e, out: String(out || '').trim(), err: String(err || '').trim() || (e ? e.message : '') })));
// the way out this computer uses (set for it, else found by the agent: harness.js) -- git pull reaches GitHub through it;
// the agent's own environment has no proxy (2026-11-25: panasonic and dell211 could not pull direct)
function netEnv(home, env) {
  let n = {}; try { n = require('./harness').readNet(home); } catch {}
  const p = n.proxy || n.detected;
  if (!p) return env;
  const out = { ...env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) out[k] = p;
  try { out.NO_PROXY = out.no_proxy = require('./harness').NO_PROXY; } catch {}
  return out;
}
// git's id of a file's content, text taken with LF line ends as git stores it (as deploy-lib.js does)
function blobId(buf) {
  if (!buf.includes(0)) buf = Buffer.from(buf.toString('binary').replace(/\r\n/g, '\n'), 'binary');
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJSON(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = f + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(tmp, f);
}

// Derive HTTP(S) base URL from agent.json server ("wss://host/agent" -> "https://host")
function httpBaseOf(serverUrl) {
  try {
    const u = new URL(String(serverUrl || ''));
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = u.pathname.replace(/\/agent\/?$/, '');
    u.search = ''; u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch { return ''; }
}
// Download the deployed git bundle directly from the NAS over HTTP(S) (no proxy; LAN/Tailscale) with Bearer token
function downloadBundle(url, token, dest, { sha256 = '', timeout = 120e3 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const req = mod.request(u, { method: 'GET', timeout, headers: token ? { Authorization: 'Bearer ' + token } : {} }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`NAS 返回 HTTP ${res.statusCode}`));
      }
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest, { mode: 0o600 });
      res.on('data', (chunk) => hash.update(chunk));
      res.pipe(out);
      out.on('finish', () => {
        const got = hash.digest('hex');
        if (sha256 && got !== sha256) {
          try { fs.rmSync(dest, { force: true }); } catch {}
          return reject(new Error(`更新包校验不一致（期望 ${sha256.slice(0, 12)}，实际 ${got.slice(0, 12)}）`));
        }
        resolve({ file: dest, sha256: got });
      });
      out.on('error', (e) => { try { fs.rmSync(dest, { force: true }); } catch {} reject(e); });
    });
    req.on('timeout', () => req.destroy(new Error('从 NAS 下载更新包超时')));
    req.on('error', (e) => { try { fs.rmSync(dest, { force: true }); } catch {} reject(e); });
    req.end();
  });
}

function createFleet({ root = ROOT, home = os.homedir(), cfg = {}, log = () => {}, platform = process.platform, env = process.env,
  spawnGuard = null, gitRun = run, fetchBundle = null } = {}) {
  const dir = path.join(home, '.ametyping', 'fleet');
  const pendingFile = path.join(dir, 'pending.json'), lastFile = path.join(dir, 'last.json');
  const versionFile = path.join(root, '.ame-version.json');
  const git = (args, t, useProxy = true) => gitRun('git', ['-C', root, ...args], root, t,
    useProxy && (args[0] === 'pull' || args[0] === 'fetch') ? netEnv(home, env) : undefined);
  let staging = null;                                     // { rid, dir, files: Map(path -> blob) }

  async function version() {
    const out = { v: 1, platform, node: process.version, root, last: readJSON(lastFile) || undefined, pending: fs.existsSync(pendingFile) || undefined };
    const dotgit = path.join(root, '.git');
    if (fs.existsSync(dotgit)) {
      out.mode = 'git';
      const head = await git(['rev-parse', 'HEAD']);
      out.commit = head.ok ? head.out : '';
      out.branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out;
      const dirtyLines = (await git(['status', '--porcelain', '--untracked-files=no'])).out.split('\n').filter((l) => l && !/package-lock\.json$/.test(l));
      const dirtyFiles = dirtyLines.map((l) => l.replace(/^\s*[MADRCU?!]{1,2}\s+/, '').trim().replace(/^"|"$/g, '')).filter(Boolean);
      out.dirty = dirtyFiles.length;
      if (dirtyFiles.length) out.dirtyFiles = dirtyFiles.slice(0, 8);
      const wt = (await git(['worktree', 'list', '--porcelain'])).out.split('\n').filter((l) => l.startsWith('worktree ')).length;
      out.why = cfg.autoUpdate === false ? 'agent.json 里 "autoUpdate": false'
        : fs.statSync(dotgit).isFile() ? '这是一个工作树（开发用），不自动更新'
        : wt > 1 ? `开发目录（${wt} 个工作树），不自动更新`
        : out.branch !== 'main' ? `在分支 ${out.branch} 上，不是 main，不自动更新`
        : dirtyFiles.length ? `本地改了文件，无法自动更新（请手动处理）：${dirtyFiles.slice(0, 5).join('、')}${dirtyFiles.length > 5 ? ' …' : ''}` : '';
    } else {
      out.mode = 'files';
      const v = readJSON(versionFile);
      out.commit = v && typeof v.commit === 'string' ? v.commit : '';
      out.why = cfg.autoUpdate === false ? 'agent.json 里 "autoUpdate": false'
        : platform === 'linux' && !env.INVOCATION_ID ? 'agent 不是由 systemd 启动的，更新后没法自动重启'
        : platform !== 'linux' ? '这台电脑的 agent 不是用 git 装的，没法自动更新' : '';
    }
    out.auto = !out.why;
    return out;
  }

  function have(files) {
    const out = {};
    for (const p of Object.keys(files || {})) {
      if (!SAFE.test(p)) continue;
      try { out[p] = blobId(fs.readFileSync(path.join(root, p))); } catch { out[p] = null; }
    }
    return out;
  }

  // items: [{ path, blob, b64 }] (a batch); the first batch of a new run id starts a new staging folder
  function stage(rid, items) {
    if (!staging || staging.rid !== rid) {
      if (staging) fs.rmSync(staging.dir, { recursive: true, force: true });
      staging = { rid, dir: path.join(dir, 'stage-' + String(rid).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)), files: new Map() };
      fs.rmSync(staging.dir, { recursive: true, force: true });
    }
    for (const it of items || []) {
      if (!it || !SAFE.test(it.path) || !/^[0-9a-f]{40}$/.test(it.blob)) throw new Error('更新包里有不合规的文件名：' + String(it && it.path).slice(0, 80));
      const buf = Buffer.from(String(it.b64 || ''), 'base64');
      if (blobId(buf) !== it.blob) throw new Error('文件传输后校验不一致：' + it.path);
      const f = path.join(staging.dir, it.path);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buf);
      staging.files.set(it.path, it.blob);
    }
    return staging.files.size;
  }

  // d: { rid, run, commit, mode, files: [paths staged], headless } -> { ok, msg, restart }   (run: the staging's id)
  async function apply(d) {
    const sid = d.run || d.rid;
    if (fs.existsSync(pendingFile)) {
      const p = readJSON(pendingFile) || {};
      if (Date.now() - (p.at || 0) < 10 * 60e3) return { ok: false, msg: '上一次更新还没确认完（等几分钟再试）' };
      fs.rmSync(pendingFile, { force: true });
    }
    const v = await version();
    if (!v.auto) return { ok: false, msg: v.why };            // (never bypassed: a development checkout stays as it is)
    if (v.mode !== d.mode) return { ok: false, msg: `服务器按 ${d.mode} 方式更新，这台电脑是 ${v.mode} 方式` };
    if (!/^[0-9a-f]{40}$/.test(String(d.commit))) return { ok: false, msg: '版本号不对' };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    let pending;
    if (v.mode === 'git') {
      const before = v.commit;
      const notes = [];
      let fetched = false;
      const gb = d.gitBundle && typeof d.gitBundle === 'object' ? d.gitBundle : null;
      if (gb && (fetchBundle || (cfg.server && cfg.token))) {
        const tmpBundle = path.join(dir, `repo-${d.commit.slice(0, 7)}-${Date.now()}.bundle`);
        try {
          if (fetchBundle) {
            await fetchBundle(gb, tmpBundle, d.commit);
          } else {
            const base = httpBaseOf(cfg.server);
            if (!base) throw new Error('agent.json 的 server 地址格式不对');
            const dlUrl = `${base}${gb.path || '/api/fleet/bundle'}?commit=${d.commit}`;
            await downloadBundle(dlUrl, cfg.token, tmpBundle, { sha256: gb.sha256 || '' });
          }
          const f = await git(['fetch', '--no-tags', tmpBundle, '+refs/*:refs/ame-fleet/*'], 180e3, false);
          if (f.ok) fetched = true;
          else notes.push('NAS 增量包缺少基线，改从 origin 拉取：' + (f.err || f.out).slice(-160));
        } catch (e) {
          notes.push('从 NAS 下载更新包失败，改从 origin 拉取：' + e.message);
        } finally {
          try { fs.rmSync(tmpBundle, { force: true }); } catch {}
        }
      }
      if (!fetched) {
        const f = await git(['fetch', 'origin', 'main'], 180e3, true);
        if (!f.ok) return { ok: false, msg: '拉取最新代码失败：' + (f.err || f.out).slice(-300), notes };
      }
      const hasCommit = await git(['cat-file', '-e', `${d.commit}^{commit}`], 15e3, false);
      if (!hasCommit.ok) return { ok: false, msg: `找不到目标版本 ${d.commit.slice(0, 7)}（GitHub 上的 main 可能还没同步？）`, notes };
      const merge = await git(['merge', '--ff-only', d.commit], 60e3, false);
      if (!merge.ok) return { ok: false, msg: '无法快进到目标版本（请手动处理本地改动或分叉）：' + (merge.err || merge.out).slice(-300), notes };
      const after = (await git(['rev-parse', 'HEAD'])).out;
      if (after === before) return { ok: true, msg: '已经是这个版本', restart: false, notes };
      const changed = (await git(['diff', '--name-only', before, after])).out.split('\n').filter(Boolean);
      for (const [sub, args] of [['app', ['install', '--no-audit', '--no-fund']], ['remote', ['install', '--omit=dev', '--no-audit', '--no-fund']]]) {
        if (!changed.some((f) => f === `${sub}/package.json` || f === `${sub}/package-lock.json`)) continue;
        const r = platform === 'win32' ? await run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm', ...args], path.join(root, sub), 600e3, netEnv(home, env))
          : await run('npm', args, path.join(root, sub), 600e3, netEnv(home, env));
        if (!r.ok) notes.push(`${sub}/ 的依赖没装成：${r.err.slice(-160)}`);
      }
      await hooks(changed, notes);
      if (changed.some((f) => f.startsWith('app/'))) notes.push('糖糖本体（app/）有改动：重启糖糖后生效');
      pending = { rid: sid, mode: 'git', from: before, to: after, at: Date.now(), notes,
        headless: changed.some((f) => f.startsWith('headless/')) };
    } else {
      const paths = (d.files || []).filter((p) => SAFE.test(p));
      if (paths.length && (!staging || staging.rid !== sid)) return { ok: false, msg: '更新文件没有收全，重新来一次' };
      for (const p of paths) if (!staging.files.has(p)) return { ok: false, msg: '少了文件：' + p };
      const backup = path.join(dir, 'backup-' + stamp);
      const created = [];
      fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
      for (const p of [...paths, '.ame-version.json']) {
        const f = path.join(root, p);
        if (fs.existsSync(f)) { fs.mkdirSync(path.dirname(path.join(backup, p)), { recursive: true }); fs.copyFileSync(f, path.join(backup, p)); }
        else created.push(p);
      }
      for (const p of paths) {
        const f = path.join(root, p), tmp = f + '.ame-new';
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.copyFileSync(path.join(staging.dir, p), tmp);
        try { fs.chmodSync(tmp, fs.existsSync(f) ? fs.statSync(f).mode : 0o644); } catch {}
        fs.renameSync(tmp, f);
      }
      writeJSON(versionFile, { commit: d.commit, at: new Date().toISOString(), by: 'fleet' });
      fs.rmSync(staging.dir, { recursive: true, force: true }); staging = null;
      const notes = [];
      await hooks(paths, notes);
      if (!paths.length) return { ok: true, msg: '文件已是这个版本，只记下了版本号', restart: false };
      pending = { rid: sid, mode: 'files', from: v.commit, to: d.commit, backup, created, at: Date.now(), notes, headless: !!d.headless };
    }
    writeJSON(pendingFile, { ...pending, agentPid: process.pid });
    try { (spawnGuard || startGuard)(); }
    catch (e) { fs.rmSync(pendingFile, { force: true }); return { ok: false, msg: '更新已写入，但启动重启守护失败：' + e.message + '（手动重启 agent）' }; }
    return { ok: true, msg: '已写入，agent 马上重启', restart: true, notes: pending.notes };
  }

  // the installers of what Claude Code / Codex / OpenCode / Antigravity run here, when those files changed (as deploy.js does)
  async function hooks(changed, notes) {
    const hasDir = (p) => { try { return fs.existsSync(p); } catch { return false; } };
    const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
    const tasks = [
      {
        label: 'Claude Code hooks',
        script: path.join(root, 'headless', 'install-hooks.js'),
        match: (p) => p === 'headless/install-hooks.js' || p === 'hook-relay.js' || p === 'permission-hook.js',
        present: () => hasDir(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')),
      },
      {
        label: 'Codex hooks',
        script: path.join(root, 'install-codex-hooks.js'),
        match: (p) => p === 'install-codex-hooks.js' || p === 'codex-hook.js',
        present: () => hasDir(env.CODEX_HOME || path.join(home, '.codex')),
      },
      {
        label: 'OpenCode plugin',
        script: path.join(root, 'install-opencode-plugin.js'),
        match: (p) => p === 'install-opencode-plugin.js' || p.startsWith('opencode-plugin/'),
        present: () => hasDir(env.OPENCODE_CONFIG_DIR || path.join(xdg, 'opencode')),
      },
      {
        label: 'Antigravity hooks',
        script: path.join(root, 'install-agy-hooks.js'),
        match: (p) => p === 'install-agy-hooks.js' || p === 'agy-hook.js',
        present: () => hasDir(env.AGY_CONFIG_DIR || path.join(home, '.gemini')),
      },
      {
        label: 'MCP 登记',
        script: path.join(root, 'install-mesh-mcp.js'),
        match: (p) => p === 'install-mesh-mcp.js' || p === 'tools/ame-mesh.js' || p === 'remote/mcp/client.js',
        present: () => true,
      },
    ];
    for (const t of tasks) {
      if (!changed.some(t.match) || !t.present() || !hasDir(t.script)) continue;
      const r = await run(process.execPath, [t.script], root, 30e3);
      if (!r.ok) notes.push(`${t.label} 没装成：` + r.err.slice(-160));
    }
  }

  // waitSec: how long the guard waits for the new agent (tests: short)
  function startGuard({ waitSec = 0 } = {}) {
    const guard = path.join(__dirname, 'update-guard.js');
    const args = [guard, '--dir', dir, '--root', root, '--task', cfg.task || 'AmeTyping Agent', '--unit', cfg.unit || 'ame-agent',
      ...(waitSec ? ['--wait', String(waitSec)] : [])];
    if (platform === 'linux') {
      // a transient unit of its own: restarting ame-agent stops every process in ame-agent's group, this one not
      const child = spawn('systemd-run', ['--user', '--collect', '--quiet', '--unit', 'ame-update-guard-' + Date.now(), process.execPath, ...args],
        { stdio: 'ignore', detached: true });
      child.on('error', (e) => log('更新守护没启动：' + e.message));
      child.unref();
    } else if (platform === 'win32') {
      // through WMI: a process that is not the agent's child, so not in the scheduled task's job that ends with it
      const cmd = [process.execPath, ...args].map((a) => '"' + a.replace(/"/g, '') + '"').join(' ');
      const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd.replace(/'/g, "''")}' }; if ($r.ReturnValue -ne 0) { exit 1 }`;
      // (not detached: under the agent's scheduled task (conhost --headless) a detached PowerShell gets no console and
      // exits at once with 0 having run nothing -- found on dell211 2026-11-25, every Windows update then waited for a
      // guard that never started. The process WMI makes is outside the task's job either way.)
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
      child.on('error', (e) => log('更新守护没启动：' + e.message));
      child.on('close', (code) => { if (code) log('更新守护没启动：PowerShell 退出码 ' + code); });
      child.unref();
    } else throw new Error('这个系统不支持自动重启');
  }

  // the new agent has reached the server: the guard stops waiting
  function markHealthy() {
    const p = readJSON(pendingFile);
    if (!p || p.healthy || p.agentPid === process.pid) return;     // (the agent that wrote the update is not the new one)
    try { writeJSON(pendingFile, { ...p, healthy: Date.now(), healthyPid: process.pid }); } catch {}
  }

  return { version, have, stage, apply, markHealthy, dir, _startGuard: startGuard };
}

module.exports = { createFleet, blobId, SAFE, httpBaseOf, downloadBundle };
