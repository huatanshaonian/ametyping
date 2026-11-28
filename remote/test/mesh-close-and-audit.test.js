'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSessionScanner } = require('../agent/session-scanner');
const {
  createGitWorktree,
  removeGitWorktree,
  collectGitAudit,
  closeNodeTerminal,
  commandMatchesNodeId,
} = require('../agent/worktree');
const { createStore } = require('../server/store');
const { createSessionControl } = require('../server/session-control');
const { createMarks } = require('../server/session-marks');
const { createFsCatalog } = require('../server/fs-catalog');
const { createMesh } = require('../server/mesh');
const { evaluateGitAudit } = require('../server/mesh/helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
};
const git = (cwd, ...args) =>
  cp.execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('Task 1: Dynamic agy cwd backfill & store.info cwd binding', () => {
  it('re-emits meta when agy cwd transitions from null to non-empty and binds pendingSpawns + store.info.cwd', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-agy-cwd-'));
    const prevAgyHome = process.env.AGY_HOME;
    const agyHome = path.join(tmp, 'agy-home');
    const claudeProjects = path.join(tmp, 'claude-projects');
    const workDir1 = path.join(tmp, 'wt-agy-1');
    const workDir2 = path.join(tmp, 'wt-agy-2');
    fs.mkdirSync(path.join(agyHome, 'brain'), { recursive: true });
    fs.mkdirSync(claudeProjects, { recursive: true });
    fs.mkdirSync(workDir1, { recursive: true });
    fs.mkdirSync(workDir2, { recursive: true });
    process.env.AGY_HOME = agyHome;

    try {
      const store = createStore(path.join(tmp, 'store'));
      const machines = new Map([
        ['pc-win', { name: 'pc-win', online: true, control: true, files: true, sessions: new Map() }],
      ]);
      const mesh = createMesh({
        dataDir: path.join(tmp, 'mesh-data'),
        machines,
        store,
        marks: createMarks({ dataDir: tmp }),
        fsCatalog: createFsCatalog({ dataDir: tmp, machines }),
        dispatchControl: async () => ({ ok: true, msg: 'launched' }),
      });

      const proj = mesh.saveProject({
        name: 'Agy CWD 动态补绑测试',
        workspaces: [
          { machine: 'pc-win', path: workDir1, mode: 'rw' },
          { machine: 'pc-win', path: workDir2, mode: 'rw' },
        ],
      }).project;
      const master = mesh.upsertNode(proj.id, {
        machine: 'pc-win',
        sessionId: 'claude:master-0',
        role: 'master',
        alias: 'master',
      }).node;

      const sp1 = await mesh.spawnWorker({
        projectId: proj.id,
        fromNodeId: master.id,
        machine: 'pc-win',
        cwd: workDir1,
        tool: 'agy',
        alias: 'worker-agy-1',
        goal: '测试首轮 cwd=null 次轮补绑',
      });
      assert.equal(sp1.ok, true);
      assert.equal(sp1.node.sessionId, '');

      // Create an agy conversation transcript whose cwd has NOT landed on disk yet
      const convId = '11111111-aaaa-4bbb-8ccc-222222222222';
      const logDir = path.join(agyHome, 'brain', convId, '.system_generated', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const tf = path.join(logDir, 'transcript.jsonl');
      fs.writeFileSync(
        tf,
        JSON.stringify({
          type: 'USER_INPUT',
          step_index: 0,
          timestamp: new Date().toISOString(),
          content: '<USER_REQUEST>\n实现任务一\n</USER_REQUEST>',
        }) + '\n',
        'utf8'
      );

      const sent = [];
      const scanner = createSessionScanner({
        projectsDir: claudeProjects,
        idleDropMs: 60000,
        archiveDays: 1,
        petMap: new Map(),
        sendJSON: (o) => sent.push(o),
        getBufferedAmount: () => 0,
        isOnline: () => true,
      });
      scanner.onSync({});

      // Poll 1: cwd is still null -> initial meta has cwd: undefined, pendingSpawns stays unbound
      sent.length = 0;
      scanner.scan();
      scanner.pushRecords();

      const meta1 = sent.find((m) => m.t === 'meta' && m.id === `agy:${convId}`);
      assert.ok(meta1, 'First scan should emit initial meta');
      assert.equal(meta1.cwd, undefined, 'Initial meta cwd is undefined before workspace metadata lands');
      for (const msg of sent) {
        if (msg.t === 'rec') store.accept('pc-win', msg);
        if (msg.t === 'meta') {
          store.meta('pc-win', msg.id, msg);
          if (msg.cwd) mesh.onSessionMeta('pc-win', msg.id, msg.cwd);
        }
      }
      assert.equal(sp1.node.sessionId, '');

      // Now agy writes history.jsonl with workspace=workDir1 (without adding new transcript records!)
      fs.writeFileSync(
        path.join(agyHome, 'history.jsonl'),
        JSON.stringify({ conversationId: convId, workspace: workDir1, display: '实现任务一' }) + '\n',
        'utf8'
      );
      const future = new Date(Date.now() + 3000);
      fs.utimesSync(tf, future, future);

      // Poll 2: scanner detects c.cwd !== r.cwd, updates r.cwd, and re-emits meta with cwd=workDir1
      sent.length = 0;
      scanner.scan();
      scanner.pushRecords();

      const meta2 = sent.find((m) => m.t === 'meta' && m.id === `agy:${convId}`);
      assert.ok(meta2, 'Second scan must re-emit meta once cwd appears');
      assert.equal(meta2.cwd, workDir1);

      store.meta('pc-win', meta2.id, meta2);
      if (meta2.cwd) mesh.onSessionMeta('pc-win', meta2.id, meta2.cwd);

      assert.equal(sp1.node.sessionId, `agy:${convId}`, 'pendingSpawns must bind worker sessionId upon delayed meta cwd');
      const savedInfo = store.info('pc-win', `agy:${convId}`);
      assert.ok(savedInfo);
      assert.equal(savedInfo.cwd, workDir1, 'store.info() must return stored cwd');

      // Also verify onMachineState fallback via store.info(m, id).cwd when live state omits s.cwd
      const sp2 = await mesh.spawnWorker({
        projectId: proj.id,
        fromNodeId: master.id,
        machine: 'pc-win',
        cwd: workDir2,
        tool: 'agy',
        alias: 'worker-agy-2',
        goal: '测试 store.info.cwd 兜底绑定',
      });
      const convId2 = '33333333-aaaa-4bbb-8ccc-444444444444';
      store.accept('pc-win', {
        id: `agy:${convId2}`,
        from: 0,
        to: 10,
        recs: [{ u: 'u1', i: 0, role: 'user', text: 'hi', t: Date.now() }],
        cwd: workDir2,
      });
      assert.equal(store.info('pc-win', `agy:${convId2}`).cwd, workDir2);
      mesh.onMachineState('pc-win', [{ id: `agy:${convId2}`, label: 'Agy 2', state: 'idle', lines: [], perms: [] }]);
      assert.equal(sp2.node.sessionId, `agy:${convId2}`, 'onMachineState should bind via store.info().cwd fallback');

      mesh.watchdog.stop();
    } finally {
      if (prevAgyHome === undefined) delete process.env.AGY_HOME;
      else process.env.AGY_HOME = prevAgyHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Task 1: AME_NODE_ID precision terminal termination & archive close status', () => {
  it('terminates only the temporary child process carrying exact AME_NODE_ID, spares bystanders, and hard-rejects master/invalid ids', async () => {
    // 1. Security hard guards
    const masterRej = await closeNodeTerminal({ nodeId: 'node_master01', role: 'master' });
    assert.equal(masterRej.ok, false);
    assert.equal(masterRej.closed, false);
    assert.match(masterRej.detail, /禁止关闭主控/);

    for (const badId of ['', 'master', 'proj_123456', 'node_x', 'node_bad;rm', 'node_' + 'a'.repeat(50)]) {
      const r = await closeNodeTerminal({ nodeId: badId });
      assert.equal(r.ok, false, `Should reject invalid nodeId: ${badId}`);
      assert.equal(r.closed, false);
    }

    // Verify exact boundary matching on command lines & -EncodedCommand
    const targetId = 'node_testclose1';
    const b64Target = Buffer.from(`$env:AME_PROJECT_ID = 'proj_t'; $env:AME_NODE_ID = '${targetId}'; Start-Sleep -Seconds 60`, 'utf16le').toString('base64');
    const b64PrefixOther = Buffer.from(`$env:AME_NODE_ID = '${targetId}_other'; Start-Sleep -Seconds 60`, 'utf16le').toString('base64');
    assert.equal(commandMatchesNodeId(`powershell.exe -NoLogo -EncodedCommand ${b64Target}`, targetId), true);
    assert.equal(commandMatchesNodeId(`powershell.exe -NoLogo -EncodedCommand ${b64PrefixOther}`, targetId), false);
    assert.equal(commandMatchesNodeId(`node -e "closeNodeTerminal({ nodeId: '${targetId}' })"`, targetId), false);

    // 2. Spawn temporary isolated sleep processes (NEVER touches any real desktop terminal!)
    let targetProc = null;
    let bystanderProc = null;
    try {
      if (process.platform === 'win32') {
        targetProc = cp.spawn(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64Target],
          { windowsHide: true, stdio: 'ignore' }
        );
        bystanderProc = cp.spawn(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64PrefixOther],
          { windowsHide: true, stdio: 'ignore' }
        );
      } else {
        targetProc = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
          stdio: 'ignore',
          env: { ...process.env, AME_NODE_ID: targetId },
        });
        bystanderProc = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
          stdio: 'ignore',
          env: { ...process.env, AME_NODE_ID: `${targetId}_other` },
        });
      }

      assert.ok(targetProc.pid > 0 && bystanderProc.pid > 0);
      await sleep(400);
      assert.equal(pidAlive(targetProc.pid), true, 'Target test child should be running before closeNodeTerminal');
      assert.equal(pidAlive(bystanderProc.pid), true, 'Bystander test child should be running before closeNodeTerminal');

      const closeRes = await closeNodeTerminal({ nodeId: targetId });
      assert.equal(closeRes.ok, true);
      assert.equal(closeRes.closed, true);
      assert.ok(closeRes.count >= 1);

      await sleep(150);
      assert.equal(pidAlive(targetProc.pid), false, 'Target child with AME_NODE_ID=node_testclose1 must be terminated');
      assert.equal(pidAlive(bystanderProc.pid), true, 'Bystander child with prefix-similar AME_NODE_ID must NOT be touched');
      assert.equal(pidAlive(process.pid), true, 'Current test runner process must never be harmed');
    } finally {
      for (const p of [targetProc, bystanderProc]) {
        if (p && p.pid && pidAlive(p.pid)) {
          try { p.kill('SIGKILL'); } catch {}
        }
      }
    }
  });

  it('wires mesh-close-node RPC in reviewNode(archive, closeTerminal=true) and preserves failure warning + topo-model badge state', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-close-rpc-'));
    try {
      const store = createStore(path.join(tmp, 'store'));
      const sentToAgent = [];
      const machines = new Map();
      const sc = createSessionControl({
        control: true,
        machines,
        store,
        auth: { checkSession: () => ({}), isFresh: () => true },
      });

      let mockCloseOutcome = { closed: true, count: 2, detail: '已按 AME_NODE_ID 终止 2 个节点进程' };
      const fakeSock = {
        readyState: 1,
        remoteControlAllowed: true,
        send(raw) {
          const msg = JSON.parse(raw);
          sentToAgent.push(msg);
          if (msg.t === 'mesh-close-node') {
            setImmediate(() => {
              sc.onCloseNodeRes('pc-a', {
                t: 'mesh-close-node-res',
                id: msg.id,
                ...mockCloseOutcome,
              });
            });
          } else if (msg.rid && msg.rid.startsWith('mesh-')) {
            setImmediate(() => {
              mesh.fromAgentResult('pc-a', { rid: msg.rid, ok: false, msg: '会话未打开终端' });
            });
          }
        },
      };

      const m = sc.machine('pc-a');
      m.online = true;
      m.control = true;
      m.sockets = new Set([fakeSock]);

      const mesh = createMesh({
        dataDir: path.join(tmp, 'mesh'),
        machines,
        store,
        marks: createMarks({ dataDir: tmp }),
        fsCatalog: createFsCatalog({ dataDir: tmp, machines }),
      });

      const proj = mesh.saveProject({ name: '归档关窗兜底测试' }).project;
      const master = mesh.upsertNode(proj.id, {
        id: 'node_master001',
        machine: 'pc-a',
        sessionId: 'agy:m-1',
        role: 'master',
        alias: 'master',
      }).node;
      const unboundWorker = mesh.upsertNode(proj.id, {
        id: 'node_unbound01',
        machine: 'pc-a',
        sessionId: '',
        role: 'worker',
        tool: 'agy',
        alias: 'worker-unbound',
      }).node;
      const stuckWorker = mesh.upsertNode(proj.id, {
        id: 'node_stuck0002',
        machine: 'pc-a',
        sessionId: 'agy:stuck-2',
        role: 'worker',
        tool: 'agy',
        alias: 'worker-stuck',
      }).node;
      m.sessions.set('agy:stuck-2', { id: 'agy:stuck-2', label: 'Stuck', state: 'idle', lines: [], perms: [] });

      // Case A: Master with closeTerminal=true is strictly blocked from closing terminal
      const masterArch = await mesh.reviewNode({
        projectId: proj.id,
        nodeId: master.id,
        action: 'archive',
        closeTerminal: true,
      });
      assert.equal(masterArch.terminalClosed, false);
      assert.match(masterArch.msg, /禁止关闭主控/);
      assert.equal(sentToAgent.length, 0, 'Must never send /exit or mesh-close-node for master');

      // Case B: Worker with empty sessionId='' still closes terminal cleanly via mesh-close-node fallback
      const okArch = await mesh.reviewNode({
        projectId: proj.id,
        nodeId: unboundWorker.id,
        action: 'archive',
        note: '验收通过',
        closeTerminal: true,
      });
      assert.equal(okArch.ok, true);
      assert.equal(okArch.terminalClosed, true);
      assert.equal(okArch.node.terminalCloseFailed, false);
      assert.ok(sentToAgent.some((x) => x.t === 'mesh-close-node' && x.nodeId === 'node_unbound01'));

      // Case C: Both /exit and mesh-close-node fail -> terminalClosed=false, warning preserved even with note!
      sentToAgent.length = 0;
      mockCloseOutcome = { closed: false, count: 0, detail: '未找到进程' };
      const failArch = await mesh.reviewNode({
        projectId: proj.id,
        nodeId: stuckWorker.id,
        action: 'archive',
        note: '阶段结单说明',
        closeTerminal: true,
      });
      assert.equal(failArch.ok, true);
      assert.equal(failArch.terminalClosed, false);
      assert.equal(failArch.node.terminalCloseFailed, true);
      assert.match(failArch.msg, /（终端未能自动关闭，请手动关闭窗口）$/);

      const enriched = mesh.getProject(proj.id);
      const stuckView = enriched.nodes.find((n) => n.id === stuckWorker.id);
      assert.equal(stuckView.terminalCloseFailed, true);
      assert.match(stuckView.lastAct, /阶段结单说明/);
      assert.match(stuckView.lastAct, /（终端未能自动关闭，请手动关闭窗口）$/);

      // Verify frontend topo-model reflects terminalCloseFailed on archived node without reviving liveState
      const topoSrc = fs.readFileSync(path.join(__dirname, '../public/js/apps/topo-model.js'), 'utf8');
      const topoMod = await import('data:text/javascript;base64,' + Buffer.from(topoSrc).toString('base64'));
      const st = topoMod.nodeStatus(stuckView);
      assert.equal(st.cls, 'done');
      assert.match(st.label, /终端未关/);

      mesh.watchdog.stop();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Task 2: Committed-diff gitAudit in worktree branches', () => {
  it('passes audit with emptyChange=false when worker commits compliant files, catches committed out-of-bounds files, and keeps worktree status clean', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-wt-audit-'));
    const repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'secret'), { recursive: true });

    try {
      git(repoDir, 'init', '-q', '-b', 'main');
      git(repoDir, 'config', 'user.email', 'test@example.com');
      git(repoDir, 'config', 'user.name', 'Tester');
      fs.writeFileSync(path.join(repoDir, 'src', 'allowed.js'), 'module.exports = 1;\n', 'utf8');
      fs.writeFileSync(path.join(repoDir, 'secret', 'forbidden.js'), 'module.exports = "nope";\n', 'utf8');
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-qm', 'initial');

      // 1. Compliant committed worktree branch -> ok: true, emptyChange: false
      const wtOk = createGitWorktree(repoDir, 'worker-ok', 'mesh/worker-ok');
      assert.equal(wtOk.ok, true);
      assert.match(wtOk.headSha, /^[0-9a-f]{40}$/i);
      assert.equal(git(wtOk.worktreePath, 'status', '--porcelain'), '', 'ame-baseline-head inside .git must not dirty worktree');

      const baseAudit = collectGitAudit(wtOk.worktreePath);
      assert.equal(baseAudit.isGit, true);
      assert.equal(baseAudit.headSha, wtOk.headSha);
      assert.deepEqual(baseAudit.changedFiles, []);
      assert.deepEqual(baseAudit.committedFiles, []);

      fs.writeFileSync(path.join(wtOk.worktreePath, 'src', 'allowed.js'), 'module.exports = 2;\n', 'utf8');
      fs.writeFileSync(path.join(wtOk.worktreePath, 'src', 'new-helper.js'), 'module.exports = true;\n', 'utf8');
      git(wtOk.worktreePath, 'add', '.');
      git(wtOk.worktreePath, 'commit', '-qm', 'feat: compliant changes');

      assert.equal(git(wtOk.worktreePath, 'status', '--porcelain'), '', 'Working tree is clean after git commit');
      const auditOk = collectGitAudit(wtOk.worktreePath);
      assert.deepEqual(auditOk.changedFiles, []);
      assert.deepEqual(auditOk.committedFiles.sort(), ['src/allowed.js', 'src/new-helper.js']);

      const evalOk = evaluateGitAudit(
        {
          boundaries: ['src/**'],
          gitBaseline: { files: baseAudit.changedFiles, fingerprints: baseAudit.fingerprints, headSha: baseAudit.headSha },
        },
        auditOk
      );
      assert.equal(evalOk.ok, true);
      assert.equal(evalOk.emptyChange, false);
      assert.deepEqual(evalOk.outOfBounds, []);
      assert.deepEqual(evalOk.changedFiles.sort(), ['src/allowed.js', 'src/new-helper.js']);

      // 2. Out-of-bounds committed worktree branch -> ok: false, outOfBounds catches secret/forbidden.js!
      const wtBad = createGitWorktree(repoDir, 'worker-bad', 'mesh/worker-bad');
      assert.equal(wtBad.ok, true);
      fs.writeFileSync(path.join(wtBad.worktreePath, 'src', 'allowed.js'), 'module.exports = 3;\n', 'utf8');
      fs.writeFileSync(path.join(wtBad.worktreePath, 'secret', 'forbidden.js'), 'module.exports = "hacked";\n', 'utf8');
      git(wtBad.worktreePath, 'add', '.');
      git(wtBad.worktreePath, 'commit', '-qm', 'sneaky out-of-bounds commit');

      const auditBad = collectGitAudit(wtBad.worktreePath);
      assert.deepEqual(auditBad.changedFiles, []);
      assert.deepEqual(auditBad.committedFiles.sort(), ['secret/forbidden.js', 'src/allowed.js']);

      const evalBad = evaluateGitAudit({ boundaries: ['src/**'] }, auditBad);
      assert.equal(evalBad.ok, false);
      assert.equal(evalBad.emptyChange, false);
      assert.deepEqual(evalBad.outOfBounds, ['secret/forbidden.js']);

      // Clean up worktrees cleanly
      assert.equal(removeGitWorktree(wtOk.worktreePath, repoDir, wtOk.worktreeBranch, true).ok, true);
      assert.equal(removeGitWorktree(wtBad.worktreePath, repoDir, wtBad.worktreeBranch, true).ok, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
