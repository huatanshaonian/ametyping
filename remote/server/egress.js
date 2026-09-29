// Which proxy the NAS uses to reach the internet (OpenAI for summaries, Google later): the PC's v2rayN on the LAN
// first, then the AWS way out (deploy/nas/egress.sh). Each candidate is probed with a CONNECT to the target host;
// the first that answers wins and is remembered for a few minutes.
'use strict';
const net = require('net');

const DEFAULT = ['http://192.168.1.7:10810', 'http://127.0.0.1:1057'];
const KEEP_MS = 5 * 60e3;

function createEgress({ proxies = DEFAULT, log = () => {} } = {}) {
  let cached = null; // { url, host, at }

  // CONNECT host:443 through an HTTP proxy; true when it answers 200
  function probe(proxyUrl, host, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const u = new URL(proxyUrl);
      const s = net.connect(Number(u.port || 80), u.hostname);
      const done = (ok) => { s.destroy(); resolve(ok); };
      s.setTimeout(timeoutMs, () => done(false));
      s.on('error', () => done(false));
      s.on('connect', () => s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
      let head = '';
      s.on('data', (d) => { head += d.toString('latin1'); if (head.includes('\r\n')) done(/^HTTP\/1\.[01] 200/.test(head)); });
    });
  }

  // the proxy to use for host, or null when none gets through
  async function pick(host = 'chatgpt.com') {
    if (cached && cached.host === host && Date.now() - cached.at < KEEP_MS) return cached.url;
    for (const url of proxies) {
      if (await probe(url, host)) {
        if (!cached || cached.url !== url) log(`egress: using ${url} for ${host}`);
        cached = { url, host, at: Date.now() };
        return url;
      }
    }
    cached = null;
    log(`egress: no proxy reaches ${host}`);
    return null;
  }

  // environment for a child process (codex) that should go out through url
  function env(url, base = process.env) {
    const e = { ...base };
    for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete e[k];
    return { ...e, HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1' };
  }

  return { pick, env, probe, forget: () => { cached = null; } };
}

module.exports = { createEgress };
