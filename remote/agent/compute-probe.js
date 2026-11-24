// Local hardware busy probe (GPU via nvidia-smi + CPU load) for AmeMesh Mini-Slurm compute queue.
// Zero external dependencies; gracefully degrades when nvidia-smi is absent.
'use strict';
const os = require('os');
const child_process = require('child_process');

const DEFAULT_GPU_MEM_RATIO = 0.15; // >= 15% VRAM used -> external GPU process active
const DEFAULT_GPU_UTIL_PCT = 25;    // >= 25% GPU utilization -> busy
const DEFAULT_CPU_LOAD_RATIO = 0.85;

function probeGpu({ memRatioThreshold = DEFAULT_GPU_MEM_RATIO, utilThreshold = DEFAULT_GPU_UTIL_PCT } = {}) {
  try {
    const out = child_process.execFileSync(
      'nvidia-smi',
      ['--query-gpu=index,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const gpus = [];
    for (const line of String(out || '').split(/\r?\n/)) {
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length < 4) continue;
      const index = Number(parts[0]);
      const utilPct = Number(parts[1]);
      const memUsedMb = Number(parts[2]);
      const memTotalMb = Number(parts[3]);
      if (!Number.isFinite(index) || !Number.isFinite(memTotalMb) || memTotalMb <= 0) continue;
      const memRatio = memUsedMb / memTotalMb;
      const busy = memRatio >= memRatioThreshold || (Number.isFinite(utilPct) && utilPct >= utilThreshold);
      gpus.push({ index, utilPct: Number.isFinite(utilPct) ? utilPct : 0, memUsedMb, memTotalMb, busy });
    }
    if (!gpus.length) return { hasGpu: false, gpus: [], gpuBusy: false };
    // Machine GPU is considered busy if ALL GPUs are busy (single-GPU workstation: GPU 0 busy)
    const gpuBusy = gpus.every((g) => g.busy);
    return { hasGpu: true, gpus, gpuBusy };
  } catch {
    return { hasGpu: false, gpus: [], gpuBusy: false };
  }
}

function probeCpu({ loadRatioThreshold = DEFAULT_CPU_LOAD_RATIO } = {}) {
  const cores = Math.max(1, (os.cpus() || []).length);
  const load1 = Array.isArray(os.loadavg()) ? Number(os.loadavg()[0]) || 0 : 0;
  // On Windows os.loadavg() always returns [0, 0, 0]; treat as not overloaded unless explicitly measured
  const loadRatio = process.platform === 'win32' ? 0 : load1 / cores;
  return {
    cores,
    load1: Number(load1.toFixed(2)),
    loadRatio: Number(loadRatio.toFixed(3)),
    cpuBusy: loadRatio >= loadRatioThreshold,
  };
}

function probeCompute(opts = {}) {
  const gpu = probeGpu(opts);
  const cpu = probeCpu(opts);
  return {
    at: Date.now(),
    ...gpu,
    ...cpu,
  };
}

module.exports = { probeGpu, probeCpu, probeCompute };
