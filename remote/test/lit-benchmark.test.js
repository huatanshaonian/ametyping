'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openKbStruct } = require('../server/literature/kb-struct');
const { createBenchmark, parseLastJsonLine } = require('../server/literature/benchmark');

function withTmpKb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-bench-'));
  const kbStruct = openKbStruct({ dir });
  try {
    return fn({ dir, kbStruct });
  } finally {
    kbStruct.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('benchmark record/list/get persists to kb_struct.sqlite and validates inputs', () => {
  withTmpKb(({ dir, kbStruct }) => {
    const bench = createBenchmark({ kbStruct, dir });

    assert.throws(() => bench.record({ id: '', status: 'reproduced', npzPath: '/tmp/a.npz' }), /id/);
    assert.throws(() => bench.record({ id: 'b1', status: 'unknown', npzPath: '/tmp/a.npz' }), /status/);
    assert.throws(() => bench.record({ id: 'b1', status: 'reproduced', npzPath: '/tmp/a.json' }), /\.npz/);

    const saved = bench.record({
      id: 'bench_tmm_1d',
      title: '1D TMM Plasma Slab',
      zoteroKeys: ['3CMZCDDL', 'YT6UVX53'],
      scriptPath: 'tools/benchmarks/bench_plasma_tmm_1d.py',
      npzPath: '/data/bench_tmm_1d.npz',
      status: 'reproduced',
      errorSummary: 'RMSE=0.04 dB',
    });

    assert.equal(saved.id, 'bench_tmm_1d');
    assert.equal(saved.status, 'reproduced');
    assert.deepEqual(saved.zoteroKeys, ['3CMZCDDL', 'YT6UVX53']);

    assert.equal(bench.get('bench_tmm_1d').npzPath, '/data/bench_tmm_1d.npz');
    assert.equal(bench.list({ status: 'reproduced' }).length, 1);
    assert.equal(bench.list({ zoteroKey: '3CMZCDDL' }).length, 1);
    assert.equal(bench.list({ zoteroKey: 'NOPE' }).length, 0);
  });
});

test('benchmark runScript parses last JSON line and saves to kb_struct.sqlite', () => {
  withTmpKb(({ dir, kbStruct }) => {
    const bench = createBenchmark({ kbStruct, dir });
    const fakeSpawn = () => ({
      status: 0,
      stdout: 'loading numpy...\n{"id":"bench_ade","title":"ADE-FDTD","zoteroKeys":["3CMZCDDL"],"npzPath":"/tmp/ade.npz","status":"reproduced","errorSummary":"R RMSE=0.08dB","metrics":{"R_rmse_db":0.08}}\n',
      stderr: '',
    });

    const out = bench.runScript({
      scriptPath: 'tools/benchmarks/bench_plasma_ade_fdtd_1d.py',
      sshHost: 'remote3090',
      spawnSync: fakeSpawn,
    });

    assert.equal(out.saved.id, 'bench_ade');
    assert.equal(out.saved.status, 'reproduced');
    assert.equal(out.metrics.R_rmse_db, 0.08);
    assert.equal(bench.get('bench_ade').errorSummary, 'R RMSE=0.08dB');
    assert.deepEqual(parseLastJsonLine('noise\n{"ok":true}\n'), { ok: true });
  });
});
