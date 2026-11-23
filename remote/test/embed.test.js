'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createClient, formatQuery, truncateAndNormalize, dot, DEFAULT_DIMS } = require('../server/embed/client');
const { cleanLine, chunkText, hashText } = require('../server/embed/clean');
const { openStore } = require('../server/embed/store');
const { fuseSessions } = require('../server/embed/search');
const embedMod = require('../server/embed');
const { createStore } = require('../server/store');
const searchIdx = require('../server/search-index');
const { createSearch } = require('../server/summary/search');
const { openVault } = require('../server/vault/database');
const { createMemory } = require('../server/vault/memory');
const { createReview } = require('../server/vault/review');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) await sleep(20);
  return fn();
};

// Deterministic semantic mock: maps topic keywords to orthogonal basis regions of a 2560-d vector.
function makeMockFetch({ dims = DEFAULT_DIMS, online = () => true, logRequests = null } = {}) {
  const topics = [
    { idx: 0, re: /网格|mesh|加密|收敛|convergence|refine/i },
    { idx: 1, re: /代理|proxy|防火墙|端口|3389|tailscale/i },
    { idx: 2, re: /气动|机翼|隐身|飞行器|aerodynamic|stealth/i },
    { idx: 3, re: /npz|落盘|算力|保存|归档|重跑/i },
    { idx: 4, re: /git|提交|commit|分支|验证/i },
  ];
  const vecOf = (text) => {
    const raw = new Array(dims).fill(0);
    let matched = false;
    for (const t of topics) {
      if (t.re.test(text)) {
        raw[t.idx] += 10;
        matched = true;
      }
    }
    if (!matched) {
      // Deterministic hash fallback into high dimensions
      const h = hashText(text);
      const slot = 10 + (parseInt(h.slice(0, 4), 16) % (dims - 10));
      raw[slot] = 10;
    }
    // Small deterministic tie-breaker
    raw[dims - 1] = 0.01;
    return Array.from(truncateAndNormalize(raw, dims));
  };

  return async function mockFetch(url, opts = {}) {
    if (!online()) throw new Error('ECONNREFUSED');
    if (logRequests) logRequests.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.endsWith('/health')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    }
    if (url.endsWith('/v1/embeddings')) {
      const body = JSON.parse(opts.body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: inputs.map((txt, index) => ({ index, embedding: vecOf(txt) })),
          usage: { prompt_tokens: inputs.reduce((s, t) => s + Math.ceil(t.length * 0.6), 0) },
        }),
      };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
}

test('clean.js drops known noise and keeps valid content with tags', () => {
  assert.equal(cleanLine('运行命令输出', 'tool'), null);
  assert.equal(cleanLine('标题', 'title'), null);
  assert.equal(cleanLine('ok', 'user'), null);
  assert.equal(cleanLine('继续', 'user'), null);
  assert.equal(cleanLine('好的，谢谢', 'user'), null);
  assert.equal(cleanLine('<skill name="foo">很长的技能说明文本内容</skill>', 'user'), null);
  assert.equal(cleanLine('<recommended_plugins>推荐插件列表内容</recommended_plugins>', 'user'), null);
  assert.equal(cleanLine('<image>base64data...</image>', 'user'), null);
  assert.equal(cleanLine('This session is being continued from a previous conversation that ran out of context.', 'user'), null);

  const stripped = cleanLine('请帮我检查一下网格收敛性<system-reminder>internal note</system-reminder>并输出曲线', 'user');
  assert.ok(stripped);
  assert.equal(stripped.text, '请帮我检查一下网格收敛性并输出曲线');
  assert.equal(stripped.tag, '');

  const pasted = cleanLine('<pasted_content>这是用户粘贴进来的实验日志数据</pasted_content>', 'user');
  assert.ok(pasted);
  assert.equal(pasted.tag, 'pasted');

  const agent = cleanLine('<agent-message from="worker">任务已完成，结果保存在 npz 中</agent-message>', 'user');
  assert.ok(agent);
  assert.equal(agent.tag, 'agent');

  const cross = cleanLine('<cross-session-message>跨会话通知：模型已经跑完</cross-session-message>', 'user');
  assert.ok(cross);
  assert.equal(cross.tag, 'cross-session');
});

