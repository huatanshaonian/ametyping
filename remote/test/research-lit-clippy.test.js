'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openKbStruct } = require('../server/literature/kb-struct');
const { createParadigm } = require('../server/literature/paradigm');
const { createDirectories } = require('../server/research/directories');

test('paradigm buildMatrix canonicalizes free-text methods into compact buckets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-paradigm-m3-'));
  const kbStruct = openKbStruct({ dir });
  try {
    kbStruct.saveEvidence({
      zoteroKey: 'P1',
      schemaId: 'plasma_rcs_v1',
      pdfMd5: 'm1',
      fields: {
        flow_chem_model: { value: 'Park 7-species two-temperature Navier-Stokes', verified: true },
        em_method: { value: '3D ADE-FDTD with Drude dispersion', verified: true },
      },
      verifiedRatio: 1,
      model: 'test',
    });
    kbStruct.saveEvidence({
      zoteroKey: 'P2',
      schemaId: 'plasma_rcs_v1',
      pdfMd5: 'm2',
      fields: {
        flow_chem_model: { value: 'Park 7-species CFD model', verified: true },
        em_method: { value: 'Auxiliary Differential Equation FDTD', verified: true },
      },
      verifiedRatio: 1,
      model: 'test',
    });
    kbStruct.saveEvidence({
      zoteroKey: 'P3',
      schemaId: 'plasma_rcs_v1',
      pdfMd5: 'm3',
      fields: {
        flow_chem_model: { value: 'Uniform slab plasma profile', verified: true },
        em_method: { value: 'PLRC-FDTD formulation', verified: true },
      },
      verifiedRatio: 1,
      model: 'test',
    });

    const paradigm = createParadigm({ kbStruct });
    const mat = paradigm.buildMatrix('plasma_rcs_v1');
    assert.ok(mat.rows.includes('Park 7-species'), `rows=${JSON.stringify(mat.rows)}`);
    assert.ok(mat.cols.includes('ADE-FDTD'), `cols=${JSON.stringify(mat.cols)}`);
    assert.ok(mat.cols.includes('PLRC-FDTD'), `cols=${JSON.stringify(mat.cols)}`);
    assert.equal(mat.cells['Park 7-species']['ADE-FDTD'].count, 2);
  } finally {
    kbStruct.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Clippy askAssistant injects verified literature evidence, contradictions, and benchmarks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-clippy-lit-'));
  const kbStruct = openKbStruct({ dir });
  const { openVault } = require('../server/vault/database');
  const { createResearchStore } = require('../server/research/database');
  const vault = openVault(dir);
  createResearchStore(vault);
  try {
    kbStruct.saveEvidence({
      zoteroKey: '3CMZCDDL',
      schemaId: 'plasma_rcs_v1',
      pdfMd5: 'abc',
      fields: {
        em_method: { value: 'ADE-FDTD', page: 2, quote: 'ADE-FDTD', verified: true },
        key_result: { value: '10 GHz reflection -1.02 dB', page: 4, quote: '-1.02 dB', verified: true },
      },
      verifiedRatio: 1,
      model: 'gemini-2.5-flash',
    });
    kbStruct.saveContradiction({
      id: 'c1',
      schemaId: 'plasma_rcs_v1',
      topic: 'FDTD dispersion accuracy',
      claimIds: ['cl1', 'cl2'],
      verdict: 'boundary_diff',
      summary: 'PLRC-FDTD shows lower phase error than RC-FDTD near cutoff.',
      paramDiff: [],
      status: 'confirmed',
    });
    kbStruct.saveBenchmark({
      id: 'bench_plasma_ade_fdtd_1d',
      title: '1D ADE-FDTD vs TMM',
      zoteroKeys: ['3CMZCDDL'],
      scriptPath: 'tools/benchmarks/bench_plasma_ade_fdtd_1d.py',
      npzPath: '/tmp/ade.npz',
      status: 'reproduced',
      errorSummary: 'R RMSE=0.076dB',
    });

    let capturedPrompt = '';
    const fakeMagpie = {
      run: async ({ prompt }) => {
        capturedPrompt = prompt;
        return {
          parsed: {
            mood: 'explain',
            headline: 'ADE-FDTD 复算误差 0.076 dB',
            answer: '根据文献 3CMZCDDL（p.4）与基准复算结果，误差在 0.076 dB 以内。',
            key_results: ['R RMSE = 0.076 dB'],
            locations: [],
            evidence_refs: [],
            follow_ups: ['是否扩展到二维柱体？'],
          },
        };
      },
    };

    const dirs = createDirectories({
      vault,
      review: { catalog: () => [{ id: 'p1', name: 'CEM', directories: [] }] },
      getMagpie: () => fakeMagpie,
      getEmbed: () => ({
        search: {
          queryMemories: async () => ({ ok: true, items: [] }),
          querySessions: async () => ({ ok: true, sessions: [] }),
          queryLit: async () => ({ ok: true, items: [{ key: '3CMZCDDL', score: 0.92 }] }),
        },
      }),
      getLit: () => ({
        kbStruct,
        mirror: { item: (k) => (k === '3CMZCDDL' ? { key: k, title: 'Luebbers 1991 Plasma FDTD', year: 1991 } : null) },
      }),
      listProjects: () => [{ id: 'p1', name: 'CEM' }],
    });

    const out = await dirs.askAssistant({ project: 'p1', scope: 'all', question: 'ADE-FDTD 等离子体平板误差是多少？' });
    assert.ok(capturedPrompt.includes('输入 5：已核验的结构化文献证据表'), 'prompt should include section 5');
    assert.ok(capturedPrompt.includes('3CMZCDDL'), 'prompt should include zoteroKey');
    assert.ok(capturedPrompt.includes('bench_plasma_ade_fdtd_1d'), 'prompt should include benchmark');
    assert.equal(out.litEvidence.length, 1);
    assert.equal(out.litEvidence[0].zoteroKey, '3CMZCDDL');
  } finally {
    kbStruct.close();
    vault.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
