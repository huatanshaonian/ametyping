'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findColabBin,
  parseColabUsage,
  parseSessionId,
  probeColabUsage,
  runColabJob,
} = require('../agent/colab-runner');
const { createComputeQueue } = require('../server/mesh-compute-queue');

describe('colab-runner (Google Colab CLI driver & CCU stop-loss)', () => {
  it('findColabBin locates ~/.local/bin/colab or PATH binary and returns null when missing', () => {
    const foundLocal = findColabBin({
      homedir: '/home/huatan',
      env: { PATH: '/usr/bin:/bin' },
      platform: 'linux',
      existsSync: (p) => String(p).replace(/\\/g, '/') === '/home/huatan/.local/bin/colab',
    });
    assert.equal(String(foundLocal).replace(/\\/g, '/'), '/home/huatan/.local/bin/colab');

    const foundPath = findColabBin({
      homedir: '/home/huatan',
      env: { PATH: '/usr/local/bin:/usr/bin' },
      platform: 'linux',
      existsSync: (p) => String(p).replace(/\\/g, '/') === '/usr/local/bin/colab',
    });
    assert.equal(String(foundPath).replace(/\\/g, '/'), '/usr/local/bin/colab');

    const missing = findColabBin({
      homedir: '/home/huatan',
      env: { PATH: '/usr/bin' },
      platform: 'linux',
      existsSync: () => false,
    });
    assert.equal(missing, null);
  });

  it('parseColabUsage & probeColabUsage accurately extract CCU balance, burn rate, and active runtimes', async () => {
    const sampleOut = [
      'Compute Units Balance: 200.00',
      'Consumption Rate: 1.96 / hr',
      'Active Runtimes: 1',
    ].join('\n');
    const parsed = parseColabUsage(sampleOut, () => 1700000000000);
    assert.equal(parsed.available, true);
    assert.equal(parsed.balanceCcu, 200);
    assert.equal(parsed.burnRatePerHour, 1.96);
    assert.equal(parsed.activeRuntimes, 1);
    assert.equal(parsed.at, 1700000000000);

    const jsonOut = JSON.stringify({ balanceCcu: 88.5, burnRatePerHour: 0, activeRuntimes: 0 });
    const parsedJson = parseColabUsage(jsonOut, () => 1700000000100);
    assert.equal(parsedJson.available, true);
    assert.equal(parsedJson.balanceCcu, 88.5);
    assert.equal(parsedJson.burnRatePerHour, 0);
    assert.equal(parsedJson.activeRuntimes, 0);

    const empty = parseColabUsage('');
    assert.equal(empty.available, false);
    assert.equal(empty.balanceCcu, null);

    const probed = await probeColabUsage(async (bin, args) => {
      assert.equal(bin, 'colab');
      assert.deepEqual(args, ['usage']);
      return { ok: true, code: 0, stdout: sampleOut, stderr: '' };
    });
    assert.equal(probed.available, true);
    assert.equal(probed.balanceCcu, 200);

    assert.equal(parseSessionId('Created session: sess-abc-123\n'), 'sess-abc-123');
    assert.equal(parseSessionId('{"sessionId":"rt_999"}'), 'rt_999');
  });

  it('rejects job launch when CCU balance is below minBalanceCcu red-line without calling colab new', async () => {
    const calls = [];
    const mockExec = async (bin, args) => {
      calls.push(args);
      if (args[0] === 'usage') {
        return {
          ok: true,
          code: 0,
          stdout: 'Compute Units Balance: 12.50\nConsumption Rate: 0.00 / hr\nActive Runtimes: 0\n',
          stderr: '',
        };
      }
      throw new Error('Should never invoke colab new/exec/stop when blocked by quota floor');
    };

    const res = await runColabJob({
      jobId: 'qjob_low_ccu',
      gpu: 'A100',
      command: 'python3 solve.py',
      minBalanceCcu: 15,
      execFn: mockExec,
    });

    assert.equal(res.ok, false);
    assert.equal(res.rejectedByQuota, true);
    assert.equal(res.stopped, false);
    assert.match(res.error, /余额不足/);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['usage']);
  });

  it('falls back from A100 to L4, runs upload -> exec -> download, emits heartbeat, and stops runtime', async () => {
    const calls = [];
    const mockExec = async (bin, args) => {
      calls.push(args);
      if (args[0] === 'usage') {
        return { ok: true, code: 0, stdout: 'Compute Units Balance: 180.00\nConsumption Rate: 0.00 / hr\nActive Runtimes: 0\n', stderr: '' };
      }
      if (args[0] === 'new' && args[2] === 'A100') {
        return { ok: false, code: 1, stdout: '', stderr: 'A100 unavailable right now' };
      }
      if (args[0] === 'new' && args[2] === 'L4') {
        return { ok: true, code: 0, stdout: 'Session ID: sess_l4_01\n', stderr: '' };
      }
      if (args[0] === 'upload') {
        return { ok: true, code: 0, stdout: 'uploaded\n', stderr: '' };
      }
      if (args[0] === 'exec') {
        return { ok: true, code: 0, stdout: 'RCS converged: -18.4 dBsm\n', stderr: '' };
      }
      if (args[0] === 'download') {
        return { ok: true, code: 0, stdout: 'downloaded to /mnt/nas/out\n', stderr: '' };
      }
      if (args[0] === 'stop') {
        return { ok: true, code: 0, stdout: 'stopped\n', stderr: '' };
      }
      return { ok: false, code: 1, stdout: '', stderr: 'unexpected' };
    };

    const res = await runColabJob({
      jobId: 'qjob_fallback',
      gpu: 'A100',
      fallbackGpus: ['L4', 'T4'],
      command: 'python3 solve.py --freq 10e9',
      uploadPaths: ['solve.py'],
      downloadPath: 'results/',
      outputDir: '/mnt/nas/out',
      minBalanceCcu: 15,
      execFn: mockExec,
    });

    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 0);
    assert.equal(res.gpu, 'L4');
    assert.deepEqual(res.triedGpus, ['A100', 'L4']);
    assert.equal(res.sessionId, 'sess_l4_01');
    assert.equal(res.stopped, true);
    assert.match(res.tail, /RCS converged/);
    assert.deepEqual(calls.map((c) => c[0]), ['usage', 'new', 'new', 'upload', 'exec', 'download', 'stop']);
    assert.deepEqual(calls[6], ['stop', '--session', 'sess_l4_01']);
  });

  it('guarantees colab stop in finally when colab exec fails or throws an exception', async () => {
    const calls = [];
    const mockExec = async (bin, args) => {
      calls.push(args);
      if (args[0] === 'usage') {
        return { ok: true, code: 0, stdout: 'Compute Units Balance: 150.00\nConsumption Rate: 0.00 / hr\nActive Runtimes: 0\n', stderr: '' };
      }
      if (args[0] === 'new') {
        return { ok: true, code: 0, stdout: 'Session ID: sess_err_99\n', stderr: '' };
      }
      if (args[0] === 'exec') {
        throw new Error('CUDA out of memory crash');
      }
      if (args[0] === 'stop') {
        return { ok: true, code: 0, stdout: 'stopped\n', stderr: '' };
      }
      return { ok: true, code: 0, stdout: '', stderr: '' };
    };

    const res = await runColabJob({
      jobId: 'qjob_crash',
      gpu: 'A100',
      command: 'python3 oom.py',
      execFn: mockExec,
    });

    assert.equal(res.ok, false);
    assert.equal(res.stopped, true);
    assert.match(res.error, /CUDA out of memory/);
    assert.ok(calls.some((c) => c[0] === 'stop' && c[1] === '--session' && c[2] === 'sess_err_99'));
  });

  it('force-stops runtime on maxDurationMin timeout and on external AbortSignal cancellation', async () => {
    // 1) Timeout test
    const timeoutCalls = [];
    const slowExec = (bin, args, opts = {}) => new Promise((resolve) => {
      timeoutCalls.push(args);
      if (args[0] === 'usage') {
        return resolve({ ok: true, code: 0, stdout: 'Compute Units Balance: 100.00\n', stderr: '' });
      }
      if (args[0] === 'new') {
        return resolve({ ok: true, code: 0, stdout: 'Session ID: sess_to_1\n', stderr: '' });
      }
      if (args[0] === 'stop') {
        return resolve({ ok: true, code: 0, stdout: 'stopped\n', stderr: '' });
      }
      if (args[0] === 'exec') {
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            resolve({ ok: false, code: 137, stdout: '', stderr: 'aborted' });
          }, { once: true });
        }
        return;
      }
      resolve({ ok: true, code: 0, stdout: '', stderr: '' });
    });

    const rTimeout = await runColabJob({
      jobId: 'qjob_timeout',
      gpu: 'T4',
      command: 'sleep 999',
      maxDurationMin: 0.001, // ~60ms
      execFn: slowExec,
    });
    assert.equal(rTimeout.ok, false);
    assert.equal(rTimeout.timedOut, true);
    assert.equal(rTimeout.exitCode, 124);
    assert.equal(rTimeout.stopped, true);
    assert.ok(timeoutCalls.some((c) => c[0] === 'stop' && c[2] === 'sess_to_1'));

    // 2) External cancellation test (simulates colab-kill)
    const cancelCalls = [];
    const ac = new AbortController();
    const cancelExec = (bin, args, opts = {}) => new Promise((resolve) => {
      cancelCalls.push(args);
      if (args[0] === 'usage') {
        return resolve({ ok: true, code: 0, stdout: 'Compute Units Balance: 100.00\n', stderr: '' });
      }
      if (args[0] === 'new') {
        return resolve({ ok: true, code: 0, stdout: 'Session ID: sess_kill_2\n', stderr: '' });
      }
      if (args[0] === 'stop') {
        return resolve({ ok: true, code: 0, stdout: 'stopped\n', stderr: '' });
      }
      if (args[0] === 'exec') {
        setTimeout(() => ac.abort(), 30);
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            resolve({ ok: false, code: 130, stdout: '', stderr: 'killed' });
          }, { once: true });
        }
        return;
      }
      resolve({ ok: true, code: 0, stdout: '', stderr: '' });
    });

    const rCancel = await runColabJob({
      jobId: 'qjob_cancel',
      gpu: 'L4',
      command: 'python3 long_job.py',
      maxDurationMin: 60,
      signal: ac.signal,
      execFn: cancelExec,
    });
    assert.equal(rCancel.ok, false);
    assert.equal(rCancel.cancelled, true);
    assert.equal(rCancel.exitCode, 130);
    assert.equal(rCancel.stopped, true);
    assert.ok(cancelCalls.some((c) => c[0] === 'stop' && c[2] === 'sess_kill_2'));
  });
});

