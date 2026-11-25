'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseSinfoPartitions,
  parseSqueueJobs,
  parseSbatchJobId,
  buildSbatchScript,
  probeSugonStatus,
  runSugonJob,
} = require('../agent/sugon-runner');
const { createComputeQueue } = require('../server/mesh-compute-queue');

describe('sugon-runner (Sugon / SCNet HPC provider)', () => {
  it('parses sinfo partitions, squeue jobs, sbatch job id, and generates valid #SBATCH scripts', () => {
    const parts = parseSinfoPartitions('normal*|up|64\ngpu_a100|up|8\n');
    assert.deepEqual(parts.map((p) => p.name), ['normal', 'gpu_a100']);

    const jobs = parseSqueueJobs('12345|RUNNING|normal|cem_mom\n12346|PENDING|gpu_a100|train\n');
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].state, 'RUNNING');
    assert.equal(jobs[1].state, 'PENDING');

    assert.equal(parseSbatchJobId('Submitted batch job 987654\n'), '987654');

    const script = buildSbatchScript({
      jobName: 'cem_sweep',
      partition: 'gpu_a100',
      nodes: 2,
      ntasks: 16,
      gpus: 2,
      walltime: '02:00:00',
      remoteWorkDir: '~/work/j1',
      command: 'python3 solve.py',
    });
    assert.match(script, /#SBATCH -p gpu_a100/);
    assert.match(script, /#SBATCH -N 2/);
    assert.match(script, /#SBATCH --gres=gpu:2/);
    assert.match(script, /python3 solve\.py/);
  });

  it('probes SSH+Slurm status and runs upload -> sbatch -> poll -> download lifecycle with scancel on abort', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-sugon-ssh-'));
    const cfgFile = path.join(tmp, 'sugon.json');
    fs.writeFileSync(cfgFile, JSON.stringify({
      mode: 'ssh',
      sshHost: 'sugon-kunshan',
      defaultPartition: 'kshdnormal',
      remoteWorkDir: '~/ame-hpc',
    }));

    try {
      const probe = await probeSugonStatus({
        configPath: cfgFile,
        execFn: async () => ({
          ok: true,
          stdout: 'kshdnormal*|up|120\nkshdgpu|up|16\n---JOBS---\n5001|RUNNING|kshdnormal|sim1\n5002|PENDING|kshdgpu|sim2\n',
        }),
      });
      assert.equal(probe.available, true);
      assert.equal(probe.mode, 'ssh');
      assert.deepEqual(probe.partitions, ['kshdnormal', 'kshdgpu']);
      assert.equal(probe.runningJobs, 1);
      assert.equal(probe.queuedJobs, 1);

      // Full SSH job lifecycle
      const calls = [];
      let polls = 0;
      const outDir = path.join(tmp, 'nas-out');
      const res = await runSugonJob({
        jobId: 'qjob_1',
        label: 'cem-1',
        partition: 'kshdgpu',
        gpus: 1,
        command: 'python3 run.py',
        uploadPaths: ['/tmp/run.py'],
        downloadPath: 'result.npz',
        outputDir: outDir,
        pollIntervalMs: 10,
        configPath: cfgFile,
        execFn: async (cmd, args) => {
          calls.push([cmd, ...args]);
          const joined = args.join(' ');
          if (joined.includes('sbatch ')) return { ok: true, stdout: 'Submitted batch job 778899\n' };
          if (joined.includes('squeue -j 778899')) {
            polls += 1;
            return { ok: true, stdout: polls < 2 ? 'RUNNING\n' : '' };
          }
          if (joined.includes('sacct -j 778899')) return { ok: true, stdout: 'COMPLETED|0:0\n' };
          if (joined.includes('tail -n 40')) return { ok: true, stdout: 'RCS converged\n' };
          return { ok: true, stdout: '' };
        },
      });
      assert.equal(res.ok, true);
      assert.equal(res.slurmJobId, '778899');
      assert.match(res.tail, /RCS converged/);
      assert.ok(calls.some((c) => c[0] === 'scp' && c.join(' ').includes('result.npz')));

      // Abort triggers scancel
      const ac = new AbortController();
      const cancelCalls = [];
      const cancelledRes = await runSugonJob({
        jobId: 'qjob_2',
        command: 'sleep 999',
        pollIntervalMs: 10,
        signal: ac.signal,
        configPath: cfgFile,
        execFn: async (cmd, args) => {
          cancelCalls.push([cmd, ...args]);
          const joined = args.join(' ');
          if (joined.includes('sbatch ')) {
            ac.abort();
            return { ok: true, stdout: 'Submitted batch job 779900\n' };
          }
          return { ok: true, stdout: '' };
        },
      });
      assert.equal(cancelledRes.ok, false);
      assert.equal(cancelledRes.exitCode, 130);
      assert.ok(cancelCalls.some((c) => c.join(' ').includes('scancel 779900')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports Sugon/SCNet OpenAPI v2 token auth, job submission, polling, and queue integration', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-sugon-api-'));
    const cfgFile = path.join(tmp, 'sugon.json');
    fs.writeFileSync(cfgFile, JSON.stringify({
      mode: 'openapi',
      baseUrl: 'https://api.scnet.cn',
      user: 'tester',
      password: 'secret',
      orgid: 'org1',
      clusterId: 'c1',
      defaultPartition: 'normal',
    }));

    try {
      let pollCount = 0;
      const mockFetch = async (url, opts) => {
        if (url.endsWith('/ac/openapi/v2/tokens')) {
          return { ok: true, status: 200, json: async () => ({ code: '0', data: [{ token: 'tok_xyz', clusterId: 'c1', clusterName: 'Kunshan' }] }) };
        }
        if (opts.method === 'POST' && url.includes('/hpc/openapi/v2/jobs')) {
          return { ok: true, status: 200, json: async () => ({ code: '0', data: { jobId: 'api_9001' } }) };
        }
        if (opts.method === 'GET' && url.includes('api_9001')) {
          pollCount += 1;
          return { ok: true, status: 200, json: async () => ({ code: '0', data: { jobStatus: pollCount < 2 ? 'RUNNING' : 'COMPLETED' } }) };
        }
        return { ok: true, status: 200, json: async () => ({ code: '0' }) };
      };

      const probe = await probeSugonStatus({ configPath: cfgFile, fetchFn: mockFetch });
      assert.equal(probe.available, true);
      assert.equal(probe.clusterId, 'c1');

      const runRes = await runSugonJob({
        jobId: 'qjob_api',
        command: 'python3 bench.py',
        pollIntervalMs: 10,
        configPath: cfgFile,
        fetchFn: mockFetch,
      });
      assert.equal(runRes.ok, true);
      assert.equal(runRes.slurmJobId, 'api_9001');

      // Queue integration for providerType='sugon'
      const dispatched = [];
      const q = createComputeQueue({
        dataDir: tmp,
        onDispatchRemote: (job) => dispatched.push(job),
      });
      q.registerProvider({ id: 'sugon', name: '曙光超算 (Sugon/SCNet)', status: 'active', meta: { machine: 'ubuntu_hpc', mode: 'openapi' } });
      const enq = q.enqueue({
        machine: 'ubuntu_hpc',
        providerType: 'sugon',
        mode: 'remote',
        resource: 'gpu',
        label: '曙光 MoM 算例',
        command: 'python3 solve.py',
      });
      assert.equal(enq.ok, true);
      assert.equal(enq.granted, true);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].providerType, 'sugon');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
