'use strict';
const fs = require('fs');
const { runApi, plain } = require('../ai/anthropic-api');
const { SYSTEM } = require('../summary/claude');

function modelsFor(clientModels) {
  return clientModels.filter(m => m.id.length < 80).map(m => ({
    slug: 'magpie:' + Buffer.from(m.id).toString('base64url'), model: m.id,
    name: m.name, provider: 'magpie', note: 'Magpie', efforts: m.efforts, defaultEffort: '',
  }));
}
function decodeModel(slug) {
  if (typeof slug !== 'string' || !/^magpie:[A-Za-z0-9_-]+$/.test(slug)) return '';
  const value = Buffer.from(slug.slice(7), 'base64url').toString('utf8');
  return /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,160}$/.test(value) ? value : '';
}
async function runMagpie({ client, catalog, model, effort, prompt, schema, images = [], timeoutMs = 20 * 60000 }) {
  const meta = catalog.find(m => m.id === model);
  if (!meta) throw Error('Magpie 当前没有提供所选模型');
  if (meta.nativeMessages) {
    const c = client.connection();
    try {
      return await runApi({ key: c.key, base: c.baseURL.replace(/\/v1$/, ''), model, effort,
        prompt, schema, images, timeoutMs, compat: true });
    } catch (e) {
      const error = Error('Magpie 请求失败' + (e.status ? `（HTTP ${e.status}）` : ''));
      if (e.status) error.status = e.status;
      throw error;
    }
  }
  const content = [{ type: 'text', text: plain(prompt) }];
  for (const image of images) {
    const filename = typeof image === 'string' ? image : image.path;
    const mime = /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'image/png';
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${fs.readFileSync(filename).toString('base64')}` } });
  }
  const raw = await client.request('chat/completions', { timeoutMs, body: {
    model, stream: false, max_tokens: Math.min(meta.output || 32000, 32000),
    ...(effort ? { reasoning_effort: effort } : {}), response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SYSTEM + '\n只输出一个 JSON 对象，符合以下 JSON Schema：' + JSON.stringify(schema) }, { role: 'user', content }],
  } });
  const choice = raw.choices?.[0];
  if (choice?.finish_reason !== 'stop') throw Error('Magpie 的回答未完成');
  const text = choice?.message?.content;
  if (typeof text !== 'string') throw Error('Magpie 返回空内容');
  try {
    const result = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'));
    if (result && typeof result === 'object') return result;
  } catch {}
  throw Error('Magpie 的回答不是有效 JSON');
}
module.exports = { modelsFor, decodeModel, runMagpie };
