// One question to a Claude model over the Claude API (the Messages API), as claude.js asks it through Claude Code --
// but paid from the Console organization's credit (the monthly API credit of a Max / Team plan), not from the
// subscription's usage. No tools; the answer is forced into the job's JSON schema (structured outputs) and read from the
// stream as it is written (a day report can take minutes: a plain request would sit silent that long and be cut off
// by a proxy on the way).
//   key: the API key (api-key.js); model: Claude's own name for it ("claude-opus-5-5"); effort: '' = the model's default
//   images: PNG / JPEG files the model looks at along with the prompt (文献's page images)
//   egress: the proxies (null: direct); base: another address than api.anthropic.com (tests: a fake on http://127.0.0.1)
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const { tunnel } = require('../google/http');
const { SYSTEM } = require('../summary/claude');

const HOST = 'api.anthropic.com', VERSION = '2023-06-01';
const MAX_TOKENS = 32000;                     // (thinking and the answer together; every current model writes this much)
const IDLE_MS = 3 * 60e3;                     // (the API sends "ping" while the model thinks: this long silent = the line is dead)

// structured outputs take a subset of JSON Schema: sizes and ranges are refused (a 400), and every object must say
// "nothing else". The limits the jobs wrote for Codex are left out here; the prompt states them anyway.
const DROP = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'uniqueItems', 'pattern', 'default', 'title', 'examples'];
function forApi(s) {
  if (Array.isArray(s)) return s.map(forApi);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.includes(k) && typeof v !== 'object') continue;                      // (a property may itself be called "title")
    if (k === 'minItems') { if (v === 0 || v === 1) out[k] = v; continue; }
    out[k] = k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([n, p]) => [n, forApi(p)])) : forApi(v);
  }
  if (out.type === 'object' || out.properties) out.additionalProperties = false;
  return out;
}

// why the API said no, in a line: its own words, and what to do about the two you can do something about
function explain(status, body) {
  let e = null; try { e = JSON.parse(body).error; } catch {}
  const type = (e && e.type) || '', said = String((e && e.message) || body || '').replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401) return 'Claude API 不认这个 key（可能填错了或已被删除）：' + said;
  if (/credit balance|usage limits|spend limit/i.test(said) || (e && e.details && /spend_limit/.test(String(e.details.error_code || '')))) return 'Claude API 的额度用完了：' + said;
  return `Claude API 出错（${status}${type ? ' ' + type : ''}）：${said}`;
}

// POST path with a JSON body; onEvent(name, data) for every event of the answering stream. Resolves when it ends.
async function post({ key, path, body, egress, base, timeoutMs, onEvent }) {
  const u = new URL(base || `https://${HOST}`);
  const lib = u.protocol === 'http:' ? http : https;
  let createConnection;
  if (egress && !base) {
    const proxy = await egress.pick(HOST);
    if (!proxy) throw new Error('连不上 Anthropic：电脑上的代理和 AWS 备用线路都不通');
    const sock = await tunnel(proxy, HOST);
    createConnection = () => sock;
  }
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let over = false;
    const end = (e) => { if (over) return; over = true; clearTimeout(total); e ? reject(e) : resolve(); };
    const req = lib.request({ hostname: u.hostname, port: u.port || (lib === https ? 443 : 80), ...(lib === https ? { defaultPort: 443 } : {}), path, method: 'POST', createConnection,
      headers: { 'x-api-key': key, 'anthropic-version': VERSION, 'content-type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'Windose' } }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      if (res.statusCode !== 200) {
        res.on('data', (c) => { buf = (buf + c).slice(0, 8000); });
        res.on('end', () => { const e = new Error(explain(res.statusCode, buf)); e.status = res.statusCode; e.said = buf; end(e); });
        return;
      }
      // server-sent events: "event: <name>\ndata: <json>\n\n"
      res.on('data', (c) => {
        buf += c;
        for (let i; (i = buf.search(/\r?\n\r?\n/)) >= 0;) {
          const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const name = (/^event: *(.*)$/m.exec(block) || [])[1] || '', raw = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          let d = null; try { d = JSON.parse(raw); } catch {}
          if (d) { try { onEvent(name || d.type, d); } catch (e) { req.destroy(); return end(e); } }
        }
      });
      res.on('end', () => end());
      res.on('error', (e) => end(new Error('Claude API 的回答中断了：' + e.message)));
    });
    const total = setTimeout(() => { req.destroy(); end(new Error('Claude API 超时')); }, timeoutMs);
    req.setTimeout(IDLE_MS, () => { req.destroy(); end(new Error('Claude API 没有回应')); });
    req.on('error', (e) => end(new Error('连不上 Claude API：' + e.message)));
    req.end(data);
  });
}

