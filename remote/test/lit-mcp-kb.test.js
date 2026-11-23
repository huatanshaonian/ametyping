'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { test } = require('node:test');
const { createAgentSocket, defaultSocket } = require('../server/literature/agent-socket');
const { createMcp, direct, serve } = require('../server/literature/mcp');
const { openKbStruct } = require('../server/literature/kb-struct');
const { createParadigm } = require('../server/literature/paradigm');
const { createLiterature } = require('../server/literature');

const schemaId = 'plasma_rcs_v1';
const first = { key: 'AAAAAAA1', title: 'Plasma scattering', year: 2024, venue: 'Journal', citekey: 'Lin2024', abstract: 'Results at X band' };
const second = { key: 'AAAAAAA2', title: 'Wave response', year: 2026, venue: 'Proceedings', citekey: 'Qin2026', abstract: 'Plasma measurements at X band' };
const papers = [first, second];
const mirror = { items: () => papers, item: (key) => papers.find((paper) => paper.key === key) };

function checkCoverage(result, matched) {
  assert.deepEqual(result.coverage, {
    matched, library_total: 2, newest_year: 2026,
    scope_warning: '仅覆盖个人 Zotero 本地库；立项、查新或新点子论证时必须结合外部检索（OpenAlex/NTRS/arXiv/Web）交叉核验',
  });
}

