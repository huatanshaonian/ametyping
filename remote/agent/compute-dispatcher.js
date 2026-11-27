'use strict';
// Compute job dispatcher & telemetry probes (local compute, Google Colab, Sugon HPC, Codex rate-limit quota).

const child_process = require('child_process');
const fs = require('fs');
const os = require('os');
const { probeCompute } = require('./compute-probe');
const { findColabBin, probeColabUsage, runColabJob } = require('./colab-runner');
const {
  loadSugonConfig,
  probeSugonStatus,
  scanSugonFailures,
  querySugonHistory,
  readSugonJobLogs,
  updateSugonProfileKey,
  runSugonJob,
} = require('./sugon-runner');
const { readCodexRateLimits } = require('./codex-quota');

const COLAB_PROBE_INTERVAL_MS = 5 * 60 * 1000;

function createComputeDispatcher({ controlOn, sendJSON, isOnline }) {
  let lastProbeAt = 0;
  let lastProbeSig = '';
  let lastColabProbeAt = 0;
  let colabProbeBusy = false;
  let lastLocalQuotaAt = 0;
  let lastLocalQuotaSig = '';
  let lastSugonAt = 0;
  let sugonBusy = false;
  let lastSugonScanAt = 0;
  let sugonScanBusy = false;
  const seenSugonFailures = new Set();

  const remoteComputeProcs = new Map(); // jobId -> { child, hbTimer, startMs }
  const activeColabJobs = new Map();    // jobId -> AbortController
  const activeSugonJobs = new Map();    // jobId -> AbortController

  function pushLocalQuota(now = Date.now()) {
    if (!isOnline() || now - lastLocalQuotaAt < 60000) return;
    lastLocalQuotaAt = now;
    try {
      const q = readCodexRateLimits();
      if (!q) return;
      const sig = JSON.stringify(q.windows);
      if (sig !== lastLocalQuotaSig) {
        lastLocalQuotaSig = sig;
        sendJSON({ t: 'local-quota', quota: q });
      }
    } catch {}
  }

  function maybeReportColabStatus(now = Date.now(), force = false) {
    if (!isOnline() || colabProbeBusy) return;
    if (!force && lastColabProbeAt && now - lastColabProbeAt < COLAB_PROBE_INTERVAL_MS) return;
    const bin = findColabBin();
    if (!bin) return;
    colabProbeBusy = true;
    lastColabProbeAt = now;
    probeColabUsage(null, { bin })
      .then((status) => {
        if (isOnline() && status) sendJSON({ t: 'colab-status', status });
      })
      .catch(() => {})
      .finally(() => { colabProbeBusy = false; });
  }

  function maybeReportSugonStatus(now = Date.now(), force = false) {
    if (!isOnline() || sugonBusy) return;
    if (!force && now - lastSugonAt < 5 * 60000) return;
    if (!loadSugonConfig()) return;
    sugonBusy = true;
    lastSugonAt = now;
    probeSugonStatus()
      .then((st) => {
        if (st) sendJSON({ t: 'sugon-status', status: st });
      })
      .catch(() => {})
      .finally(() => { sugonBusy = false; });
  }

  function maybeScanSugonFailures(now = Date.now()) {
    if (!isOnline() || sugonScanBusy) return;
    if (now - lastSugonScanAt < 3 * 60000) return;
    if (!loadSugonConfig()) return;
    sugonScanBusy = true;
    lastSugonScanAt = now;
    scanSugonFailures({ seenFailedIds: seenSugonFailures, lookbackMinutes: 20 })
      .then((alerts) => {
        for (const alert of (Array.isArray(alerts) ? alerts : [])) {
          sendJSON({ t: 'sugon-alert', alert });
        }
      })
      .catch(() => {})
      .finally(() => { sugonScanBusy = false; });
  }

  function maybeReportComputeProbe() {
    if (!isOnline()) return;
    const now = Date.now();
    if (now - lastProbeAt >= 15000) {
      try {
        const probe = probeCompute();
        const sig = `${probe.hasGpu}|${probe.gpuBusy}|${probe.cpuBusy}`;
        if (sig !== lastProbeSig || now - lastProbeAt >= 60000) {
          lastProbeSig = sig;
          lastProbeAt = now;
          sendJSON({ t: 'compute-probe', probe });
        }
      } catch {}
    } else {
      return;
    }
    pushLocalQuota(now);
    maybeReportColabStatus(now);
    maybeReportSugonStatus(now);
    maybeScanSugonFailures(now);
  }

  function refuseNoControl(jobId) {
    sendJSON({ t: 'compute-done', jobId, exitCode: 1, durationMs: 0, error: '这台电脑没开远程控制（agent.json "control": true）' });
  }

  function runRemoteCompute(d) {
    if (!controlOn()) return refuseNoControl(d.jobId);
    const jobId = String(d.jobId || '').trim();
    const cmdStr = String(d.command || '').trim();
    if (!jobId || !cmdStr) return;
    const cwd = (typeof d.cwd === 'string' && d.cwd.trim() && fs.existsSync(d.cwd.trim())) ? d.cwd.trim() : os.homedir();
    const extraEnv = (d.env && typeof d.env === 'object' && !Array.isArray(d.env)) ? d.env : {};
    const startMs = Date.now();
    const rolling = [];
    const child = child_process.spawn(cmdStr, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    const onChunk = (buf) => {
      for (const l of buf.toString('utf8').split(/\r?\n/)) {
        if (l.trim()) {
          rolling.push(l);
          if (rolling.length > 40) rolling.shift();
        }
      }
    };
    if (child.stdout) child.stdout.on('data', onChunk);
    if (child.stderr) child.stderr.on('data', onChunk);
    const hbTimer = setInterval(() => sendJSON({ t: 'compute-heartbeat', jobId }), 60000);
    if (hbTimer.unref) hbTimer.unref();
    remoteComputeProcs.set(jobId, { child, hbTimer, startMs });

    let finished = false;
    const finish = (code, errMsg = '') => {
      if (finished) return;
      finished = true;
      clearInterval(hbTimer);
      remoteComputeProcs.delete(jobId);
      sendJSON({
        t: 'compute-done',
        jobId,
        exitCode: code,
        durationMs: Date.now() - startMs,
        tail: rolling.join('\n'),
        ...(errMsg ? { error: errMsg } : {}),
      });
    };
    child.on('close', (code) => finish(code !== null ? code : 1));
    child.on('error', (err) => finish(1, err && err.message ? err.message : '启动进程失败'));
  }

  function killRemoteCompute(jobId) {
    const entry = remoteComputeProcs.get(String(jobId || ''));
    if (!entry || !entry.child) return;
    try {
      if (process.platform === 'win32' && entry.child.pid) {
        child_process.spawn('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        entry.child.kill('SIGTERM');
      }
    } catch {}
  }

  function runRemoteColab(d) {
    if (!controlOn()) return refuseNoControl(d.jobId);
    const jobId = String(d.jobId || '').trim();
    const cmdStr = String(d.command || '').trim();
    if (!jobId || !cmdStr) return;
    const ac = new AbortController();
    activeColabJobs.set(jobId, ac);
    runColabJob({
      jobId,
      gpu: d.gpu || 'A100',
      fallbackGpus: Array.isArray(d.fallbackGpus) ? d.fallbackGpus : ['L4', 'T4'],
      command: cmdStr,
      cwd: typeof d.cwd === 'string' ? d.cwd : '',
      uploadPaths: Array.isArray(d.uploadPaths) ? d.uploadPaths : [],
      downloadPath: typeof d.downloadPath === 'string' ? d.downloadPath : '',
      outputDir: typeof d.outputDir === 'string' ? d.outputDir : '',
      maxDurationMin: Number(d.maxDurationMin) || 120,
      minBalanceCcu: d.minBalanceCcu != null ? Number(d.minBalanceCcu) : 15,
      signal: ac.signal,
      onHeartbeat: () => sendJSON({ t: 'compute-heartbeat', jobId }),
    })
      .then((res) => {
        activeColabJobs.delete(jobId);
        sendJSON({
          t: 'compute-done',
          jobId,
          exitCode: res && typeof res.exitCode === 'number' ? res.exitCode : 1,
          durationMs: (res && res.durationMs) || 0,
          tail: (res && res.tail) || '',
          ...(res && res.error ? { error: res.error } : {}),
          colab: res ? {
            gpu: res.gpu || '',
            sessionId: res.sessionId || '',
            stopped: Boolean(res.stopped),
            timedOut: Boolean(res.timedOut),
            cancelled: Boolean(res.cancelled),
          } : undefined,
        });
        maybeReportColabStatus(Date.now(), true);
      })
      .catch((err) => {
        activeColabJobs.delete(jobId);
        sendJSON({ t: 'compute-done', jobId, exitCode: 1, durationMs: 0, error: (err && err.message) || 'Colab 作业运行异常' });
      });
  }

  function killRemoteColab(jobId) {
    const ac = activeColabJobs.get(String(jobId || ''));
    if (ac) { try { ac.abort(); } catch {} }
  }

  function runRemoteSugon(d) {
    if (!controlOn()) return refuseNoControl(d.jobId);
    const jobId = String(d.jobId || '').trim();
    const cmdStr = String(d.command || '').trim();
    if (!jobId || !cmdStr) return;
    const ac = new AbortController();
    activeSugonJobs.set(jobId, ac);
    runSugonJob({
      jobId,
      profile: d.sugonProfile || d.profile || '',
      label: d.label || '',
      partition: d.partition || '',
      nodes: Number(d.nodes) || 1,
      ntasks: Number(d.ntasks) || 1,
      gpus: Number(d.gpus) || 0,
      walltime: d.walltime || '',
      remoteWorkDir: d.remoteWorkDir || '',
      command: cmdStr,
      uploadPaths: Array.isArray(d.uploadPaths) ? d.uploadPaths : [],
      downloadPath: typeof d.downloadPath === 'string' ? d.downloadPath : '',
      outputDir: typeof d.outputDir === 'string' ? d.outputDir : '',
      signal: ac.signal,
      onHeartbeat: () => sendJSON({ t: 'compute-heartbeat', jobId }),
    })
      .then((res) => {
        activeSugonJobs.delete(jobId);
        sendJSON({
          t: 'compute-done',
          jobId,
          exitCode: res && typeof res.exitCode === 'number' ? res.exitCode : 1,
          durationMs: (res && res.durationMs) || 0,
          tail: (res && res.tail) || '',
          ...(res && res.slurmJobId ? { slurmJobId: res.slurmJobId } : {}),
          ...(res && res.profileId ? { profileId: res.profileId } : {}),
          ...(res && res.transferMethod ? { transferMethod: res.transferMethod } : {}),
          ...(res && res.transferWarning ? { transferWarning: res.transferWarning } : {}),
          ...(res && res.error ? { error: res.error } : {}),
        });
        maybeReportSugonStatus(Date.now(), true);
      })
      .catch((err) => {
        activeSugonJobs.delete(jobId);
        sendJSON({ t: 'compute-done', jobId, exitCode: 1, durationMs: 0, error: (err && err.message) || '曙光作业运行异常' });
      });
  }

  function killRemoteSugon(jobId) {
    const ac = activeSugonJobs.get(String(jobId || ''));
    if (ac) { try { ac.abort(); } catch {} }
  }

  function handleSugonQuery(d) {
    const args = (d.args && typeof d.args === 'object') ? d.args : {};
    const run = d.op === 'history'
      ? querySugonHistory(args)
      : d.op === 'logs'
        ? readSugonJobLogs(args)
        : d.op === 'update-key'
          ? (controlOn()
            ? updateSugonProfileKey(args).then((r) => { maybeReportSugonStatus(Date.now(), true); return r; })
            : Promise.resolve({ ok: false, msg: '这台网关机没开远程控制（agent.json "control": true）' }))
          : Promise.resolve({ ok: false, msg: '不支持的 sugon-query 操作：' + d.op });
    run
      .then((r) => sendJSON({ t: 'sugon-query-res', rid: d.rid, ...r }))
      .catch((e) => sendJSON({ t: 'sugon-query-res', rid: d.rid, ok: false, msg: (e && e.message) || '超算查询失败' }));
  }

  return {
    maybeReportComputeProbe,
    runRemoteCompute,
    killRemoteCompute,
    runRemoteColab,
    killRemoteColab,
    runRemoteSugon,
    killRemoteSugon,
    handleSugonQuery,
  };
}

module.exports = { createComputeDispatcher };
