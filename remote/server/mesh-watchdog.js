'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONFIG = {
  idleNudgeMin: 3,
  idleAlertMin: 10,
  askingAlertMin: 10,
  silentAlertMin: 60,
  loopWindowMin: 10,
  loopCount: 5,
  loopNudge: true,
  autoRestart: true,
  restartWindowMin: 30,
  offlineAlertMin: 2,
  folderPollSec: 30,
  triggerMaxPerHour: 6,
};

function normalizeErrorSig(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/(?:[a-zA-Z]:)?[\\/][^\s:]+/g, '') // remove paths
    .replace(/0x[0-9a-fA-F]+/g, '')             // remove hex
    .replace(/\d+/g, '')                        // remove numbers
    .replace(/[^\w\u4e00-\u9fa5]/g, ' ')        // punctuation to space
    .replace(/\s+/g, ' ')                       // collapse whitespace
    .trim()
    .toLowerCase();
}

function loadMeshConfig(dataDir) {
  const cfgFile = path.join(dataDir, 'mesh-config.json');
  let cachedConfig = { ...DEFAULT_CONFIG };
  let cachedMtimeMs = 0;

  function ensureConfig() {
    if (!fs.existsSync(cfgFile)) {
      try {
        fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
        fs.writeFileSync(cfgFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
      } catch {}
    }
  }

  function getConfig() {
    ensureConfig();
    try {
      const stat = fs.statSync(cfgFile);
      if (stat.mtimeMs !== cachedMtimeMs) {
        const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        cachedConfig = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
        cachedMtimeMs = stat.mtimeMs;
      }
    } catch {}
    return { ...cachedConfig };
  }

  function updateConfig(patch) {
    const cur = getConfig();
    const updated = { ...cur, ...(patch && typeof patch === 'object' ? patch : {}) };
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    cachedConfig = updated;
    try {
      cachedMtimeMs = fs.statSync(cfgFile).mtimeMs;
    } catch {}
    return { ...cachedConfig };
  }

  ensureConfig();
  getConfig();

  return { getConfig, updateConfig, cfgFile };
}

function createWatchdog({
  dataDir,
  getProjects = () => [],
  getMachines = () => new Map(),
  liveSessionOf = () => null,
  deliverToNode = async () => ({ ok: true }),
  sendToAgent = async () => ({ ok: true }),
  recordEvent = () => {},
  notify = async () => ({ sent: 0 }),
  save = () => {},
  now = () => Date.now(),
}) {
  const { getConfig, updateConfig } = loadMeshConfig(dataDir);
  const nodeTrack = new Map(); // key: "projectId|nodeId" -> tracking object
  const machOfflineSince = new Map(); // machineName -> timestamp when first noticed offline
  let timer = null;

  function onNodeReport(projectId, nodeId, reviewStatus = 'running') {
    const key = `${projectId}|${nodeId}`;
    const track = nodeTrack.get(key);
    if (track) {
      track.lastProgressAt = now();
      track.idleNudged = false;
      track.errorHistory = [];
      track.activeAlerts.delete('W3_SILENT');
      track.activeAlerts.delete('W4_LOOP');
      if (reviewStatus !== 'running') {
        track.activeAlerts.clear();
        track.handlingExit = false;
      }
    }
    const projects = getProjects();
    const proj = projects.find((p) => p.id === projectId);
    const node = proj && (proj.nodes || []).find((n) => n.id === nodeId);
    if (node && reviewStatus !== 'running') {
      node.watchdogAlert = null;
    }
  }

  function onNodeCommand(projectId, nodeId) {
    const key = `${projectId}|${nodeId}`;
    const track = nodeTrack.get(key);
    if (track) {
      track.lastProgressAt = now();
    }
  }

  function dismissAlert(projectId, nodeId) {
    const projects = getProjects();
    const proj = projects.find((p) => p.id === projectId);
    const node = proj && (proj.nodes || []).find((n) => n.id === nodeId);
    if (node) {
      node.watchdogAlert = null;
      save();
    }
    const key = `${projectId}|${nodeId}`;
    const track = nodeTrack.get(key);
    if (track) {
      track.activeAlerts.clear();
      track.idleNudged = false;
    }
    return { ok: true };
  }

  function tick() {
    const cfg = getConfig();
    const curTime = now();
    const projects = getProjects();
    const machines = typeof getMachines === 'function' ? getMachines() : new Map();

    // 1. Update machine offline timestamps for all machines running mesh nodes
    const runningMachines = new Set();
    for (const proj of projects) {
      for (const node of proj.nodes || []) {
        if (node.reviewStatus === 'running' && node.machine) {
          runningMachines.add(node.machine);
        }
      }
    }

    for (const machineName of runningMachines) {
      const m = machines && machines.get(machineName);
      const isOnline = !!(m && m.online);
      if (!isOnline) {
        if (!machOfflineSince.has(machineName)) {
          machOfflineSince.set(machineName, curTime);
        }
      } else {
        machOfflineSince.delete(machineName);
      }
    }

    // 2. Evaluate rules for running nodes
    for (const proj of projects) {
      for (const node of proj.nodes || []) {
        if (node.reviewStatus !== 'running' || !node.sessionId) continue;

        const key = `${proj.id}|${node.id}`;
        let track = nodeTrack.get(key);
        if (!track) {
          track = {
            state: null,
            stateCategory: null,
            stateSince: curTime,
            askingSince: 0,
            lastProgressAt: curTime,
            idleNudged: false,
            activeAlerts: new Set(),
            errorHistory: [],
            exitTimestamps: [],
            handlingExit: false,
            lastErrorTs: 0,
          };
          nodeTrack.set(key, track);
        }

        const live = liveSessionOf(node.machine, node.sessionId);
        const liveState = live ? live.state : 'history';
        const liveOnline = !!(live && live.online);
        const liveAsking = !!(live && live.asking);

        // State category mapping
        let category;
        if (!liveOnline) {
          category = 'offline';
        } else if (liveAsking) {
          category = 'asking';
        } else if (['idle', 'done'].includes(liveState)) {
          category = 'idle';
        } else if (['working', 'thinking', 'reading', 'message'].includes(liveState)) {
          category = 'working';
        } else if (['history', 'ended'].includes(liveState)) {
          category = 'ended';
        } else {
          category = liveState || 'unknown';
        }

        if (track.stateCategory !== category) {
          // Leaving idle
          if (track.stateCategory === 'idle') {
            track.idleNudged = false;
            track.activeAlerts.delete('W1_IDLE');
            if (node.watchdogAlert && (node.watchdogAlert.code === 'W1_NUDGE' || node.watchdogAlert.code === 'W1_IDLE')) {
              node.watchdogAlert = null;
            }
          }
          // Leaving asking
          if (track.stateCategory === 'asking') {
            track.activeAlerts.delete('W2_ASKING');
            if (node.watchdogAlert && node.watchdogAlert.code === 'W2_ASKING') {
              node.watchdogAlert = null;
            }
          }
          // Re-activating from ended
          if (track.stateCategory === 'ended' && ['working', 'idle', 'asking'].includes(category)) {
            track.handlingExit = false;
          }
          // Recovering from offline
          if (track.stateCategory === 'offline' && category !== 'offline') {
            track.activeAlerts.delete('W6_OFFLINE');
            if (node.watchdogAlert && node.watchdogAlert.code === 'W6_OFFLINE') {
              node.watchdogAlert = null;
            }
          }

          track.stateCategory = category;
          track.state = liveState;
          track.stateSince = curTime;
        } else {
          track.state = liveState;
        }

        // Asking duration tracking
        if (liveAsking) {
          if (!track.askingSince) track.askingSince = curTime;
        } else {
          track.askingSince = 0;
        }

        // W6: 机器掉线
        const offlineSince = machOfflineSince.get(node.machine) || 0;
        if (!liveOnline || offlineSince > 0) {
          const offDuration = curTime - (offlineSince || curTime);
          if (offDuration >= cfg.offlineAlertMin * 60e3 && !track.activeAlerts.has('W6_OFFLINE')) {
            track.activeAlerts.add('W6_OFFLINE');
            node.watchdogAlert = { code: 'W6_OFFLINE', label: '机器离线', at: curTime };
            recordEvent(proj, {
              source: 'watchdog',
              kind: 'W6_OFFLINE',
              machine: node.machine,
              nodeId: node.id,
              summary: `机器 ${node.machine} 离线超过 ${cfg.offlineAlertMin} 分钟`,
              payload: { machine: node.machine, offlineDurationMin: Math.round(offDuration / 60e3) },
            });
            notify({
              title: '看门狗 · 节点机器离线',
              body: `机器 ${node.machine} 已离线超过 ${cfg.offlineAlertMin} 分钟（影响项目：${proj.name}）`,
              tag: `wd-w6-${node.machine}`,
              url: `/#proj=${proj.id}`,
            });
            save();
          }
          continue; // Machine is offline, skip online session rules
        }

        // W5: 会话意外退出
        if (['history', 'ended'].includes(liveState)) {
          if (!track.handlingExit) {
            track.handlingExit = true;
            track.exitTimestamps = (track.exitTimestamps || []).filter((t) => curTime - t <= cfg.restartWindowMin * 60e3);
            track.exitTimestamps.push(curTime);

            const allowRestart = cfg.autoRestart !== false && (node.role === 'master' ? proj.autoResumeMaster !== false : node.autoResumeClosed !== false);
            if (track.exitTimestamps.length === 1 && allowRestart) {
              node.watchdogAlert = { code: 'W5_RESTARTED', label: '意外退出已自动恢复', at: curTime };
              recordEvent(proj, {
                source: 'watchdog',
                kind: 'W5_RESTARTED',
                machine: node.machine,
                nodeId: node.id,
                summary: '会话意外退出，看门狗已自动恢复（1/1）',
                payload: { restartCount: 1 },
              });
              sendToAgent(node.machine, {
                t: 'send',
                id: node.sessionId,
                text: `[AmeMesh Watchdog 自动恢复] 检测到会话在契约执行期间意外退出，已自动唤醒恢复（1/1）。请检查当前进度并继续完成目标：${node.goal || '契约任务'}`,
              });
              save();
            } else {
              track.activeAlerts.add('W5_EXIT');
              node.watchdogAlert = { code: 'W5_EXIT', label: '多次意外退出', at: curTime };
              recordEvent(proj, {
                source: 'watchdog',
                kind: 'W5_EXIT',
                machine: node.machine,
                nodeId: node.id,
                summary: `会话短时间内第 ${track.exitTimestamps.length} 次退出，需人工介入`,
                payload: { restartCount: track.exitTimestamps.length },
              });
              notify({
                title: '看门狗 · 会话意外退出需人工介入',
                body: `${proj.name} / ${node.alias || node.id} (${node.machine}) 短时间内第 ${track.exitTimestamps.length} 次退出，已暂停自动重启`,
                tag: `wd-w5-${node.id}`,
                url: `/#proj=${proj.id}`,
              });
              save();
            }
          }
          continue;
        }

        // W2: 卡在权限确认
        if (liveAsking) {
          const askDuration = curTime - (track.askingSince || curTime);
          if (askDuration >= cfg.askingAlertMin * 60e3 && !track.activeAlerts.has('W2_ASKING')) {
            track.activeAlerts.add('W2_ASKING');
            node.watchdogAlert = { code: 'W2_ASKING', label: '卡在权限确认', at: curTime };
            recordEvent(proj, {
              source: 'watchdog',
              kind: 'W2_ASKING',
              machine: node.machine,
              nodeId: node.id,
              summary: `等待权限确认超过 ${cfg.askingAlertMin} 分钟`,
              payload: { askingDurationMin: Math.round(askDuration / 60e3) },
            });
            notify({
              title: '看门狗 · 权限确认超时',
              body: `${proj.name} / ${node.alias || node.id} 等待权限确认已超过 ${cfg.askingAlertMin} 分钟`,
              tag: `wd-w2-${node.id}`,
              url: `/#proj=${proj.id}`,
            });
            save();
          }
          continue;
        }

        // W4: 反复报同一个错
        const isErr = /error|fail|exception|traceback|错误|失败|拒绝|enoent|eacces|timeout/i.test(live.lastAct || '') || liveState === 'error';
        if (isErr && live.lastAct) {
          const sig = normalizeErrorSig(live.lastAct);
          if (sig && live.last && live.last !== track.lastErrorTs) {
            track.lastErrorTs = live.last;
            track.errorHistory.push({ sig, t: curTime });
          }
        }
        track.errorHistory = (track.errorHistory || []).filter((e) => curTime - e.t <= cfg.loopWindowMin * 60e3);
        if (!track.activeAlerts.has('W4_LOOP')) {
          const sigCounts = new Map();
          let loopedSig = null;
          for (const e of track.errorHistory) {
            const c = (sigCounts.get(e.sig) || 0) + 1;
            sigCounts.set(e.sig, c);
            if (c >= cfg.loopCount) {
              loopedSig = e.sig;
              break;
            }
          }
          if (loopedSig) {
            track.activeAlerts.add('W4_LOOP');
            node.watchdogAlert = { code: 'W4_LOOP', label: '错误死循环', detail: (live.lastAct || loopedSig).slice(0, 80), at: curTime };
            if (cfg.loopNudge) {
              sendToAgent(node.machine, {
                t: 'send',
                id: node.sessionId,
                text: '[AmeMesh Watchdog 提醒] 检测到短时间内反复出现相同错误。请停止盲目重试，调用 mesh_report(reviewStatus="blocked") 汇报错误详情等待检视。',
              });
            }
            recordEvent(proj, {
              source: 'watchdog',
              kind: 'W4_LOOP',
              machine: node.machine,
              nodeId: node.id,
              summary: `错误死循环告警：${(live.lastAct || loopedSig).slice(0, 80)}`,
              payload: { sig: loopedSig, errorCount: cfg.loopCount },
            });
            notify({
              title: '看门狗 · 错误循环告警',
              body: `${proj.name} / ${node.alias || node.id} 反复报错：${(live.lastAct || loopedSig).slice(0, 80)}`,
              tag: `wd-w4-${node.id}`,
              url: `/#proj=${proj.id}`,
            });
            save();
          }
        }

        // W1: 干完忘了汇报 (仅适用于非主控执行节点)
        const isIdle = ['idle', 'done'].includes(liveState) && !liveAsking;
        const hasInboxWork = node.inbox && node.inbox.some((m) => !m.needsManualWake);
        if (node.role !== 'master' && isIdle && !hasInboxWork) {
          const idleDuration = curTime - (track.stateSince || curTime);
          if (idleDuration >= cfg.idleNudgeMin * 60e3 && !track.idleNudged) {
            track.idleNudged = true;
            node.watchdogAlert = { code: 'W1_NUDGE', label: '已提醒汇报', at: curTime };
            recordEvent(proj, {
              source: 'watchdog',
              kind: 'W1_NUDGE',
              machine: node.machine,
              nodeId: node.id,
              summary: '已提醒节点提交阶段汇报',
              payload: { idleDurationMin: Math.round(idleDuration / 60e3) },
            });
            sendToAgent(node.machine, {
              t: 'send',
              id: node.sessionId,
              text: '[AmeMesh Watchdog 提醒] 检测到当前节点已处于空闲状态，但尚未提交阶段汇报。若已完成当前契约目标，请立即调用 mesh_report 汇报结果；若遇到阻塞，请调用 mesh_report(reviewStatus="blocked") 说明原因。',
            });
            save();
          }
          if (idleDuration >= (cfg.idleNudgeMin + cfg.idleAlertMin) * 60e3 && !track.activeAlerts.has('W1_IDLE')) {
            track.activeAlerts.add('W1_IDLE');
            node.watchdogAlert = { code: 'W1_IDLE', label: '干完未汇报', at: curTime };
            recordEvent(proj, {
              source: 'watchdog',
              kind: 'W1_IDLE',
              machine: node.machine,
              nodeId: node.id,
              summary: `节点空闲超过 ${cfg.idleNudgeMin + cfg.idleAlertMin} 分钟未汇报`,
              payload: { idleDurationMin: Math.round(idleDuration / 60e3) },
            });
            const masterNode = (proj.nodes || []).find((n) => n.role === 'master' && n.id !== node.id);
            if (masterNode) {
              deliverToNode(proj, masterNode, `[AmeMesh 看门狗告警 | 项目：${proj.name}]\n节点 ${node.alias || node.id} (${node.machine}) 已空闲超过 ${cfg.idleNudgeMin + cfg.idleAlertMin} 分钟未提交阶段汇报。请留意或介入检视。`);
            }
            notify({
              title: '看门狗 · 节点干完未汇报',
              body: `${proj.name} / ${node.alias || node.id} (${node.machine}) 已空闲超过 ${cfg.idleNudgeMin + cfg.idleAlertMin} 分钟未汇报`,
              tag: `wd-w1-${node.id}`,
              url: `/#proj=${proj.id}`,
            });
            save();
          }
        }

        // W3: 长时间工作不汇报 (仅适用于非主控执行节点)
        const isWorking = ['working', 'thinking', 'reading', 'message'].includes(liveState);
        if (node.role !== 'master' && isWorking) {
          const silentMaxMin = node.maxSilentMin || cfg.silentAlertMin;
          const workSilentDuration = curTime - (track.lastProgressAt || curTime);
          if (workSilentDuration >= silentMaxMin * 60e3 && !track.activeAlerts.has('W3_SILENT')) {
            track.activeAlerts.add('W3_SILENT');
            node.watchdogAlert = { code: 'W3_SILENT', label: '疑似卡住', at: curTime };
            recordEvent(proj, {
              source: 'watchdog',
              kind: 'W3_SILENT',
              machine: node.machine,
              nodeId: node.id,
              summary: `连续工作超过 ${silentMaxMin} 分钟无阶段汇报`,
              payload: { silentDurationMin: Math.round(workSilentDuration / 60e3) },
            });
            notify({
              title: '看门狗 · 节点疑似卡住',
              body: `${proj.name} / ${node.alias || node.id} 已连续工作超过 ${silentMaxMin} 分钟无阶段汇报`,
              tag: `wd-w3-${node.id}`,
              url: `/#proj=${proj.id}`,
            });
            save();
          }
        }
      }
    }
  }

  function start(intervalMs = 15000) {
    if (timer) clearInterval(timer);
    timer = setInterval(() => tick(), intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    getConfig,
    updateConfig,
    dismissAlert,
    onNodeReport,
    onNodeCommand,
    tick,
    start,
    stop,
    nodeTrack,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  loadMeshConfig,
  createWatchdog,
  normalizeErrorSig,
};
