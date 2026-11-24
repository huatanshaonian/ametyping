'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createComputeQueue } = require('../server/mesh-compute-queue');
const { probeCpu, probeCompute } = require('../agent/compute-probe');

describe('mesh-compute-queue (Mini-Slurm GPU/CPU exclusive slot scheduler)', () => {
  it('enforces per-machine exclusive GPU slots, allows cross-machine parallelism, and promotes FIFO on complete', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cq-'));
    try {
      let curTime = 1000000;
      const q = createComputeQueue({ dataDir: tmp, now: () => curTime });

      // 1) First GPU job on remote3090 granted immediately
      const j1 = q.enqueue({ machine: 'remote3090', resource: 'gpu', label: 'CuPy MoM 1' });
      assert.equal(j1.ok, true);
      assert.equal(j1.granted, true);
      assert.equal(j1.job.status, 'running');

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

      // 6) Persistence survives reload
      const qReload = createComputeQueue({ dataDir: tmp, now: () => curTime });
      const listed = qReload.list({ machine: 'remote3090' });
      assert.ok(listed.jobs.some((x) => x.id === j2.job.id && x.status === 'running'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('defers queued GPU job when external manual process occupies GPU, then grants once free, and reclaims stale leases', () => {
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

  it('compute-probe returns well-formed CPU and GPU status snapshot without throwing', () => {
    const cpu = probeCpu();
    assert.ok(cpu.cores >= 1);
    assert.equal(typeof cpu.cpuBusy, 'boolean');
    const all = probeCompute();
    assert.equal(typeof all.hasGpu, 'boolean');
    assert.equal(typeof all.gpuBusy, 'boolean');
  });
});
