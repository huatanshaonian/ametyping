'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openKbStruct, SCHEMA_VERSION } = require('../server/literature/kb-struct');
const {
  SCHEMAS,
  getSchema,
  listSchemas,
  buildExtractSchema,
  verifyQuote,
  verifyExtraction,
  normalizeForMatch,
} = require('../server/literature/evidence-schemas');

describe('kb-struct.js (kb_struct.sqlite)', () => {
  let tmpDir;
  let kb;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-kb-struct-'));
    kb = openKbStruct({ dir: tmpDir });
    assert.ok(kb, 'openKbStruct should return a store instance');
  });

  afterEach(() => {
    if (kb) kb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports SCHEMA_VERSION = "1" and initializes empty stats for all 4 tables', () => {
    assert.equal(SCHEMA_VERSION, '1');
    const st = kb.stats();
    assert.equal(st.file, path.join(tmpDir, 'kb_struct.sqlite'));
    assert.equal(st.evidence, 0);
    assert.equal(st.claims, 0);
    assert.equal(st.verifiedClaims, 0);
    assert.equal(st.contradictions, 0);
    assert.equal(st.benchmarks, 0);
  });

  it('supports paper_evidence save, get, list, queryEvidence filtering, and verifyEvidence human revision', () => {
    kb.saveEvidence({
      zoteroKey: 'KEY_RAMC',
      schemaId: 'plasma_rcs_v1',
      pdfMd5: 'md5_aaa',
      fields: {
        flight_condition: { value: 'Mach 25.9, 71 km', unit: '', page: 3, quote: 'At 71 km altitude, Mach 25.9', verified: 1 },
        em_method: { value: 'ADE-FDTD', unit: '', page: 4, quote: 'using ADE-FDTD method', verified: 1 },
        freq_pol: { value: 'X-band 10 GHz HH', unit: 'GHz', page: 5, quote: 'X-band 10 GHz HH polarization', verified: 1 },
      },
      verifiedRatio: 1,
      humanVerified: 0,
      model: 'gemini-2.5-flash',
    });

    kb.saveEvidence({
      zoteroKey: 'KEY_MOM',
      schemaId: 'plasma_rcs_v1',
      pdfMd5: 'md5_bbb',
      fields: {
        flight_condition: { value: 'Mach 15, 50 km', unit: '', page: 2, quote: 'Mach 15 at 50 km', verified: 1 },
        em_method: { value: 'Volume MoM', unit: '', page: 2, quote: 'unverified quote', verified: 0 },
        freq_pol: { value: 'Ka-band 35 GHz VV', unit: 'GHz', page: 3, quote: '35 GHz VV', verified: 1 },
      },
      verifiedRatio: 2 / 3,
      humanVerified: 0,
      model: 'gemini-2.5-flash',
    });

    const got = kb.getEvidence('KEY_RAMC', 'plasma_rcs_v1');
    assert.equal(got.zoteroKey, 'KEY_RAMC');
    assert.equal(got.pdfMd5, 'md5_aaa');
    assert.equal(got.fields.em_method.value, 'ADE-FDTD');
    assert.equal(got.verifiedRatio, 1);
    assert.equal(got.humanVerified, 0);
    assert.equal(kb.getEvidence('MISSING', 'plasma_rcs_v1'), null);

    // listEvidence & onlyVerified
    assert.equal(kb.listEvidence('plasma_rcs_v1').length, 2);
    const verifiedOnly = kb.listEvidence('plasma_rcs_v1', { onlyVerified: true });
    assert.equal(verifiedOnly.length, 1);
    assert.equal(verifiedOnly[0].zoteroKey, 'KEY_RAMC');

    // queryEvidence case-insensitive substring matching
    const q1 = kb.queryEvidence({ schemaId: 'plasma_rcs_v1', filters: { em_method: 'fdtd', freq_pol: '10 ghz' } });
    assert.equal(q1.length, 1);
    assert.equal(q1[0].zoteroKey, 'KEY_RAMC');

    const q2 = kb.queryEvidence({ schemaId: 'plasma_rcs_v1', filters: { em_method: 'mom' } });
    assert.equal(q2.length, 1);
    assert.equal(q2[0].zoteroKey, 'KEY_MOM');

    const q3 = kb.queryEvidence({ schemaId: 'plasma_rcs_v1', filters: { em_method: 'mom' }, onlyVerified: true });
    assert.equal(q3.length, 0);

    // Human verification & revision sets human_verified = 1
    const revised = kb.verifyEvidence({
      zoteroKey: 'KEY_MOM',
      schemaId: 'plasma_rcs_v1',
      fields: {
        ...kb.getEvidence('KEY_MOM', 'plasma_rcs_v1').fields,
        em_method: { value: 'Volume MoM (confirmed)', unit: '', page: 2, quote: 'verified by human', verified: 1 },
      },
    });
    assert.equal(revised.humanVerified, 1);
    assert.equal(revised.verifiedRatio, 1);
    assert.equal(revised.fields.em_method.value, 'Volume MoM (confirmed)');

    const q4 = kb.queryEvidence({ schemaId: 'plasma_rcs_v1', filters: { em_method: 'confirmed' }, onlyVerified: true });
    assert.equal(q4.length, 1);
    assert.equal(q4[0].zoteroKey, 'KEY_MOM');
  });

  it('supports paper_claims transactional replaceClaims and filtered listClaims', () => {
    kb.replaceClaims('KEY_1', 'plasma_rcs_v1', [
      { id: 'c1', condition: '71 km, Mach 25.9', conclusion: 'Peak ne reaches 1e12 cm^-3', metric: '1e12 cm^-3', page: 5, quote: 'peak ne reaches 1e12 cm^-3', verified: 1 },
      { id: 'c2', condition: '61 km, Mach 25.9', conclusion: 'Attenuation > 20 dB at X-band', metric: '20 dB', page: 7, quote: 'hallucinated quote', verified: 0 },
    ]);
    kb.replaceClaims('KEY_2', 'plasma_rcs_v1', [
      { condition: '81 km', conclusion: 'Weak attenuation < 2 dB', metric: '2 dB', page: 3, quote: 'weak attenuation below 2 dB', verified: 1 },
    ]);

    assert.equal(kb.listClaims({ schemaId: 'plasma_rcs_v1' }).length, 3);
    assert.equal(kb.listClaims({ schemaId: 'plasma_rcs_v1', zoteroKey: 'KEY_1' }).length, 2);
    assert.equal(kb.listClaims({ schemaId: 'plasma_rcs_v1', onlyVerified: true }).length, 2);
    assert.equal(kb.stats().claims, 3);
    assert.equal(kb.stats().verifiedClaims, 2);

    // Replace KEY_1 claims should delete old ones and insert new ones atomically
    kb.replaceClaims('KEY_1', 'plasma_rcs_v1', [
      { condition: '71 km updated', conclusion: 'Updated conclusion', metric: '1.2e12 cm^-3', page: 6, quote: 'updated quote text', verified: 1 },
    ]);
    const k1Claims = kb.listClaims({ schemaId: 'plasma_rcs_v1', zoteroKey: 'KEY_1' });
    assert.equal(k1Claims.length, 1);
    assert.equal(k1Claims[0].condition, '71 km updated');
    assert.equal(kb.stats().claims, 2);
    assert.equal(kb.stats().verifiedClaims, 2);
  });

  it('supports claim_contradictions and benchmarks CRUD and reflects counts in stats()', () => {
    const c = kb.saveContradiction({
      id: 'contra_1',
      schemaId: 'plasma_rcs_v1',
      topic: '71 km RAM-C II peak ne',
      claimIds: ['c1', 'c2'],
      verdict: 'boundary_diff',
      summary: 'Different catalytic wall boundary assumptions',
      paramDiff: { wall: ['non-catalytic', 'fully-catalytic'] },
    });
    assert.equal(c.status, 'pending');
    assert.deepEqual(c.claimIds, ['c1', 'c2']);
    assert.equal(kb.listContradictions({ schemaId: 'plasma_rcs_v1' }).length, 1);

    const updated = kb.updateContradictionStatus('contra_1', 'confirmed');
    assert.equal(updated.status, 'confirmed');
    assert.equal(kb.listContradictions({ status: 'confirmed' }).length, 1);

    const b = kb.saveBenchmark({
      id: 'bench_1d_tmm',
      title: '1D Stratified Plasma TMM',
      zoteroKeys: ['KEY_RAMC'],
      scriptPath: 'benchmarks/tmm_1d.py',
      npzPath: 'benchmarks/tmm_1d.npz',
      status: 'reproduced',
      errorSummary: 'Max error < 0.15 dB across 1-20 GHz',
    });
    assert.equal(b.status, 'reproduced');
    assert.equal(kb.listBenchmarks({ status: 'reproduced' }).length, 1);

    const st = kb.stats();
    assert.equal(st.contradictions, 1);
    assert.equal(st.benchmarks, 1);
  });

  it('renames corrupted kb_struct.sqlite to .bad and rebuilds cleanly', () => {
    kb.close();
    kb = null;

    const dbFile = path.join(tmpDir, 'kb_struct.sqlite');
    fs.writeFileSync(dbFile, 'NOT A VALID SQLITE DATABASE HEADER CORRUPTED DATA!!!');

    const logs = [];
    kb = openKbStruct({ dir: tmpDir, log: (m) => logs.push(m) });
    assert.ok(kb, 'openKbStruct should recover from corruption');
    assert.equal(kb.rebuilt, true);
    assert.equal(fs.existsSync(dbFile + '.bad'), true);
    assert.ok(logs.some((l) => l.includes('打不开')));

    // Rebuilt DB is fully functional
    kb.saveEvidence({
      zoteroKey: 'KEY_OK',
      schemaId: 'aero_stealth_v1',
      pdfMd5: 'md5_ok',
      fields: { geometry: { value: 'Flying wing', unit: '', page: 1, quote: 'flying wing', verified: 1 } },
      verifiedRatio: 1,
      model: 'gemini-2.5-flash',
    });
    assert.equal(kb.stats().evidence, 1);
  });
});