async function runApi({ key, model, effort = '', prompt, schema, images = [], egress = null, base = '', timeoutMs = 20 * 60e3 }) {
  if (!key) throw new Error('还没有填 Claude API 的 key（控制面板 → AI 模型 → Claude API）');
  let content = prompt;
  if (images.length) {
    try {
      content = [...images.map((f) => ({ type: 'image', source: { type: 'base64', media_type: /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/png', data: fs.readFileSync(f).toString('base64') } })),
        { type: 'text', text: prompt }];
    } catch (e) { throw new Error('读不到要给 Claude 看的图片：' + e.message); }
  }
  const think = /^[a-z]{2,10}$/.test(effort);
  const ask = async (withEffort) => {
    let text = '', stop = '';
    const body = { model, max_tokens: MAX_TOKENS, stream: true, system: SYSTEM, messages: [{ role: 'user', content }],
      ...(withEffort ? { thinking: { type: 'adaptive' } } : {}),
      output_config: { ...(withEffort ? { effort } : {}), format: { type: 'json_schema', schema: forApi(schema) } } };
    await post({ key, path: '/v1/messages', body, egress, base, timeoutMs, onEvent(name, d) {
      if (name === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') text += d.delta.text || '';
      else if (name === 'message_delta' && d.delta && d.delta.stop_reason) stop = d.delta.stop_reason;
      else if (name === 'error') throw new Error(explain((d.error && d.error.type) || '中途', JSON.stringify(d)));
    } });
    if (stop === 'refusal') throw new Error('Claude 拒绝回答这个问题');
    if (stop === 'max_tokens') throw new Error('Claude 的回答太长，没写完（超过 ' + MAX_TOKENS + ' 个 token）');
    try { const v = JSON.parse(text); if (v && typeof v === 'object') return v; } catch {}
    throw new Error('Claude API 的回答不是 JSON：' + text.slice(0, 200));
  };
  try { return await ask(think); }
  catch (e) {
    // a model that does not take an effort (the catalog said it did): asked once more as it is by itself
    if (think && e.status === 400 && /effort|thinking/i.test(e.said || '')) return ask(false);
    throw e;
  }
}

// is the key good, without spending anything: the list of models it may use (one of them is enough)
async function checkKey({ key, egress = null, base = '' }) {
  const u = new URL(base || `https://${HOST}`);
  if (!base) {
    const { request } = require('../google/http');
    const r = await request(`https://${HOST}/v1/models?limit=1`, { headers: { 'x-api-key': key, 'anthropic-version': VERSION, 'User-Agent': 'Windose' } }, egress);
    if (r.status !== 200) throw new Error(explain(r.status, r.body.toString('utf8')));
    return true;
  }
  return new Promise((resolve, reject) => {
    http.get({ hostname: u.hostname, port: u.port, path: '/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': VERSION } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(true) : reject(new Error(explain(res.statusCode, b)))));
    }).on('error', (e) => reject(new Error('连不上 Claude API：' + e.message)));
  });
}

module.exports = { runApi, checkKey, forApi };
