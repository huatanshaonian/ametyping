'use strict';
const fs = require('fs');

function createClient(config = {}, { fetcher = globalThis.fetch } = {}) {
  const enabled = !!config && config.enabled !== false && !!config.baseURL;
  function connection() {
    if (!enabled) throw Error('尚未启用 Magpie');
    let url;
    try { url = new URL(config.baseURL); } catch { throw Error('Magpie 地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Magpie 地址无效');
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    let key = '';
    try { key = config.keyFile ? fs.readFileSync(config.keyFile, 'utf8').trim() : config.keyEnv ? process.env[config.keyEnv] || '' : ''; }
    catch { throw Error('Magpie 调用密钥不可读'); }
    if (!key && local) key = 'magpie-windose'; // A loopback client identifier, not an upstream credential.
    if (!key || /[\r\n]/.test(key)) throw Error('Magpie 调用密钥不可读');
    return { baseURL: url.href.replace(/\/$/, ''), key };
  }
  async function request(endpoint, { body, timeoutMs = 15000, signal } = {}) {
    const c = connection();
    try {
      const res = await fetcher(c.baseURL + '/' + endpoint, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: 'Bearer ' + c.key, 'User-Agent': 'Windose', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { const e = Error('Magpie HTTP ' + res.status); e.status = res.status; throw e; }
      const text = await res.text();
      if (text.length > 16 * 1024 * 1024) throw Error('Magpie 数据超过上限');
      try { return JSON.parse(text); } catch { throw Error('Magpie 返回的数据格式无效'); }
    } catch (e) {
      if (e.status) throw e;
      throw Error(e.name === 'TimeoutError' ? 'Magpie 连接超时' : 'Magpie 数据暂不可读');
    }
  }
  return { enabled, connection, request };
}
module.exports = { createClient };
