// Sugon / SCNet (中科曙光 / 国家超算互联网) Multi-Cluster HPC Provider Runner (deterministic, zero-token).
// Supports both legacy single-profile and multi-profile ~/.config/ame-hpc/sugon.json (mode 0600, never stored in Git):
//   - `mode: "ssh"`     — Standard SSH + Slurm CLI (sbatch / squeue / sacct / scancel) + rsync upload + rayfile-c 720Mbps download
//   - `mode: "openapi"` — Sugon AC / SCNet OpenAPI v2 (POST /ac/openapi/v2/tokens + REST job API)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'ame-hpc', 'sugon.json');
const DEFAULT_RAYFILE_BIN = path.join(os.homedir(), '.local', 'bin', 'rayfile-c');
const KEY_EXPIRY_WARN_DAYS = 7;

function cleanStr(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function expandHome(p) {
  const s = cleanStr(p, 400);
  if (!s) return '';
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function stripClusterBanner(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^Currently Loaded Modulefiles:/i.test(t)) return false;
      if (/^\d+\)\s+\S+\/\S+/.test(t)) return false;
      if (/^\*\*\s/.test(t)) return false;
      if (/^Warning:\s+Permanently added/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

function normalizeRayfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const host = cleanStr(raw.host, 160);
  const port = Math.trunc(Number(raw.port) || 0);
  const user = cleanStr(raw.user, 80);
  const token = cleanStr(raw.token, 200);
  const shareRoot = cleanStr(raw.shareRoot, 200).replace(/\/+$/, '');
  const remoteRoot = cleanStr(raw.remoteRoot, 300).replace(/\/+$/, '');
  if (!host || !port || !user || !token || !shareRoot || !remoteRoot) return null;
  return { host, port, user, token, shareRoot, remoteRoot };
}

function normalizeProfile(raw, fallbackId = 'default') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const mode = String(raw.mode || (raw.sshHost ? 'ssh' : raw.baseUrl ? 'openapi' : '')).trim().toLowerCase();
  if (mode !== 'ssh' && mode !== 'openapi') return null;
  const id = cleanStr(raw.id, 60) || fallbackId;
  const keyExpireAt = cleanStr(raw.keyExpireAt, 40);
  return {
    id,
    label: cleanStr(raw.label, 80) || id,
    region: cleanStr(raw.region, 60),
    account: cleanStr(raw.account || raw.user, 60),
    mode,
    sshHost: cleanStr(raw.sshHost, 120),
    baseUrl: cleanStr(raw.baseUrl, 240).replace(/\/+$/, ''),
    user: cleanStr(raw.user, 120),
    password: typeof raw.password === 'string' ? raw.password : '',
    orgid: cleanStr(raw.orgid, 120),
    clusterId: cleanStr(raw.clusterId, 120),
    defaultPartition: cleanStr(raw.defaultPartition, 80) || 'normal',
    remoteWorkDir: cleanStr(raw.remoteWorkDir, 300) || '~/ame-hpc-jobs',
    maxWalltime: cleanStr(raw.maxWalltime, 32) || '04:00:00',
    submitPath: cleanStr(raw.submitPath, 160) || '/hpc/openapi/v2/jobs',
    statusPath: cleanStr(raw.statusPath, 160) || '/hpc/openapi/v2/jobs',
    keyExpireAt,
    rayfile: normalizeRayfile(raw.rayfile),
  };
}

function loadSugonConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const rayfileBin = expandHome(raw.rayfileBin) || DEFAULT_RAYFILE_BIN;
    if (Array.isArray(raw.profiles) && raw.profiles.length) {
      const profiles = raw.profiles
        .map((p, idx) => normalizeProfile(p, `profile-${idx + 1}`))
        .filter(Boolean);
      if (!profiles.length) return null;
      const defaultProfileId = cleanStr(raw.defaultProfile, 60);
      const def = profiles.find((p) => p.id === defaultProfileId) || profiles[0];
      return {
        ...def,
        defaultProfile: def.id,
        rayfileBin,
        profiles,
      };
    }

    const single = normalizeProfile(raw, 'default');
    if (!single) return null;
    return {
      ...single,
      defaultProfile: single.id,
      rayfileBin,
      profiles: [single],
    };
  } catch {
    return null;
  }
}

function resolveSugonProfile(cfg, profileId = '') {
  if (!cfg) return null;
  const list = Array.isArray(cfg.profiles) && cfg.profiles.length ? cfg.profiles : [cfg];
  const want = cleanStr(profileId, 60);
  if (want) {
    const exact = list.find((p) => p.id === want || p.sshHost === want || p.label === want);
    if (exact) return exact;
  }
  return list.find((p) => p.id === cfg.defaultProfile) || list[0] || null;
}

