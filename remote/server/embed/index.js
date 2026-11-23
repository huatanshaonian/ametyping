// Entry point for the NAS-side embedding subsystem (Stage 1: conversations, Stage 2: memories, literature).
// Returns null when cfg is absent or disabled so existing dashboard behavior is completely unchanged.
'use strict';
const { createClient, DEFAULT_DIMS, DEFAULT_TASK } = require('./client');
const { RULE_VERSION } = require('./clean');
const { openStore } = require('./store');
const { createJob, parseDurationMs } = require('./job');
const { createEmbedSearch, fuseSessions } = require('./search');

function open({ cfg = null, dataDir, searchIndex = null, memoryProvider = null, litProvider = null, log = () => {}, fetchImpl = global.fetch } = {}) {
  if (!cfg || cfg.enabled === false || !cfg.url) return null;

  const dims = Number(cfg.dims) || DEFAULT_DIMS;
  const model = String(cfg.model || 'Qwen3-Embedding-4B');
  const task = String(cfg.task || DEFAULT_TASK);

  const client = createClient({
    url: cfg.url,
    key: cfg.key || '',
    keyFile: cfg.keyFile || '',
    dims,
    task,
    queryTimeoutMs: Number(cfg.queryTimeoutMs) || 2000,
    batchTimeoutMs: Number(cfg.batchTimeoutMs) || 120000,
    fetchImpl,
  });

  const store = openStore({
    dataDir,
    model,
    dims,
    task,
    ruleVersion: RULE_VERSION,
    log,
  });
  if (!store) return null;

  const job = createJob({
    client,
    store,
    searchIndex,
    memoryProvider,
    litProvider,
    dataDir,
    batchSize: Number(cfg.batchSize) || 16,
    everyMs: parseDurationMs(cfg.every, 10 * 60 * 1000),
    log,
  });

  const search = createEmbedSearch({ client, store });

  async function status() {
    const health = await client.health();
    return {
      ok: true,
      enabled: true,
      url: client.baseUrl,
      service: health,
      store: store.stats(),
      job: job.status(),
    };
  }

  function close() {
    job.stop();
    store.close();
  }

  return {
    client,
    store,
    job,
    search,
    fuseSessions,
    similarMemoryPairs: store.similarMemoryPairs,
    similarLitItems: store.similarLitItems,
    setLitProvider: job.setLitProvider,
    status,
    close,
  };
}

module.exports = { open };
