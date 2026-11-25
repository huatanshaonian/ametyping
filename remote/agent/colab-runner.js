// Pure deterministic Google Colab CLI runner (zero LLM tokens).
// Supports CCU usage probing, quota-floor guard, GPU fallback (A100 -> L4 -> T4),
// upload -> exec -> download lifecycle, heartbeat callbacks, timeout/abort handling,
// and guaranteed try/finally `colab stop` billing stop-loss.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

const DEFAULT_FALLBACK_GPUS = ['L4', 'T4'];
const DEFAULT_MAX_DURATION_MIN = 120;
const DEFAULT_MIN_BALANCE_CCU = 15;
const DEFAULT_HEARTBEAT_MS = 60000;

function cleanStr(v, max = 300) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function findColabBin({
  env = process.env,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
  platform = process.platform,
} = {}) {
  const names = platform === 'win32' ? ['colab.exe', 'colab.cmd', 'colab.bat', 'colab'] : ['colab'];
  const candidates = [];

  if (homedir) {
    for (const n of names) {
      candidates.push(path.join(homedir, '.local', 'bin', n));
    }
  }

  const pathVar = (env && (env.PATH || env.Path || env.path)) || '';
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of String(pathVar).split(sep)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (!trimmed) continue;
    for (const n of names) {
      candidates.push(path.join(trimmed, n));
    }
  }

  const seen = new Set();
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function parseColabUsage(stdout, now = () => Date.now()) {
  const raw = String(stdout || '').trim();
  const at = now();
  if (!raw) {
    return {
      available: false,
      balanceCcu: null,
      burnRatePerHour: null,
      activeRuntimes: 0,
      raw: '',
      at,
    };
  }

  // Try JSON format first
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const obj = JSON.parse(raw);
      const bal = obj.balanceCcu ?? obj.balance ?? obj.computeUnitsBalance ?? obj.ccu;
      const rate = obj.burnRatePerHour ?? obj.burnRate ?? obj.consumptionRate ?? obj.rate;
      const active = obj.activeRuntimes ?? obj.runtimes ?? obj.activeSessions ?? 0;
      const balanceCcu = Number.isFinite(Number(bal)) ? Number(bal) : null;
      const burnRatePerHour = Number.isFinite(Number(rate)) ? Number(rate) : null;
      const activeRuntimes = Number.isFinite(Number(active)) ? Math.max(0, Math.trunc(Number(active))) : 0;
      return {
        available: balanceCcu !== null,
        balanceCcu,
        burnRatePerHour,
        activeRuntimes,
        raw: raw.slice(0, 1000),
        at,
      };
    } catch {}
  }

  const balMatch =
    /(?:compute\s+units?\s+balance|ccu\s+balance|remaining(?:\s+ccu|\s+units?)?|balance|余额)[^\d.-]*(-?\d+(?:\.\d+)?)/i.exec(raw) ||
    /(-?\d+(?:\.\d+)?)\s*(?:compute\s+units?|ccu)\b/i.exec(raw);

  const rateMatch =
    /(?:consumption\s+rate|burn\s+rate|usage\s+rate|rate|消耗率)[^\d.-]*(\d+(?:\.\d+)?)/i.exec(raw) ||
    /(\d+(?:\.\d+)?)\s*(?:ccu\s*)?\/\s*(?:h|hr|hour)\b/i.exec(raw);

  const activeMatch =
    /(?:active\s+(?:runtimes?|sessions?)|running\s+runtimes?|runtimes?|活动运行时)[^\d]*(\d+)/i.exec(raw);

  const balanceCcu = balMatch && Number.isFinite(Number(balMatch[1])) ? Number(balMatch[1]) : null;
  const burnRatePerHour = rateMatch && Number.isFinite(Number(rateMatch[1])) ? Number(rateMatch[1]) : null;
  const activeRuntimes = activeMatch && Number.isFinite(Number(activeMatch[1]))
    ? Math.max(0, Math.trunc(Number(activeMatch[1])))
    : 0;

  return {
    available: balanceCcu !== null,
    balanceCcu,
    burnRatePerHour,
    activeRuntimes,
    raw: raw.slice(0, 1000),
    at,
  };
}

function parseSessionId(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return '';
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const obj = JSON.parse(raw);
      const id = obj.sessionId || obj.runtimeId || obj.session || obj.id || obj.name || '';
      if (typeof id === 'string' && id.trim()) return id.trim().slice(0, 120);
    } catch {}
  }
  const m = /(?:session(?:\s+id)?|runtime(?:\s+id)?|id)\s*[:=]\s*([A-Za-z0-9._:/-]{2,120})/i.exec(raw);
  if (m) return m[1];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && /^[A-Za-z0-9._:/-]{2,120}$/.test(lines[0])) {
    return lines[0];
  }
  return '';
}