function computeKeyExpiryDays(keyExpireAt, nowMs = Date.now()) {
  if (!keyExpireAt) return null;
  const parsed = Date.parse(keyExpireAt.replace(' ', 'T'));
  if (!Number.isFinite(parsed)) return null;
  return Math.round(((parsed - nowMs) / 86400e3) * 10) / 10;
}

function buildRayfileDownloadPlan(profile, remoteSrc, outputDir, rayfileBin = DEFAULT_RAYFILE_BIN) {
  const rf = profile && profile.rayfile;
  if (!rf || !remoteSrc || !outputDir) return null;
  const normSrc = String(remoteSrc).replace(/\/+$/, '');
  const root = rf.remoteRoot;
  if (normSrc !== root && !normSrc.startsWith(root + '/')) return null;
  const rel = normSrc.slice(root.length);
  const sharePath = `${rf.shareRoot}${rel}` || rf.shareRoot;
  return {
    bin: rayfileBin || DEFAULT_RAYFILE_BIN,
    sharePath,
    args: [
      '-a', rf.host,
      '-P', String(rf.port),
      '-u', rf.user,
      '-w', rf.token,
      '-no-meta',
      '-symbolic-links', 'follow',
      '-retry', '10',
      '-retrytimeout', '30',
      '-o', 'download',
      '-s', sharePath,
      '-d', outputDir,
    ],
  };
}

function defaultExec(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    child_process.execFile(cmd, args, {
      timeout: opts.timeoutMs || 60000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: process.env,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? err.message : '',
      });
    });
  });
}

