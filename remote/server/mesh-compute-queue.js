// AmeMesh Mini-Slurm Compute Queue: per-GPU & dual-socket NUMA fine-grained slot scheduling
// with external-process hardware busy detection, atomic multi-GPU allocation, HoL anti-starvation,
// FIFO queueing, heartbeat lease, and persistence.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RESOURCES = ['gpu', 'cpu'];
const DEFAULT_SLOTS = { gpu: 1, cpu: 1 };
const DEFAULT_LEASE_MS = 10 * 60 * 1000; // 10 min without heartbeat -> auto-reclaim
const PROBE_FRESH_MS = 5 * 60 * 1000;    // ignore probes older than 5 min
const MAX_HISTORY = 120;

function cleanStr(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function parseSlotRequest(val, fallback, maxLimit) {
  if (val === undefined || val === null || val === '') return fallback;
  if (typeof val === 'string' && val.trim().toLowerCase() === 'all') return 'all';
  const n = Number(val);
  if (Number.isFinite(n) && n >= 1 && n <= maxLimit && Math.trunc(n) === n) return n;
  return null;
}

function createComputeQueue({ dataDir, getMachineProbe = () => null, now = () => Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  const file = path.join(dataDir, 'mesh-compute-queue.json');
  let state = { jobs: [], slots: {} }; // slots[machine] = { gpu: n, cpu: m }

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

  function getFreshProbe(machine) {
    const probe = typeof getMachineProbe === 'function' ? getMachineProbe(machine) : null;
    if (!probe || typeof probe !== 'object') return null;
    if (probe.at && now() - probe.at > PROBE_FRESH_MS) return null;
    return probe;
  }

  function topologyFor(machine) {
    const custom = state.slots[machine] || {};
    const customGpu = Number.isFinite(Number(custom.gpu)) && Number(custom.gpu) > 0 ? Math.trunc(Number(custom.gpu)) : 0;
    const customCpu = Number.isFinite(Number(custom.cpu)) && Number(custom.cpu) > 0 ? Math.trunc(Number(custom.cpu)) : 0;
    const probe = getFreshProbe(machine);

    // Build GPU list
    let gpus = [];
    if (probe && Array.isArray(probe.gpus) && probe.gpus.length > 0) {
      gpus = probe.gpus
        .filter((g) => g && Number.isFinite(Number(g.index)))
        .map((g) => ({
          index: Math.trunc(Number(g.index)),
          name: cleanStr(g.name || '', 80),
          busy: Boolean(g.busy),
          numaNode: Number.isInteger(g.numaNode) && g.numaNode >= 0 ? g.numaNode : null,
        }))
        .sort((a, b) => a.index - b.index);
      if (customGpu > 0) {
        if (customGpu < gpus.length) gpus = gpus.slice(0, customGpu);
        else {
          const used = new Set(gpus.map((g) => g.index));
          let idx = 0;
          while (gpus.length < customGpu) {
            if (!used.has(idx)) {
              gpus.push({ index: idx, name: '', busy: false, numaNode: null });
              used.add(idx);
            }
            idx++;
          }
        }
      }
    } else {
      const cap = customGpu || DEFAULT_SLOTS.gpu;
      const extBusy = Boolean(probe && probe.hasGpu && probe.gpuBusy);
      for (let i = 0; i < cap; i++) {
        gpus.push({ index: i, name: '', busy: extBusy, numaNode: null });
      }
    }

    // Build NUMA / CPU slot list
    let numaNodes = [];
    if (probe && Array.isArray(probe.numaNodes) && probe.numaNodes.length > 0) {
      numaNodes = probe.numaNodes
        .filter((n) => n && Number.isFinite(Number(n.id)))
        .map((n) => ({
          id: Math.trunc(Number(n.id)),
          cpuList: cleanStr(n.cpuList || '', 120),
          cpuCount: Number.isFinite(Number(n.cpuCount)) && Number(n.cpuCount) > 0 ? Math.trunc(Number(n.cpuCount)) : 0,
          busy: Boolean(n.busy),
        }))
        .sort((a, b) => a.id - b.id);
      if (customCpu > 0) {
        if (customCpu < numaNodes.length) numaNodes = numaNodes.slice(0, customCpu);
        else {
          const used = new Set(numaNodes.map((n) => n.id));
          let id = 0;
          while (numaNodes.length < customCpu) {
            if (!used.has(id)) {
              numaNodes.push({ id, cpuList: '', cpuCount: 0, busy: Boolean(probe.cpuBusy) });
              used.add(id);
            }
            id++;
          }
        }
      }
    } else {
      const cap = customCpu || DEFAULT_SLOTS.cpu;
      const extBusy = Boolean(probe && probe.cpuBusy);
      for (let i = 0; i < cap; i++) {
        numaNodes.push({ id: i, cpuList: '', cpuCount: 0, busy: extBusy });
      }
    }

    return { gpus, numaNodes, probeFresh: Boolean(probe) };
  }

  function slotsFor(machine) {
    const topo = topologyFor(machine);
    return {
      gpu: topo.gpus.length,
      cpu: topo.numaNodes.length,
    };
  }

  function setSlots({ machine, gpu, cpu } = {}) {
    const m = cleanStr(machine, 60);
    if (!m) return { ok: false, msg: '缺少 machine 参数' };
    const cur = { ...(state.slots[m] || {}) };
    if (gpu !== undefined && Number.isFinite(Number(gpu)) && Number(gpu) >= 1 && Number(gpu) <= 16) cur.gpu = Math.trunc(Number(gpu));
    if (cpu !== undefined && Number.isFinite(Number(cpu)) && Number(cpu) >= 1 && Number(cpu) <= 32) cur.cpu = Math.trunc(Number(cpu));
    state.slots[m] = cur;
    reconcile();
    save();
    return { ok: true, machine: m, slots: slotsFor(m) };
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

  function resolveNumaCpuInfo(numaIds, numaNodes) {
    const matched = numaIds
      .map((id) => numaNodes.find((n) => n.id === id))
      .filter(Boolean);
    const assignedCpus = matched.map((n) => n.cpuList).filter(Boolean).join(',');
    const assignedCpuCount = matched.reduce((sum, n) => sum + (Number(n.cpuCount) || 0), 0);
    return { assignedCpus, assignedCpuCount };
  }

  function reconcile() {
    let changed = reclaimStale();
    const queuedWithIdx = state.jobs
      .map((job, idx) => ({ job, idx }))
      .filter((x) => x.job.status === 'queued')
      .sort((a, b) => ((a.job.createdAt || 0) - (b.job.createdAt || 0)) || (a.idx - b.idx));

    // Group queued jobs by machine
    const machinesSet = new Set(queuedWithIdx.map((x) => x.job.machine));

    for (const machine of machinesSet) {
      const topo = topologyFor(machine);

      // ---- 1) GPU per-card scheduling with atomic multi-GPU + HoL anti-starvation ----
      const managedGpus = new Set();
      for (const j of state.jobs) {
        if (j.machine === machine && j.resource === 'gpu' && j.status === 'running') {
          const ids = Array.isArray(j.assignedGpus) && j.assignedGpus.length ? j.assignedGpus : [0];
          for (const id of ids) managedGpus.add(id);
        }
      }

      let gpuHolReserved = null;
      const queuedGpu = queuedWithIdx.filter((x) => x.job.machine === machine && x.job.resource === 'gpu').map((x) => x.job);
      for (const job of queuedGpu) {
        const totalGpus = topo.gpus.length;
        const reqCount = job.gpus === 'all' ? totalGpus : Math.max(1, Number(job.gpus) || 1);

        if (reqCount > totalGpus) {
          job.waitReason = `${machine} 仅有 ${totalGpus} 张 GPU，无法满足 ${reqCount} 卡请求`;
          continue;
        }

        if (gpuHolReserved) {
          job.waitReason = `等待队头多卡作业 ${gpuHolReserved.id}（${gpuHolReserved.label}）优先获取 GPU（防饥饿预约）`;
          continue;
        }

        const freeGpus = topo.gpus.filter((g) => !managedGpus.has(g.index) && !g.busy);
        const extBusyGpus = topo.gpus.filter((g) => !managedGpus.has(g.index) && g.busy);

        if (freeGpus.length >= reqCount) {
          const picked = freeGpus.slice(0, reqCount);
          job.assignedGpus = picked.map((g) => g.index);

          // Populate NUMA affinity from assigned GPUs
          const affinitySet = [];
          for (const g of picked) {
            if (Number.isInteger(g.numaNode) && g.numaNode >= 0 && !affinitySet.includes(g.numaNode)) {
              affinitySet.push(g.numaNode);
            }
          }
          if (!affinitySet.length && topo.numaNodes.length === 1) {
            affinitySet.push(topo.numaNodes[0].id);
          }
          job.assignedNuma = affinitySet;
          const { assignedCpus, assignedCpuCount } = resolveNumaCpuInfo(affinitySet, topo.numaNodes);
          job.assignedCpus = assignedCpus;
          job.assignedCpuCount = assignedCpuCount;

          job.status = 'running';
          job.startedAt = now();
          job.heartbeatAt = job.startedAt;
          job.waitReason = '';
          for (const id of job.assignedGpus) managedGpus.add(id);
          changed = true;
        } else {
          if (extBusyGpus.length > 0 && managedGpus.size === 0) {
            job.waitReason = `${machine} 的 GPU 正被外部进程占用（空闲 ${freeGpus.length}/${totalGpus}，需要 ${reqCount}），等待空闲`;
          } else if (extBusyGpus.length > 0) {
            job.waitReason = `${machine} 的 GPU 可用卡不足（空闲 ${freeGpus.length}/${totalGpus}，含外部进程占用，需要 ${reqCount}）`;
          } else {
            job.waitReason = `${machine} 的 GPU 槽位不足（已占 ${managedGpus.size}/${totalGpus}，需要 ${reqCount}）`;
          }
          // Head-of-Line reservation: prevent subsequent smaller GPU jobs from starving a waiting multi-GPU job
          if (reqCount > 1) {
            gpuHolReserved = job;
          }
        }
      }

      // ---- 2) CPU / NUMA slot scheduling with dual-socket concurrency + HoL anti-starvation ----
      const managedNuma = new Set();
      for (const j of state.jobs) {
        if (j.machine === machine && j.resource === 'cpu' && j.status === 'running') {
          const ids = Array.isArray(j.assignedNuma) && j.assignedNuma.length ? j.assignedNuma : [0];
          for (const id of ids) managedNuma.add(id);
        }
      }

      let cpuHolReserved = null;
      const queuedCpu = queuedWithIdx.filter((x) => x.job.machine === machine && x.job.resource === 'cpu').map((x) => x.job);
      for (const job of queuedCpu) {
        const totalNuma = topo.numaNodes.length;
        const reqNuma = job.numa === 'all' ? totalNuma : Math.max(1, Number(job.numa) || 1);

        if (reqNuma > totalNuma) {
          job.waitReason = `${machine} 仅有 ${totalNuma} 个 NUMA 槽位，无法满足 ${reqNuma} 路请求`;
          continue;
        }

        if (cpuHolReserved) {
          job.waitReason = `等待队头多路 CPU 作业 ${cpuHolReserved.id}（${cpuHolReserved.label}）优先获取 NUMA 槽位（防饥饿预约）`;
          continue;
        }

        const freeNumas = topo.numaNodes.filter((n) => !managedNuma.has(n.id) && !n.busy);
        const extBusyNumas = topo.numaNodes.filter((n) => !managedNuma.has(n.id) && n.busy);

        if (freeNumas.length >= reqNuma) {
          const picked = freeNumas.slice(0, reqNuma);
          job.assignedNuma = picked.map((n) => n.id);
          const { assignedCpus, assignedCpuCount } = resolveNumaCpuInfo(job.assignedNuma, topo.numaNodes);
          job.assignedCpus = assignedCpus;
          job.assignedCpuCount = assignedCpuCount;

          job.status = 'running';
          job.startedAt = now();
          job.heartbeatAt = job.startedAt;
          job.waitReason = '';
          for (const id of job.assignedNuma) managedNuma.add(id);
          changed = true;
        } else {
          if (extBusyNumas.length > 0 && managedNuma.size === 0) {
            job.waitReason = `${machine} 的 CPU 正被外部进程占用（空闲 NUMA ${freeNumas.length}/${totalNuma}，需要 ${reqNuma}），等待空闲`;
          } else {
            job.waitReason = `${machine} 的 CPU/NUMA 槽位不足（已占 ${managedNuma.size}/${totalNuma}，需要 ${reqNuma}）`;
          }
          if (reqNuma > 1) {
            cpuHolReserved = job;
          }
        }
      }
    }
    return changed;
  }

  function enqueue({ machine, resource = 'gpu', gpus, numa, label = '', projectId = '', nodeId = '', command = '' } = {}) {
    const m = cleanStr(machine, 60);
    const r = String(resource || 'gpu').trim().toLowerCase();
    if (!m) return { ok: false, msg: '缺少 machine 参数' };
    if (!RESOURCES.includes(r)) return { ok: false, msg: 'resource 仅支持 gpu 或 cpu' };

    let reqGpus = 0;
    let reqNuma = 0;
    if (r === 'gpu') {
      reqGpus = parseSlotRequest(gpus, 1, 16);
      if (reqGpus === null) return { ok: false, msg: 'gpus 仅支持 1~16 的正整数或 "all"' };
      if (numa !== undefined && numa !== null && numa !== '') {
        reqNuma = parseSlotRequest(numa, 0, 32);
        if (reqNuma === null) return { ok: false, msg: 'numa 仅支持 1~32 的正整数或 "all"' };
      }
    } else {
      reqNuma = parseSlotRequest(numa, 1, 32);
      if (reqNuma === null) return { ok: false, msg: 'numa 仅支持 1~32 的正整数或 "all"' };
    }

    const t = now();
    const job = {
      id: 'qjob_' + crypto.randomBytes(5).toString('hex'),
      machine: m,
      resource: r,
      gpus: reqGpus,
      numa: reqNuma,
      assignedGpus: [],
      assignedNuma: [],
      assignedCpus: '',
      assignedCpuCount: 0,
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
    const result = { ok: true, jobs, slots: { ...state.slots } };
    if (m) result.topology = topologyFor(m);
    return result;
  }

  return { enqueue, poll, heartbeat, complete, cancel, clearDone, setSlots, list, reconcile, slotsFor, topologyFor };
}

module.exports = { createComputeQueue, RESOURCES, DEFAULT_SLOTS };