function defaultExecFn(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const cwd = (typeof opts.cwd === 'string' && opts.cwd.trim() && fs.existsSync(opts.cwd.trim()))
      ? opts.cwd.trim()
      : undefined;
    const child = child_process.spawn(bin, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const killChild = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          child_process.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
          const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
          if (t.unref) t.unref();
        }
      } catch {}
    };

    const onAbort = () => {
      killChild();
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        killChild();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        killChild();
      }, opts.timeoutMs);
      if (timer.unref) timer.unref();
    }

    const done = (code, errMsg = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.signal) {
        try { opts.signal.removeEventListener('abort', onAbort); } catch {}
      }
      const exitCode = code !== null && code !== undefined ? Number(code) : 1;
      resolve({
        ok: exitCode === 0 && !errMsg,
        code: exitCode,
        stdout,
        stderr: errMsg ? (stderr ? `${stderr}\n${errMsg}` : errMsg) : stderr,
      });
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const s = chunk.toString('utf8');
        stdout = (stdout + s).slice(-16000);
        if (typeof opts.onOutput === 'function') opts.onOutput(s);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const s = chunk.toString('utf8');
        stderr = (stderr + s).slice(-16000);
        if (typeof opts.onOutput === 'function') opts.onOutput(s);
      });
    }
    child.on('close', (code) => done(code));
    child.on('error', (err) => done(1, err && err.message ? err.message : 'spawn failed'));
  });
}

async function probeColabUsage(execFn = null, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const bin = opts.bin || (execFn ? 'colab' : findColabBin(opts));
  if (!bin) {
    return {
      available: false,
      balanceCcu: null,
      burnRatePerHour: null,
      activeRuntimes: 0,
      error: '未检测到 colab CLI',
      raw: '',
      at: now(),
    };
  }
  const run = typeof execFn === 'function' ? execFn : defaultExecFn;
  try {
    const res = await run(bin, ['usage'], { timeoutMs: opts.timeoutMs || 20000 });
    const code = res && typeof res.code === 'number' ? res.code : (res && res.ok ? 0 : 1);
    const stdout = (res && res.stdout) || '';
    const stderr = (res && res.stderr) || '';
    if (code !== 0) {
      return {
        available: false,
        balanceCcu: null,
        burnRatePerHour: null,
        activeRuntimes: 0,
        error: cleanStr(stderr || stdout || `colab usage exit ${code}`, 200),
        raw: cleanStr(stdout || stderr, 1000),
        at: now(),
      };
    }
    const parsed = parseColabUsage(stdout, now);
    if (!parsed.available) {
      parsed.error = '无法解析 colab usage 的 CCU 余额';
    }
    return parsed;
  } catch (e) {
    return {
      available: false,
      balanceCcu: null,
      burnRatePerHour: null,
      activeRuntimes: 0,
      error: cleanStr((e && e.message) || 'colab usage 调用异常', 200),
      raw: '',
      at: now(),
    };
  }
}

function normalizeGpuList(gpu, fallbackGpus) {
  const list = [];
  const raw = [gpu || 'A100', ...(Array.isArray(fallbackGpus) ? fallbackGpus : DEFAULT_FALLBACK_GPUS)];
  for (const item of raw) {
    const g = cleanStr(String(item || ''), 24).toUpperCase();
    if (g && !list.includes(g)) list.push(g);
  }
  return list.length ? list : ['A100', 'L4', 'T4'];
}

function sessionFlagArgs(sessionId) {
  return sessionId ? ['--session', sessionId] : [];
}