function parseSinfoPartitions(stdout) {
  const parts = [];
  const seen = new Set();
  for (const line of stripClusterBanner(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || !t.includes('|')) continue;
    const [rawName, avail, nodes] = t.split('|').map((s) => s.trim());
    const name = rawName.replace(/\*$/, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    parts.push({ name, avail: avail || 'up', nodes: Number(nodes) || 0 });
  }
  return parts;
}

function parseSqueueJobs(stdout) {
  const jobs = [];
  for (const line of stripClusterBanner(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || !t.includes('|')) continue;
    const [id, state, partition, name] = t.split('|').map((s) => s.trim());
    if (!id) continue;
    jobs.push({ id, state: (state || '').toUpperCase(), partition: partition || '', name: name || '' });
  }
  return jobs;
}

function parseSacctFailures(stdout) {
  const fails = [];
  const seen = new Set();
  for (const line of stripClusterBanner(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || !t.includes('|')) continue;
    const [rawId, jobName, partition, state, exitCode, maxRss, elapsed, workDir] = t.split('|').map((s) => s.trim());
    if (!rawId || rawId.includes('.')) continue; // skip .batch / .extern sub-steps
    if (!/^(FAILED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL)/i.test(state || '')) continue;
    if (seen.has(rawId)) continue;
    seen.add(rawId);
    fails.push({
      slurmJobId: rawId,
      jobName: jobName || rawId,
      partition: partition || '',
      state: (state || '').toUpperCase(),
      exitCode: exitCode || '',
      maxRss: maxRss || '',
      elapsed: elapsed || '',
      workDir: workDir || '',
    });
  }
  return fails;
}

function buildSbatchScript({
  jobName = 'ame_job',
  partition = 'normal',
  nodes = 1,
  ntasks = 1,
  gpus = 0,
  walltime = '04:00:00',
  remoteWorkDir = '~/ame-hpc-jobs',
  command = '',
} = {}) {
  const safeName = String(jobName || 'ame_job').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || 'ame_job';
  const lines = [
    '#!/bin/bash',
    `#SBATCH -J ${safeName}`,
    `#SBATCH -p ${cleanStr(partition, 80) || 'normal'}`,
    `#SBATCH -N ${Math.max(1, Math.trunc(Number(nodes) || 1))}`,
    `#SBATCH -n ${Math.max(1, Math.trunc(Number(ntasks) || 1))}`,
    gpus > 0 ? `#SBATCH --gres=gpu:${Math.trunc(Number(gpus))}` : null,
    walltime ? `#SBATCH -t ${cleanStr(walltime, 32)}` : null,
    `#SBATCH -o ${remoteWorkDir}/slurm-%j.out`,
    `#SBATCH -e ${remoteWorkDir}/slurm-%j.err`,
    '',
    'set -eo pipefail',
    `cd ${remoteWorkDir}`,
    String(command || ''),
    '',
  ].filter((x) => x !== null);
  return lines.join('\n');
}

function parseSbatchJobId(stdout) {
  const m = /Submitted\s+batch\s+job\s+(\d+)/i.exec(stripClusterBanner(stdout));
  return m ? m[1] : '';
}

async function fetchOpenApiToken(cfg, fetchFn = global.fetch) {
  const res = await fetchFn(`${cfg.baseUrl}/ac/openapi/v2/tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      user: cfg.user,
      password: cfg.password,
      ...(cfg.orgid ? { orgid: cfg.orgid } : {}),
    },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!res.ok || !data || (data.code && String(data.code) !== '0' && String(data.code) !== '200')) {
    throw new Error((data && (data.msg || data.message)) || `HTTP ${res.status}`);
  }
  const list = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
  const picked = (cfg.clusterId && list.find((x) => String(x.clusterId) === cfg.clusterId)) || list[0] || data;
  const token = picked.token || data.token || '';
  if (!token) throw new Error('曙光 OpenAPI 未返回有效 token');
  return { token, clusterId: String(picked.clusterId || cfg.clusterId || ''), clusterName: String(picked.clusterName || '') };
}

async function probeSingleProfile(profile, { execFn = defaultExec, fetchFn = global.fetch, nowMs = Date.now() } = {}) {
  const keyDaysLeft = computeKeyExpiryDays(profile.keyExpireAt, nowMs);
  const keyExpiringSoon = keyDaysLeft !== null && keyDaysLeft <= KEY_EXPIRY_WARN_DAYS;
  const base = {
    id: profile.id,
    label: profile.label,
    region: profile.region,
    account: profile.account,
    mode: profile.mode,
    host: profile.mode === 'ssh' ? profile.sshHost : profile.baseUrl,
    defaultPartition: profile.defaultPartition,
    remoteWorkDir: profile.remoteWorkDir,
    hasRayfile: Boolean(profile.rayfile),
    keyExpireAt: profile.keyExpireAt || '',
    keyDaysLeft,
    keyExpiringSoon,
  };

  if (profile.mode === 'ssh') {
    if (!profile.sshHost) return { ...base, available: false, partitions: [], activeJobs: 0, runningJobs: 0, queuedJobs: 0, error: '缺少 sshHost 配置' };
    const r = await execFn('ssh', [
      '-n',
      '-o', 'ConnectTimeout=8',
      '-o', 'BatchMode=yes',
      profile.sshHost,
      "sinfo -h -o '%P|%a|%D' 2>/dev/null | head -n 12; echo '---JOBS---'; squeue -u $USER -h -o '%i|%T|%P|%j' 2>/dev/null | head -n 30",
    ], { timeoutMs: 12000 });
    if (!r.ok) {
      return { ...base, available: false, partitions: [], activeJobs: 0, runningJobs: 0, queuedJobs: 0, error: cleanStr(r.stderr || r.error || 'SSH 探测失败', 160) };
    }
    const [partRaw, jobRaw] = stripClusterBanner(r.stdout).split('---JOBS---');
    const partitions = parseSinfoPartitions(partRaw);
    const jobs = parseSqueueJobs(jobRaw);
    const runningJobs = jobs.filter((j) => j.state === 'RUNNING' || j.state === 'R').length;
    const queuedJobs = jobs.filter((j) => j.state === 'PENDING' || j.state === 'PD').length;
    return {
      ...base,
      available: true,
      partitions: partitions.map((p) => p.name),
      activeJobs: jobs.length,
      runningJobs,
      queuedJobs,
    };
  }

  if (!profile.baseUrl || !profile.user || !profile.password) {
    return { ...base, available: false, partitions: [], activeJobs: 0, runningJobs: 0, queuedJobs: 0, error: '缺少 baseUrl/user/password 配置' };
  }
  try {
    const auth = await fetchOpenApiToken(profile, fetchFn);
    return {
      ...base,
      available: true,
      clusterId: auth.clusterId,
      clusterName: auth.clusterName,
      partitions: [profile.defaultPartition],
      activeJobs: 0,
      runningJobs: 0,
      queuedJobs: 0,
    };
  } catch (e) {
    return { ...base, available: false, partitions: [], activeJobs: 0, runningJobs: 0, queuedJobs: 0, error: cleanStr(e && e.message, 160) };
  }
}

async function probeSugonStatus({ configPath = DEFAULT_CONFIG_PATH, execFn = defaultExec, fetchFn = global.fetch, nowMs = Date.now() } = {}) {
  const cfg = loadSugonConfig(configPath);
  if (!cfg) return null;
  const at = nowMs;
  const list = Array.isArray(cfg.profiles) && cfg.profiles.length ? cfg.profiles : [cfg];
  const probed = await Promise.all(list.map((p) => probeSingleProfile(p, { execFn, fetchFn, nowMs })));
  const online = probed.filter((p) => p.available);
  const primary = probed.find((p) => p.id === cfg.defaultProfile) || online[0] || probed[0];
  const runningJobs = probed.reduce((s, p) => s + (p.runningJobs || 0), 0);
  const queuedJobs = probed.reduce((s, p) => s + (p.queuedJobs || 0), 0);
  const activeJobs = probed.reduce((s, p) => s + (p.activeJobs || 0), 0);
  const expiringKeys = probed
    .filter((p) => p.keyExpiringSoon)
    .map((p) => ({ id: p.id, label: p.label, keyExpireAt: p.keyExpireAt, keyDaysLeft: p.keyDaysLeft }));

  return {
    available: online.length > 0,
    mode: primary.mode,
    host: primary.host,
    ...(primary.clusterId ? { clusterId: primary.clusterId, clusterName: primary.clusterName || '' } : {}),
    defaultProfile: primary.id,
    defaultPartition: primary.defaultPartition,
    partitions: primary.partitions || [],
    onlineCount: online.length,
    totalCount: probed.length,
    activeJobs,
    runningJobs,
    queuedJobs,
    expiringKeys,
    profiles: probed,
    ...(online.length === 0 && primary.error ? { error: primary.error } : {}),
    at,
  };
}

// Zero-token periodic watcher: detects newly failed Slurm jobs across all SSH profiles
async function scanSugonFailures({
  configPath = DEFAULT_CONFIG_PATH,
  seenFailedIds = new Set(),
  lookbackMinutes = 20,
  execFn = defaultExec,
} = {}) {
  const cfg = loadSugonConfig(configPath);
  if (!cfg) return [];
  const list = (Array.isArray(cfg.profiles) ? cfg.profiles : [cfg]).filter((p) => p.mode === 'ssh' && p.sshHost);
  if (!list.length) return [];

  const alerts = [];
  const startIso = new Date(Date.now() - Math.max(5, lookbackMinutes) * 60000).toISOString().slice(0, 19);
  for (const prof of list) {
    const r = await execFn('ssh', [
      '-n', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes',
      prof.sshHost,
      `sacct -u $USER -S ${startIso} -n -P -o JobID,JobName,Partition,State,ExitCode,MaxRSS,Elapsed,WorkDir 2>/dev/null | head -n 40`,
    ], { timeoutMs: 12000 });
    if (!r.ok) continue;
    const fails = parseSacctFailures(r.stdout);
    for (const f of fails) {
      const key = `${prof.id}:${f.slurmJobId}`;
      if (seenFailedIds.has(key)) continue;
      seenFailedIds.add(key);
      let logTail = '';
      if (f.workDir && /^\/[A-Za-z0-9._\/-]+$/.test(f.workDir)) {
        const logRes = await execFn('ssh', [
          '-n', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes',
          prof.sshHost,
          `tail -n 100 "${f.workDir}/slurm-${f.slurmJobId}.err" "${f.workDir}/slurm-${f.slurmJobId}.out" 2>/dev/null || true`,
        ], { timeoutMs: 10000 });
        logTail = stripClusterBanner(logRes.stdout).slice(-3500);
      }
      alerts.push({
        profileId: prof.id,
        profileLabel: prof.label,
        region: prof.region,
        account: prof.account,
        sshHost: prof.sshHost,
        ...f,
        logTail,
        detectedAt: Date.now(),
      });
    }
  }
  return alerts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSugonJob({
  jobId = '',
  profile = '',
  label = '',
  partition = '',
  nodes = 1,
  ntasks = 1,
  gpus = 0,
  walltime = '',
  command = '',
  remoteWorkDir = '',
  uploadPaths = [],
  downloadPath = '',
  outputDir = '',
  pollIntervalMs = 15000,
  onHeartbeat = () => {},
  signal = null,
  configPath = DEFAULT_CONFIG_PATH,
  execFn = defaultExec,
  fetchFn = global.fetch,
  fsExists = fs.existsSync,
} = {}) {
  const startMs = Date.now();
  const cfg = loadSugonConfig(configPath);
  if (!cfg) {
    return { ok: false, exitCode: 1, durationMs: 0, error: `未找到曙光超算配置文件 ${configPath}` };
  }
  const prof = resolveSugonProfile(cfg, profile);
  if (!prof) {
    return { ok: false, exitCode: 1, durationMs: 0, error: `未找到曙光超算配置档: ${profile || 'default'}` };
  }
  const part = cleanStr(partition, 80) || prof.defaultPartition || 'normal';
  const workDir = cleanStr(remoteWorkDir, 300) || `${prof.remoteWorkDir}/${jobId || ('job_' + Date.now())}`;
  const wt = cleanStr(walltime, 32) || prof.maxWalltime || '04:00:00';

  if (prof.mode === 'ssh') {
    const host = prof.sshHost;
    // 1. Ensure remote working directory
    const mk = await execFn('ssh', ['-n', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', host, `mkdir -p ${workDir}`]);
    if (!mk.ok) return { ok: false, exitCode: 1, durationMs: Date.now() - startMs, error: `创建远端目录失败: ${mk.stderr || mk.error}` };

    // 2. Upload local files if specified (prefer rsync --partial, fallback to scp)
    for (const lp of (Array.isArray(uploadPaths) ? uploadPaths : [])) {
      const p = cleanStr(lp, 500);
      if (!p) continue;
      let up = await execFn('rsync', ['-az', '--partial', '-e', 'ssh -o BatchMode=yes', p, `${host}:${workDir}/`], { timeoutMs: 300000 });
      if (!up.ok) {
        up = await execFn('scp', ['-r', '-o', 'BatchMode=yes', p, `${host}:${workDir}/`], { timeoutMs: 300000 });
      }
      if (!up.ok) return { ok: false, exitCode: 1, durationMs: Date.now() - startMs, error: `上传 ${p} 失败: ${up.stderr || up.error}` };
    }

    // 3. Submit sbatch script
    const script = buildSbatchScript({
      jobName: label || jobId || 'ame_hpc',
      partition: part,
      nodes,
      ntasks,
      gpus,
      walltime: wt,
      remoteWorkDir: workDir,
      command,
    });
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    const sub = await execFn('ssh', [
      '-n', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes',
      host,
      `echo '${b64}' | base64 -d > ${workDir}/run.sbatch && sbatch ${workDir}/run.sbatch`,
    ]);
    const slurmJobId = parseSbatchJobId(sub.stdout);
    if (!sub.ok || !slurmJobId) {
      return { ok: false, exitCode: 1, durationMs: Date.now() - startMs, error: `sbatch 提交失败: ${sub.stderr || sub.stdout || sub.error}` };
    }

    // 4. Poll Slurm until completion or cancellation
    let cancelled = false;
    while (true) {
      if (signal && signal.aborted) {
        cancelled = true;
        await execFn('ssh', ['-n', '-o', 'BatchMode=yes', host, `scancel ${slurmJobId}`]);
        return { ok: false, exitCode: 130, slurmJobId, profileId: prof.id, durationMs: Date.now() - startMs, error: '已通过 scancel 中止曙光作业' };
      }
      try { onHeartbeat({ slurmJobId, profileId: prof.id }); } catch {}
      const sq = await execFn('ssh', ['-n', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', host, `squeue -j ${slurmJobId} -h -o '%T'`]);
      const st = cleanStr(stripClusterBanner(sq.stdout), 40).toUpperCase();
      if (!st || ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'OUT_OF_MEMORY'].includes(st)) break;
      await sleep(Math.max(10, pollIntervalMs));
    }

    // 5. Inspect final exit status & log tail
    const ac = await execFn('ssh', ['-n', '-o', 'BatchMode=yes', host, `sacct -j ${slurmJobId} -n -P -o State,ExitCode,MaxRSS,Elapsed 2>/dev/null | head -n 1`]);
    const logRes = await execFn('ssh', ['-n', '-o', 'BatchMode=yes', host, `tail -n 120 ${workDir}/slurm-${slurmJobId}.err ${workDir}/slurm-${slurmJobId}.out 2>/dev/null || true`]);
    const sacctLine = cleanStr(stripClusterBanner(ac.stdout), 160);
    const failed = !cancelled && /FAILED|TIMEOUT|CANCELLED|OUT_OF_MEMORY|NODE_FAIL/i.test(sacctLine);
    const exitM = /\|(\d+):\d+/.exec(sacctLine);
    const exitCode = exitM ? Number(exitM[1]) : (failed ? 1 : 0);

    // 6. Download artifacts directly into outputDir (prefer rayfile-c 720Mbps, fallback to rsync/scp)
    let transferMethod = '';
    let transferWarning = '';
    if (!failed && downloadPath && outputDir) {
      try { fs.mkdirSync(outputDir, { recursive: true }); } catch {}
      const remoteSrc = downloadPath.startsWith('/') ? downloadPath : `${workDir}/${downloadPath}`;
      const rfPlan = buildRayfileDownloadPlan(prof, remoteSrc, outputDir, cfg.rayfileBin);
      let downloaded = false;
      if (rfPlan && fsExists(rfPlan.bin)) {
        const rfRes = await execFn(rfPlan.bin, rfPlan.args, { timeoutMs: 3600000 });
        const rfText = `${rfRes.stdout}\n${rfRes.stderr}`;
        if (rfRes.ok && !/Authentication error/i.test(rfText)) {
          downloaded = true;
          transferMethod = 'rayfile-c';
        } else {
          transferWarning = /Authentication error/i.test(rfText)
            ? 'rayfile-c 令牌已过期或越界，已降级为 SSH 传输'
            : `rayfile-c 下载异常，已降级为 SSH 传输`;
        }
      }
      if (!downloaded) {
        const rs = await execFn('rsync', ['-az', '--partial', '-e', 'ssh -o BatchMode=yes', `${host}:${remoteSrc}`, outputDir], { timeoutMs: 3600000 });
        if (rs.ok) {
          transferMethod = 'rsync';
        } else {
          await execFn('scp', ['-r', '-o', 'BatchMode=yes', `${host}:${remoteSrc}`, outputDir], { timeoutMs: 3600000 });
          transferMethod = 'scp';
        }
      }
    }

    return {
      ok: exitCode === 0,
      exitCode,
      slurmJobId,
      profileId: prof.id,
      transferMethod,
      ...(transferWarning ? { transferWarning } : {}),
      durationMs: Date.now() - startMs,
      tail: stripClusterBanner(logRes.stdout).slice(-3500),
      ...(exitCode !== 0 ? { error: sacctLine || `Slurm exit ${exitCode}` } : {}),
    };
  }

  // OpenAPI v2 mode
  try {
    const auth = await fetchOpenApiToken(prof, fetchFn);
    const subRes = await fetchFn(`${prof.baseUrl}${prof.submitPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: auth.token },
      body: JSON.stringify({
        clusterId: auth.clusterId,
        jobName: label || jobId || 'ame_hpc',
        queue: part,
        nodes: Math.max(1, Number(nodes) || 1),
        ntasks: Math.max(1, Number(ntasks) || 1),
        gpus: Math.max(0, Number(gpus) || 0),
        walltime: wt,
        workDir,
        command,
      }),
    });
    const subJson = await subRes.json();
    const slurmJobId = String((subJson && subJson.data && (subJson.data.jobId || subJson.data.id)) || subJson.jobId || '');
    if (!subRes.ok || !slurmJobId) {
      return { ok: false, exitCode: 1, durationMs: Date.now() - startMs, error: (subJson && (subJson.msg || subJson.message)) || 'OpenAPI 提交作业失败' };
    }

    let finalState = 'COMPLETED';
    while (true) {
      if (signal && signal.aborted) {
        await fetchFn(`${prof.baseUrl}${prof.statusPath}/${encodeURIComponent(slurmJobId)}`, {
          method: 'DELETE',
          headers: { token: auth.token },
        }).catch(() => {});
        return { ok: false, exitCode: 130, slurmJobId, profileId: prof.id, durationMs: Date.now() - startMs, error: '已通过 OpenAPI 中止曙光作业' };
      }
      try { onHeartbeat({ slurmJobId, profileId: prof.id }); } catch {}
      const stRes = await fetchFn(`${prof.baseUrl}${prof.statusPath}/${encodeURIComponent(slurmJobId)}`, {
        method: 'GET',
        headers: { token: auth.token },
      });
      const stJson = await stRes.json();
      const st = String((stJson && stJson.data && (stJson.data.jobStatus || stJson.data.state)) || stJson.state || '').toUpperCase();
      if (['COMPLETED', 'DONE', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'ERROR'].includes(st)) {
        finalState = st;
        break;
      }
      await sleep(Math.max(10, pollIntervalMs));
    }
    const ok = ['COMPLETED', 'DONE', 'SUCCESS'].includes(finalState);
    return {
      ok,
      exitCode: ok ? 0 : 1,
      slurmJobId,
      profileId: prof.id,
      durationMs: Date.now() - startMs,
      tail: `Sugon OpenAPI Job ${slurmJobId}: ${finalState}`,
      ...(!ok ? { error: `Sugon OpenAPI ${finalState}` } : {}),
    };
  } catch (e) {
    return { ok: false, exitCode: 1, durationMs: Date.now() - startMs, error: cleanStr(e && e.message, 200) };
  }
}