test('clean.js chunks long text around 600 chars with one-sentence overlap', () => {
  const short = '这是一段很短的对话，不需要切块。';
  assert.deepEqual(chunkText(short), [short]);

  const para = (i) => `第${i}段讨论电磁散射求解器的网格加密收敛测试。我们把边界层网格加密了五层，并对比了双站 RCS 曲线的误差变化。最终误差收敛到 0.2 dB 以内。`;
  const longText = Array.from({ length: 18 }, (_, i) => para(i + 1)).join('\n\n');
  const chunks = chunkText(longText, { maxChars: 600 });
  assert.ok(chunks.length >= 3, `expected >= 3 chunks, got ${chunks.length}`);
  for (const ch of chunks) assert.ok(ch.length <= 600, `chunk exceeded 600: ${ch.length}`);
  // Adjacent chunks should overlap on the trailing sentence of chunk 0
  assert.ok(chunks[1].includes('最终误差收敛到 0.2 dB 以内。'));
});

test('client.js enforces query instruction prefix, no doc prefix, and L2 normalization', async () => {
  const reqs = [];
  const client = createClient({
    url: 'http://127.0.0.1:8090',
    key: 'secret-key',
    dims: 2560,
    fetchImpl: makeMockFetch({ dims: 2560, logRequests: reqs }),
  });

  const h = await client.health();
  assert.equal(h.ok, true);
  assert.equal(reqs[0].headers.Authorization, undefined);

  const docRes = await client.embed(['文档原文内容']);
  assert.equal(docRes.vectors.length, 1);
  assert.equal(docRes.vectors[0].length, 2560);
  assert.equal(reqs[1].headers.Authorization, 'Bearer secret-key');
  assert.equal(reqs[1].body.input[0], '文档原文内容');

  const qRes = await client.embedQuery('网格加密');
  assert.equal(qRes.vector.length, 2560);
  assert.equal(reqs[2].body.input[0], formatQuery('网格加密'));
  assert.ok(reqs[2].body.input[0].startsWith('Instruct: '));
  assert.ok(reqs[2].body.input[0].includes('\nQuery:网格加密'));

  // Truncation re-normalization check
  const trunc = truncateAndNormalize([3, 4, 12, 0], 2);
  assert.equal(trunc.length, 2);
  assert.ok(Math.abs(dot(trunc, trunc) - 1) < 1e-5);
  assert.ok(Math.abs(trunc[0] - 0.6) < 1e-5);
  assert.ok(Math.abs(trunc[1] - 0.8) < 1e-5);
});

