// "检查更新" in the tray menu: what you would otherwise type -- `git pull` in the folder the pet runs from, `npm install`
// where the dependencies changed, the dashboard agent started again -- after which main.js restarts the pet itself.
// Only for a copy installed with git (install/install-windows.ps1); nothing is overwritten: files changed by hand stop it.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const run = (cmd, args, cwd, timeout = 120e3) => new Promise((res) => {
  execFile(cmd, args, { cwd, windowsHide: true, timeout, maxBuffer: 8e6 }, (err, out, errOut) =>
    res({ ok: !err, out: String(out || '').trim(), err: String(errOut || '').trim() || (err ? err.message : '') }));
});
const tail = (s, n = 400) => (s.length > n ? '…' + s.slice(-n) : s);
// npm is a .cmd on Windows: through cmd.exe there
const npm = (args, cwd) => (process.platform === 'win32'
  ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm', ...args], cwd, 600e3) : run('npm', args, cwd, 600e3));

// The agent of this copy (a scheduled task on Windows, as the installer sets it up): its process ended, the task
// started again when it is not running by then. Returns false when there is no such task.
async function restartAgent(root, task) {
  if (process.platform !== 'win32') return false;
  const at = path.join(root, 'remote', 'agent', 'agent.js').replace(/'/g, "''");
  const ps = `$t = Get-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue; if (-not $t) { 'none'; exit }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like ('*' + '${at}' + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1
if ((Get-ScheduledTask -TaskName '${task}').State -ne 'Running') { Start-ScheduledTask -TaskName '${task}' }
'ok'`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], root, 60e3);
  return r.ok && /ok\s*$/.test(r.out);
}

// root: the repository the pet runs from. -> { ok, changed, msg, detail }
//   ok && !changed: already the newest; ok && changed: updated, the pet is to be restarted
async function update(root, { task = 'AmeTyping Agent' } = {}) {
  if (!fs.existsSync(path.join(root, '.git'))) return { ok: false, msg: '这份糖糖不是用 git 装的，没法这样更新', detail: root };
  const head = async () => (await run('git', ['rev-parse', 'HEAD'], root)).out;
  const before = await head();
  if (!before) return { ok: false, msg: '没找到 git，或者这个文件夹不是一个仓库', detail: root };
  const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no'], root);
  if (dirty.out) return { ok: false, msg: '有文件被直接改过还没提交，先处理它们再更新', detail: tail(dirty.out) };
  const pull = await run('git', ['pull', '--ff-only'], root, 180e3);
  if (!pull.ok) return { ok: false, msg: '拉取最新代码失败（网络、代理，或者本地有自己的提交）', detail: tail(pull.err || pull.out) };
  const after = await head();
  if (after === before) return { ok: true, changed: false, msg: '已经是最新的了', detail: before.slice(0, 7) };
  const files = (await run('git', ['diff', '--name-only', before, after], root)).out.split('\n').filter(Boolean);
  const log = (await run('git', ['log', '--no-merges', '--format=· %s', `${before}..${after}`], root)).out.split('\n').filter(Boolean);
  const notes = [];
  for (const [dir, args] of [['app', ['install', '--no-audit', '--no-fund']], ['remote', ['install', '--omit=dev', '--no-audit', '--no-fund']]]) {
    if (!files.some((f) => f === `${dir}/package.json` || f === `${dir}/package-lock.json`)) continue;
    const r = await npm(args, path.join(root, dir));
    if (!r.ok) notes.push(`${dir}/ 的依赖没装成（手动运行 npm install）：${tail(r.err, 200)}`);
  }
  if (files.some((f) => /^(remote\/agent|headless|app)\//.test(f)) && !(await restartAgent(root, task))) notes.push('看板 agent 没有重启（没找到它的计划任务）：需要的话手动重启');
  return { ok: true, changed: true, msg: `已更新 ${log.length || 1} 项改动`, detail: [...log.slice(0, 8), log.length > 8 ? `…… 共 ${log.length} 项` : '', ...notes].filter(Boolean).join('\n') };
}

module.exports = { update };
