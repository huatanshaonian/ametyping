// HTTP client for the remote3090 llama-server OpenAI-compatible embedding service.
// Queries ALWAYS get the Qwen3-Embedding instruction prefix; documents NEVER do.
// Supports Matryoshka truncation with mandatory L2 re-normalization, timeouts, and /health checks.
'use strict';
const fs = require('fs');

const DEFAULT_TASK = 'Given a search query, retrieve relevant passages from coding-agent conversations and notes';
const DEFAULT_DIMS = 2560;
const DEFAULT_MAX_CHARS = 6000;          // defensive guard below the 4096-token server limit
const DEFAULT_QUERY_TIMEOUT_MS = 2000;
const DEFAULT_BATCH_TIMEOUT_MS = 120000;

function formatQuery(q, task = DEFAULT_TASK) {
  return `Instruct: ${task}\nQuery:${String(q || '').trim()}`;
}

function truncateAndNormalize(raw, dims = DEFAULT_DIMS) {
  const len = Math.min(raw.length, dims);
  const out = new Float32Array(len);
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const v = Number(raw[i]) || 0;
    out[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    const inv = 1 / norm;
    for (let i = 0; i < len; i++) out[i] *= inv;
  }
  return out;
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function createClient({
  url,
  key = '',
  keyFile = '',
  dims = DEFAULT_DIMS,
  task = DEFAULT_TASK,
  maxChars = DEFAULT_MAX_CHARS,
  queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
  batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
  fetchImpl = global.fetch,
} = {}) {
  const baseUrl = String(url || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('embed client requires url');
  if (typeof fetchImpl !== 'function') throw new Error('embed client requires fetch');

  let cachedKey = String(key || '').trim();
  function resolveKey() {
    if (cachedKey) return cachedKey;
    if (keyFile) {
      cachedKey = fs.readFileSync(keyFile, 'utf8').trim();
      return cachedKey;
    }
    return '';
  }

  async function requestJson(endpoint, { method = 'GET', body = null, timeoutMs = queryTimeoutMs, auth = true } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const headers = {};
    if (auth) {
      const k = resolveKey();
      if (k) headers.Authorization = 'Bearer ' + k;
    }
    if (body !== null) headers['Content-Type'] = 'application/json';
    try {
      const res = await fetchImpl(baseUrl + endpoint, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let msg = '';
        try { msg = (await res.text()).slice(0, 200); } catch {}
        throw new Error(`HTTP ${res.status}${msg ? ': ' + msg : ''}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function health(timeoutMs = queryTimeoutMs) {
    const t0 = Date.now();
    try {
      const data = await requestJson('/health', { method: 'GET', timeoutMs, auth: false });
      const ok = !!(data && (data.status === 'ok' || data.ok === true));
      return { ok, ms: Date.now() - t0, status: data?.status || '' };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: e.message || String(e) };
    }
  }

  // Embed documents: NO instruction prefix.
  async function embed(texts, { timeoutMs = batchTimeoutMs } = {}) {
    const list = Array.isArray(texts) ? texts : [texts];
    if (!list.length) return { vectors: [], usage: null };
    const safe = list.map((t) => {
      const s = String(t || '');
      return s.length > maxChars ? s.slice(0, maxChars) : s;
    });
    const data = await requestJson('/v1/embeddings', {
      method: 'POST',
      body: { input: safe },
      timeoutMs,
      auth: true,
    });
    if (!data || !Array.isArray(data.data) || data.data.length !== safe.length) {
      throw new Error('invalid embeddings response');
    }
    const ordered = [...data.data].sort((a, b) => a.index - b.index);
    const vectors = ordered.map((d) => truncateAndNormalize(d.embedding, dims));
    return { vectors, usage: data.usage || null };
  }

  // Embed a search query: ALWAYS adds the instruction prefix.
  async function embedQuery(q, { task: qTask = task, timeoutMs = queryTimeoutMs } = {}) {
    const prompt = formatQuery(q, qTask);
    const { vectors, usage } = await embed([prompt], { timeoutMs });
    return { vector: vectors[0], usage };
  }

  return {
    baseUrl,
    dims,
    task,
    health,
    embed,
    embedQuery,
    formatQuery,
  };
}

module.exports = {
  createClient,
  formatQuery,
  truncateAndNormalize,
  dot,
  DEFAULT_TASK,
  DEFAULT_DIMS,
};