async function querySugonHistory({
  profile = '',
  days = 30,
  limit = 20,
  configPath = DEFAULT_CONFIG_PATH,
  execFn = defaultExec,
} = {}) {
  const cfg = loadSugonConfig(configPath);
  if (!cfg) return { ok: false, msg: `未找到曙光超算配置文件 ${configPath}` };
  const allSsh = (Array.isArray(cfg.profiles) ? cfg.profiles : [cfg]).filter((p) => p.mode === 'ssh' && p.sshHost);
  const targets = profile
    ? allSsh.filter((p) => p.id === profile || p.sshHost === profile || p.label === profile)
    : allSsh;
  if (!targets.length) return { ok: false, msg: `未找到匹配的 SSH 超算入口：${profile || '(无)'}` };

  const d = Math.min(180, Math.max(1, Math.trunc(Number(days) || 30)));
  const lim = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
  const sinceDate = new Date(Date.now() - d * 86400e3).toISOString().slice(0, 10);

  const results = await Promise.all(targets.map(async (prof) => {
    const r = await execFn('ssh', [
      '-n', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes',
      prof.sshHost,
      `sacct -u $USER -S ${sinceDate} -X -n -P -o JobID,JobName,Partition,State,Start,Elapsed,AllocCPUS,MaxRSS 2>/dev/null | tail -n ${lim}`,
    ], { timeoutMs: 15000 });
    if (!r.ok) {
      return { profileId: prof.id, label: prof.label, region: prof.region, account: prof.account, ok: false, error: cleanStr(r.stderr || r.error, 140), jobs: [] };
    }
    const jobs = [];
    for (const line of stripClusterBanner(r.stdout).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || !t.includes('|')) continue;
      const [jobId, jobName, partition, state, start, elapsed, allocCpus, maxRss] = t.split('|').map((s) => s.trim());
      if (!jobId) continue;
      jobs.push({ jobId, jobName, partition, state, start, elapsed, allocCpus: Number(allocCpus) || 0, maxRss });
    }
    return { profileId: prof.id, label: prof.label, region: prof.region, account: prof.account, ok: true, count: jobs.length, jobs: jobs.reverse() };
  }));

  return { ok: true, since: sinceDate, days: d, clusters: results };
}