test('store.js deduplicates by hash, rebuilds on meta mismatch, and recovers when deleted', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-embed-store-'));
  try {
    let store = openStore({ dataDir: tmp, model: 'Qwen3-Embedding-4B', dims: 2560, task: 't1', ruleVersion: '1' });
    const v1 = truncateAndNormalize([1, 0, 0, 0], 4);
    const vFull = new Float32Array(2560);
    vFull[0] = v1[0];
    const hash = hashText('重复的对话片段内容测试');
    store.putChunks(
      [{ hash, text: '重复的对话片段内容测试', vec: vFull }],
      [
        { hash, machine: 'pc1', session: 's1', t: 100, role: 'user', file: '2026-11-23/pc1/s1.jsonl', tag: '' },
        { hash, machine: 'pc2', session: 's2', t: 200, role: 'user', file: '2026-11-23/pc2/s2.jsonl', tag: '' },
      ]
    );
    assert.equal(store.stats().chunks, 1);
    assert.equal(store.stats().refs, 2);
    const hits = store.searchVectors(vFull, 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].refs.length, 2);
    assert.ok(Math.abs(hits[0].score - 1) < 1e-5);
    store.close();

    // Changing dims triggers automatic clean rebuild
    store = openStore({ dataDir: tmp, model: 'Qwen3-Embedding-4B', dims: 1024, task: 't1', ruleVersion: '1' });
    assert.equal(store.stats().rebuilt, true);
    assert.equal(store.stats().chunks, 0);
    store.close();

    // Deleting vectors.sqlite allows fresh reopen
    for (const sfx of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(path.join(tmp, 'vectors.sqlite' + sfx)); } catch {}
    }
    store = openStore({ dataDir: tmp, model: 'Qwen3-Embedding-4B', dims: 2560, task: 't1', ruleVersion: '1' });
    assert.equal(store.stats().chunks, 0);
    store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 1 E2E: BM25 ranking + RRF hybrid search + offline fallback', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-embed-e2e-'));
  let index = null;
  let embed = null;
  try {
    const D = path.join(tmp, 'data');
    const st = createStore(D);
    const t = (d, h) => Date.parse(`2026-11-${d}T${h}:00:00Z`);
    const put = (m, id, recs) => st.accept(m, { id, from: 0, to: 100, recs: recs.map((r, i) => ({ i, ...r })), project: 'cem', title: id });

    // Session A: mentions 隐身飞行器机翼优化 (zero lexical overlap with "气动外形")
    put('pc', 'sess-aero', [
      { role: 'user', text: '帮我分析一下隐身飞行器的机翼优化方案', t: t(20, 10) },
      { role: 'assistant', text: '可以从升阻比和散射截面两个指标联合迭代。', t: t(20, 11) },
    ]);
    // Session B: mentions 网格加密 once (older)
    put('pc', 'sess-mesh-1', [
      { role: 'user', text: '请顺便看一下网格参数和日志输出情况', t: t(21, 10) },
    ]);
    // Session C: mentions 网格加密 multiple times (strong BM25 match)
    put('dell97', 'sess-mesh-strong', [
      { role: 'user', text: '网格加密收敛测试：网格加密 5 层后网格收敛误差是多少？', t: t(19, 10) },
      { role: 'assistant', text: '网格加密 5 层后，mesh refinement convergence 达标。', t: t(19, 11) },
    ]);
    // Session D: noise-only line should be filtered out of vectors
    put('pc', 'sess-noise', [
      { role: 'user', text: '<skill>codex injected skill text very long</skill>', t: t(22, 10) },
      { role: 'user', text: 'ok', t: t(22, 11) },
    ]);
    st.flush();

    index = searchIdx.open({ dataDir: D });
    index.sweep();
    assert.equal(await until(() => index.ready()), true);

    // BM25 check: sess-mesh-strong (older, higher term frequency) ranks before sess-mesh-1 (newer, 1 mention)
    const kwOnly = index.find(['网格'], {});
    assert.equal(kwOnly[0].session, 'sess-mesh-strong');

    let isOnline = true;
    embed = embedMod.open({
      cfg: { url: 'http://127.0.0.1:8090', key: 'k', dims: 2560 },
      dataDir: D,
      searchIndex: index,
      fetchImpl: makeMockFetch({ dims: 2560, online: () => isOnline }),
    });

    const syncRes = await embed.job.syncLinesOnce();
    assert.equal(syncRes.ok, true);
    assert.ok(syncRes.embedded >= 4);
    // Noise session should not have been embedded
    assert.equal(embed.store.stats().chunks, syncRes.embedded);

    const search = createSearch({
      storeDir: D,
      reports: { list: () => [], get: () => null },
      artifacts: null,
      sessions: () => st.sessions(),
      index,
      embed,
    });

    // Cross-expression semantic query ("气动" -> finds "隐身飞行器机翼优化" despite 0 lexical match)
    const semRes = await search.searchHybrid('气动', { scope: 'sessions' });
    assert.equal(semRes.semantic, 'ok');
    assert.ok(semRes.sessions.some((s) => s.id === 'sess-aero'));
    assert.equal(semRes.sessions[0].id, 'sess-aero');
    assert.equal(semRes.sessions[0].matchBy, 'semantic');

    // Cross-language hybrid query ("mesh convergence" -> finds both lexical + semantic)
    const hybRes = await search.searchHybrid('mesh convergence', { scope: 'sessions' });
    assert.equal(hybRes.semantic, 'ok');
    assert.equal(hybRes.sessions[0].id, 'sess-mesh-strong');
    assert.equal(hybRes.sessions[0].matchBy, 'both');

    // Offline graceful degradation
    isOnline = false;
    const offRes = await search.searchHybrid('网格', { scope: 'sessions' });
    assert.equal(offRes.semantic, 'unavailable');
    assert.ok(offRes.sessions.length >= 2);
    assert.equal(offRes.sessions[0].id, 'sess-mesh-strong');

    embed.close(); embed = null;
    index.close(); index = null;
  } finally {
    try { embed && embed.close(); } catch {}
    try { index && index.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 2 E2E: memory vectors detect semantically duplicate memories and recall relevant memories', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-embed-mem-'));
  try {
    const vault = openVault(tmp);
    const memory = createMemory(vault);

    // Two memories with almost zero character bigram overlap, but same semantic topic (npz archiving)
    const m1 = memory.save({ scope: 'global', owner: '', name: '算例归档格式', body: '所有算例全量保存为 npz，保留算力产物避免重跑。' });
    const m2 = memory.save({ scope: 'global', owner: '', name: 'Simulation Output Rule', body: 'Always archive simulation results to npz files so expensive runs do not need rerun.' });
    const m3 = memory.save({ scope: 'global', owner: '', name: 'Git 提交规范', body: '任务完成并验证无误后再提交 Git，不在中途分批 commit。' });

    let embed = null;
    const review = createReview({ vault, memory, getEmbed: () => embed });

    embed = embedMod.open({
      cfg: { url: 'http://127.0.0.1:8090', key: 'k', dims: 2560 },
      dataDir: tmp,
      memoryProvider: () => ({ memories: memory.list(), observed: [] }),
      fetchImpl: makeMockFetch({ dims: 2560 }),
    });

    const mSync = await embed.job.syncMemoriesOnce();
    assert.equal(mSync.ok, true);
    assert.equal(mSync.embedded, 3);
    assert.equal(embed.store.stats().memories, 3);

    const refs = [
      { kind: 'memory', id: m1.id, revision: m1.revision },
      { kind: 'memory', id: m2.id, revision: m2.revision },
      { kind: 'memory', id: m3.id, revision: m3.revision },
    ];

    // Pure lexical alignment misses the cross-language duplicate m1 <-> m2
    const lexAlign = review.alignment(refs);
    assert.equal(lexAlign.pairs.length, 0);

    // Semantic alignment catches m1 <-> m2 while ignoring unrelated m3
    const semAlign = review.alignmentWithSemantic(refs, { threshold: 0.85 });
    assert.equal(semAlign.pairs.length, 1);
    assert.equal(semAlign.pairs[0].kind, 'semantic');
    assert.equal(semAlign.pairs[0].left, 'item1');
    assert.equal(semAlign.pairs[0].right, 'item2');
    assert.ok(semAlign.pairs[0].semanticScore >= 85);

    // Query relevant memories for a question
    const qMem = await embed.search.queryMemories('代码改完什么时候 commit', { topK: 2 });
    assert.equal(qMem.ok, true);
    assert.equal(qMem.items[0].key, m3.id);

    embed.close();
    vault.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fuseSessions RRF ranks dual-matched sessions above single-source matches', () => {
  const kw = [
    { machine: 'pc', id: 's1', last: 100, hits: [{ t: 100, role: 'user', snippet: 'kw1' }] },
    { machine: 'pc', id: 's2', last: 200, hits: [{ t: 200, role: 'user', snippet: 'kw2' }] },
  ];
  const vec = [
    { machine: 'pc', id: 's2', last: 200, vecScore: 0.9, hits: [{ t: 200, role: 'user', snippet: 'vec2' }] },
    { machine: 'pc', id: 's3', last: 300, vecScore: 0.8, hits: [{ t: 300, role: 'user', snippet: 'vec3' }] },
  ];
  const fused = fuseSessions(kw, vec);
  assert.equal(fused[0].id, 's2');
  assert.equal(fused[0].matchBy, 'both');
  assert.equal(fused.length, 3);
});
