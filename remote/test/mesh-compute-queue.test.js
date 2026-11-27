'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createComputeQueue } = require('../server/mesh-compute-queue');
const {
  probeCpu,
  probeCompute,
  parseNvidiaSmiOutput,
  parseCpuListCount,
  normalizePciBusId,
  readPciNumaNode,
  readNumaNodes,
} = require('../agent/compute-probe');
const { buildAssignedEnv, MCP_TOOLS } = require('../../tools/ame-mesh');

function makeDell97Probe({ gpu0Busy = false, gpu1Busy = false, numa0Busy = false, numa1Busy = false, at = 1000000 } = {}) {
  return {
    at,
    hasGpu: true,
    gpuBusy: gpu0Busy && gpu1Busy,
    gpus: [
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 4090',
        pciBusId: '00000000:73:00.0',
        memUsedMiB: gpu0Busy ? 8000 : 1,
        memTotalMiB: 24564,
        utilPct: gpu0Busy ? 65 : 0,
        busy: gpu0Busy,
        numaNode: 0,
      },
      {
        index: 1,
        name: 'NVIDIA GeForce RTX 4090',
        pciBusId: '00000000:A6:00.0',
        memUsedMiB: gpu1Busy ? 8000 : 1,
        memTotalMiB: 24564,
        utilPct: gpu1Busy ? 65 : 0,
        busy: gpu1Busy,
        numaNode: 1,
      },
    ],
    cores: 104,
    cpuCount: 104,
    load1: (numa0Busy && numa1Busy) ? 96.0 : 2.1,
    loadRatio: (numa0Busy && numa1Busy) ? 0.923 : 0.02,
    cpuBusy: numa0Busy && numa1Busy,
    numaNodes: [
      { id: 0, cpuList: '0-25,52-77', cpuCount: 52, busy: numa0Busy },
      { id: 1, cpuList: '26-51,78-103', cpuCount: 52, busy: numa1Busy },
    ],
  };
}