async function readSugonJobLogs({
  profile = '',
  slurmJobId = '',
  workDir = '',
  lines = 80,
  configPath = DEFAULT_CONFIG_PATH,
  execFn = defaultExec,
} = {}) {
  const cfg = loadSugonConfig(configPath);
  if (!cfg) return { ok: false, msg: `未找到曙光超算配置文件 ${configPath}` };
  const prof = resolveSugonProfile(cfg, profile);
  if (!prof || prof.mode !== 'ssh' || !prof.sshHost) return { ok: false, msg: '未找到可用的 SSH 超算入口' };
  const jid = String(slurmJobId || '').trim();
  if (!/^\d{1,20}$/.test(jid)) return { ok: false, msg: 'slurmJobId 必须是数字' };
  const nLines = Math.min(300, Math.max(10, Math.trunc(Number(lines) || 80)));

  let dir = cleanStr(workDir, 300);
  if (!dir) {
    const wdRes = await execFn('ssh', [
      '-n', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes',
      prof.sshHost,
      `sacct -j ${jid} -X -n -P -o WorkDir 2>/dev/null | head -n 1`,
    ], { timeoutMs: 12000 });
    dir = cleanStr(stripClusterBanner(wdRes.stdout), 300).split('|')[0].trim();
  }
  if (!dir || !/^\/[A-Za-z0-9._\/-]+$/.test(dir)) {
    return { ok: false, msg: `无法定位作业 ${jid} 的工作目录，请手动提供 workDir` };
  }
  const logRes = await execFn('ssh', [
    '-n', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes',
    prof.sshHost,
    `tail -n ${nLines} "${dir}/slurm-${jid}.err" "${dir}/slurm-${jid}.out" 2>/dev/null || ls -la "${dir}" | head -n 20`,
  ], { timeoutMs: 12000 });
  return {
    ok: true,
    profileId: prof.id,
    slurmJobId: jid,
    workDir: dir,
    tail: stripClusterBanner(logRes.stdout).slice(-6000),
  };
}