test('local socket research endpoints and MCP forwarding', { timeout: 5000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-lit-mcp-kb-'));
  const socket = defaultSocket(dir);
  const kbStruct = openKbStruct({ dir });
  t.after(() => {
    kbStruct?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(kbStruct);
  const fields = { em_method: { value: 'FDTD' }, freq_pol: { value: 'X band' } };
  kbStruct.saveEvidence({ zoteroKey: first.key, schemaId, verifiedRatio: 1, fields });
  kbStruct.saveEvidence({ zoteroKey: second.key, schemaId, fields });

  let online = true;
  const searches = [];
  const embed = { search: { queryLit: async (q, opts) => {
    searches.push([q, opts]);
    if (!online) throw new Error('offline');
    return { ok: true, items: [{ key: 'STALEKEY', score: 0.99 }, { key: second.key, score: 0.9 }] };
  } } };
  const contradiction = kbStruct.saveContradiction({ id: 'c1', schemaId, topic: 'plasma sheath' });
  const paradigm = createParadigm({ kbStruct });
  const fulltext = { forItem: async (key) => key === first.key
    ? { pages: Array.from({ length: 9 }, (_, i) => i === 0 ? '文'.repeat(8050) : `Page ${i + 1}`) }
    : { missing: 'no-pdf' } };
  let agent;
  await new Promise((resolve) => {
    agent = createAgentSocket({ socket, downloads: {}, kb: { mirror, kbStruct, paradigm, embed, fulltext }, log: resolve });
    t.after(() => agent.stop());
    agent.start();
  });
  const call = (method, route, body) => direct(socket, method, route, body);
  const mcp = createMcp(call);

  await t.test('search uses embedding scores, drops stale keys, and falls back to title and abstract', async () => {
    const query = '等离子体 & 电磁波';
    const semantic = await mcp.run('search_library', { query, k: 2 });
    assert.deepEqual(searches, [[query, { topK: 2 }]]);
    assert.deepEqual(semantic.items, [{ ...second, score: 0.9 }]);
    assert.equal(semantic.semantic, 'ok');
    checkCoverage(semantic, 1);

    online = false;
    const fallback = await mcp.run('search_library', { query: 'PLASMA X band' });
    assert.deepEqual(fallback.items, papers.map((paper) => ({ ...paper, score: null })));
    assert.equal(fallback.semantic, 'unavailable');
    assert.deepEqual(searches[1], ['PLASMA X band', { topK: 10 }]);
    checkCoverage(fallback, 2);
    checkCoverage(await mcp.run('search_library', { query: 'no matches' }), 0);
  });

  await t.test('evidence query passes filters and verification flags and enriches metadata', async () => {
    const result = await mcp.run('query_evidence', { schema_id: schemaId, filters: { em_method: 'fdtd' }, only_verified: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.items.map(({ zoteroKey, title, year, citekey }) => ({ zoteroKey, title, year, citekey })), [
      { zoteroKey: first.key, title: first.title, year: first.year, citekey: first.citekey },
    ]);
    checkCoverage(result, 1);
    checkCoverage(await mcp.run('query_evidence', { filters: { em_method: 'MoM' } }), 0);
  });

  await t.test('contradictions return saved entries and the requested matrix', async () => {
    const result = await mcp.run('get_contradictions_and_gaps', { row_field: 'em_method', col_field: 'freq_pol' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.contradictions, [contradiction]);
    assert.equal(result.matrix.rowField, 'em_method');
    assert.equal(result.matrix.colField, 'freq_pol');
    assert.deepEqual(result.matrix.cells.FDTD['X band'].keys.slice().sort(), [first.key, second.key]);
    checkCoverage(result, 1);
  });

  await t.test('pages preserve order, cap the payload, and report missing text', async () => {
    const result = await mcp.run('read_paper_pages', { key: first.key, pages: [2, 1] });
    assert.equal(result.ok, true);
    assert.equal(result.key, first.key);
    assert.equal(result.title, first.title);
    assert.equal(result.total_pages, 9);
    assert.deepEqual(result.pages, [{ page: 2, text: 'Page 2' }, { page: 1, text: '文'.repeat(8000) }]);
    checkCoverage(result, 2);
    const capped = await call('GET', `/v1/pages?key=${first.key}&pages=1,1,2,3,4,5,6,7,8,9`);
    assert.equal(capped.s, 200);
    assert.deepEqual(capped.j.pages.map(({ page }) => page), [1, 2, 3, 4, 5, 6, 7, 8]);
    checkCoverage(capped.j, 8);
    await assert.rejects(mcp.run('read_paper_pages', { key: second.key, pages: [1] }), (error) => {
      checkCoverage(error, 0);
      return /没有可读/.test(error.message);
    });
  });
});

test('literature Web API lists and verifies evidence and manages contradictions', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-lit-web-kb-'));
  let lit;
  t.after(() => {
    lit?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const dir = path.join(dataDir, 'literature');
  const seed = openKbStruct({ dir });
  try {
    seed.saveEvidence({ zoteroKey: first.key, schemaId, fields: { em_method: { value: 'FDTD' } } });
    seed.saveContradiction({ id: 'c1', schemaId, topic: 'plasma sheath' });
  } finally { seed.close(); }
  fs.writeFileSync(path.join(dir, 'zotero.json'), JSON.stringify({ items: { [first.key]: first } }));
  lit = createLiterature({ dataDir, cfg: { zotero: 'http://127.0.0.1:1', agentSocket: false, refreshMs: 0, feed: false, review: false },
    ask: () => assert.fail('These requests must not call a model'), log: () => {} });

  async function request(route, data) {
    let response;
    const handled = await lit.handle({ method: data ? 'POST' : 'GET' }, {}, new URL(route, 'http://local/api/lit/'), 'test',
      (_, status, body) => { response = { status, body }; }, async () => JSON.stringify(data));
    assert.equal(handled, true);
    assert.equal(response.status, 200, route);
    return response.body;
  }
  assert.ok((await request('evidence/schemas')).schemas.some(({ id }) => id === schemaId));
  const before = await request('evidence');
  assert.equal(before.stats.evidence, 1);
  assert.equal(before.schema.id, schemaId);
  assert.equal(before.items[0].citekey, first.citekey);
  assert.deepEqual((await request('evidence?onlyVerified=1')).items, []);
  assert.equal((await request('evidence/extract', { key: 'invalid' })).ok, false);
  assert.equal((await request('evidence/extract', { key: first.key, schemaId })).zoteroKey, first.key);
  const verified = await request('evidence/verify', { key: first.key, schemaId, fields: { em_method: { value: 'FDTD', verified: 1 } } });
  assert.equal(verified.item.humanVerified, 1);
  assert.equal((await request('evidence?onlyVerified=1')).items.length, 1);
  assert.equal((await request('contradictions')).items[0].status, 'pending');
  assert.equal((await request('contradictions/run', { schemaId })).analyzed, 0);
  const updated = await request('contradictions/status', { id: 'c1', status: 'confirmed' });
  assert.equal(updated.ok, true);
  assert.equal(updated.item.status, 'confirmed');
  const matrix = await request('matrix?row=em_method');
  assert.equal(matrix.ok, true);
  assert.equal(matrix.rowField, 'em_method');
  assert.equal(matrix.totalPapers, 1);
});

test('MCP registers three download tools and four read-only research tools', async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = serve(() => assert.fail('Registration must not query the socket'), input, output);
  t.after(() => lines.close());
  async function rpc(method) {
    const response = once(output, 'data');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method }) + '\n');
    const [data] = await response;
    return JSON.parse(data).result;
  }
  const { instructions } = await rpc('initialize');
  assert.match(instructions, /先查家底.*必查外部.*下载回流/);
  const { tools } = await rpc('tools/list');
  assert.deepEqual(tools.map(({ name }) => name), [
    'submit_downloads', 'download_status', 'save_pdf', 'search_library', 'query_evidence',
    'get_contradictions_and_gaps', 'read_paper_pages',
  ]);
  for (const tool of tools.slice(3)) assert.equal(tool.annotations.readOnlyHint, true, tool.name);
});
