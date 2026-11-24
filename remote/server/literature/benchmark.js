// Classic benchmark reproduction manager (docs/literature-kb-architecture.md, M6 / M3-B).
// Records and executes Python (+ CuPy / NumPy) benchmark scripts locally or on remote3090 via SSH,
// enforces .npz full-artifact persistence, and writes results back to kb_struct.sqlite `benchmarks`.
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const VALID_STATUSES = new Set(['reproduced', 'mismatch', 'failed']);

function parseLastJsonLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.startsWith('{') && l.endsWith('}')) {
      try { return JSON.parse(l); } catch {}
    }
  }
  return null;
}

function createBenchmark({ kbStruct, dir = '', log = () => {} } = {}) {
  if (!kbStruct) throw new Error('createBenchmark requires kbStruct');

  function list({ status = null, zoteroKey = null } = {}) {
    let rows = kbStruct.listBenchmarks({ status: status || null });
    if (zoteroKey) {
      const k = String(zoteroKey).trim();
      rows = rows.filter((r) => Array.isArray(r.zoteroKeys) && r.zoteroKeys.includes(k));
    }
    return rows;
  }

  function get(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return kbStruct.listBenchmarks().find((r) => r.id === key) || null;
  }

  function record({ id, title, zoteroKeys = [], scriptPath = '', npzPath = '', status = 'failed', errorSummary = '' } = {}) {
    const bid = String(id || '').trim();
    if (!bid) throw new Error('benchmark id 不能为空');
    const st = String(status || '').trim();
    if (!VALID_STATUSES.has(st)) {
      throw new Error(`无效的 benchmark status：${st}（仅允许 reproduced / mismatch / failed）`);
    }
    const npz = String(npzPath || '').trim();
    if (st !== 'failed' && (!npz || !/\.npz$/i.test(npz))) {
      throw new Error('成功或偏差对照算例必须提供 .npz 全量产物路径');
    }
    const keys = Array.isArray(zoteroKeys)
      ? zoteroKeys.map((k) => String(k || '').trim()).filter(Boolean)
      : [];
    return kbStruct.saveBenchmark({
      id: bid,
      title: String(title || bid).trim(),
      zoteroKeys: keys,
      scriptPath: String(scriptPath || '').trim(),
      npzPath: npz,
      status: st,
      errorSummary: String(errorSummary || '').trim(),
    });
  }

  function runScript({
    scriptPath,
    pythonBin = 'python',
    sshHost = '',
    outDir = '',
    args = [],
    timeoutMs = 300000,
    spawnSync = cp.spawnSync,
  } = {}) {
    if (!scriptPath) throw new Error('runScript 缺少 scriptPath');
    const extraArgs = Array.isArray(args) ? args.map(String) : [];
    const targetOutDir = outDir || (dir ? path.join(dir, 'benchmarks') : '');
    if (!sshHost && targetOutDir) fs.mkdirSync(targetOutDir, { recursive: true });

    let r;
    if (sshHost) {
      const remoteCmd = [pythonBin, scriptPath, ...extraArgs]
        .map((a) => `'${String(a).replace(/'/g, "'\\''")}'`)
        .join(' ');
      r = spawnSync('ssh', ['-o', 'BatchMode=yes', String(sshHost), remoteCmd], {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
    } else {
      r = spawnSync(pythonBin, [scriptPath, ...extraArgs], {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
    }

    if (r.error) throw r.error;
    const summary = parseLastJsonLine(r.stdout);
    if (!summary) {
      throw new Error(`基准脚本未输出 JSON 摘要（exit=${r.status}）：${String(r.stderr || r.stdout || '').slice(0, 400)}`);
    }
    const saved = record({
      id: summary.id || path.basename(scriptPath, path.extname(scriptPath)),
      title: summary.title || summary.id || path.basename(scriptPath),
      zoteroKeys: summary.zoteroKeys || summary.zotero_keys || [],
      scriptPath,
      npzPath: summary.npzPath || summary.npz_path || '',
      status: r.status === 0 ? (summary.status || 'reproduced') : 'failed',
      errorSummary: summary.errorSummary || summary.error_summary || (r.status !== 0 ? String(r.stderr || '').slice(0, 300) : ''),
    });
    log(`基准复算完成：${saved.id} [${saved.status}] ${saved.errorSummary}`);
    return { saved, metrics: summary.metrics || null, stdout: r.stdout, stderr: r.stderr };
  }

  return { list, get, record, runScript, parseLastJsonLine, VALID_STATUSES };
}

module.exports = { createBenchmark, parseLastJsonLine, VALID_STATUSES };