describe('evidence-schemas.js (domain schemas & quote verifier)', () => {
  it('provides plasma_rcs_v1 and aero_stealth_v1 with 10 fields each and Gemini-compatible buildExtractSchema', () => {
    assert.ok(SCHEMAS.plasma_rcs_v1);
    assert.ok(SCHEMAS.aero_stealth_v1);
    assert.equal(listSchemas().length, 2);
    assert.equal(getSchema('plasma_rcs_v1').fields.length, 10);
    assert.equal(getSchema('aero_stealth_v1').fields.length, 10);
    assert.equal(getSchema('nonexistent'), null);

    const plasmaKeys = getSchema('plasma_rcs_v1').fields.map((f) => f.key);
    assert.deepEqual(plasmaKeys, [
      'flight_condition', 'geometry', 'flow_chem_model', 'em_method', 'freq_pol',
      'peak_ne', 'collision_freq', 'validation_source', 'key_result', 'limitations',
    ]);

    const aeroKeys = getSchema('aero_stealth_v1').fields.map((f) => f.key);
    assert.deepEqual(aeroKeys, [
      'geometry', 'flight_regime', 'aero_solver', 'em_method', 'freq_pol_angle',
      'surrogate_opt', 'validation_source', 'key_result', 'compute_cost', 'limitations',
    ]);

    const jsonSchema = buildExtractSchema('plasma_rcs_v1');
    assert.equal(jsonSchema.type, 'object');
    assert.deepEqual(jsonSchema.required, ['fields', 'claims']);
    assert.deepEqual(jsonSchema.properties.fields.required, plasmaKeys);
    assert.deepEqual(jsonSchema.properties.fields.properties.peak_ne.required, ['value', 'unit', 'page', 'quote']);
    assert.deepEqual(jsonSchema.properties.claims.items.required, ['condition', 'conclusion', 'metric', 'page', 'quote']);
    assert.throws(() => buildExtractSchema('unknown_v99'));
  });

  it('normalizes hyphenated line breaks, full-width chars, whitespace, and case', () => {
    const raw = 'Electro-\n  magnetic　Wave（１０．５　ＧＨｚ）\r\n  attenu-\r\nation';
    assert.equal(normalizeForMatch(raw), 'electromagnetic wave(10.5 ghz) attenuation');
  });

  it('verifyQuote handles exact match, ±1 page tolerance, hyphen/whitespace normalization, token fallback, and rejects fabrications', () => {
    const pages = [
      'Page 1 introduction to hypersonic plasma sheath.',
      'At an altitude of 71 km, the peak elec-\ntron density reaches 1.2e12 cm^-3 along the stagnation line.',
      'The radar cross section (RCS) at 10.5 GHz HH polarization drops by 8.4 dB compared to PEC.',
      'Page 4 discusses limitations such as neglecting ablation products and magnetic field effects.',
    ];

    // Exact match on reported page
    assert.deepEqual(
      verifyQuote(pages, 3, 'RCS) at 10.5 GHz HH polarization drops by 8.4 dB'),
      { verified: true, matchedPage: 3 }
    );

    // Hyphenated line-break + whitespace normalization
    assert.deepEqual(
      verifyQuote(pages, 2, 'peak electron   density reaches 1.2e12 cm^-3'),
      { verified: true, matchedPage: 2 }
    );

    // ±1 page tolerance (reported page 2, actually on page 3; reported page 3, actually on page 2)
    assert.deepEqual(
      verifyQuote(pages, 2, 'drops by 8.4 dB compared to PEC'),
      { verified: true, matchedPage: 3 }
    );
    assert.deepEqual(
      verifyQuote(pages, 3, 'altitude of 71 km, the peak electron density'),
      { verified: true, matchedPage: 2 }
    );

    // Out of ±1 range (reported page 1, actually on page 3 -> rejected)
    assert.deepEqual(
      verifyQuote(pages, 1, 'drops by 8.4 dB compared to PEC'),
      { verified: false, matchedPage: 0 }
    );

    // Token-level fuzzy match (>= 80% & >= 3 tokens, minor punctuation/omission diff)
    assert.deepEqual(
      verifyQuote(pages, 4, 'limitations neglecting ablation products magnetic field effects'),
      { verified: true, matchedPage: 4 }
    );

    // Reject fabricated quote
    assert.deepEqual(
      verifyQuote(pages, 2, 'The plasma frequency exceeds 95 GHz with zero attenuation in vacuum'),
      { verified: false, matchedPage: 0 }
    );

    // Reject too-short quote (< 6 non-whitespace chars)
    assert.deepEqual(verifyQuote(pages, 2, '71 km'), { verified: false, matchedPage: 0 });
    assert.deepEqual(verifyQuote(pages, 2, '   a b c   '), { verified: false, matchedPage: 0 });
    assert.deepEqual(verifyQuote(pages, 2, ''), { verified: false, matchedPage: 0 });
  });

  it('verifyQuote rejects quotes with a tampered number or a flipped verb (#30)', () => {
    const pages = [
      'x',
      'At an altitude of 71 km, the peak electron density reaches 1.2e12 cm^-3.',
      'The radar cross section (RCS) at 10.5 GHz HH polarization drops by 8.4 dB compared to PEC.',
    ];
    // a real sentence with one number changed
    assert.deepEqual(
      verifyQuote(pages, 2, 'At an altitude of 71 km, the peak electron density reaches 5.0e13 cm^-3.'),
      { verified: false, matchedPage: 0 }
    );
    // two numbers changed (frequency and attenuation)
    assert.deepEqual(
      verifyQuote(pages, 3, 'The radar cross section (RCS) at 35 GHz HH polarization drops by 2.1 dB compared to PEC.'),
      { verified: false, matchedPage: 0 }
    );
    // numbers kept, verb flipped
    assert.deepEqual(
      verifyQuote(pages, 3, 'The radar cross section (RCS) at 10.5 GHz HH polarization increases by 8.4 dB compared to PEC.'),
      { verified: false, matchedPage: 0 }
    );
    // numbers may not be met inside a longer number (71 inside 1971)
    assert.deepEqual(
      verifyQuote(['in 1971 the sound barrier fell'], 1, 'in 71 the sound barrier fell'),
      { verified: false, matchedPage: 0 }
    );
    // a sentence pieced together from two pages is not one quote
    assert.deepEqual(
      verifyQuote(pages, 2, 'the peak electron density reaches 1.2e12 cm^-3 and RCS drops by 8.4 dB compared to PEC'),
      { verified: false, matchedPage: 0 }
    );
    // controls: the unchanged sentences still pass
    assert.deepEqual(
      verifyQuote(pages, 2, 'the peak electron density reaches 1.2e12 cm^-3'),
      { verified: true, matchedPage: 2 }
    );
    assert.deepEqual(
      verifyQuote(pages, 3, 'at 10.5 GHz HH polarization drops by 8.4 dB compared to PEC'),
      { verified: true, matchedPage: 3 }
    );
  });

  it('verifyExtraction rejects a real quote with a made-up value (#30)', () => {
    const pages = ['At an altitude of 71 km, the peak electron density reaches 1.2e12 cm^-3.'];
    const res = verifyExtraction('plasma_rcs_v1', {
      fields: {
        peak_ne: { value: '5.0e13', unit: 'cm^-3', page: 1, quote: 'the peak electron density reaches 1.2e12 cm^-3' },
        flight_condition: { value: '71 km', unit: '', page: 1, quote: 'At an altitude of 71 km' },
      },
      claims: [],
    }, pages);
    // the quote is genuine, so it matched the page; the value's number is not in it
    assert.equal(res.fields.peak_ne.matchedPage, 1);
    assert.equal(res.fields.peak_ne.verified, 0);
    assert.equal(res.fields.flight_condition.verified, 1);
    assert.equal(res.verifiedRatio, 0.5);
    assert.deepEqual(res.unverifiedFields, ['peak_ne']);

    // the same number in another notation is accepted (1.2 × 10^12 vs 1.2e12)
    const ok = verifyExtraction('plasma_rcs_v1', {
      fields: { peak_ne: { value: '1.2 × 10^12', unit: 'cm^-3', page: 1, quote: 'the peak electron density reaches 1.2e12 cm^-3' } },
      claims: [],
    }, pages);
    assert.equal(ok.fields.peak_ne.verified, 1);
    assert.equal(ok.verifiedRatio, 1);

    // a value with no numbers is checked by its quote alone
    const noNum = verifyExtraction('plasma_rcs_v1', {
      fields: { geometry: { value: 'blunt cone', unit: '', page: 1, quote: 'At an altitude of 71 km' } },
      claims: [],
    }, pages);
    assert.equal(noNum.fields.geometry.verified, 1);
  });

  it('verifyExtraction computes verifiedRatio, treats empty/null/N/A as verified empty, and verifies claims', () => {
    const pages = [
      'RAM-C II blunt cone flying at Mach 25.9 and 71 km altitude.',
      'We solve the 7-species Park chemical non-equilibrium model and ADE-FDTD at 10 GHz HH.',
    ];

    const extracted = {
      fields: {
        flight_condition: { value: 'Mach 25.9, 71 km', unit: '', page: 1, quote: 'Mach 25.9 and 71 km altitude' },
        geometry: { value: 'RAM-C II blunt cone', unit: '', page: 1, quote: 'RAM-C II blunt cone flying' },
        flow_chem_model: { value: 'Park 7-species', unit: '', page: 2, quote: '7-species Park chemical non-equilibrium model' },
        em_method: { value: 'MoM', unit: '', page: 2, quote: 'fabricated MoM quote not in paper' },
        freq_pol: { value: 'N/A', unit: '', page: 0, quote: '' },
        peak_ne: { value: 'null', unit: '', page: 0, quote: '' },
        collision_freq: { value: '', unit: '', page: 0, quote: '' },
        validation_source: { value: '', unit: '', page: 0, quote: '' },
        key_result: { value: '', unit: '', page: 0, quote: '' },
        limitations: { value: '', unit: '', page: 0, quote: '' },
      },
      claims: [
        { condition: '71 km, Mach 25.9', conclusion: 'Uses ADE-FDTD at 10 GHz HH', metric: '10 GHz', page: 2, quote: 'ADE-FDTD at 10 GHz HH' },
        { condition: '50 km', conclusion: 'Fake claim', metric: '99 dB', page: 1, quote: 'completely invented sentence about 99 dB' },
      ],
    };

    const res = verifyExtraction('plasma_rcs_v1', extracted, pages);
    // 4 non-empty fields: 3 verified, 1 unverified (em_method)
    assert.equal(res.verifiedRatio, 0.75);
    assert.deepEqual(res.unverifiedFields, ['em_method']);
    assert.equal(res.fields.flight_condition.verified, 1);
    assert.equal(res.fields.em_method.verified, 0);
    assert.equal(res.fields.em_method.matchedPage, 0);
    // 'N/A' and 'null' treated as empty with verified = 1
    assert.equal(res.fields.freq_pol.value, '');
    assert.equal(res.fields.freq_pol.verified, 1);
    assert.equal(res.fields.peak_ne.value, '');
    assert.equal(res.fields.peak_ne.verified, 1);

    // Claims verified individually
    assert.equal(res.claims.length, 2);
    assert.equal(res.claims[0].verified, 1);
    assert.equal(res.claims[0].matchedPage, 2);
    assert.equal(res.claims[1].verified, 0);
    assert.equal(res.claims[1].matchedPage, 0);

    // All-empty extraction yields verifiedRatio = 1
    const allEmpty = verifyExtraction('aero_stealth_v1', { fields: {}, claims: [] }, pages);
    assert.equal(allEmpty.verifiedRatio, 1);
    assert.deepEqual(allEmpty.unverifiedFields, []);
  });

  it('verifyQuote & verifyExtraction handle NFKC ligatures (ﬁ/ﬂ), legacy OCR spaced letters, and PDF dropped-decimal scientific notation without relaxing tamper checks', () => {
    // 1. NFKC ligatures (ﬁnite-volume, ﬂow) & Unicode superscripts (¹¹)
    const ligaturePages = [
      'A ﬁnite-volume hypersonic ﬂow solver predicts peak ne = 1.8 × 10¹¹ cm⁻³ along the body.',
    ];
    assert.deepEqual(
      verifyQuote(ligaturePages, 1, 'finite-volume hypersonic flow solver predicts peak ne = 1.8 × 10^11 cm^-3'),
      { verified: true, matchedPage: 1 }
    );
    const ligRes = verifyExtraction('plasma_rcs_v1', {
      fields: {
        flow_chem_model: { value: 'finite-volume flow solver', unit: '', page: 1, quote: 'A finite-volume hypersonic flow solver' },
        peak_ne: { value: '1.8e11', unit: 'cm^-3', page: 1, quote: 'predicts peak ne = 1.8 × 10¹¹ cm⁻³' },
      },
      claims: [],
    }, ligaturePages);
    assert.equal(ligRes.fields.flow_chem_model.verified, 1);
    assert.equal(ligRes.fields.peak_ne.verified, 1);
    assert.equal(ligRes.verifiedRatio, 1);

    // 2. Legacy OCR spaced letters (r e f l e c t i o n / a l t i t u d e)
    const ocrPages = [
      'The r e f l e c t i o n coefficient at a l t i t u d e 71 km is measured at X-band.',
    ];
    assert.deepEqual(
      verifyQuote(ocrPages, 1, 'The reflection coefficient at altitude 71 km is measured'),
      { verified: true, matchedPage: 1 }
    );
    // Normal word boundaries must remain intact (swapped word still fails)
    assert.deepEqual(
      verifyQuote(ocrPages, 1, 'The transmission coefficient at altitude 71 km is measured'),
      { verified: false, matchedPage: 0 }
    );

    // 3. PDF dropped decimal + superscript ("1 8 × 1011" matches "1.8e11", "2 0 × 1010" matches "2.0e10")
    const droppedDecimalPages = [
      'Table 1: At 71 km, peak electron density is 1 8 × 1011 cm-3 and at 81 km it is 2 0 × 1010 cm-3.',
    ];
    const decOk = verifyExtraction('plasma_rcs_v1', {
      fields: {
        peak_ne: { value: '1.8e11', unit: 'cm^-3', page: 1, quote: 'peak electron density is 1 8 × 1011 cm-3' },
        key_result: { value: '81 km 峰值 2.0e10', unit: 'cm^-3', page: 1, quote: 'at 81 km it is 2 0 × 1010 cm-3' },
      },
      claims: [],
    }, droppedDecimalPages);
    assert.equal(decOk.fields.peak_ne.verified, 1);
    assert.equal(decOk.fields.key_result.verified, 1);
    assert.equal(decOk.verifiedRatio, 1);

    // Tampered value against "1 8 × 1011" must still be rejected!
    const decTampered = verifyExtraction('plasma_rcs_v1', {
      fields: {
        peak_ne: { value: '1.9e11', unit: 'cm^-3', page: 1, quote: 'peak electron density is 1 8 × 1011 cm-3' },
      },
      claims: [],
    }, droppedDecimalPages);
    assert.equal(decTampered.fields.peak_ne.verified, 0);
    assert.deepEqual(decTampered.unverifiedFields, ['peak_ne']);
  });
});
