'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  stripClusterBanner,
  buildRayfileDownloadPlan,
  parseSinfoPartitions,
  parseSqueueJobs,
  parseSacctFailures,
  parseSbatchJobId,
  buildSbatchScript,
  probeSugonStatus,
  scanSugonFailures,
  runSugonJob,
} = require('../agent/sugon-runner');
const { createComputeQueue } = require('../server/mesh-compute-queue');
const { diagnoseSugonFailure, ruleBasedDiagnose } = require('../server/mesh-sugon-advisor');

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
          if (joined.includes('tail -n')) return { ok: true, stdout: 'RCS converged\n' };
          return { ok: true, stdout: '' };
        },
      });
      assert.equal(res.ok, true);
      assert.equal(res.slurmJobId, '778899');
      assert.match(res.tail, /RCS converged/);
      assert.ok(calls.some((c) => (c[0] === 'rsync' || c[0] === 'scp') && c.join(' ').includes('result.npz')));

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

  it('supports multi-profile probing, banner stripping, rayfile-c 720Mbps download + fallback, and sacct failure scan', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-sugon-multi-'));
    const cfgFile = path.join(tmp, 'sugon.json');
    const nowMs = Date.parse('2026-11-26T14:00:00Z');
    fs.writeFileSync(cfgFile, JSON.stringify({
      defaultProfile: 'hf-huatan',
      rayfileBin: '/fake/bin/rayfile-c',
      profiles: [
        {
          id: 'hf-huatan',
          label: '合肥 (huatan)',
          region: '合肥',
          account: 'huatan',
          mode: 'ssh',
          sshHost: 'scnet-huatan-hf',
          defaultPartition: 'hfacnormal04',
          remoteWorkDir: '/public/home/huatan/workspace/ame-jobs',
          keyExpireAt: '2027-02-24 20:35:21',
          rayfile: {
            host: 'hefei03.nscc-hf.cn',
            port: 65012,
            user: 'huatan',
            token: 'tok_ws',
            shareRoot: '/workspace',
            remoteRoot: '/public/home/huatan/workspace',
          },
        },
        {
          id: 'hf-acc',
          label: '合肥 (acc143g266)',
          region: '合肥',
          account: 'acc143g266',
          mode: 'ssh',
          sshHost: 'scnet-acc-hf',
          defaultPartition: 'hfacnormal04',
          remoteWorkDir: '/public/home/acc143g266/TangYC/ame-jobs',
          keyExpireAt: '2026-12-01 16:23:12',
        },
      ],
    }));

    try {
      const cleaned = stripClusterBanner('Currently Loaded Modulefiles:\n  1) compiler/intel/2017.5.239\nhfacnormal04|up|149\n');
      assert.equal(cleaned.trim(), 'hfacnormal04|up|149');

      const probe = await probeSugonStatus({
        configPath: cfgFile,
        nowMs,
        execFn: async () => ({
          ok: true,
          stdout: 'Currently Loaded Modulefiles:\n  1) compiler/intel/2017.5.239\nhfacnormal04|up|149\n---JOBS---\n',
        }),
      });
      assert.equal(probe.available, true);
      assert.equal(probe.onlineCount, 2);
      assert.equal(probe.totalCount, 2);
      assert.equal(probe.expiringKeys.length, 1);
      assert.equal(probe.expiringKeys[0].id, 'hf-acc');

      // Rayfile-c download path construction & execution
      const outDir = path.join(tmp, 'nas-out');
      const rfCalls = [];
      const rfRes = await runSugonJob({
        jobId: 'j_rf',
        profile: 'hf-huatan',
        command: 'python3 sim.py',
        downloadPath: 'result.npz',
        outputDir: outDir,
        pollIntervalMs: 10,
        configPath: cfgFile,
        fsExists: (p) => p === '/fake/bin/rayfile-c',
        execFn: async (cmd, args) => {
          rfCalls.push([cmd, ...args]);
          const joined = args.join(' ');
          if (cmd === '/fake/bin/rayfile-c') return { ok: true, stdout: 'Download file completed', stderr: '' };
          if (joined.includes('sbatch ')) return { ok: true, stdout: 'Submitted batch job 555001\n' };
          if (joined.includes('squeue -j 555001')) return { ok: true, stdout: '' };
          if (joined.includes('sacct -j 555001')) return { ok: true, stdout: 'COMPLETED|0:0|12G|00:10:00\n' };
          return { ok: true, stdout: '' };
        },
      });
      assert.equal(rfRes.ok, true);
      assert.equal(rfRes.transferMethod, 'rayfile-c');
      const rfCall = rfCalls.find((c) => c[0] === '/fake/bin/rayfile-c');
      assert.ok(rfCall);
      assert.ok(rfCall.includes('/workspace/ame-jobs/j_rf/result.npz'));

      // sacct failure parser & watcher
      const parsedFails = parseSacctFailures('901|cem_mom|hfacnormal04|OUT_OF_MEMORY|0:125|512G|01:02:03|/public/home/huatan/workspace/j1\n901.batch|batch||OUT_OF_MEMORY|0:125|512G|01:02:03|\n');
      assert.equal(parsedFails.length, 1);
      assert.equal(parsedFails[0].state, 'OUT_OF_MEMORY');

      const seen = new Set();
      const alerts = await scanSugonFailures({
        configPath: cfgFile,
        seenFailedIds: seen,
        execFn: async (cmd, args) => {
          const joined = args.join(' ');
          if (joined.includes('sacct -u')) {
            return { ok: true, stdout: '901|cem_mom|hfacnormal04|OUT_OF_MEMORY|0:125|512G|01:02:03|/public/home/huatan/workspace/j1\n' };
          }
          if (joined.includes('tail -n 100')) {
            return { ok: true, stdout: 'slurmstepd: error: Detected 1 oom-kill event(s)\n' };
          }
          return { ok: true, stdout: '' };
        },
      });
      assert.equal(alerts.length, 2);
      assert.match(alerts[0].logTail, /oom-kill/);
      // Second scan deduplicates
      const alerts2 = await scanSugonFailures({ configPath: cfgFile, seenFailedIds: seen, execFn: async () => ({ ok: true, stdout: '901|cem_mom|hfacnormal04|OUT_OF_MEMORY|0:125|512G|01:02:03|/public/home/huatan/workspace/j1\n' }) });
      assert.equal(alerts2.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('diagnoses Sugon failures via keyless pure-API Magpie call with deterministic fallback', async () => {
    const oomRule = ruleBasedDiagnose({ state: 'OUT_OF_MEMORY', maxRss: '512G', logTail: 'oom-kill' });
    assert.match(oomRule.category, /OOM/);

    const fallbackDiag = await diagnoseSugonFailure({
      alert: { profileLabel: '合肥 (huatan)', slurmJobId: '901', state: 'TIMEOUT', elapsed: '04:00:00', logTail: 'DUE TO TIME LIMIT' },
      magpie: null,
    });
    assert.equal(fallbackDiag.viaLlm, false);
    assert.match(fallbackDiag.category, /TIMEOUT/);
    assert.match(fallbackDiag.summaryText, /超算报错诊断/);

    const llmDiag = await diagnoseSugonFailure({
      alert: { profileLabel: '昆山 (acc143g266)', slurmJobId: '902', state: 'FAILED', exitCode: '1:0', logTail: 'CUDA out of memory' },
      magpie: {
        status: () => ({ enabled: true, models: [{ id: 'google/gemini-2.5-flash' }] }),
        run: async ({ model }) => ({
          category: 'GPU 显存不足',
          rootCause: `RTX 4090 24GB 显存耗尽 (${model})`,
          suggestion: '减小 batch 或改用单精度 float32',
        }),
      },
    });
    assert.equal(llmDiag.viaLlm, true);
    assert.equal(llmDiag.provider, 'Magpie API');
    assert.equal(llmDiag.model, 'google/gemini-2.5-flash');
    assert.match(llmDiag.summaryText, /Magpie API/);

    // Google AI Studio takes priority over Magpie when configured in Win98 dataDir
    let magpieCalled = false;
    const gDiag = await diagnoseSugonFailure({
      alert: { profileLabel: '合肥 (huatan)', slurmJobId: '903', state: 'FAILED', exitCode: '139:0', logTail: 'Segmentation fault' },
      googleAiKey: {
        get: () => 'AIzaSyFakeTestKey1234567890',
        models: () => [{ model: 'gemini-2.5-pro' }, { model: 'gemini-2.5-flash' }],
      },
      runGoogleAiFn: async ({ key, model }) => {
        assert.equal(key, 'AIzaSyFakeTestKey1234567890');
        assert.equal(model, 'gemini-2.5-flash');
        return { category: '段错误 (SIGSEGV)', rootCause: '内存越界访问', suggestion: '检查网格数组下标与 ulimit -s' };
      },
      magpie: {
        status: () => ({ enabled: true, models: [{ id: 'claude-sonnet' }] }),
        run: async () => { magpieCalled = true; return {}; },
      },
    });
    assert.equal(gDiag.viaLlm, true);
    assert.equal(gDiag.provider, 'Google AI Studio');
    assert.equal(gDiag.model, 'gemini-2.5-flash');
    assert.equal(magpieCalled, false);
    assert.match(gDiag.summaryText, /Google AI Studio/);
  });
});
