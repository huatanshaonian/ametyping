// Google AI Studio API (Gemini Developer API, generativelanguage.googleapis.com):
//   <dataDir>/google-ai-api.json   { key, setAt, models: [{ id, name }] }
// Kept on the NAS only (0600); never sent back to the browser except whether it is set and its last 4 chars.
// Routed through the NAS egress proxies (the same ones that reach Google) when configured.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { tunnel } = require('../google/http');
const { plain } = require('./anthropic-api');
const { SYSTEM } = require('../summary/claude');
const { readJsonSafe, writeJsonAtomic } = require('../lib/json-store');

const HOST = 'generativelanguage.googleapis.com';
const KEY_RE = /^[A-Za-z0-9_-]{20,300}$/;

const DEFAULT_MODELS = [
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro · AI Studio', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash · AI Studio', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash · AI Studio', efforts: [] },
];

// Clean JSON Schema for Gemini structured output (removes keywords Gemini's responseSchema rejects)
const DROP_SCHEMA = ['additionalProperties', '$schema', 'default', 'examples', 'title', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'uniqueItems'];
function forGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(forGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP_SCHEMA.includes(k) && typeof v !== 'object') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, forGeminiSchema(p)]));
    } else {
      out[k] = forGeminiSchema(v);
    }
  }
  return out;
}

function explain(status, body) {
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = (j.error && j.error.message) || '';
  } catch {}
  const said = String(msg || body || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(said)) return 'Google AI Studio 不认这个 key（请检查是否复制完整）：' + said;
  if (status === 401 || status === 403) return 'Google AI Studio 拒绝访问（key 无效或未开通权限）：' + said;
  if (status === 429) return 'Google AI Studio 触发速率或配额限制（429）：' + said;
  return `Google AI Studio API 出错（HTTP ${status}）：${said}`;
}

async function rawRequest({ method = 'GET', path: reqPath, key, body = null, egress = null, base = '', timeoutMs = 120000 }) {
  const u = new URL(base || `https://${HOST}`);
  const lib = u.protocol === 'http:' ? http : https;
  let createConnection;
  if (egress && !base) {
    const proxy = await egress.pick(u.hostname);
    if (!proxy) throw new Error('连不上 Google AI Studio：群晖的代理线路不通');
    const sock = await tunnel(proxy, u.hostname);
    createConnection = () => sock;
  }
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => { try { req.destroy(); } catch {} finish(new Error('Google AI Studio 请求超时')); }, timeoutMs);
    if (timer.unref) timer.unref();
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (lib === https ? 443 : 80),
      ...(lib === https ? { defaultPort: 443 } : {}),
      path: u.pathname.replace(/\/$/, '') + reqPath,
      method,
      createConnection,
      headers: {
        'x-goog-api-key': key,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        'User-Agent': 'Windose',
      },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (buf.length < 16 * 1024 * 1024) buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(explain(res.statusCode, buf));
          e.status = res.statusCode;
          return finish(e);
        }
        try { finish(null, JSON.parse(buf)); }
        catch { finish(new Error('Google AI Studio 返回的数据不是有效 JSON')); }
      });
    });
    req.on('error', (e) => finish(e));
    if (data) req.end(data); else req.end();
  });
}

