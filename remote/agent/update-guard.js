#!/usr/bin/env node
// The restart after an update the server pushed (agent/fleet.js), from outside the agent:
//   node update-guard.js --dir ~/.ametyping/fleet --root <repository> [--task 'AmeTyping Agent'] [--unit ame-agent]
// It restarts the agent, then waits for the new one to reach the server (it marks pending.json healthy). When it does
// not within two minutes, the old version is put back -- the backed-up files (files mode) or git reset --keep to the old
// commit (git mode) -- and the agent restarted again. The outcome is left in last.json; the agent reports it.
// The headless service is restarted only when its code changed and only when its unit stops just its own process
// (KillMode=process), as deploy.js does: never tmux and the Claude sessions in it.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { timeout: 120e3, windowsHide: true, ...opts },
  (e, out, err) => res({ ok: !e, out: String(out || '').trim(), err: String(err || '').trim() || (e ? e.message : '') })));
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function restartAgentWith(platform, root, task, unit = 'ame-agent') {
  return async () => {
    // (reset-failed first: a crash loop of a broken version may have hit systemd's start limit)
    if (platform === 'linux') { await run('systemctl', ['--user', 'reset-failed', unit]); return run('systemctl', ['--user', 'restart', unit]); }
    const at = path.join(root, 'remote', 'agent', 'agent.js').replace(/'/g, "''");
    const t = String(task).replace(/'/g, "''");
    const ps = `$t = Get-ScheduledTask -TaskName '${t}' -ErrorAction SilentlyContinue; if (-not $t) { 'none'; exit 1 }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like ('*' + '${at}' + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1
if ((Get-ScheduledTask -TaskName '${t}').State -ne 'Running') { Start-ScheduledTask -TaskName '${t}' }
'ok'`;
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60e3 });
  };
}
async function restartHeadlessLinux() {
  const unit = path.join(require('os').homedir(), '.config', 'systemd', 'user', 'ame-headless.service');
  let text = ''; try { text = fs.readFileSync(unit, 'utf8'); } catch { return '这台电脑没有无头服务'; }
  if (!/^KillMode=process/m.test(text)) return '无头服务的代码变了，但它的 KillMode 不是 process，怕连带杀掉 tmux 里的会话，没有重启它';
  const r = await run('systemctl', ['--user', 'restart', 'ame-headless']);
  return r.ok ? '无头服务已重启' : '无头服务重启失败：' + r.err.slice(-160);
}

function restoreFiles(root, p) {
  const back = (rel) => {
    const src = path.join(p.backup, rel), dst = path.join(root, rel);
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) back(r);
      else { fs.mkdirSync(path.dirname(path.join(root, r)), { recursive: true }); fs.copyFileSync(path.join(p.backup, r), path.join(root, r)); }
    }
    return dst;
  };
  if (p.backup && fs.existsSync(p.backup)) back('');
  for (const rel of p.created || []) fs.rmSync(path.join(root, rel), { force: true });
}

// -> the last.json it wrote
async function guard({ dir, root, task = 'AmeTyping Agent', unit = 'ame-agent', platform = process.platform, waitMs = 120e3, pollMs = 2000,
  restart = restartAgentWith(platform, root, task, unit), headless = platform === 'linux' ? restartHeadlessLinux : async () => '',
  gitRun = (args) => run('git', ['-C', root, ...args]) } = {}) {
  const pendingFile = path.join(dir, 'pending.json'), lastFile = path.join(dir, 'last.json');
  const p = readJSON(pendingFile);
  if (!p) return null;
  const notes = [...(p.notes || [])];
  const r = await restart();
  if (!r.ok) notes.push('重启 agent 时出错：' + r.err.slice(-160));
  const end = Date.now() + waitMs;
  let healthy = false;
  while (Date.now() < end) {
    await sleep(pollMs);
    const now = readJSON(pendingFile);
    if (now && now.healthy && now.healthyPid !== p.agentPid) { healthy = true; break; }
  }
  let last;
  if (healthy) {
    if (p.headless) { const h = await headless(); if (h) notes.push(h); }
    last = { ok: true, commit: p.to, from: p.from, at: new Date().toISOString(), notes };
    fs.rmSync(pendingFile, { force: true });
    // the newest three backups are kept
    try {
      const old = fs.readdirSync(dir).filter((n) => n.startsWith('backup-')).sort().slice(0, -3);
      for (const n of old) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    } catch {}
  } else {
    let how = '';
    try {
      if (p.mode === 'git') {
        const g = await gitRun(['reset', '--keep', p.from]);
        how = g.ok ? `已退回 ${String(p.from).slice(0, 7)}` : '退回旧版本失败（git reset --keep）：' + g.err.slice(-160);
      } else { restoreFiles(root, p); how = `已用备份恢复到 ${String(p.from || '之前的版本').slice(0, 7)}`; }
    } catch (e) { how = '恢复备份失败：' + e.message; }
    fs.rmSync(pendingFile, { force: true });
    last = { ok: false, commit: p.from, tried: p.to, at: new Date().toISOString(),
      msg: `新版本 ${Math.round(waitMs / 1000)} 秒内没有连上看板服务器，${how}`, notes };
    await restart();
  }
  fs.writeFileSync(lastFile, JSON.stringify(last, null, 2), { mode: 0o600 });
  return last;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const dir = opt('--dir'), root = opt('--root');
  if (!dir || !root) { console.error('用法：node update-guard.js --dir <状态目录> --root <仓库目录> [--task 计划任务名]'); process.exit(2); }
  setTimeout(() => guard({ dir, root, task: opt('--task', 'AmeTyping Agent'), unit: opt('--unit', 'ame-agent'), waitMs: +opt('--wait', 120) * 1000 })
    .then((l) => { console.log(JSON.stringify(l)); process.exit(l && l.ok === false ? 1 : 0); })
    .catch((e) => { console.error(e); process.exit(1); }), 1500);       // (the agent first sends its answer to the server)
}

module.exports = { guard, restoreFiles };
