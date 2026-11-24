// Local hardware busy probe (per-GPU via nvidia-smi + CPU/NUMA topology) for AmeMesh Mini-Slurm compute queue.
// Zero external dependencies; gracefully degrades when nvidia-smi or Linux sysfs NUMA is absent.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

const DEFAULT_GPU_MEM_RATIO = 0.15; // >= 15% VRAM used -> external GPU process active
const DEFAULT_GPU_UTIL_PCT = 25;    // >= 25% GPU utilization -> busy
const DEFAULT_CPU_LOAD_RATIO = 0.85;

function parseCpuListCount(cpuList) {
  const s = String(cpuList || '').trim();
  if (!s) return 0;
  let total = 0;
  for (const part of s.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const range = seg.split('-');
    if (range.length === 2) {
      const a = Number(range[0]);
      const b = Number(range[1]);
      if (Number.isInteger(a) && Number.isInteger(b) && b >= a) total += (b - a + 1);
    } else {
      const n = Number(seg);
      if (Number.isInteger(n) && n >= 0) total += 1;
    }
  }
  return total;
}

function normalizePciBusId(pciBusId) {
  const raw = String(pciBusId || '').trim().toLowerCase();
  if (!raw) return '';
  // nvidia-smi reports 8-digit domain (00000000:73:00.0), Linux sysfs uses 4-digit domain (0000:73:00.0)
  return raw.replace(/^0000([0-9a-f]{4}:)/, '$1');
}

function readPciNumaNode(pciBusId, { pciDevicesDir = '/sys/bus/pci/devices', fsImpl = fs } = {}) {
  if (!pciBusId) return null;
  const raw = String(pciBusId).trim().toLowerCase();
  const norm = normalizePciBusId(raw);
  const candidates = norm && norm !== raw ? [norm, raw] : [raw];
  for (const bus of candidates) {
    try {
      const txt = fsImpl.readFileSync(path.join(pciDevicesDir, bus, 'numa_node'), 'utf8').trim();
      const val = Number(txt);
      if (Number.isInteger(val) && val >= 0) return val;
    } catch {}
  }
  return null;
}

function parseNvidiaSmiOutput(out, {
  memRatioThreshold = DEFAULT_GPU_MEM_RATIO,
  utilThreshold = DEFAULT_GPU_UTIL_PCT,
  readNumaNode = (bus) => (process.platform === 'linux' ? readPciNumaNode(bus) : null),
} = {}) {
  const gpus = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',').map((s) => s.trim());
    let index;
    let name = '';
    let pciBusId = '';
    let utilPct;
    let memUsedMiB;
    let memTotalMiB;

    if (parts.length >= 6) {
      // index, name, pci.bus_id, utilization.gpu, memory.used, memory.total
      index = Number(parts[0]);
      name = parts[1];
      pciBusId = parts[2];
      utilPct = Number(parts[3]);
      memUsedMiB = Number(parts[4]);
      memTotalMiB = Number(parts[5]);
    } else if (parts.length >= 4) {
      // Legacy 4-column format: index, utilization.gpu, memory.used, memory.total
      index = Number(parts[0]);
      utilPct = Number(parts[1]);
      memUsedMiB = Number(parts[2]);
      memTotalMiB = Number(parts[3]);
    } else {
      continue;
    }

    if (!Number.isFinite(index) || !Number.isFinite(memTotalMiB) || memTotalMiB <= 0) continue;
    const safeUsed = Number.isFinite(memUsedMiB) ? memUsedMiB : 0;
    const safeUtil = Number.isFinite(utilPct) ? utilPct : 0;
    const memRatio = safeUsed / memTotalMiB;
    const busy = memRatio >= memRatioThreshold || safeUtil >= utilThreshold;
    const numaNode = pciBusId && typeof readNumaNode === 'function' ? readNumaNode(pciBusId) : null;
    gpus.push({
      index: Math.trunc(index),
      name,
      ...(pciBusId ? { pciBusId } : {}),
      memUsedMiB: safeUsed,
      memTotalMiB,
      // Backward-compatible aliases
      memUsedMb: safeUsed,
      memTotalMb: memTotalMiB,
      utilPct: safeUtil,
      busy,
      numaNode: Number.isInteger(numaNode) && numaNode >= 0 ? numaNode : null,
    });
  }
  gpus.sort((a, b) => a.index - b.index);
  return gpus;
}

