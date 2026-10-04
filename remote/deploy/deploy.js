#!/usr/bin/env node
// One command to put a commit (main by default) on the NAS and the machines' agents:
//   node remote/deploy/deploy.js [--ref main] [--dry-run] [--test] [--force] [--no-agents] [--no-headless]
// 1. the commit: main must be what GitHub has (fetched first); --test runs the e2e tests (remote/test/run.js) first
// 2. the NAS: its code is compared with git -- a file edited on the NAS (a version git never had) stops the deploy
//    (--force: overwrite it anyway); then a backup (code-backup-<time>.tar.gz, the newest 5 kept), the upload
//    (git archive of remote/, never config.json / data / node_modules), npm install when package.json changed,
//    the restart, and the log checked
// 3. each agent machine: the same check, its files updated (remote/agent, headless, app/*.js), the agent restarted;
//    the Linux headless service only when its code changed (a restart drops permission prompts waiting there);
//    this PC's agent (it runs from this working tree) when the tree is at that commit
// 4. deployed.json on the NAS records what was deployed; a change to the pet (app/) since then is pointed out
// Machines: remote/deploy/deploy.local.json (not in git; see deploy.example.json). --dry-run: checks only.
'use strict';
const fs = require('fs');
const path = require('path');
const { git, ssh, run, upload, treeOf, remoteFiles, compare } = require('./deploy-lib');

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REF = opt('--ref', 'main'), DRY = flag('--dry-run'), FORCE = flag('--force');
const say = (s) => console.log(s);
const step = (s) => console.log('\n== ' + s);
const fail = (s) => { console.error('\n✗ ' + s); process.exit(1); };

const cfgFile = path.join(__dirname, 'deploy.local.json');
if (!fs.existsSync(cfgFile)) fail(`缺少 ${cfgFile}：照 deploy.example.json 写一份（机器的 ssh 名称和目录）`);
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const NAS = cfg.nas;

const NAS_EXCLUDE = ['remote/node_modules', 'remote/server/data', 'remote/server/config.json*', 'remote/test/out', '*.log', '*.log.old'];
// what an agent machine runs: remote/agent/ and headless/, plus the app/ modules they load (found by following their
// require()s) -- not the pet's own files
function depsOf(ref, roots) {
  const deps = new Set(), seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return; seen.add(file);
    let src = ''; try { src = git(['show', `${ref}:${file}`]); } catch { return; }
    for (const m of src.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)) {
      const p = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])).replace(/(\.js)?$/, '.js');
      if (/^(app|headless|remote\/agent)\//.test(p)) { deps.add(p); visit(p); }
    }
  };
  for (const [p] of treeOf(ref, roots)) { deps.add(p); if (p.endsWith('.js')) visit(p); }
  return deps;
}

function checkMachine(name, local, extraOk) {
  if (local.length) {
    say(`  ${name} 上有 ${local.length} 个文件被直接改过（git 里没有这个版本）：`);
    for (const p of local) say('    ' + p);
    if (!FORCE) fail(`先弄清楚这些改动（需要的话提交进 git），或者用 --force 覆盖`);
    say('  --force：照样覆盖');
  }
  if (extraOk.length) say(`  （${name} 上另有 ${extraOk.length} 个 git 里没有的文件，不动：${extraOk.slice(0, 5).join('、')}${extraOk.length > 5 ? ' …' : ''}）`);
}

