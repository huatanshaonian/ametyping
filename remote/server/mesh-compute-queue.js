// AmeMesh Mini-Slurm Compute Queue: per-machine GPU/CPU exclusive slot scheduling
// with external-process hardware busy detection, FIFO queueing, heartbeat lease, and persistence.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RESOURCES = ['gpu', 'cpu'];
const DEFAULT_SLOTS = { gpu: 1, cpu: 1 };
const DEFAULT_LEASE_MS = 10 * 60 * 1000; // 10 min without heartbeat -> auto-reclaim
const MAX_HISTORY = 120;

function cleanStr(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function createComputeQueue({ dataDir, getMachineProbe = () => null, now = () => Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  const file = path.join(dataDir, 'mesh-compute-queue.json');
  let state = { jobs: [], slots: {} }; // slots[machine] = { gpu: 1, cpu: 1 }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        state.jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
        state.slots = (raw.slots && typeof raw.slots === 'object' && !Array.isArray(raw.slots)) ? raw.slots : {};
      }
    } catch {}
  }

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      // Trim finished history beyond MAX_HISTORY
      const active = state.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
      const done = state.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running').slice(-MAX_HISTORY);
      state.jobs = [...done, ...active];
      fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch {}
  }

  load();

  function slotsFor(machine) {
    const custom = state.slots[machine] || {};
    return {
      gpu: Number.isFinite(Number(custom.gpu)) && Number(custom.gpu) > 0 ? Math.trunc(Number(custom.gpu)) : DEFAULT_SLOTS.gpu,
      cpu: Number.isFinite(Number(custom.cpu)) && Number(custom.cpu) > 0 ? Math.trunc(Number(custom.cpu)) : DEFAULT_SLOTS.cpu,
    };
  }

  function setSlots({ machine, gpu, cpu } = {}) {
    const m = cleanStr(machine, 60);
    if (!m) return { ok: false, msg: '缺少 machine 参数' };
    const cur = slotsFor(m);
    if (gpu !== undefined && Number.isFinite(Number(gpu)) && Number(gpu) >= 1 && Number(gpu) <= 16) cur.gpu = Math.trunc(Number(gpu));
    if (cpu !== undefined && Number.isFinite(Number(cpu)) && Number(cpu) >= 1 && Number(cpu) <= 32) cur.cpu = Math.trunc(Number(cpu));
    state.slots[m] = cur;
    reconcile();
    save();
    return { ok: true, machine: m, slots: cur };
  }

  function reclaimStale() {
    const t = now();
    let changed = false;
    for (const j of state.jobs) {
      if (j.status === 'running' && t - (j.heartbeatAt || j.startedAt || j.createdAt) > leaseMs) {
        j.status = 'failed';
        j.reason = '心跳超时自动回收槽位';
        j.endedAt = t;
        changed = true;
      }
    }
    return changed;
  }

  function runningCount(machine, resource) {
    return state.jobs.filter((j) => j.machine === machine && j.resource === resource && j.status === 'running').length;
  }

  function isHardwareExternallyBusy(machine, resource) {
    const probe = typeof getMachineProbe === 'function' ? getMachineProbe(machine) : null;
    if (!probe || typeof probe !== 'object') return false;
    // Ignore probe if stale (> 5 min old)
    if (probe.at && now() - probe.at > 5 * 60 * 1000) return false;
    if (resource === 'gpu') return Boolean(probe.hasGpu && probe.gpuBusy);
    if (resource === 'cpu') return Boolean(probe.cpuBusy);
    return false;
  }

  function reconcile() {
    let changed = reclaimStale();
    const queued = state.jobs
      .filter((j) => j.status === 'queued')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    for (const job of queued) {
      const cap = slotsFor(job.machine)[job.resource] || 1;
      const curRunning = runningCount(job.machine, job.resource);
      if (curRunning >= cap) {
        job.waitReason = `${job.machine} 的 ${job.resource.toUpperCase()} 槽位已满（${curRunning}/${cap}）`;
        continue;
      }
      // When no managed job is running on this slot, check external hardware usage (e.g. manual FEKO/PyTorch)
      if (curRunning === 0 && isHardwareExternallyBusy(job.machine, job.resource)) {
        job.waitReason = `${job.machine} 的 ${job.resource.toUpperCase()} 正被外部进程占用，等待空闲`;
        continue;
      }
      job.status = 'running';
      job.startedAt = now();
      job.heartbeatAt = job.startedAt;
      job.waitReason = '';
      changed = true;
    }
    return changed;
  }

  function enqueue({ machine, resource = 'gpu', label = '', projectId = '', nodeId = '', command = '' } = {}) {
    const m = cleanStr(machine, 60);
    const r = String(resource || 'gpu').trim().toLowerCase();
    if (!m) return { ok: false, msg: '缺少 machine 参数' };
    if (!RESOURCES.includes(r)) return { ok: false, msg: 'resource 仅支持 gpu 或 cpu' };
    const t = now();
    const job = {
      id: 'qjob_' + crypto.randomBytes(5).toString('hex'),
      machine: m,
      resource: r,
      label: cleanStr(label, 120) || `${r.toUpperCase()} 计算作业`,
      projectId: cleanStr(projectId, 40),
      nodeId: cleanStr(nodeId, 40),
      command: cleanStr(command, 500),
      status: 'queued',
      waitReason: '',
      createdAt: t,
      startedAt: 0,
      heartbeatAt: 0,
      endedAt: 0,
    };
    state.jobs.push(job);
    reconcile();
    save();
    const position = job.status === 'queued'
      ? state.jobs.filter((x) => x.machine === m && x.resource === r && x.status === 'queued').findIndex((x) => x.id === job.id) + 1
      : 0;
    return { ok: true, job, granted: job.status === 'running', position };
  }

  function poll(jobId) {
    reconcile();
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return { ok: false, msg: '找不到排队作业：' + String(jobId || '') };
    if (job.status === 'running') {
      job.heartbeatAt = now();
    }
    save();
    const position = job.status === 'queued'
      ? state.jobs.filter((x) => x.machine === job.machine && x.resource === job.resource && x.status === 'queued').findIndex((x) => x.id === job.id) + 1
      : 0;
    return { ok: true, job, granted: job.status === 'running', position };
  }

  function heartbeat(jobId) {
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return { ok: false, msg: '找不到作业' };
    if (job.status === 'running') {
      job.heartbeatAt = now();
      save();
    }
    return { ok: true, job };
  }

  function complete(jobId, { ok = true, reason = '' } = {}) {
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return { ok: false, msg: '找不到作业' };
    if (job.status === 'queued' || job.status === 'running') {
      job.status = ok ? 'done' : 'failed';
      job.reason = cleanStr(reason, 200);
      job.endedAt = now();
    }
    reconcile();
    save();
    return { ok: true, job };
  }

  function cancel(jobId) {
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return { ok: false, msg: '找不到作业' };
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'cancelled';
      job.reason = '已取消';
      job.endedAt = now();
    }
    reconcile();
    save();
    return { ok: true, job };
  }

  function clearDone() {
    state.jobs = state.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    save();
    return { ok: true, jobs: state.jobs };
  }

  function list({ machine = '', resource = '' } = {}) {
    reconcile();
    const m = cleanStr(machine, 60);
    const r = cleanStr(resource, 20).toLowerCase();
    const jobs = state.jobs.filter((j) => (!m || j.machine === m) && (!r || j.resource === r));
    return { ok: true, jobs, slots: { ...state.slots } };
  }

  return { enqueue, poll, heartbeat, complete, cancel, clearDone, setSlots, list, reconcile, slotsFor };
}

module.exports = { createComputeQueue, RESOURCES, DEFAULT_SLOTS };
