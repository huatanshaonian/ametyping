'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  DEFAULT_CONFIG,
  loadMeshConfig,
  createWatchdog,
  normalizeErrorSig,
} = require('../server/mesh-watchdog');
const { createMesh } = require('../server/mesh');

describe('mesh-watchdog', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-test-watchdog-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('loadMeshConfig', () => {
    it('creates default config file if not existing', () => {
      const cfgMgr = loadMeshConfig(tmpDir);
      assert.ok(fs.existsSync(cfgMgr.cfgFile));
      const cfg = cfgMgr.getConfig();
      assert.equal(cfg.idleNudgeMin, 3);
      assert.equal(cfg.idleAlertMin, 10);
      assert.equal(cfg.askingAlertMin, 10);
      assert.equal(cfg.silentAlertMin, 60);
      assert.equal(cfg.loopCount, 5);
      assert.equal(cfg.autoRestart, true);
    });

    it('hot-reloads config on external file changes', () => {
      const cfgMgr = loadMeshConfig(tmpDir);
      assert.equal(cfgMgr.getConfig().idleNudgeMin, 3);

      // Externally modify mesh-config.json
      const modified = { ...DEFAULT_CONFIG, idleNudgeMin: 1, idleAlertMin: 5 };
      // Give mtime a clear change
      fs.writeFileSync(cfgMgr.cfgFile, JSON.stringify(modified, null, 2));
      const stat = fs.statSync(cfgMgr.cfgFile);
      fs.utimesSync(cfgMgr.cfgFile, stat.atime, new Date(Date.now() + 2000));

      const reloaded = cfgMgr.getConfig();
      assert.equal(reloaded.idleNudgeMin, 1);
      assert.equal(reloaded.idleAlertMin, 5);
    });

    it('updates config and writes to disk via updateConfig', () => {
      const cfgMgr = loadMeshConfig(tmpDir);
      const res = cfgMgr.updateConfig({ idleNudgeMin: 2, loopCount: 7 });
      assert.equal(res.idleNudgeMin, 2);
      assert.equal(res.loopCount, 7);

      const diskData = JSON.parse(fs.readFileSync(cfgMgr.cfgFile, 'utf8'));
      assert.equal(diskData.idleNudgeMin, 2);
      assert.equal(diskData.loopCount, 7);
    });
  });

  describe('normalizeErrorSig', () => {
    it('normalizes error paths, numbers, and hex addresses', () => {
      const e1 = "Error: ENOENT: no such file, open 'C:\\project\\run_1\\data.csv'";
      const e2 = "Error: ENOENT: no such file, open 'D:\\project\\run_2\\data.csv'";
      assert.equal(normalizeErrorSig(e1), normalizeErrorSig(e2));
      assert.ok(normalizeErrorSig(e1).includes('enoent'));
    });
  });

  describe('Watchdog Rules (W1 - W6)', () => {
    let curTime;
    let now;
    let proj;
    let workerNode;
    let masterNode;
    let liveStateMap;
    let machinesMap;
    let agentMessages;
    let pushNotifs;
    let recordedEvents;
    let watchdog;

    beforeEach(() => {
      curTime = 1000000;
      now = () => curTime;
      agentMessages = [];
      pushNotifs = [];
      recordedEvents = [];

      masterNode = {
        id: 'node-master',
        alias: '主控节点',
        role: 'master',
        machine: 'pc-master',
        sessionId: 'sess-master',
        reviewStatus: 'running',
        inbox: [],
      };

      workerNode = {
        id: 'node-worker',
        alias: '仿真Worker',
        role: 'worker',
        machine: 'pc-worker',
        sessionId: 'sess-worker',
        reviewStatus: 'running',
        goal: '完成FEKO求解',
        inbox: [],
        watchdogAlert: null,
      };

      proj = {
        id: 'proj-1',
        name: '雷达散射截面仿真',
        nodes: [masterNode, workerNode],
        edges: [{ from: 'node-master', to: 'node-worker', type: 'master-worker' }],
        events: [],
      };

      liveStateMap = new Map();
      liveStateMap.set('pc-worker|sess-worker', {
        online: true,
        state: 'idle',
        asking: false,
        lastAct: '等待指令',
        last: curTime,
      });
      liveStateMap.set('pc-master|sess-master', {
        online: true,
        state: 'idle',
        asking: false,
        lastAct: '',
        last: curTime,
      });

      machinesMap = new Map();
      machinesMap.set('pc-worker', { name: 'pc-worker', online: true });
      machinesMap.set('pc-master', { name: 'pc-master', online: true });

      watchdog = createWatchdog({
        dataDir: tmpDir,
        getProjects: () => [proj],
        getMachines: () => machinesMap,
        liveSessionOf: (m, s) => liveStateMap.get(`${m}|${s}`) || null,
        deliverToNode: async (p, node, text) => {
          node.inbox = node.inbox || [];
          node.inbox.push({ text, at: now() });
          return { ok: true };
        },
        sendToAgent: async (machine, payload) => {
          agentMessages.push({ machine, payload });
          return { ok: true };
        },
        recordEvent: (p, evt) => {
          recordedEvents.push(evt);
          p.events = p.events || [];
          p.events.push(evt);
        },
        notify: async (msg) => {
          pushNotifs.push(msg);
          return { sent: 1 };
        },
        save: () => {},
        now: () => curTime,
      });
    });

    it('W1: sends nudge at 3 min idle, alerts + pushes + notifies master at 13 min idle, and clears on report', () => {
      // Initially at t=0
      watchdog.tick();
      assert.equal(workerNode.watchdogAlert, null);
      assert.equal(agentMessages.length, 0);

      // Advance by 3 minutes (180,000 ms)
      curTime += 3 * 60e3;
      watchdog.tick();

      // Nudge should fire
      assert.ok(workerNode.watchdogAlert);
      assert.equal(workerNode.watchdogAlert.code, 'W1_NUDGE');
      assert.equal(agentMessages.length, 1);
      assert.ok(agentMessages[0].payload.text.includes('Watchdog 提醒'));
      assert.equal(pushNotifs.length, 0); // No push on nudge

      // Another tick at 4 min: should not fire another nudge
      curTime += 60e3;
      watchdog.tick();
      assert.equal(agentMessages.length, 1);

      // Advance to 13 minutes total idle (3 + 10 min)
      curTime += 9 * 60e3;
      watchdog.tick();

      // Alert should fire
      assert.equal(workerNode.watchdogAlert.code, 'W1_IDLE');
      assert.equal(pushNotifs.length, 1);
      assert.ok(pushNotifs[0].title.includes('干完未汇报'));
      assert.ok(masterNode.inbox.some((m) => m.text.includes('看门狗告警')));

      // Worker reports done -> alert cleared
      watchdog.onNodeReport('proj-1', 'node-worker', 'done');
      assert.equal(workerNode.watchdogAlert, null);
    });

    it('W2: alerts and pushes phone notification when asking >= 10 min', () => {
      liveStateMap.set('pc-worker|sess-worker', {
        online: true,
        state: 'waiting',
        asking: true,
        lastAct: '等待权限确认',
        last: curTime,
      });

      watchdog.tick();
      assert.equal(workerNode.watchdogAlert, null);

      // Advance 10 minutes
      curTime += 10 * 60e3;
      watchdog.tick();

      assert.ok(workerNode.watchdogAlert);
      assert.equal(workerNode.watchdogAlert.code, 'W2_ASKING');
      assert.equal(pushNotifs.length, 1);
      assert.ok(pushNotifs[0].title.includes('权限确认超时'));
    });

    it('W3: alerts and pushes phone notification when working silently >= 60 min', () => {
      liveStateMap.set('pc-worker|sess-worker', {
        online: true,
        state: 'working',
        asking: false,
        lastAct: '正在执行数值积分求解...',
        last: curTime,
      });

      watchdog.tick();
      assert.equal(workerNode.watchdogAlert, null);

      // Advance 59 minutes: no alert
      curTime += 59 * 60e3;
      watchdog.tick();
      assert.equal(workerNode.watchdogAlert, null);

      // Advance 1 more minute (total 60 min)
      curTime += 60e3;
      watchdog.tick();

      assert.ok(workerNode.watchdogAlert);
      assert.equal(workerNode.watchdogAlert.code, 'W3_SILENT');
      assert.equal(pushNotifs.length, 1);
      assert.ok(pushNotifs[0].title.includes('疑似卡住'));
    });

    it('W4: detects repeated error loop (5 times in 10 min), sends nudge and pushes phone', () => {
      // Simulate 5 errors within 10 min
      for (let i = 0; i < 5; i++) {
        curTime += 60e3; // 1 min apart
        liveStateMap.set('pc-worker|sess-worker', {
          online: true,
          state: 'idle',
          asking: false,
          lastAct: `Error: fail to allocate memory in solver thread ${i}`,
          last: curTime,
        });
        watchdog.tick();
      }

      assert.ok(workerNode.watchdogAlert);
      assert.equal(workerNode.watchdogAlert.code, 'W4_LOOP');
      assert.ok(agentMessages.some((m) => m.payload.text.includes('反复出现相同错误')));
      assert.equal(pushNotifs.length, 1);
      assert.ok(pushNotifs[0].title.includes('错误循环告警'));
    });

    it('W5: auto-restarts once on first exit; on second exit within 30 min does not restart and pushes phone', () => {
      // Start in active working state
      liveStateMap.set('pc-worker|sess-worker', {
        online: true,
        state: 'working',
        asking: false,
        lastAct: '运行中',
        last: curTime,
      });
      watchdog.tick();

      // Session suddenly closes unexpectedly to 'history'
      curTime += 60e3;
      liveStateMap.set('pc-worker|sess-worker', {
        online: true,
        state: 'history',
        asking: false,
        lastAct: '（会话已关闭，可唤醒续聊）',
        last: curTime,
      });
      watchdog.tick();

      // First exit: auto restarted once via sendToAgent, NO phone push
      assert.equal(workerNode.watchdogAlert.code, 'W5_RESTARTED');
      assert.ok(agentMessages.some((m) => m.payload.text.includes('自动恢复')));
      assert.equal(pushNotifs.length, 0);

      // Session came back to life after restart
      curTime += 30e3;
      liveStateMap.set('pc-worker|sess-worker', {
        online: true,
        state: 'working',
        asking: false,
        lastAct: '恢复运行',
        last: curTime,
      });
      watchdog.tick();

      // Second unexpected exit occurs 5 minutes later (well within 30 min restartWindowMin)
      curTime += 5 * 60e3;
      liveStateMap.set('pc-worker|sess-worker', {
        online: true,
        state: 'history',
        asking: false,
        lastAct: '再次退出',
        last: curTime,
      });
      const msgsBefore = agentMessages.length;
      watchdog.tick();

      // Second exit: should NOT auto restart again; MUST push to phone
      assert.equal(workerNode.watchdogAlert.code, 'W5_EXIT');
      assert.equal(agentMessages.length, msgsBefore); // no new restart command sent
      assert.equal(pushNotifs.length, 1);
      assert.ok(pushNotifs[0].title.includes('会话意外退出需人工介入'));
    });

    it('W6: alerts and pushes phone notification when machine offline >= 2 min', () => {
      machinesMap.set('pc-worker', { name: 'pc-worker', online: false });
      liveStateMap.set('pc-worker|sess-worker', {
        online: false,
        state: 'offline',
        asking: false,
        lastAct: '',
        last: curTime,
      });

      watchdog.tick();
      assert.equal(workerNode.watchdogAlert, null);

      // Advance 2 minutes
      curTime += 2 * 60e3;
      watchdog.tick();

      assert.ok(workerNode.watchdogAlert);
      assert.equal(workerNode.watchdogAlert.code, 'W6_OFFLINE');
      assert.equal(pushNotifs.length, 1);
      assert.ok(pushNotifs[0].title.includes('节点机器离线'));
    });

    it('dismissAlert: clears alert on demand', () => {
      workerNode.watchdogAlert = { code: 'W1_IDLE', label: '干完未汇报', at: curTime };
      const res = watchdog.dismissAlert('proj-1', 'node-worker');
      assert.equal(res.ok, true);
      assert.equal(workerNode.watchdogAlert, null);
    });
  });

  describe('Trigger Rate-Limiting & Deduplication', () => {
    it('deduplicates identical events within 5 seconds', async () => {
      const mesh = createMesh({
        dataDir: tmpDir,
        machines: new Map(),
      });

      const pRes = mesh.saveProject({ name: '测试去重项目' });
      const projId = pRes.project.id;

      const evtPayload = {
        projectId: projId,
        source: 'run',
        kind: 'exit_ok',
        label: '任务A',
        exitCode: 0,
        durationMs: 1200,
      };

      const r1 = await mesh.emitEvent(evtPayload);
      assert.equal(r1.ok, true);
      assert.equal(r1.deduped, undefined);

      // Second identical event immediately after
      const r2 = await mesh.emitEvent(evtPayload);
      assert.equal(r2.ok, true);
      assert.equal(r2.deduped, true);

      const proj = mesh.getProject(projId);
      assert.equal(proj.events.length, 1);
    });

    it('enforces triggerMaxPerHour rate-limiting on folder triggers', async () => {
      const mesh = createMesh({
        dataDir: tmpDir,
        machines: new Map(),
      });

      const pRes = mesh.saveProject({ name: '测试限频项目' });
      const projId = pRes.project.id;

      const trigRes = mesh.upsertTrigger(projId, {
        type: 'folder',
        machine: 'pc-1',
        path: 'D:\\sim',
        glob: '*.ffe',
        label: '求解监听',
      });
      assert.equal(trigRes.ok, true);
      const trigId = trigRes.trigger.id;

      // Default triggerMaxPerHour is 6
      for (let i = 0; i < 6; i++) {
        const r = await mesh.emitEvent({
          projectId: projId,
          triggerId: trigId,
          source: 'folder',
          kind: 'files_ready',
          machine: 'pc-1',
          path: 'D:\\sim',
          files: [`file_${i}.ffe`],
        });
        assert.equal(r.ok, true, `fire ${i + 1} should succeed`);
      }

      // 7th fire in the same hour should be rate-limited
      const r7 = await mesh.emitEvent({
        projectId: projId,
        triggerId: trigId,
        source: 'folder',
        kind: 'files_ready',
        machine: 'pc-1',
        path: 'D:\\sim',
        files: ['file_overflow.ffe'],
      });
      assert.equal(r7.ok, false);
      assert.ok(r7.msg.includes('每小时上限'));
    });
  });
});