describe('mesh-compute-queue Colab provider integration', () => {
  it('routes providerType=colab jobs to gateway machine independently of local GPU busy state and supports serial queueing + cancel + complete', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cq-colab-'));
    try {
      let curTime = 5000000;
      const dispatched = [];
      const cancelled = [];

      const q = createComputeQueue({
        dataDir: tmp,
        now: () => curTime,
        // Gateway machine has local GPU busy — must NOT block cloud Colab jobs
        getMachineProbe: (m) => (m === 'ubuntu_hpc' ? { hasGpu: true, gpuBusy: true, cpuBusy: true, at: curTime } : null),
        onDispatchRemote: (job) => dispatched.push(job),
        onCancelRemote: (job) => cancelled.push(job),
      });

      // Before colab provider is activated, omitting machine returns clear error
      const failBefore = q.enqueue({
        providerType: 'colab',
        mode: 'remote',
        command: 'python3 solve.py',
      });
      assert.equal(failBefore.ok, false);
      assert.match(failBefore.msg, /网关机/);

      // Register active Colab provider (as mesh.onColabStatus does)
      q.registerProvider({
        id: 'colab',
        name: 'Google Colab (WSL CLI)',
        status: 'active',
        note: '网关机 ubuntu_hpc · 剩余 200.00 CCU',
        meta: {
          machine: 'ubuntu_hpc',
          available: true,
          balanceCcu: 200,
          burnRatePerHour: 0,
          activeRuntimes: 0,
          at: curTime,
        },
      });

      // 1) First Colab job auto-resolves gateway machine and dispatches immediately
      const j1 = q.enqueue({
        providerType: 'colab',
        mode: 'remote',
        colabGpu: 'A100',
        fallbackGpus: ['L4', 'T4'],
        maxDurationMin: 90,
        minBalanceCcu: 20,
        downloadPath: 'out/',
        outputDir: '/mnt/nas/colab-out',
        projectId: 'proj_demo',
        label: 'Colab A100 MoM',
        command: 'python3 solve.py',
      });
      assert.equal(j1.ok, true);
      assert.equal(j1.granted, true);
      assert.equal(j1.job.machine, 'ubuntu_hpc');
      assert.equal(j1.job.providerType, 'colab');
      assert.equal(j1.job.colabGpu, 'A100');
      assert.equal(j1.job.outputDir, '/mnt/nas/colab-out');
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].id, j1.job.id);

      // 2) Second Colab job queues while j1 is running
      curTime += 100;
      const j2 = q.enqueue({
        providerType: 'colab',
        mode: 'remote',
        colabGpu: 'L4',
        label: 'Colab L4 Sweep',
        command: 'python3 sweep.py',
      });
      assert.equal(j2.ok, true);
      assert.equal(j2.granted, false);
      assert.equal(j2.job.status, 'queued');
      assert.match(j2.job.waitReason, /Colab/);

      // 3) Completing j1 records result/tail and promotes j2
      const done1 = q.complete(j1.job.id, { ok: true, exitCode: 0, durationMs: 42000, tail: 'saved /mnt/nas/colab-out/rcs.npz' });
      assert.equal(done1.ok, true);
      assert.equal(done1.job.status, 'done');
      assert.equal(done1.job.exitCode, 0);
      assert.equal(dispatched.length, 2);
      assert.equal(dispatched[1].id, j2.job.id);

      // 4) Cancelling running j2 invokes onCancelRemote (triggers colab-kill)
      const c2 = q.cancel(j2.job.id);
      assert.equal(c2.ok, true);
      assert.equal(c2.job.status, 'cancelled');
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].id, j2.job.id);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