(async () => {
  // ---- 1. the commit ----
  step(`提交 ${REF}`);
  git(['fetch', '-q', 'origin']);
  const commit = git(['rev-parse', REF + '^{commit}']);
  if (REF === 'main') {
    const remote = git(['rev-parse', 'origin/main']);
    if (commit !== remote) fail(`本地 main（${commit.slice(0, 7)}）和 GitHub 的 main（${remote.slice(0, 7)}）不一致：先 pull / push`);
  }
  say(`  ${commit.slice(0, 7)} ${git(['log', '-1', '--format=%s', commit])}`);
  if (flag('--test')) {
    step('跑 e2e 测试（remote/test/run.js）');
    const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')], { stdio: 'inherit' });
    if (r.status !== 0) fail('测试没通过，不部署');
  }

  // ---- 2. the NAS ----
  step(`群晖（${NAS.ssh}:${NAS.dir}）`);
  const tree = treeOf(commit, ['remote']);
  for (const p of [...tree.keys()]) if (p.startsWith('remote/test/')) tree.delete(p);   // (tests stay here)
  const onNas = remoteFiles(NAS.ssh, NAS.dir, ['remote'], [...NAS_EXCLUDE, 'remote/test']);
  const nas = compare(onNas, tree);
  checkMachine('群晖', nas.local, nas.extra);
  const pkgChanged = onNas.get('remote/package.json') !== tree.get('remote/package.json');
  say(`  要更新 ${nas.changed.length} 个文件${pkgChanged ? '，package.json 变了（会 npm install）' : ''}`);
  let prev = null; try { prev = JSON.parse(String(ssh(NAS.ssh, `cat ${NAS.dir}/deployed.json 2>/dev/null || true`))); } catch {}
  if (DRY) say('  （--dry-run：到此为止）');
  else if (nas.changed.length) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    ssh(NAS.ssh, `cd ${NAS.dir} && tar -czf code-backup-${stamp}.tar.gz ${NAS_EXCLUDE.map((e) => `--exclude='${e}'`).join(' ')} remote && ls -1t code-backup-*.tar.gz | tail -n +6 | xargs -r rm -f`);
    say(`  备份：code-backup-${stamp}.tar.gz（保留最近 5 个）`);
    await upload(commit, ['remote', ':(exclude)remote/test'], NAS.ssh, NAS.dir);
    say('  已上传');
    if (pkgChanged) { say('  npm install …'); say(String(ssh(NAS.ssh, `cd ${NAS.dir}/remote && ${NAS.node} ${NAS.npm} install --omit=dev --no-audit --no-fund 2>&1 | tail -3`)).trim()); }
    const out = String(ssh(NAS.ssh, `cd ${NAS.dir} && sh run.sh restart >/dev/null && sleep 8 && sh run.sh status && tail -n 6 remote/server/server.log`));
    say(out.trim().split('\n').map((l) => '  | ' + l).join('\n'));
    if (!/running/.test(out) || /server exited/.test(out.split('\n').slice(-3).join('\n'))) fail('服务器没有正常跑起来，看上面的日志；备份可以这样还原：tar -xzf code-backup-…tar.gz');
  } else say('  群晖上已经是这个版本，不用更新');

  // ---- 3. the agents ----
  const appChanged = prev && prev.commit && prev.commit !== commit ? git(['diff', '--name-only', prev.commit, commit, '--', 'app']).split('\n').filter(Boolean) : [];
  if (!flag('--no-agents')) {
    const want = depsOf(commit, ['remote/agent', 'headless']);
    const agentTree = new Map([...treeOf(commit, ['remote/agent', 'headless', 'app'])].filter(([p]) => want.has(p)));
    const hdeps = depsOf(commit, ['headless']);                     // (the headless service's own code)
    for (const a of cfg.agents || []) {
      if (a.local) {
        step(`本机 agent（${a.name}）`);
        const head = git(['rev-parse', 'HEAD']);
        if (head !== commit) { say(`  这个工作目录在 ${head.slice(0, 7)}，不是 ${commit.slice(0, 7)}：本机 agent 用的是工作目录里的代码，先切到 ${REF} 再重启它`); continue; }
        if (DRY) { say('  （--dry-run：会重启本机 agent）'); continue; }
        run('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'agent\\\\agent\\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Seconds 1; if ((Get-ScheduledTask -TaskName '${a.task}').State -ne 'Running') { Start-ScheduledTask -TaskName '${a.task}' }`]);
        say('  已重启');
        continue;
      }
      step(`${a.name}（${a.ssh}:${a.dir}）`);
      const have = remoteFiles(a.ssh, a.dir, [...agentTree.keys()], []);
      const cmp = compare(have, agentTree);
      checkMachine(a.name, cmp.local, []);
      const headless = cmp.changed.filter((p) => hdeps.has(p));
      say(`  要更新 ${cmp.changed.length} 个文件${headless.length ? `（其中 ${headless.length} 个是无头服务的代码）` : ''}`);
      if (DRY || !cmp.changed.length) { if (!cmp.changed.length) say('  已经是这个版本'); continue; }
      await upload(commit, cmp.changed, a.ssh, a.dir);
      ssh(a.ssh, 'systemctl --user restart ame-agent');
      say(`  已更新，agent 已重启：${String(ssh(a.ssh, 'sleep 2; systemctl --user is-active ame-agent', { allowFail: true })).trim()}`);
      if (headless.length) {
        if (flag('--no-headless')) say('  无头服务的代码变了，但按 --no-headless 没重启（下次重启时生效）');
        else { ssh(a.ssh, 'systemctl --user restart ame-headless'); say(`  无头服务已重启（那台电脑上正在等待的权限确认会回到终端里问）：${String(ssh(a.ssh, 'sleep 2; systemctl --user is-active ame-headless', { allowFail: true })).trim()}`); }
      }
    }
  }

  // ---- 4. what was deployed ----
  if (!DRY) ssh(NAS.ssh, `cat > ${NAS.dir}/deployed.json`, { input: JSON.stringify({ ref: REF, commit, at: new Date().toISOString() }, null, 2) });
  step(DRY ? '检查完毕（没有改动任何机器）' : `部署完成：${commit.slice(0, 7)}`);
  if (appChanged.length) say(`糖糖本体（app/）自上次部署以来有改动（${appChanged.length} 个文件）：重启糖糖后生效`);
})().catch((e) => fail(e.message));
