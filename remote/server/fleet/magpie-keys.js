// A gateway key per computer, made through Magpie's management API (/v1/magpie/admin/gateway-keys/..., Magpie's
// docs/reference.md "Management API"). It takes a gateway key allowed to manage Magpie from this computer -- made once
// on the NAS:  magpie gateway-key add "Windose 管理"  then  magpie gateway-key admin <id> local  -- whose secret is kept
// in the file config.json "magpie": { "adminKeyFile": ... } names (chmod 600). The new key's secret is in the answer
// only once: it goes on to that computer's agent and is not kept here.
// Plain http(s).request, not fetch: Magpie refuses its management API to any request with Origin or Sec-Fetch-* headers,
// and Node's fetch sends Sec-Fetch-Mode. The address must be localhost / 127.0.0.1 (Magpie checks that too).
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');

function httpJSON(url, { method = 'GET', key, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, timeout: timeoutMs,
      headers: { Authorization: 'Bearer ' + key, 'User-Agent': 'Windose', Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 4 * 1024 * 1024) req.destroy(new Error('Magpie 回答过大')); else chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json: j, text: text.slice(0, 400) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Magpie 连接超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function createMagpieKeys({ config = {}, request = httpJSON } = {}) {
  function connection() {
    if (!config || !config.baseURL) throw new Error('config.json 里没有配置 magpie.baseURL');
    if (!config.adminKeyFile) throw new Error('还没给看板一把能管理 Magpie 的密钥（config.json "magpie": { "adminKeyFile": ... }）');
    let key = '';
    try { key = fs.readFileSync(config.adminKeyFile, 'utf8').trim(); } catch { throw new Error('读不到 Magpie 管理密钥文件：' + config.adminKeyFile); }
    if (!key || /[\s]/.test(key)) throw new Error('Magpie 管理密钥文件是空的或格式不对');
    const u = new URL(config.baseURL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('Magpie 管理接口只能从 NAS 本机（127.0.0.1）调用');
    return { base: u.origin + '/v1/magpie/admin/', key };
  }
  async function call(path, body) {
    const c = connection();
    let r;
    try { r = await request(c.base + path, { method: body === undefined ? 'GET' : 'POST', key: c.key, body }); }
    catch (e) { throw new Error('连不上 Magpie：' + e.message); }
    if (r.status === 404 && !(r.json && r.json.error && /management API|action/.test(r.json.error.message || ''))) throw new Error('这个 Magpie 版本没有管理接口：先在「网络与设备」里把 Magpie 升级到新版');
    if (r.status === 401 || r.status === 403) {
      const code = r.json && r.json.error && r.json.error.code;
      throw new Error(code === 'gateway_key_not_admin' ? '这把密钥没有管理 Magpie 的权限（在 NAS 上运行 magpie gateway-key admin <id> local）'
        : 'Magpie 拒绝了管理请求：' + ((r.json && r.json.error && r.json.error.message) || r.status));
    }
    if (r.status >= 400 || !r.json) throw new Error('Magpie 管理接口出错（HTTP ' + r.status + '）：' + ((r.json && (r.json.error && r.json.error.message || r.json.error)) || r.text));
    return r.json;
  }
  const keysOf = (j) => (Array.isArray(j && j.keys) ? j.keys : Array.isArray(j) ? j : []).map((k) => ({ id: String(k.id || ''), name: String(k.name || ''), off: !!k.off }));
  function available() { try { connection(); return { ok: true }; } catch (e) { return { ok: false, msg: e.message }; } }
  async function list() { return keysOf(await call('gateway-keys')); }
  // the computer's key: a new one, or a new secret for the one of that name (the old secret stops working)
  async function issue(name) {
    const before = await list();
    const same = before.find((k) => k.name === name);
    if (same) {
      const r = await call('gateway-keys/rotate-key', { key: same.id });
      if (!r.secret) throw new Error('Magpie 没有返回新密钥');
      if (same.off) await call('gateway-keys/on-key', { key: same.id });
      return { id: same.id, name, secret: r.secret, rotated: true };
    }
    const r = await call('gateway-keys/add-key', { name });
    const made = keysOf(r).find((k) => k.name === name && !before.some((b) => b.id === k.id));
    if (!r.secret || !made) throw new Error('Magpie 没有返回新密钥');
    return { id: made.id, name, secret: r.secret, rotated: false };
  }
  // whether the key of that id still exists and is on
  async function usable(id) { return !!id && (await list()).some((k) => k.id === id && !k.off); }
  return { available, list, issue, usable };
}

module.exports = { createMagpieKeys, httpJSON };