async function runColabJob({
  jobId = '',
  gpu = 'A100',
  fallbackGpus = DEFAULT_FALLBACK_GPUS,
  command = '',
  cwd = '',
  uploadPaths = [],
  downloadPath = '',
  outputDir = '',
  maxDurationMin = DEFAULT_MAX_DURATION_MIN,
  minBalanceCcu = DEFAULT_MIN_BALANCE_CCU,
  onHeartbeat = null,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
  signal = null,
  execFn = null,
  bin = null,
  now = () => Date.now(),
} = {}) {
  const startMs = now();
  const cmdStr = cleanStr(command, 2000);
  if (!cmdStr) {
    return {
      ok: false,
      exitCode: 1,
      error: '缺少要执行的命令（command）',
      durationMs: 0,
      tail: '',
      stopped: false,
    };
  }

  const colabBin = bin || (execFn ? 'colab' : findColabBin());
  if (!colabBin) {
    return {
      ok: false,
      exitCode: 1,
      error: '本机未安装 colab CLI，无法执行 Google Colab 作业',
      durationMs: Math.max(0, now() - startMs),
      tail: '',
      stopped: false,
    };
  }

  const run = typeof execFn === 'function' ? execFn : defaultExecFn;
  const floorCcu = Number.isFinite(Number(minBalanceCcu)) ? Math.max(0, Number(minBalanceCcu)) : DEFAULT_MIN_BALANCE_CCU;
  const maxDurMin = Number.isFinite(Number(maxDurationMin)) && Number(maxDurationMin) > 0
    ? Number(maxDurationMin)
    : DEFAULT_MAX_DURATION_MIN;

  // 1) Pre-flight CCU balance red-line check
  const usage = await probeColabUsage(run, { bin: colabBin, now });
  if (!usage.available || usage.balanceCcu === null) {
    return {
      ok: false,
      exitCode: 1,
      error: `Colab 额度检查失败，拒绝开卡：${usage.error || '无法读取余额'}`,
      usage,
      rejectedByQuota: true,
      stopped: false,
      durationMs: Math.max(0, now() - startMs),
      tail: '',
    };
  }
  if (usage.balanceCcu < floorCcu) {
    return {
      ok: false,
      exitCode: 1,
      error: `Colab CCU 余额不足（当前 ${usage.balanceCcu} < 红线 ${floorCcu}），已拦截开卡止损`,
      usage,
      rejectedByQuota: true,
      stopped: false,
      durationMs: Math.max(0, now() - startMs),
      tail: '',
    };
  }

  // 2) Provision runtime with GPU fallback
  const gpuCandidates = normalizeGpuList(gpu, fallbackGpus);
  const triedGpus = [];
  let selectedGpu = '';
  let sessionId = '';
  let lastNewErr = '';

  for (const candidate of gpuCandidates) {
    if (signal && signal.aborted) {
      return {
        ok: false,
        exitCode: 1,
        error: '作业在申请 Colab 运行时前已被取消',
        cancelled: true,
        triedGpus,
        usage,
        stopped: false,
        durationMs: Math.max(0, now() - startMs),
        tail: '',
      };
    }
    triedGpus.push(candidate);
    try {
      const res = await run(colabBin, ['new', '--gpu', candidate], { cwd, timeoutMs: 120000, signal });
      const code = res && typeof res.code === 'number' ? res.code : (res && res.ok ? 0 : 1);
      if (code === 0) {
        selectedGpu = candidate;
        sessionId = parseSessionId(res && res.stdout);
        break;
      }
      lastNewErr = cleanStr((res && (res.stderr || res.stdout)) || `exit ${code}`, 200);
    } catch (e) {
      lastNewErr = cleanStr((e && e.message) || 'colab new 异常', 200);
    }
  }

  if (!selectedGpu) {
    return {
      ok: false,
      exitCode: 1,
      error: `无法申请 Colab GPU 运行时（已尝试 ${triedGpus.join(' -> ')}）：${lastNewErr || '无可用库存'}`,
      triedGpus,
      usage,
      stopped: false,
      durationMs: Math.max(0, now() - startMs),
      tail: '',
    };
  }

  // 3) Execute lifecycle inside try/finally to guarantee `colab stop`
  const rolling = [];
  const pushLines = (text) => {
    if (!text) return;
    for (const line of String(text).split(/\r?\n/)) {
      if (line.trim()) {
        rolling.push(line);
        if (rolling.length > 40) rolling.shift();
      }
    }
  };

  const execController = new AbortController();
  let timedOut = false;
  let cancelled = false;
  let ok = false;
  let exitCode = 1;
  let errMsg = '';
  let stopped = false;
  let stopError = '';

  const onExternalAbort = () => {
    cancelled = true;
    execController.abort();
  };
  if (signal) {
    if (signal.aborted) {
      onExternalAbort();
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  let hbTimer = null;
  if (typeof onHeartbeat === 'function' && heartbeatIntervalMs > 0) {
    hbTimer = setInterval(() => {
      try {
        onHeartbeat({
          jobId,
          sessionId,
          gpu: selectedGpu,
          elapsedMs: Math.max(0, now() - startMs),
        });
      } catch {}
    }, heartbeatIntervalMs);
    if (hbTimer.unref) hbTimer.unref();
  }

  const maxDurationMs = Math.max(1, Math.round(maxDurMin * 60 * 1000));
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    execController.abort();
  }, maxDurationMs);

  try {
    const sessArgs = sessionFlagArgs(sessionId);

    // 3a) Optional uploads
    const uploads = Array.isArray(uploadPaths)
      ? uploadPaths.map((p) => cleanStr(String(p || ''), 500)).filter(Boolean)
      : (typeof uploadPaths === 'string' && uploadPaths.trim() ? [uploadPaths.trim()] : []);

    for (const upPath of uploads) {
      if (execController.signal.aborted) break;
      const upRes = await run(colabBin, ['upload', ...sessArgs, upPath], {
        cwd,
        signal: execController.signal,
        onOutput: pushLines,
      });
      const upCode = upRes && typeof upRes.code === 'number' ? upRes.code : (upRes && upRes.ok ? 0 : 1);
      pushLines(upRes && upRes.stdout);
      pushLines(upRes && upRes.stderr);
      if (upCode !== 0) {
        exitCode = upCode;
        errMsg = `上传文件失败 (${upPath})：${cleanStr((upRes && (upRes.stderr || upRes.stdout)) || `exit ${upCode}`, 180)}`;
        throw new Error(errMsg);
      }
    }

    // 3b) Remote command execution
    if (!execController.signal.aborted) {
      const execRes = await run(colabBin, ['exec', ...sessArgs, cmdStr], {
        cwd,
        signal: execController.signal,
        onOutput: pushLines,
      });
      const code = execRes && typeof execRes.code === 'number' ? execRes.code : (execRes && execRes.ok ? 0 : 1);
      pushLines(execRes && execRes.stdout);
      pushLines(execRes && execRes.stderr);
      exitCode = code;
      if (code !== 0) {
        errMsg = cleanStr((execRes && execRes.stderr) || `colab exec 退出码 ${code}`, 200);
      } else {
        ok = true;
      }
    }

    // 3c) Optional artifact download
    const dlRemote = cleanStr(downloadPath, 300);
    const dlLocal = cleanStr(outputDir, 500);
    if (ok && !execController.signal.aborted && dlRemote && dlLocal) {
      const dlRes = await run(colabBin, ['download', ...sessArgs, dlRemote, dlLocal], {
        cwd,
        signal: execController.signal,
        onOutput: pushLines,
      });
      const dlCode = dlRes && typeof dlRes.code === 'number' ? dlRes.code : (dlRes && dlRes.ok ? 0 : 1);
      pushLines(dlRes && dlRes.stdout);
      pushLines(dlRes && dlRes.stderr);
      if (dlCode !== 0) {
        ok = false;
        exitCode = dlCode;
        errMsg = `下载产物失败 (${dlRemote} -> ${dlLocal})：${cleanStr((dlRes && (dlRes.stderr || dlRes.stdout)) || `exit ${dlCode}`, 180)}`;
      }
    }
  } catch (e) {
    ok = false;
    if (!errMsg) {
      errMsg = cleanStr((e && e.message) || 'Colab 作业执行异常', 200);
    }
  } finally {
    if (hbTimer) clearInterval(hbTimer);
    clearTimeout(timeoutTimer);
    if (signal) {
      try { signal.removeEventListener('abort', onExternalAbort); } catch {}
    }

    // Unconditionally stop the cloud runtime to prevent CCU billing leaks.
    try {
      const stopArgs = ['stop', ...sessionFlagArgs(sessionId)];
      const stopRes = await run(colabBin, stopArgs, { timeoutMs: 30000 });
      const stopCode = stopRes && typeof stopRes.code === 'number' ? stopRes.code : (stopRes && stopRes.ok ? 0 : 1);
      stopped = stopCode === 0;
      if (!stopped) {
        stopError = cleanStr((stopRes && (stopRes.stderr || stopRes.stdout)) || `colab stop exit ${stopCode}`, 180);
      }
    } catch (e) {
      stopped = false;
      stopError = cleanStr((e && e.message) || 'colab stop 异常', 180);
    }
  }

  if (timedOut) {
    ok = false;
    exitCode = 124;
    errMsg = `Colab 作业超过最大时长上限（${maxDurMin} 分钟），已强制终止并释放运行时`;
  } else if (cancelled) {
    ok = false;
    exitCode = 130;
    errMsg = 'Colab 作业已被手动中止并释放运行时';
  }

  if (!stopped && stopError) {
    const warn = `警告：colab stop 失败（${stopError}），请人工核查运行时状态`;
    errMsg = errMsg ? `${errMsg}；${warn}` : warn;
  }

  return {
    ok,
    exitCode,
    gpu: selectedGpu,
    triedGpus,
    sessionId,
    timedOut,
    cancelled,
    stopped,
    stopError,
    usage,
    durationMs: Math.max(0, now() - startMs),
    tail: rolling.join('\n').slice(-2000),
    error: errMsg,
  };
}

module.exports = {
  findColabBin,
  parseColabUsage,
  parseSessionId,
  probeColabUsage,
  runColabJob,
  DEFAULT_FALLBACK_GPUS,
  DEFAULT_MAX_DURATION_MIN,
  DEFAULT_MIN_BALANCE_CCU,
};
