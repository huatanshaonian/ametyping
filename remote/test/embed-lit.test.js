'use strict';
// Literature vectors (Zotero items/notes): incremental sync, schema compatibility,
// cross-language queryLit, similarLitItems and rankCandidates (all with a mocked embedding service).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { truncateAndNormalize } = require('../server/embed/client');
const { hashText } = require('../server/embed/clean');
const { openStore, SCHEMA_VERSION } = require('../server/embed/store');
const embedMod = require('../server/embed');

const DIMS = 64;

// Deterministic bilingual topic embedding: Chinese and English phrasings of one topic share a basis axis.
function makeMockFetch({ dims = DIMS, online = () => true, requests = null } = {}) {
  const topics = [
    { idx: 0, re: /网格|mesh|加密|收敛|convergence|refine/i },
    { idx: 1, re: /代理|proxy|防火墙|firewall|端口/i },
    { idx: 2, re: /气动|隐身|飞行器|aerodynamic|stealth|aircraft/i },
    { idx: 3, re: /npz|归档|重跑|archive/i },
    { idx: 4, re: /git|提交|commit/i },
  ];
  const vecOf = (text) => {
    const raw = new Array(dims).fill(0);
    let matched = false;
    for (const t of topics) {
      if (t.re.test(text)) { raw[t.idx] += 10; matched = true; }
    }
    if (!matched) raw[10 + (parseInt(hashText(text).slice(0, 4), 16) % (dims - 11))] = 10;
    raw[dims - 1] = 0.01;
    return Array.from(truncateAndNormalize(raw, dims));
  };
  return async function mockFetch(url, opts = {}) {
    if (!online()) throw new Error('ECONNREFUSED');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (requests) requests.push({ url, body });
    if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    if (url.endsWith('/v1/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: inputs.map((txt, index) => ({ index, embedding: vecOf(txt) })), usage: { prompt_tokens: 1 } }),
      };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
}

function withTmp(prefix, fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try { await fn(tmp); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}

function openEmbed(dataDir, { online = () => true, requests = null, litProvider = null } = {}) {
  return embedMod.open({
    cfg: { url: 'http://127.0.0.1:8090', key: 'k', dims: DIMS },
    dataDir,
    litProvider,
    fetchImpl: makeMockFetch({ online, requests }),
  });
}

const embedCalls = (reqs) => reqs.filter((r) => r.url.endsWith('/v1/embeddings'));

test('lit_vec incremental sync: sha256 skip, change detection, batch size 16, delete cleanup, offline skip', withTmp('ame-lit-sync-', async (tmp) => {
  const reqs = [];
  let online = true;
  let lib = {
    items: [
      { key: 'A', title: 'Mesh refinement for MoM', abstract: 'Convergence study.', tags: ['CEM', 'MoM'], venue: 'IEEE TAP', year: 2024 },
      { key: 'B', title: '隐身飞行器气动外形优化', abstract: '气动/电磁耦合', tags: [], venue: '', year: 2023 },
      { key: 'C', title: 'Proxy firewall setup', abstract: '', tags: ['net'], venue: '', year: '' },
    ],
    notes: [
      { key: 'N1', parentKey: 'A', text: '  网格加密 5 层后收敛  ' },
      { key: 'N2', parentKey: 'B', text: 'npz 归档避免重跑' },
      { key: 'N3', parentKey: 'B', text: '   ' },          // blank notes are ignored
    ],
  };
  const embed = openEmbed(tmp, { online: () => online, requests: reqs });
  try {
    // No provider yet: clean skip
    const none = await embed.job.syncLitOnce();
    assert.equal(none.ok, true);
    assert.equal(none.skipped, 'no-lit-provider');

    // Provider injected after open
    embed.setLitProvider(() => lib);
    const r1 = await embed.job.syncLitOnce();
    assert.equal(r1.ok, true);
    assert.equal(r1.embedded, 5);
    let st = embed.store.stats();
    assert.equal(st.litItems, 3);
    assert.equal(st.litNotes, 2);
    assert.ok(st.lastLitSyncAt > 0);

    // Item text = title/abstract/tags/venue/year joined by newlines; note text trimmed
    const expectA = ['Mesh refinement for MoM', 'Convergence study.', 'CEM MoM', 'IEEE TAP', '2024'].join('\n');
    assert.equal(embed.store.getLitVec('item', 'A').sha256, hashText(expectA));
    assert.equal(embed.store.getLitVec('note', 'N1').sha256, hashText('网格加密 5 层后收敛'));
    assert.equal(embed.store.getLitVec('note', 'N1').parentKey, 'A');
    assert.ok(embedCalls(reqs)[0].body.input.includes(expectA));

    // Unchanged library: no embedding request at all
    reqs.length = 0;
    const r2 = await embed.job.syncLitOnce();
    assert.equal(r2.embedded, 0);
    assert.equal(r2.deleted, 0);
    assert.equal(embedCalls(reqs).length, 0);

    // Changed abstract re-embeds only that item; removed item/note are cleaned up
    lib = {
      items: [
        { ...lib.items[0], abstract: 'Convergence study, revised.' },
        lib.items[1],
      ],
      notes: [lib.notes[0]],
    };
    reqs.length = 0;
    const r3 = await embed.job.syncLitOnce();
    assert.equal(r3.embedded, 1);
    assert.equal(r3.deleted, 2);
    assert.equal(embedCalls(reqs).length, 1);
    assert.deepEqual(embed.store.listLitKeys('item').sort(), ['A', 'B']);
    assert.deepEqual(embed.store.listLitKeys('note'), ['N1']);
    assert.equal(embed.store.getLitVec('item', 'C'), null);

    // 20 new items -> batches of 16 + 4 (concurrency 1)
    lib = {
      items: [...lib.items, ...Array.from({ length: 20 }, (_, i) => ({ key: 'X' + i, title: 'Paper number ' + i }))],
      notes: lib.notes,
    };
    reqs.length = 0;
    const r4 = await embed.job.syncLitOnce();
    assert.equal(r4.embedded, 20);
    assert.deepEqual(embedCalls(reqs).map((r) => r.body.input.length), [16, 4]);

    // Offline: skipped, nothing written or deleted
    online = false;
    lib = { items: [], notes: [] };
    const off = await embed.job.syncLitOnce();
    assert.equal(off.ok, false);
    assert.equal(off.skipped, 'offline');
    assert.equal(off.embedded, 0);
    assert.equal(embed.store.stats().litItems, 22);

    // runOnce / auditConsistency carry the lit field
    online = true;
    const run = await embed.job.runOnce();
    assert.ok(run.lit);
    assert.equal(run.lit.ok, true);
    assert.equal(run.lit.deleted, 23);
    assert.equal(embed.store.stats().litItems, 0);
    const audit = await embed.job.auditConsistency();
    assert.ok(audit.lit);
    assert.equal(audit.lit.ok, true);

    // A throwing provider does not break runOnce's other stages
    embed.setLitProvider(() => { throw new Error('zotero.sqlite locked'); });
    const bad = await embed.job.runOnce();
    assert.equal(bad.lit.ok, false);
    assert.match(bad.lit.error, /locked/);
    assert.equal(bad.lines.ok, true);
  } finally {
    embed.close();
  }
}));

test('SCHEMA_VERSION stays 1: opening an existing pre-literature vectors.sqlite keeps data and adds lit_vec', withTmp('ame-lit-schema-', async (tmp) => {
  assert.equal(SCHEMA_VERSION, '1');
  const opts = { dataDir: tmp, model: 'Qwen3-Embedding-4B', dims: DIMS, task: 't', ruleVersion: '1' };
  let store = openStore(opts);
  const v = truncateAndNormalize([1, 0, 0], DIMS);
  const hash = hashText('旧对话片段');
  store.putChunks([{ hash, text: '旧对话片段', vec: v }], [{ hash, machine: 'pc', session: 's', t: 1, role: 'user', file: 'f.jsonl' }]);
  store.putMemories([{ kind: 'memory', key: 'm1', sha256: 'x', vec: v }]);
  store.close();

  // Simulate a store created before lit_vec existed
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(tmp, 'vectors.sqlite'));
  raw.exec('DROP TABLE lit_vec');
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'lit_vec'").get().n, 0);
  raw.close();

  store = openStore(opts);
  try {
    const st = store.stats();
    assert.equal(st.rebuilt, false);
    assert.equal(st.chunks, 1);
    assert.equal(st.refs, 1);
    assert.equal(st.memories, 1);
    assert.equal(st.litItems, 0);
    assert.equal(st.litNotes, 0);
    assert.equal(st.lastLitSyncAt, 0);
    store.putLitVecs([{ kind: 'item', key: 'P1', sha256: 's1', vec: v }]);
    assert.equal(store.stats().litItems, 1);
  } finally {
    store.close();
  }

  // Lit vectors persist and reload into memory on reopen
  store = openStore(opts);
  try {
    assert.equal(store.stats().rebuilt, false);
    assert.equal(store.stats().chunks, 1);
    assert.equal(store.getLitVec('item', 'P1').sha256, 's1');
    assert.equal(store.getLitVec('item', 'P1').parentKey, '');
    store.deleteLitVecs([{ kind: 'item', key: 'P1' }]);
  } finally {
    store.close();
  }
  store = openStore(opts);
  try {
    assert.equal(store.getLitVec('item', 'P1'), null);
  } finally {
    store.close();
  }
}));

test('queryLit: cross-language hits, notes folded into parent paper, kinds filter, offline -> ok:false', withTmp('ame-lit-query-', async (tmp) => {
  let online = true;
  const lib = {
    items: [
      { key: 'MESH', title: 'Mesh refinement convergence of MoM solvers' },
      { key: 'AERO', title: '隐身飞行器气动外形优化' },
      { key: 'NET', title: 'Corporate proxy firewall configuration' },
    ],
    notes: [
      { key: 'NT1', parentKey: 'NET', text: '算例结果全量 npz 归档，避免重跑' },
      { key: 'NT2', parentKey: 'MESH', text: 'mesh convergence reached after 5 refinements' },
    ],
  };
  const embed = openEmbed(tmp, { online: () => online, litProvider: () => lib });
  try {
    assert.equal((await embed.job.syncLitOnce()).embedded, 5);

    // English query -> Chinese paper
    const en = await embed.search.queryLit('stealth aircraft aerodynamic design', { topK: 3 });
    assert.equal(en.ok, true);
    assert.equal(en.items[0].key, 'AERO');
    assert.equal(en.items[0].via, 'item');
    assert.ok(en.items[0].score > 0.99);

    // Chinese query -> English paper; its note also hits but is folded into one MESH entry
    const zh = await embed.search.queryLit('网格加密收敛', { topK: 5 });
    assert.equal(zh.ok, true);
    assert.equal(zh.items[0].key, 'MESH');
    assert.equal(zh.items.filter((x) => x.key === 'MESH').length, 1);
    assert.ok(!zh.items.some((x) => x.key === 'NT2'));

    // Note-only hit maps to its parent paper with via='note'
    const ar = await embed.search.queryLit('archive results as npz', { topK: 3 });
    assert.equal(ar.items[0].key, 'NET');
    assert.equal(ar.items[0].via, 'note');
    assert.ok(ar.items[0].score > 0.99);

    // kinds filter: items only -> the note can no longer lift NET to the top
    const itemsOnly = await embed.search.queryLit('archive results as npz', { topK: 3, kinds: ['item'] });
    assert.ok(itemsOnly.items.every((x) => x.via === 'item'));
    assert.ok(!(itemsOnly.items[0].key === 'NET' && itemsOnly.items[0].score > 0.5));

    // Sorted by score descending
    for (let i = 1; i < zh.items.length; i++) assert.ok(zh.items[i - 1].score >= zh.items[i].score);

    // Empty query
    assert.deepEqual((await embed.search.queryLit('  ')).items, []);

    // Offline: no throw, ok:false
    online = false;
    const off = await embed.search.queryLit('网格');
    assert.equal(off.ok, false);
    assert.ok(off.reason);
    assert.deepEqual(off.items, []);
  } finally {
    embed.close();
  }
}));

test('similarLitItems ranks other items by similarity, excludes self and notes', withTmp('ame-lit-similar-', async (tmp) => {
  const lib = {
    items: [
      { key: 'A', title: '网格加密收敛性研究' },
      { key: 'A2', title: 'Mesh convergence with git commit tracking' },  // half mesh, half git
      { key: 'A3', title: 'Mesh refinement benchmark' },                  // pure mesh, English
      { key: 'B', title: 'Stealth aircraft aerodynamic shape' },
    ],
    notes: [{ key: 'N', parentKey: 'B', text: '网格加密' }],              // identical topic, but a note
  };
  const embed = openEmbed(tmp, { litProvider: () => lib });
  try {
    await embed.job.syncLitOnce();
    const sim = embed.similarLitItems('A', { topK: 10 });
    assert.deepEqual(sim.map((x) => x.key), ['A3', 'A2', 'B']);
    assert.ok(sim[0].score > 0.99);
    assert.ok(Math.abs(sim[1].score - Math.SQRT1_2) < 0.01);
    assert.ok(sim[2].score < 0.01);
    assert.ok(!sim.some((x) => x.key === 'A' || x.key === 'N'));
    assert.equal(embed.similarLitItems('A', { topK: 1 }).length, 1);
    assert.deepEqual(embed.similarLitItems('missing'), []);
    assert.deepEqual(embed.similarLitItems('N'), []);                     // notes are not items
  } finally {
    embed.close();
  }
}));

test('rankCandidates scores candidates by max similarity to anchors and degrades to ok:false', withTmp('ame-lit-rank-', async (tmp) => {
  const reqs = [];
  let online = true;
  const embed = openEmbed(tmp, { online: () => online, requests: reqs });
  try {
    const anchors = ['网格加密收敛', '隐身飞行器气动', '  ', null];
    const cands = [
      'An adaptive mesh refinement convergence study',
      'Proxy and firewall rules for remote desktop',
      'Stealth aircraft aerodynamic optimization',
      '',
    ];
    const r = await embed.search.rankCandidates(anchors, cands);
    assert.equal(r.ok, true);
    assert.equal(r.scores.length, 4);
    assert.ok(r.scores[0] > 0.99);
    assert.ok(r.scores[2] > 0.99);
    assert.ok(r.scores[1] < 0.01);
    assert.equal(r.scores[3], 0);
    assert.ok(r.ms >= 0);

    // Anchors capped at 15 query embeddings (with instruction prefix); candidates batched 16 + 4
    reqs.length = 0;
    const many = Array.from({ length: 20 }, (_, i) => 'anchor topic ' + i);
    const cs = Array.from({ length: 20 }, (_, i) => 'candidate ' + i);
    const r2 = await embed.search.rankCandidates(many, cs);
    assert.equal(r2.ok, true);
    assert.equal(r2.scores.length, 20);
    const calls = embedCalls(reqs);
    const queryCalls = calls.filter((c) => c.body.input[0].startsWith('Instruct: '));
    const docCalls = calls.filter((c) => !c.body.input[0].startsWith('Instruct: '));
    assert.equal(queryCalls.length, 15);
    assert.deepEqual(docCalls.map((c) => c.body.input.length), [16, 4]);

    // Empty inputs
    assert.deepEqual(await embed.search.rankCandidates([], cands), { ok: false, reason: 'empty', scores: null });
    assert.deepEqual(await embed.search.rankCandidates(['  '], cands), { ok: false, reason: 'empty', scores: null });
    assert.deepEqual(await embed.search.rankCandidates(anchors, []), { ok: false, reason: 'empty', scores: null });
    assert.deepEqual(await embed.search.rankCandidates(anchors, null), { ok: false, reason: 'empty', scores: null });

    // Offline: never throws
    online = false;
    const off = await embed.search.rankCandidates(anchors, cands);
    assert.equal(off.ok, false);
    assert.equal(off.scores, null);
    assert.match(off.reason, /ECONNREFUSED/);
  } finally {
    embed.close();
  }
}));
