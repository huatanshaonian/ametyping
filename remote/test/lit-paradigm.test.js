'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openKbStruct } = require('../server/literature/kb-struct');
const { createParadigm, CONTRADICTION_SCHEMA } = require('../server/literature/paradigm');

function makeMockEmbed(vecBySubstr, { failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async embed(texts) {
        calls.push(texts);
        if (failWith) throw failWith;
        const vectors = texts.map((t) => {
          for (const [needle, vec] of vecBySubstr) {
            if (t.includes(needle)) return vec;
          }
          return [0, 0, 1];
        });
        return { vectors };
      },
    },
  };
}

describe('paradigm.js (M4 claim clustering, contradiction analysis, paradigm matrix)', () => {
  let tmpDir;
  let kb;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-paradigm-'));
    kb = openKbStruct({ dir: tmpDir });
    assert.ok(kb);
  });

  afterEach(() => {
    if (kb) kb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports CONTRADICTION_SCHEMA with required verdict/topic/summary/param_diff', () => {
    assert.equal(CONTRADICTION_SCHEMA.type, 'object');
    assert.deepEqual(CONTRADICTION_SCHEMA.required, ['verdict', 'topic', 'summary', 'param_diff']);
    assert.deepEqual(CONTRADICTION_SCHEMA.properties.verdict.enum, ['consistent', 'contradiction', 'boundary_diff']);
  });

  it('clusterClaims groups cross-paper verified claims by cosine similarity and degrades gracefully offline', async () => {
    kb.replaceClaims('P1', 'plasma_rcs_v1', [
      { id: 'c1', condition: 'RAM-C II 71 km', conclusion: 'Peak ne is 1.2e12 cm^-3', metric: '1.2e12', page: 3, quote: 'q1', verified: 1 },
      { id: 'c1_unv', condition: 'RAM-C II 71 km', conclusion: 'Unverified peak ne 9e12', metric: '9e12', page: 3, quote: 'q_bad', verified: 0 },
    ]);
    kb.replaceClaims('P2', 'plasma_rcs_v1', [
      { id: 'c2', condition: 'RAM-C II 71 km catalytic wall', conclusion: 'Peak ne drops to 3.5e11 cm^-3', metric: '3.5e11', page: 5, quote: 'q2', verified: 1 },
      { id: 'c3', condition: 'Ka-band 35 GHz', conclusion: 'Weak plasma attenuation below 1 dB', metric: '1 dB', page: 6, quote: 'q3', verified: 1 },
    ]);
    // Same-paper-only pair (should NOT form a cross-paper cluster)
    kb.replaceClaims('P3', 'plasma_rcs_v1', [
      { id: 'c4', condition: 'S-band 3 GHz', conclusion: 'Blackout occurs at 61 km', metric: '30 dB', page: 4, quote: 'q4', verified: 1 },
      { id: 'c5', condition: 'S-band 3 GHz', conclusion: 'Signal loss exceeds 30 dB at 61 km', metric: '30 dB', page: 4, quote: 'q5', verified: 1 },
    ]);

    // Offline degradation: no embed
    const offlineP = createParadigm({ kbStruct: kb, embed: null });
    assert.deepEqual(await offlineP.clusterClaims('plasma_rcs_v1'), {
      ok: false,
      reason: 'embed-off',
      clusters: [],
    });

    // Offline degradation: embed throws
    const errEmbed = makeMockEmbed([], { failWith: new Error('embed timeout') });
    const errP = createParadigm({ kbStruct: kb, embed: errEmbed });
    const errRes = await errP.clusterClaims('plasma_rcs_v1');
    assert.equal(errRes.ok, false);
    assert.match(errRes.reason, /embed timeout/);
    assert.deepEqual(errRes.clusters, []);

    // Normal clustering: c1 & c2 close (cosine ~0.99), c4 & c5 close but same paper P3 (filtered out), c3 singleton
    const mockEmbed = makeMockEmbed([
      ['RAM-C II 71 km', [1, 0.05, 0]],
      ['S-band 3 GHz', [0, 1, 0]],
      ['Ka-band 35 GHz', [0, 0, 1]],
    ]);
    const p = createParadigm({ kbStruct: kb, embed: mockEmbed });
    const res = await p.clusterClaims('plasma_rcs_v1', { threshold: 0.72 });
    assert.equal(res.ok, true);
    assert.equal(res.clusters.length, 1);
    assert.deepEqual(res.clusters[0].claims.map((c) => c.id).sort(), ['c1', 'c2']);
    assert.ok(res.clusters[0].topic.includes('RAM-C II 71 km'));
    // Unverified claim c1_unv was excluded, so 5 verified claims were embedded in 1 batch
    assert.equal(mockEmbed.calls.length, 1);
    assert.equal(mockEmbed.calls[0].length, 5);

    // Fewer than 2 verified claims -> ok: true, empty clusters without calling embed
    const emptyRes = await offlineP.clusterClaims('aero_stealth_v1');
    assert.deepEqual(emptyRes, { ok: true, clusters: [] });
  });

  it('analyzeContradictions persists LLM verdicts to kb_struct and supports list & status updates', async () => {
    kb.saveEvidence({
      zoteroKey: 'P1',
      schemaId: 'plasma_rcs_v1',
      pdfMd5: 'm1',
      fields: {
        flow_chem_model: { value: 'Park 7-species non-catalytic', unit: '', page: 2, quote: 'q', verified: 1 },
        em_method: { value: 'ADE-FDTD', unit: '', page: 3, quote: 'q', verified: 1 },
      },
      verifiedRatio: 1,
      model: 'mock',
    });
    kb.saveEvidence({
      zoteroKey: 'P2',
      schemaId: 'plasma_rcs_v1',
      pdfMd5: 'm2',
      fields: {
        flow_chem_model: { value: 'Park 7-species fully-catalytic', unit: '', page: 2, quote: 'q', verified: 1 },
        em_method: { value: 'TMM', unit: '', page: 4, quote: 'q', verified: 1 },
      },
      verifiedRatio: 1,
      model: 'mock',
    });
    kb.replaceClaims('P1', 'plasma_rcs_v1', [
      { id: 'c1', condition: '71 km Mach 25.9', conclusion: 'Peak ne is 1.2e12 cm^-3', metric: '1.2e12', page: 3, quote: 'q1', verified: 1 },
    ]);
    kb.replaceClaims('P2', 'plasma_rcs_v1', [
      { id: 'c2', condition: '71 km Mach 25.9', conclusion: 'Peak ne is 3.5e11 cm^-3', metric: '3.5e11', page: 5, quote: 'q2', verified: 1 },
    ]);

    const mockEmbed = makeMockEmbed([['71 km Mach 25.9', [0.9, 0.1, 0]]]);
    const askCalls = [];
    const mockAsk = async (prompt, schema) => {
      askCalls.push({ prompt, schema });
      return {
        verdict: 'boundary_diff',
        topic: 'RAM-C II 71 km 峰值电子密度差异',
        summary: '两篇论文分别采用非催化与完全催化壁面假设，导致峰值电子密度相差约 3 倍。',
        param_diff: [
          { param: '壁面催化条件', values: ['P1: non-catalytic', 'P2: fully-catalytic'] },
        ],
      };
    };

    const p = createParadigm({ kbStruct: kb, embed: mockEmbed, ask: mockAsk });
    const analyzed = await p.analyzeContradictions('plasma_rcs_v1', { threshold: 0.72 });
    assert.equal(analyzed.ok, true);
    assert.equal(analyzed.analyzed, 1);
    assert.equal(analyzed.items.length, 1);
    assert.equal(analyzed.items[0].verdict, 'boundary_diff');
    assert.equal(analyzed.items[0].status, 'pending');
    assert.deepEqual(analyzed.items[0].paramDiff, [
      { param: '壁面催化条件', values: ['P1: non-catalytic', 'P2: fully-catalytic'] },
    ]);
    assert.equal(askCalls.length, 1);
    assert.match(askCalls[0].prompt, /non-catalytic/);
    assert.match(askCalls[0].prompt, /fully-catalytic/);
    assert.equal(askCalls[0].schema, CONTRADICTION_SCHEMA);

    // listContradictions & updateContradictionStatus
    const listed = p.listContradictions('plasma_rcs_v1');
    assert.equal(listed.length, 1);
    const id = listed[0].id;

    const confirmed = p.updateContradictionStatus(id, 'confirmed');
    assert.equal(confirmed.status, 'confirmed');
    const dismissed = p.updateContradictionStatus(id, 'dismissed');
    assert.equal(dismissed.status, 'dismissed');

    assert.throws(() => p.updateContradictionStatus(id, 'invalid_status'), /无效的矛盾状态/);

    // Offline degradation when embed is missing
    const offline = createParadigm({ kbStruct: kb, embed: null, ask: mockAsk });
    const offRes = await offline.analyzeContradictions('plasma_rcs_v1');
    assert.equal(offRes.ok, false);
    assert.equal(offRes.analyzed, 0);
    assert.deepEqual(offRes.items, []);
  });

  it('buildMatrix aggregates row/col fields, labels empty values as 未说明, and identifies gaps', () => {
    const add = (key, flow, em) => {
      kb.saveEvidence({
        zoteroKey: key,
        schemaId: 'plasma_rcs_v1',
        pdfMd5: 'md5_' + key,
        fields: {
          flow_chem_model: { value: flow, unit: '', page: 1, quote: 'q', verified: 1 },
          em_method: { value: em, unit: '', page: 1, quote: 'q', verified: 1 },
        },
        verifiedRatio: 1,
        model: 'mock',
      });
    };
    add('K1', 'Park 7-species', 'ADE-FDTD');
    add('K2', 'Park 7-species', 'ADE-FDTD');
    add('K3', 'Park 11-species', 'WKB');
    add('K4', '', 'ADE-FDTD');

    const p = createParadigm({ kbStruct: kb });
    const m = p.buildMatrix('plasma_rcs_v1', { rowField: 'flow_chem_model', colField: 'em_method' });

    assert.equal(m.schemaId, 'plasma_rcs_v1');
    assert.equal(m.rowField, 'flow_chem_model');
    assert.equal(m.colField, 'em_method');
    assert.equal(m.totalPapers, 4);
    assert.deepEqual(m.rows, ['Park 7-species', 'Park 11-species', '未说明']);
    assert.deepEqual(m.cols, ['ADE-FDTD', 'WKB']);
    assert.equal(m.cells['Park 7-species']['ADE-FDTD'].count, 2);
    assert.deepEqual(m.cells['Park 7-species']['ADE-FDTD'].keys.sort(), ['K1', 'K2']);
    assert.equal(m.cells['Park 11-species']['WKB'].count, 1);
    assert.equal(m.cells['未说明']['ADE-FDTD'].count, 1);
    // Gaps only include non-empty (non-未说明) row/col pairs with count === 0
    assert.deepEqual(m.gaps, [
      { row: 'Park 7-species', col: 'WKB' },
      { row: 'Park 11-species', col: 'ADE-FDTD' },
    ]);
  });
});