function parseKeyExpireFromFilename(filename = '') {
  const m = /RsaKeyExpireTime_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/i.exec(String(filename || ''));
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : '';
}

async function updateSugonProfileKey({
  profileId = '',
  keyContent = '',
  keyFileName = '',
  keyExpireAt = '',
  rayfileToken = '',
  configPath = DEFAULT_CONFIG_PATH,
  sshDir = path.join(os.homedir(), '.ssh', 'scnet'),
  sshConfPath = path.join(os.homedir(), '.ssh', 'config.d', 'scnet.conf'),
  execFn = defaultExec,
} = {}) {
  const cfg = loadSugonConfig(configPath);
  if (!cfg) return { ok: false, msg: `未找到曙光超算配置文件 ${configPath}` };
  const prof = resolveSugonProfile(cfg, profileId);
  if (!prof || prof.mode !== 'ssh' || !prof.sshHost) {
    return { ok: false, msg: `未找到可用的 SSH 超算入口：${profileId || '(空)'}` };
  }

  const rawJson = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const targetObj = Array.isArray(rawJson.profiles)
    ? rawJson.profiles.find((p) => p && (p.id === prof.id || p.sshHost === prof.sshHost))
    : rawJson;
  if (!targetObj) return { ok: false, msg: `配置中找不到入口 ${prof.id}` };

  let updatedKey = false;
  let updatedToken = false;
  let resolvedExpire = cleanStr(keyExpireAt, 40) || parseKeyExpireFromFilename(keyFileName);

  if (typeof keyContent === 'string' && keyContent.trim()) {
    const cleanPem = keyContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim() + '\n';
    if (!/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/m.test(cleanPem) || !/-----END [A-Z0-9 ]*PRIVATE KEY-----/m.test(cleanPem)) {
      return { ok: false, msg: '上传的内容不是有效的 PEM 私钥文件（缺少 BEGIN/END PRIVATE KEY）' };
    }
    const safeName = (path.basename(String(keyFileName || '')).replace(/[^A-Za-z0-9._-]/g, '_') || `${prof.id}_rsa_${Date.now()}.txt`).slice(0, 120);
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(sshDir, safeName);
    const tmpKey = keyPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmpKey, cleanPem, { mode: 0o600 });
    fs.renameSync(tmpKey, keyPath);
    try { fs.chmodSync(keyPath, 0o600); } catch {}

    // Update IdentityFile in ~/.ssh/config.d/scnet.conf for this Host
    if (fs.existsSync(sshConfPath)) {
      const confLines = fs.readFileSync(sshConfPath, 'utf8').split(/\r?\n/);
      let inHost = false;
      let replaced = false;
      const tildePath = keyPath.startsWith(os.homedir() + path.sep)
        ? '~/' + keyPath.slice(os.homedir().length + 1).replace(/\\/g, '/')
        : keyPath;
      for (let i = 0; i < confLines.length; i++) {
        const mHost = /^\s*Host\s+(.+)$/i.exec(confLines[i]);
        if (mHost) {
          inHost = mHost[1].trim().split(/\s+/).includes(prof.sshHost);
          continue;
        }
        if (inHost && /^\s*IdentityFile\s+/i.test(confLines[i])) {
          confLines[i] = `  IdentityFile ${tildePath}`;
          replaced = true;
          break;
        }
      }
      if (replaced) {
        const tmpConf = sshConfPath + '.tmp-' + process.pid;
        fs.writeFileSync(tmpConf, confLines.join('\n'), { mode: 0o600 });
        fs.renameSync(tmpConf, sshConfPath);
      }
    }
    if (resolvedExpire) targetObj.keyExpireAt = resolvedExpire;
    updatedKey = true;
  }

  const cleanTok = cleanStr(rayfileToken, 200);
  if (cleanTok) {
    if (!targetObj.rayfile || typeof targetObj.rayfile !== 'object') {
      return { ok: false, msg: `入口 ${prof.id} 尚未配置 rayfile 基础信息，无法仅更新令牌` };
    }
    targetObj.rayfile.token = cleanTok;
    updatedToken = true;
  }

  if (!updatedKey && !updatedToken) {
    return { ok: false, msg: '请上传新的私钥文件或填写新的快传令牌' };
  }

  const tmpCfg = configPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmpCfg, JSON.stringify(rawJson, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpCfg, configPath);

  // Immediately verify SSH connectivity if key was updated
  let verified = true;
  let verifyMsg = '';
  if (updatedKey) {
    const chk = await execFn('ssh', ['-n', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', prof.sshHost, 'echo AME_KEY_OK'], { timeoutMs: 14000 });
    verified = Boolean(chk.ok && /AME_KEY_OK/.test(chk.stdout));
    verifyMsg = verified ? 'SSH 免密实测通过' : cleanStr(chk.stderr || chk.error || 'SSH 验证未通过', 160);
  }

  return {
    ok: verified,
    profileId: prof.id,
    label: prof.label,
    updatedKey,
    updatedToken,
    keyExpireAt: targetObj.keyExpireAt || '',
    verified,
    msg: verified
      ? `已更新 ${prof.label}${updatedKey ? ' SSH 私钥' : ''}${updatedToken ? ' 快传令牌' : ''}${verifyMsg ? '（' + verifyMsg + '）' : ''}`
      : `密钥已写入，但连接验证失败：${verifyMsg}`,
  };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_RAYFILE_BIN,
  stripClusterBanner,
  loadSugonConfig,
  resolveSugonProfile,
  computeKeyExpiryDays,
  parseKeyExpireFromFilename,
  buildRayfileDownloadPlan,
  parseSinfoPartitions,
  parseSqueueJobs,
  parseSacctFailures,
  parseSbatchJobId,
  buildSbatchScript,
  probeSugonStatus,
  scanSugonFailures,
  querySugonHistory,
  readSugonJobLogs,
  updateSugonProfileKey,
  runSugonJob,
};