describe('mesh-compute-queue (Mini-Slurm multi-GPU & dual-socket NUMA scheduler)', () => {
  it('enforces per-machine exclusive GPU slots (backward compat), allows cross-machine parallelism, and promotes FIFO on complete', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cq-'));
    try {
      let curTime = 1000000;
      const q = createComputeQueue({ dataDir: tmp, now: () => curTime });

      // 1) First GPU job on remote3090 granted immediately
      const j1 = q.enqueue({ machine: 'remote3090', resource: 'gpu', label: 'CuPy MoM 1' });
      assert.equal(j1.ok, true);
      assert.equal(j1.granted, true);
      assert.equal(j1.job.status, 'running');
      assert.deepEqual(j1.job.assignedGpus, [0]);

      // 2) Second GPU job on remote3090 queues behind j1
      curTime += 100;
      const j2 = q.enqueue({ machine: 'remote3090', resource: 'gpu', label: 'Train AE 2' });
      assert.equal(j2.ok, true);
      assert.equal(j2.granted, false);
      assert.equal(j2.job.status, 'queued');
      assert.equal(j2.position, 1);

      // 3) GPU job on dell211 does NOT block on remote3090
      const jOther = q.enqueue({ machine: 'dell211', resource: 'gpu', label: 'FEKO dell211' });
      assert.equal(jOther.ok, true);
      assert.equal(jOther.granted, true);

      // 4) CPU job on remote3090 does NOT block on its GPU slot
      const jCpu = q.enqueue({ machine: 'remote3090', resource: 'cpu', label: 'Mesh gen CPU' });
      assert.equal(jCpu.ok, true);
      assert.equal(jCpu.granted, true);

      // 5) Completing j1 automatically promotes j2 to running
      const c1 = q.complete(j1.job.id, { ok: true });
      assert.equal(c1.ok, true);
      const p2 = q.poll(j2.job.id);
      assert.equal(p2.granted, true);
      assert.equal(p2.job.status, 'running');
      assert.deepEqual(p2.job.assignedGpus, [0]);

      // 6) Persistence survives reload
      const qReload = createComputeQueue({ dataDir: tmp, now: () => curTime });
      const listed = qReload.list({ machine: 'remote3090' });
      assert.ok(listed.jobs.some((x) => x.id === j2.job.id && x.status === 'running'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('defers queued GPU job when external manual process occupies GPU (legacy probe), then grants once free, and reclaims stale leases', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cq-ext-'));
    try {
      let curTime = 2000000;
      let gpuBusy = true;
      const q = createComputeQueue({
        dataDir: tmp,
        now: () => curTime,
        leaseMs: 60000,
        getMachineProbe: (m) => (m === 'remote3090' ? { hasGpu: true, gpuBusy, cpuBusy: false, at: curTime } : null),
      });

      // External manual FEKO/PyTorch is occupying 3090 -> queued job waits
      const j1 = q.enqueue({ machine: 'remote3090', resource: 'gpu', label: 'Wait external GPU' });
      assert.equal(j1.ok, true);
      assert.equal(j1.granted, false);
      assert.match(j1.job.waitReason, /外部进程占用/);

      // External process finishes -> next poll grants slot immediately
      gpuBusy = false;
      curTime += 5000;
      const p1 = q.poll(j1.job.id);
      assert.equal(p1.granted, true);
      assert.equal(p1.job.status, 'running');

      // Second job queues; if j1 crashes (no heartbeat > leaseMs), j1 is reclaimed and j2 promoted
      const j2 = q.enqueue({ machine: 'remote3090', resource: 'gpu', label: 'After crash' });
      assert.equal(j2.granted, false);
      curTime += 65000;
      const p2 = q.poll(j2.job.id);
      assert.equal(p2.granted, true);
      assert.equal(p2.job.status, 'running');
      const all = q.list({ machine: 'remote3090' }).jobs;
      assert.equal(all.find((x) => x.id === j1.job.id).status, 'failed');

      // Cancel releases slot
      const can = q.cancel(j2.job.id);
      assert.equal(can.ok, true);
      assert.equal(can.job.status, 'cancelled');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports dual-GPU parallel execution on dell97 with exact card & NUMA affinity assignment', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cq-dual-'));
    try {
      let curTime = 3000000;
      const q = createComputeQueue({
        dataDir: tmp,
        now: () => curTime,
        getMachineProbe: (m) => (m === 'dell97' ? makeDell97Probe({ at: curTime }) : null),
      });

      assert.deepEqual(q.slotsFor('dell97'), { gpu: 2, cpu: 2 });

      const j1 = q.enqueue({ machine: 'dell97', resource: 'gpu', gpus: 1, label: 'Run A' });
      assert.equal(j1.granted, true);
      assert.deepEqual(j1.job.assignedGpus, [0]);
      assert.deepEqual(j1.job.assignedNuma, [0]);
      assert.equal(j1.job.assignedCpus, '0-25,52-77');

      curTime += 100;
      const j2 = q.enqueue({ machine: 'dell97', resource: 'gpu', gpus: 1, label: 'Run B' });
      assert.equal(j2.granted, true);
      assert.deepEqual(j2.job.assignedGpus, [1]);
      assert.deepEqual(j2.job.assignedNuma, [1]);
      assert.equal(j2.job.assignedCpus, '26-51,78-103');

      // Third 1-GPU job queues until one finishes
      curTime += 100;
      const j3 = q.enqueue({ machine: 'dell97', resource: 'gpu', gpus: 1, label: 'Run C' });
      assert.equal(j3.granted, false);
      assert.equal(j3.position, 1);

      // Completing j1 frees GPU 0 -> j3 gets GPU 0
      q.complete(j1.job.id, { ok: true });
      const p3 = q.poll(j3.job.id);
      assert.equal(p3.granted, true);
      assert.deepEqual(p3.job.assignedGpus, [0]);
      assert.deepEqual(p3.job.assignedNuma, [0]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('avoids externally busy GPU 0 and allocates free GPU 1 immediately without blocking the machine', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cq-ext1-'));
    try {
      let curTime = 4000000;
      let gpu0Busy = true;
      const q = createComputeQueue({
        dataDir: tmp,
        now: () => curTime,
        getMachineProbe: (m) => (m === 'dell97' ? makeDell97Probe({ gpu0Busy, gpu1Busy: false, at: curTime }) : null),
      });

      // GPU 0 is externally occupied, GPU 1 is free -> gpus=1 immediately gets GPU 1!
      const j1 = q.enqueue({ machine: 'dell97', resource: 'gpu', gpus: 1, label: 'Single on free card' });
      assert.equal(j1.granted, true);
      assert.deepEqual(j1.job.assignedGpus, [1]);
      assert.deepEqual(j1.job.assignedNuma, [1]);

      // Another gpus=1 waits while GPU 0 is still externally busy
      curTime += 100;
      const j2 = q.enqueue({ machine: 'dell97', resource: 'gpu', gpus: 1, label: 'Wait GPU 0' });
      assert.equal(j2.granted, false);
      assert.match(j2.job.waitReason, /外部进程占用/);

      // External process on GPU 0 finishes -> j2 gets GPU 0
      gpu0Busy = false;
      curTime += 1000;
      const p2 = q.poll(j2.job.id);
      assert.equal(p2.granted, true);
      assert.deepEqual(p2.job.assignedGpus, [0]);
      assert.deepEqual(p2.job.assignedNuma, [0]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('atomically allocates dual-GPU merged jobs (gpus=2 / gpus="all") and prevents starvation via HoL reservation', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cq-hol-'));
    try {
      let curTime = 5000000;
      const q = createComputeQueue({
        dataDir: tmp,
        now: () => curTime,
        getMachineProbe: (m) => (m === 'dell97' ? makeDell97Probe({ at: curTime }) : null),
      });

      // 1) A single-GPU job starts on GPU 0
      const j1 = q.enqueue({ machine: 'dell97', resource: 'gpu', gpus: 1, label: 'Initial 1-GPU' });
      assert.equal(j1.granted, true);
      assert.deepEqual(j1.job.assignedGpus, [0]);

      // 2) Dual-GPU merged job (gpus='all') arrives -> only GPU 1 is free, so it MUST wait atomically
      curTime += 100;
      const jDual = q.enqueue({ machine: 'dell97', resource: 'gpu', gpus: 'all', label: 'Dual-4090 MoM' });
      assert.equal(jDual.granted, false);
      assert.equal(jDual.job.status, 'queued');

      // 3) A later single-GPU job arrives -> MUST NOT steal GPU 1 and starve jDual (HoL reservation)
      curTime += 100;
      const jLateSingle = q.enqueue({ machine: 'dell97', resource: 'gpu', gpus: 1, label: 'Late 1-GPU' });
      assert.equal(jLateSingle.granted, false);
      assert.match(jLateSingle.job.waitReason, /防饥饿/);

      // 4) Once j1 finishes, BOTH GPUs are free -> jDual atomically acquires [0, 1] and both NUMA nodes
      curTime += 100;
      q.complete(j1.job.id, { ok: true });
      const pDual = q.poll(jDual.job.id);
      assert.equal(pDual.granted, true);
      assert.deepEqual(pDual.job.assignedGpus, [0, 1]);
      assert.deepEqual(pDual.job.assignedNuma, [0, 1]);
      assert.equal(pDual.job.assignedCpus, '0-25,52-77,26-51,78-103');

      // jLateSingle still waits while jDual holds both GPUs
      const pLate1 = q.poll(jLateSingle.job.id);
      assert.equal(pLate1.granted, false);

      // 5) Once jDual completes, jLateSingle runs on GPU 0
      q.complete(jDual.job.id, { ok: true });
      const pLate2 = q.poll(jLateSingle.job.id);
      assert.equal(pLate2.granted, true);
      assert.deepEqual(pLate2.job.assignedGpus, [0]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports dual-socket NUMA CPU concurrency, full-machine merge (numa=2 / "all"), and HoL anti-starvation', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cq-numa-'));
    try {
      let curTime = 6000000;
      const q = createComputeQueue({
        dataDir: tmp,
        now: () => curTime,
        getMachineProbe: (m) => (m === 'dell97' ? makeDell97Probe({ at: curTime }) : null),
      });

      // Two numa=1 CPU jobs run concurrently on NUMA 0 and NUMA 1
      const c1 = q.enqueue({ machine: 'dell97', resource: 'cpu', numa: 1, label: 'FEKO Socket 0' });
      assert.equal(c1.granted, true);
      assert.deepEqual(c1.job.assignedNuma, [0]);
      assert.equal(c1.job.assignedCpus, '0-25,52-77');
      assert.equal(c1.job.assignedCpuCount, 52);

      curTime += 100;
      const c2 = q.enqueue({ machine: 'dell97', resource: 'cpu', numa: 1, label: 'FEKO Socket 1' });
      assert.equal(c2.granted, true);
      assert.deepEqual(c2.job.assignedNuma, [1]);
      assert.equal(c2.job.assignedCpus, '26-51,78-103');
      assert.equal(c2.job.assignedCpuCount, 52);

      // Full-machine CPU job (numa='all') queues
      curTime += 100;
      const cAll = q.enqueue({ machine: 'dell97', resource: 'cpu', numa: 'all', label: 'Full 104T Solve' });
      assert.equal(cAll.granted, false);

      // Complete c1 -> NUMA 0 is free, but cAll needs both, so a late numa=1 must NOT starve cAll
      curTime += 100;
      q.complete(c1.job.id, { ok: true });
      const cLate = q.enqueue({ machine: 'dell97', resource: 'cpu', numa: 1, label: 'Late Socket Job' });
      assert.equal(cLate.granted, false);
      assert.match(cLate.job.waitReason, /防饥饿/);

      // Complete c2 -> cAll atomically gets [0, 1]
      q.complete(c2.job.id, { ok: true });
      const pAll = q.poll(cAll.job.id);
      assert.equal(pAll.granted, true);
      assert.deepEqual(pAll.job.assignedNuma, [0, 1]);
      assert.equal(pAll.job.assignedCpus, '0-25,52-77,26-51,78-103');
      assert.equal(pAll.job.assignedCpuCount, 104);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('compute-probe parses dell97 multi-GPU nvidia-smi output, PCI NUMA mapping, and Linux NUMA cpulists accurately', () => {
    // 1) Parse real dell97 nvidia-smi format with simulated PCI NUMA lookup
    const smiOut = [
      '0, NVIDIA GeForce RTX 4090, 00000000:73:00.0, 0, 1, 24564',
      '1, NVIDIA GeForce RTX 4090, 00000000:A6:00.0, 42, 5120, 24564',
    ].join('\n');
    assert.equal(normalizePciBusId('00000000:A6:00.0'), '0000:a6:00.0');
    const gpus = parseNvidiaSmiOutput(smiOut, {
      readNumaNode: (bus) => (normalizePciBusId(bus) === '0000:73:00.0' ? 0 : 1),
    });
    assert.equal(gpus.length, 2);
    assert.equal(gpus[0].index, 0);
    assert.equal(gpus[0].name, 'NVIDIA GeForce RTX 4090');
    assert.equal(gpus[0].memUsedMiB, 1);
    assert.equal(gpus[0].memTotalMiB, 24564);
    assert.equal(gpus[0].utilPct, 0);
    assert.equal(gpus[0].busy, false);
    assert.equal(gpus[0].numaNode, 0);

    assert.equal(gpus[1].index, 1);
    assert.equal(gpus[1].memUsedMiB, 5120);
    assert.equal(gpus[1].utilPct, 42);
    assert.equal(gpus[1].busy, true);
    assert.equal(gpus[1].numaNode, 1);

    // 2) Simulated Linux sysfs PCI numa_node (in-memory fsImpl to stay Windows-safe with ':' in PCI bus IDs) & NUMA node cpulists
    const fakePciFiles = {
      '/sys/bus/pci/devices/0000:73:00.0/numa_node': '0\n',
      '/sys/bus/pci/devices/0000:a6:00.0/numa_node': '1\n',
    };
    const fakePciFs = {
      readFileSync(p) {
        const key = String(p).replace(/\\/g, '/');
        if (Object.prototype.hasOwnProperty.call(fakePciFiles, key)) return fakePciFiles[key];
        throw new Error('ENOENT');
      },
    };
    assert.equal(readPciNumaNode('00000000:73:00.0', { pciDevicesDir: '/sys/bus/pci/devices', fsImpl: fakePciFs }), 0);
    assert.equal(readPciNumaNode('00000000:A6:00.0', { pciDevicesDir: '/sys/bus/pci/devices', fsImpl: fakePciFs }), 1);
    assert.equal(readPciNumaNode('00000000:ff:00.0', { pciDevicesDir: '/sys/bus/pci/devices', fsImpl: fakePciFs }), null);

    const tmpSys = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-sysfs-'));
    try {
      const numaDir = path.join(tmpSys, 'node');
      fs.mkdirSync(path.join(numaDir, 'node0'), { recursive: true });
      fs.mkdirSync(path.join(numaDir, 'node1'), { recursive: true });
      fs.writeFileSync(path.join(numaDir, 'node0', 'cpulist'), '0-25,52-77\n');
      fs.writeFileSync(path.join(numaDir, 'node1', 'cpulist'), '26-51,78-103\n');

      assert.equal(parseCpuListCount('0-25,52-77'), 52);
      const nodes = readNumaNodes({ cores: 104, cpuBusy: false, platform: 'linux', numaDir });
      assert.equal(nodes.length, 2);
      assert.deepEqual(nodes[0], { id: 0, cpuList: '0-25,52-77', cpuCount: 52, busy: false });
      assert.deepEqual(nodes[1], { id: 1, cpuList: '26-51,78-103', cpuCount: 52, busy: false });

      // Fallback on Windows -> 1 slot
      const winNodes = readNumaNodes({ cores: 16, cpuBusy: false, platform: 'win32', numaDir });
      assert.equal(winNodes.length, 1);
      assert.deepEqual(winNodes[0], { id: 0, cpuList: '0-15', cpuCount: 16, busy: false });
    } finally {
      fs.rmSync(tmpSys, { recursive: true, force: true });
    }

    // 3) Live local probe runs without throwing and keeps backward-compatible fields
    const cpu = probeCpu();
    assert.ok(cpu.cores >= 1);
    assert.equal(cpu.cpuCount, cpu.cores);
    assert.ok(Array.isArray(cpu.numaNodes) && cpu.numaNodes.length >= 1);
    assert.equal(typeof cpu.cpuBusy, 'boolean');
    const all = probeCompute();
    assert.equal(typeof all.hasGpu, 'boolean');
    assert.equal(typeof all.gpuBusy, 'boolean');
  });

  it('mesh_run schema exposes gpus/numa and buildAssignedEnv injects CUDA/NUMA/CPU/OMP vars without overriding user values', () => {
    const runTool = MCP_TOOLS.find((t) => t.name === 'mesh_run');
    assert.ok(runTool && runTool.inputSchema && runTool.inputSchema.properties);
    assert.ok(runTool.inputSchema.properties.gpus);
    assert.ok(runTool.inputSchema.properties.numa);

    // GPU single-card assignment
    const envGpu1 = buildAssignedEnv({
      resource: 'gpu',
      assignedGpus: [1],
      assignedNuma: [1],
      assignedCpus: '26-51,78-103',
      assignedCpuCount: 52,
    }, {});
    assert.equal(envGpu1.CUDA_VISIBLE_DEVICES, '1');
    assert.equal(envGpu1.AME_ASSIGNED_GPUS, '1');
    assert.equal(envGpu1.AME_ASSIGNED_NUMA, '1');
    assert.equal(envGpu1.AME_ASSIGNED_CPUS, '26-51,78-103');
    assert.equal(envGpu1.OMP_NUM_THREADS, undefined);

    // Dual-GPU merged assignment
    const envGpu2 = buildAssignedEnv({
      resource: 'gpu',
      assignedGpus: [0, 1],
      assignedNuma: [0, 1],
      assignedCpus: '0-25,52-77,26-51,78-103',
      assignedCpuCount: 104,
    }, {});
    assert.equal(envGpu2.CUDA_VISIBLE_DEVICES, '0,1');
    assert.equal(envGpu2.AME_ASSIGNED_GPUS, '0,1');
    assert.equal(envGpu2.AME_ASSIGNED_NUMA, '0,1');

    // Single-NUMA CPU job sets OMP_NUM_THREADS=26 (52/2)
    const envCpu1 = buildAssignedEnv({
      resource: 'cpu',
      assignedGpus: [],
      assignedNuma: [0],
      assignedCpus: '0-25,52-77',
      assignedCpuCount: 52,
    }, {});
    assert.equal(envCpu1.AME_ASSIGNED_NUMA, '0');
    assert.equal(envCpu1.AME_ASSIGNED_CPUS, '0-25,52-77');
    assert.equal(envCpu1.OMP_NUM_THREADS, '26');
    assert.equal(envCpu1.CUDA_VISIBLE_DEVICES, undefined);

    // Explicit user environment variables are NOT overwritten
    const envExplicit = buildAssignedEnv({
      resource: 'cpu',
      assignedGpus: [1],
      assignedNuma: [1],
      assignedCpus: '26-51,78-103',
      assignedCpuCount: 52,
    }, { CUDA_VISIBLE_DEVICES: '0', OMP_NUM_THREADS: '8' });
    assert.equal(envExplicit.CUDA_VISIBLE_DEVICES, '0');
    assert.equal(envExplicit.OMP_NUM_THREADS, '8');
    assert.equal(envExplicit.AME_ASSIGNED_GPUS, '1');
  });

  it('sugon remote CPU jobs do not lock gateway machine local NUMA slot 0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cq-sugon-numa-'));
    try {
      let curTime = 7000000;
      const q = createComputeQueue({
        dataDir: tmp,
        now: () => curTime,
        getMachineProbe: (m) => (m === 'vbuntu' ? {
          hasGpu: false,
          gpus: [],
          cores: 16,
          cpuCount: 16,
          cpuBusy: false,
          numaNodes: [{ id: 0, cpuList: '0-15', cpuCount: 16, busy: false }],
          at: curTime,
        } : null),
      });
      q.registerProvider({
        id: 'sugon',
        name: '曙光超算',
        status: 'active',
        meta: { machine: 'vbuntu', available: true },
      });

      const sugonJob = q.enqueue({
        machine: 'vbuntu',
        providerType: 'sugon',
        mode: 'remote',
        resource: 'cpu',
        ntasks: 64,
        command: 'mpirun -np 64 ./solver',
        label: 'Sugon Slurm CPU',
      });
      assert.equal(sugonJob.granted, true);
      assert.equal(sugonJob.job.status, 'running');
      assert.deepEqual(sugonJob.job.assignedNuma, []);

      curTime += 100;
      const localCpu = q.enqueue({
        machine: 'vbuntu',
        providerType: 'local-agent',
        resource: 'cpu',
        numa: 1,
        label: 'Local Gateway CPU',
      });
      assert.equal(localCpu.granted, true);
      assert.deepEqual(localCpu.job.assignedNuma, [0]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
