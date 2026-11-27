// AmeMesh HPC & remote compute integration: Colab, Sugon/SCNet gateways, Mini-Slurm dispatch, and failure advisor.
'use strict';
const crypto = require('crypto');
const { createComputeQueue } = require('../mesh-compute-queue');
const { diagnoseSugonFailure } = require('../mesh-sugon-advisor');
const { cleanStr } = require('./helpers');

function createMeshHpc(ctx) {
  const { dataDir, data, machines, getMagpie, getEgress, onChange, notify } = ctx;

  function resolveGateway(providerId, preferredMachine = '') {
    const prov = computeQueue.getProvider(providerId);
    const gw = (prov && prov.meta && prov.meta.machine) || '';
    const candidates = [preferredMachine, gw].filter(Boolean);
    for (const name of candidates) {
      const m = machines && machines.get(name);
      const sock = m && m.sockets && [...m.sockets].reverse().find((s) => s.readyState === 1 && s.remoteControlAllowed === true);
      if (sock) return { machine: name, sock };
    }
    return { machine: candidates[0] || '', sock: null };
  }

  const resolveColabGateway = (preferredMachine = '') => resolveGateway('colab', preferredMachine);
  const resolveSugonGateway = (preferredMachine = '') => resolveGateway('sugon', preferredMachine);

  function onColabStatus(machineName, status = {}) {
    const mName = cleanStr(machineName, 60);
    if (!mName || !status || typeof status !== 'object') return;
    const available = Boolean(status.available);
    const balanceCcu = Number.isFinite(Number(status.balanceCcu)) ? Number(status.balanceCcu) : null;
    const burnRatePerHour = Number.isFinite(Number(status.burnRatePerHour)) ? Number(status.burnRatePerHour) : null;
    const activeRuntimes = Number.isFinite(Number(status.activeRuntimes)) ? Math.max(0, Math.trunc(Number(status.activeRuntimes))) : 0;
    const at = Number(status.at) || Date.now();
    const errTxt = cleanStr(status.error || '', 160);
    const note = available
      ? `网关机 ${mName} · 剩余 ${balanceCcu != null ? balanceCcu.toFixed(2) : '—'} CCU · 消耗 ${burnRatePerHour != null ? burnRatePerHour.toFixed(2) : '0.00'}/h · 活动运行时 ${activeRuntimes}`
      : `网关机 ${mName} · Colab CLI 不可用${errTxt ? `（${errTxt}）` : ''}`;
    computeQueue.registerProvider({
      id: 'colab',
      name: 'Google Colab (WSL CLI)',
      status: available ? 'active' : 'offline',
      note,
      meta: {
        machine: mName,
        available,
        balanceCcu,
        burnRatePerHour,
        activeRuntimes,
        error: errTxt,
        at,
      },
    });
    computeQueue.reconcile();
    onChange();
  }

  const keyExpiryNotifiedAt = new Map(); // profileId -> last push ts (24h dedupe)
  function onSugonStatus(machineName, status = {}) {
    const mName = cleanStr(machineName, 60);
    if (!mName || !status || typeof status !== 'object') return;
    const available = Boolean(status.available);
    const mode = cleanStr(status.mode || '', 24);
    const host = cleanStr(status.host || '', 160);
    const partitions = Array.isArray(status.partitions) ? status.partitions.map((x) => cleanStr(x, 60)).filter(Boolean).slice(0, 12) : [];
    const activeJobs = Number.isFinite(Number(status.activeJobs)) ? Math.max(0, Math.trunc(Number(status.activeJobs))) : 0;
    const runningJobs = Number.isFinite(Number(status.runningJobs)) ? Math.max(0, Math.trunc(Number(status.runningJobs))) : 0;
    const queuedJobs = Number.isFinite(Number(status.queuedJobs)) ? Math.max(0, Math.trunc(Number(status.queuedJobs))) : 0;
    const at = Number(status.at) || Date.now();
    const errTxt = cleanStr(status.error || '', 160);
    const note = available
      ? `网关机 ${mName} (${mode || 'ssh'}) · 分区 ${partitions.slice(0, 4).join(', ') || status.defaultPartition || 'normal'} · 运行 ${runningJobs} / 排队 ${queuedJobs}`
      : `网关机 ${mName} · 曙光超算暂不可用${errTxt ? `（${errTxt}）` : ''}`;
    const profiles = Array.isArray(status.profiles) ? status.profiles.slice(0, 32) : [];
    const expiringKeys = Array.isArray(status.expiringKeys) ? status.expiringKeys.slice(0, 16) : [];
    computeQueue.registerProvider({
      id: 'sugon',
      name: '曙光超算 (Sugon / SCNet)',
      status: available ? 'active' : 'offline',
      note,
      meta: {
        machine: mName,
        available,
        mode,
        host,
        defaultProfile: cleanStr(status.defaultProfile || '', 60),
        defaultPartition: cleanStr(status.defaultPartition || '', 60),
        partitions,
        onlineCount: Number.isFinite(Number(status.onlineCount)) ? Number(status.onlineCount) : profiles.filter((x) => x && x.available).length,
        totalCount: Number.isFinite(Number(status.totalCount)) ? Number(status.totalCount) : profiles.length,
        profiles,
        expiringKeys,
        activeJobs,
        runningJobs,
        queuedJobs,
        error: errTxt,
        at,
      },
    });
    if (typeof notify === 'function' && expiringKeys.length) {
      const nowMs = Date.now();
      const due = expiringKeys.filter((k) => {
        if (!k || !k.id) return false;
        const prev = keyExpiryNotifiedAt.get(k.id) || 0;
        return nowMs - prev >= 24 * 3600e3;
      });
      if (due.length) {
        for (const k of due) keyExpiryNotifiedAt.set(k.id, nowMs);
        try {
          notify({
            title: '曙光超算 SSH 密钥即将到期',
            body: due.map((k) => `${k.label || k.id}：${k.keyExpireAt}（剩 ${k.keyDaysLeft != null ? k.keyDaysLeft : '?'} 天）`).join('\n') + '\n请在 Win98「算力与作业」中点「更新密钥」直接上传新文件。',
            tag: 'sugon-key-expiry',
          });
        } catch {}
      }
    }
    computeQueue.reconcile();
    onChange();
  }

  function dispatchRemoteComputeJob(job) {
    if (!job || !job.command) return;
    if (job.providerType === 'sugon') {
      const { machine: gwMachine, sock } = resolveSugonGateway(job.machine);
      if (!sock) {
        computeQueue.complete(job.id, {
          ok: false,
          reason: `曙光超算网关机 ${gwMachine || '(未就绪)'} 不在线或未开启远程控制，无法提交曙光作业`,
        });
        return;
      }
      if (gwMachine && job.machine !== gwMachine) job.machine = gwMachine;
      try {
        sock.send(JSON.stringify({
          t: 'sugon-exec',
          jobId: job.id,
          sugonProfile: job.sugonProfile || '',
          label: job.label || '',
          partition: job.partition || '',
          nodes: job.nodes || 1,
          ntasks: job.ntasks || 1,
          gpus: job.resource === 'gpu' ? (Number(job.gpus) || 0) : 0,
          walltime: job.walltime || '',
          remoteWorkDir: job.remoteWorkDir || '',
          command: job.command,
          uploadPaths: Array.isArray(job.uploadPaths) ? job.uploadPaths : [],
          downloadPath: job.downloadPath || '',
          outputDir: job.outputDir || '',
        }));
      } catch (e) {
        computeQueue.complete(job.id, { ok: false, reason: '下发曙光作业失败：' + (e && e.message) });
      }
      return;
    }
    if (job.providerType === 'colab') {
      const { machine: gwMachine, sock } = resolveColabGateway(job.machine);
      if (!sock) {
        computeQueue.complete(job.id, {
          ok: false,
          reason: `Google Colab 网关机 ${gwMachine || '(未就绪)'} 不在线或未开启远程控制，无法执行 Colab 作业`,
        });
        return;
      }
      if (gwMachine && job.machine !== gwMachine) job.machine = gwMachine;
      try {
        sock.send(JSON.stringify({
          t: 'colab-exec',
          jobId: job.id,
          gpu: job.colabGpu || 'A100',
          fallbackGpus: Array.isArray(job.fallbackGpus) ? job.fallbackGpus : ['L4', 'T4'],
          command: job.command,
          cwd: job.cwd || '',
          label: job.label || '',
          uploadPaths: Array.isArray(job.uploadPaths) ? job.uploadPaths : [],
          downloadPath: job.downloadPath || '',
          outputDir: job.outputDir || '',
          maxDurationMin: job.maxDurationMin || 120,
          minBalanceCcu: job.minBalanceCcu != null ? job.minBalanceCcu : 15,
        }));
      } catch (e) {
        computeQueue.complete(job.id, { ok: false, reason: '下发 Colab 作业失败：' + (e && e.message) });
      }
      return;
    }
    if (!job.machine) return;
    const m = machines && machines.get(job.machine);
    const sock = m && m.sockets && [...m.sockets].reverse().find((s) => s.readyState === 1 && s.remoteControlAllowed === true);
    if (!sock) {
      computeQueue.complete(job.id, { ok: false, reason: `机器 ${job.machine} 不在线或未开启远程控制，无法执行远程算例` });
      return;
    }
    const env = {};
    if (Array.isArray(job.assignedGpus) && job.assignedGpus.length) {
      const gpuStr = job.assignedGpus.join(',');
      env.CUDA_VISIBLE_DEVICES = gpuStr;
      env.AME_ASSIGNED_GPUS = gpuStr;
    }
    if (Array.isArray(job.assignedNuma) && job.assignedNuma.length) {
      env.AME_ASSIGNED_NUMA = job.assignedNuma.join(',');
    }
    if (job.assignedCpus) env.AME_ASSIGNED_CPUS = job.assignedCpus;
    if (job.resource === 'cpu' && job.assignedCpuCount > 0 && Array.isArray(job.assignedNuma) && job.assignedNuma.length === 1) {
      env.OMP_NUM_THREADS = String(Math.max(1, Math.min(32, Math.floor(job.assignedCpuCount / 2) || job.assignedCpuCount)));
    }
    try {
      sock.send(JSON.stringify({
        t: 'compute-exec',
        jobId: job.id,
        command: job.command,
        cwd: job.cwd || '',
        label: job.label || '',
        env,
      }));
    } catch (e) {
      computeQueue.complete(job.id, { ok: false, reason: '下发远程作业失败：' + (e && e.message) });
    }
  }

  function cancelRemoteComputeJob(job) {
    if (!job) return;
    if (job.providerType === 'colab') {
      const { sock } = resolveColabGateway(job.machine);
      if (sock) {
        try { sock.send(JSON.stringify({ t: 'colab-kill', jobId: job.id })); } catch {}
      }
      return;
    }
    if (job.providerType === 'sugon') {
      const { sock } = resolveSugonGateway(job.machine);
      if (sock) {
        try { sock.send(JSON.stringify({ t: 'sugon-kill', jobId: job.id })); } catch {}
      }
      return;
    }
    if (!job.machine) return;
    const m = machines && machines.get(job.machine);
    const sock = m && m.sockets && [...m.sockets].reverse().find((s) => s.readyState === 1 && s.remoteControlAllowed === true);
    if (sock) {
      try { sock.send(JSON.stringify({ t: 'compute-kill', jobId: job.id })); } catch {}
    }
  }

  const recentSugonAlerts = new Map(); // key -> ts (dedupe 30 min)
  async function onSugonAlert(machineName, alert = {}) {
    if (!alert || typeof alert !== 'object') return { ok: false };
    const key = `${alert.profileId || ''}:${alert.slurmJobId || alert.jobId || ''}`;
    const nowMs = Date.now();
    if (key !== ':' && recentSugonAlerts.has(key) && nowMs - recentSugonAlerts.get(key) < 30 * 60000) {
      return { ok: true, deduped: true };
    }
    if (key !== ':') recentSugonAlerts.set(key, nowMs);
    if (recentSugonAlerts.size > 200) {
      for (const [k, ts] of recentSugonAlerts) {
        if (nowMs - ts > 60 * 60000) recentSugonAlerts.delete(k);
      }
    }

    const diag = await diagnoseSugonFailure({
      alert,
      dataDir,
      egress: typeof getEgress === 'function' ? getEgress() : null,
      magpie: typeof getMagpie === 'function' ? getMagpie() : null,
    });
    if (typeof notify === 'function') {
      try {
        notify({
          title: diag.header,
          body: `${diag.category}：${diag.rootCause}\n建议：${diag.suggestion}`,
          tag: `sugon-alert-${alert.slurmJobId || nowMs}`,
        });
      } catch {}
    }
    const targetPid = cleanStr(alert.projectId, 40);
    if (targetPid && data.projects.some((p) => p.id === targetPid)) {
      try {
        await ctx.postBoard({
          projectId: targetPid,
          agent: '超算巡检',
          kind: 'alert',
          text: `@master ${diag.summaryText}`,
        });
      } catch {}
    }
    return { ok: true, diagnosis: diag };
  }

  async function onComputeDone(machineName, d = {}) {
    const jobId = cleanStr(d.jobId, 60);
    if (!jobId) return;
    const exitCode = Number.isFinite(Number(d.exitCode)) ? Number(d.exitCode) : 1;
    const ok = exitCode === 0;
    const durationMs = Math.max(0, Number(d.durationMs) || 0);
    const tail = typeof d.tail === 'string' ? d.tail.slice(-2000) : '';
    const r = computeQueue.complete(jobId, {
      ok,
      reason: ok ? '' : (cleanStr(d.error, 160) || `exit ${exitCode}`),
      exitCode,
      durationMs,
      tail,
    });
    const job = r && r.job;
    if (job && job.providerType === 'sugon' && !ok) {
      onSugonAlert(machineName || job.machine, {
        profileId: d.profileId || job.sugonProfile || '',
        profileLabel: d.profileId || job.sugonProfile || '曙光超算',
        slurmJobId: d.slurmJobId || job.id,
        jobName: job.label || job.id,
        partition: job.partition || '',
        state: cleanStr(d.error, 80) || 'FAILED',
        exitCode: String(exitCode),
        elapsed: durationMs ? `${Math.round(durationMs / 1000)}s` : '',
        command: job.command || '',
        logTail: tail,
        projectId: job.projectId || '',
      }).catch(() => {});
    }
    if (job && job.projectId) {
      try {
        await ctx.emitEvent({
          source: 'run',
          kind: ok ? 'exit_ok' : 'exit_err',
          machine: machineName || job.machine,
          projectId: job.projectId,
          nodeId: job.nodeId || '',
          label: job.label || job.command.slice(0, 60),
          exitCode,
          durationMs,
          tail,
          cwd: job.cwd || '',
        });
      } catch {}
    }
  }

  const sugonQueryPending = new Map(); // rid -> { resolve, timer }
  function onSugonQueryRes(machineName, d = {}) {
    const rid = cleanStr(d.rid, 80);
    const p = rid && sugonQueryPending.get(rid);
    if (!p) return;
    clearTimeout(p.timer);
    sugonQueryPending.delete(rid);
    const { t, rid: _rid, ...rest } = d;
    p.resolve(rest);
  }

  function querySugon(op, args = {}, timeoutMs = 25000) {
    const { machine: gwMachine, sock } = resolveSugonGateway('');
    if (!sock) {
      return Promise.resolve({ ok: false, msg: `曙光超算网关机 ${gwMachine || '(未就绪)'} 不在线或未开启远程控制` });
    }
    const rid = 'sq_' + crypto.randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sugonQueryPending.delete(rid);
        resolve({ ok: false, msg: '查询曙光超算超时（网关机未在规定时间内返回）' });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      sugonQueryPending.set(rid, { resolve, timer });
      try {
        sock.send(JSON.stringify({ t: 'sugon-query', rid, op, args }));
      } catch (e) {
        clearTimeout(timer);
        sugonQueryPending.delete(rid);
        resolve({ ok: false, msg: '下发超算查询失败：' + (e && e.message) });
      }
    });
  }

  const computeQueue = createComputeQueue({
    dataDir,
    getMachineProbe: (mName) => (machines && machines.get(mName) && machines.get(mName).computeProbe) || null,
    onDispatchRemote: dispatchRemoteComputeJob,
    onCancelRemote: cancelRemoteComputeJob,
    onChange: () => onChange(),
  });

  return {
    computeQueue,
    onColabStatus,
    onSugonStatus,
    onSugonAlert,
    onSugonQueryRes,
    querySugon,
    onComputeDone,
  };
}

module.exports = { createMeshHpc };