function probeGpu({ memRatioThreshold = DEFAULT_GPU_MEM_RATIO, utilThreshold = DEFAULT_GPU_UTIL_PCT, execFileSync = child_process.execFileSync, readNumaNode } = {}) {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=index,name,pci.bus_id,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const gpus = parseNvidiaSmiOutput(out, { memRatioThreshold, utilThreshold, readNumaNode });
    if (!gpus.length) return { hasGpu: false, gpus: [], gpuBusy: false };
    // Backward-compatible machine-level gpuBusy: true when ALL GPUs are busy
    const gpuBusy = gpus.every((g) => g.busy);
    return { hasGpu: true, gpus, gpuBusy };
  } catch {
    return { hasGpu: false, gpus: [], gpuBusy: false };
  }
}

function readNumaNodes({
  cores = 1,
  cpuBusy = false,
  platform = process.platform,
  numaDir = '/sys/devices/system/node',
  fsImpl = fs,
} = {}) {
  const safeCores = Math.max(1, Number(cores) || 1);
  if (platform === 'linux') {
    try {
      const entries = fsImpl.readdirSync(numaDir, { withFileTypes: true });
      const nodeIds = [];
      for (const ent of entries) {
        const name = typeof ent === 'string' ? ent : ent.name;
        const m = /^node(\d+)$/.exec(name);
        if (m) nodeIds.push(Number(m[1]));
      }
      nodeIds.sort((a, b) => a - b);
      const nodes = [];
      for (const id of nodeIds) {
        try {
          const cpuList = fsImpl.readFileSync(path.join(numaDir, `node${id}`, 'cpulist'), 'utf8').trim();
          const count = parseCpuListCount(cpuList);
          if (count > 0 || cpuList) {
            nodes.push({
              id,
              cpuList,
              cpuCount: count || Math.max(1, Math.floor(safeCores / nodeIds.length)),
              busy: Boolean(cpuBusy),
            });
          }
        } catch {}
      }
      if (nodes.length > 0) return nodes;
    } catch {}
  }
  // Windows / macOS / single-socket fallback: 1 NUMA slot covering all logical CPUs
  return [
    {
      id: 0,
      cpuList: safeCores > 1 ? `0-${safeCores - 1}` : '0',
      cpuCount: safeCores,
      busy: Boolean(cpuBusy),
    },
  ];
}

function probeCpu({ loadRatioThreshold = DEFAULT_CPU_LOAD_RATIO, platform = process.platform, numaDir = '/sys/devices/system/node', fsImpl = fs } = {}) {
  const cores = Math.max(1, (os.cpus() || []).length);
  const load1 = Array.isArray(os.loadavg()) ? Number(os.loadavg()[0]) || 0 : 0;
  // On Windows os.loadavg() always returns [0, 0, 0]; treat as not overloaded unless explicitly measured
  const loadRatio = platform === 'win32' ? 0 : load1 / cores;
  const cpuBusy = loadRatio >= loadRatioThreshold;
  const numaNodes = readNumaNodes({ cores, cpuBusy, platform, numaDir, fsImpl });
  return {
    cores,
    cpuCount: cores,
    load1: Number(load1.toFixed(2)),
    loadRatio: Number(loadRatio.toFixed(3)),
    cpuBusy,
    numaNodes,
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

module.exports = {
  probeGpu,
  probeCpu,
  probeCompute,
  parseNvidiaSmiOutput,
  parseCpuListCount,
  normalizePciBusId,
  readPciNumaNode,
  readNumaNodes,
};