async function checkGoogleKey({ key, egress = null, base = '' }) {
  const j = await rawRequest({ method: 'GET', path: '/v1beta/models?pageSize=100', key, egress, base, timeoutMs: 25000 });
  const rawList = Array.isArray(j && j.models) ? j.models : [];
  const models = rawList
    .filter((m) => m && typeof m.name === 'string' && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => {
      const id = m.name.replace(/^models\//, '');
      return {
        id,
        name: `${m.displayName || id} · AI Studio`,
        efforts: /gemini-(?:2\.5|3|4)/i.test(id) ? ['low', 'medium', 'high'] : [],
      };
    })
    .filter((m) => /^gemini-/i.test(m.id) && !/embedding|imagen|veo|aqa|tts|audio/i.test(m.id));
  return { ok: true, models: models.length ? models : DEFAULT_MODELS };
}

async function runGoogleAi({ key, model, effort = '', prompt, schema, images = [], egress = null, base = '', timeoutMs = 180000 }) {
  if (!key) throw new Error('尚未配置 Google AI Studio API key');
  const cleanModel = String(model || 'gemini-2.5-pro').replace(/^models\//, '');
  const parts = [{ text: plain(prompt) }];
  for (const img of images) {
    const filename = typeof img === 'string' ? img : img.path;
    const mimeType = /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'image/png';
    parts.push({ inlineData: { mimeType, data: fs.readFileSync(filename).toString('base64') } });
  }
  const generationConfig = {
    responseMimeType: 'application/json',
    ...(schema ? { responseSchema: forGeminiSchema(schema) } : {}),
  };
  if (effort && /gemini-2\.5/i.test(cleanModel)) {
    const budget = effort === 'low' ? 1024 : effort === 'high' ? 16384 : 4096;
    generationConfig.thinkingConfig = { thinkingBudget: budget };
  }
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM + (schema ? '\n只输出一个符合指定 JSON Schema 的 JSON 对象。' : '') }] },
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
  let j;
  try {
    j = await rawRequest({ method: 'POST', path: `/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`, key, body, egress, base, timeoutMs });
  } catch (e) {
    // If responseSchema or thinkingConfig was rejected by a specific model variant, retry once with plain json mimeType
    if (e.status === 400 && (generationConfig.responseSchema || generationConfig.thinkingConfig)) {
      delete body.generationConfig.responseSchema;
      delete body.generationConfig.thinkingConfig;
      j = await rawRequest({ method: 'POST', path: `/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`, key, body, egress, base, timeoutMs });
    } else {
      throw e;
    }
  }
  const cand = j && Array.isArray(j.candidates) ? j.candidates[0] : null;
  const textParts = (cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!textParts.trim()) throw new Error('Google AI Studio 返回空内容');
  try {
    const parsed = JSON.parse(textParts.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  throw new Error('Google AI Studio 的回答不是有效 JSON');
}

function createGoogleAiKey({ dataDir }) {
  const file = path.join(dataDir, 'google-ai-api.json');
  let st = { key: '', setAt: 0, models: DEFAULT_MODELS };
  const j = readJsonSafe(file);
  if (j && typeof j.key === 'string') {
    st = {
      key: j.key,
      setAt: +j.setAt || 0,
      models: Array.isArray(j.models) && j.models.length ? j.models : DEFAULT_MODELS,
    };
  }
  const save = () => writeJsonAtomic(file, st, { mode: 0o600 });

  function set(key) {
    key = String(key || '').trim();
    if (key && !KEY_RE.test(key)) return { ok: false, msg: 'Google AI Studio API key 格式不正确（通常以 AIza 开头）' };
    st = { key, setAt: key ? Date.now() : 0, models: DEFAULT_MODELS };
    if (key) save(); else { try { fs.rmSync(file, { force: true }); } catch {} }
    return { ok: true };
  }

  function setModels(models) {
    if (Array.isArray(models) && models.length) {
      st.models = models;
      if (st.key) save();
    }
  }

  function models() {
    if (!st.key) return [];
    return (st.models || DEFAULT_MODELS).map((m) => ({
      slug: 'google:' + m.id,
      model: m.id,
      name: m.name || `${m.id} · AI Studio`,
      note: 'Google AI Studio API',
      efforts: Array.isArray(m.efforts) ? m.efforts : [],
      defaultEffort: '',
      provider: 'google',
    }));
  }

  return {
    get: () => st.key,
    has: () => !!st.key,
    set,
    setModels,
    models,
    view: () => ({ has: !!st.key, tail: st.key ? st.key.slice(-4) : '', setAt: st.setAt, modelCount: st.key ? (st.models || DEFAULT_MODELS).length : 0 }),
  };
}

module.exports = { createGoogleAiKey, checkGoogleKey, runGoogleAi };
