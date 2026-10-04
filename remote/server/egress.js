// Which proxy the NAS uses to reach the internet (OpenAI for summaries, Google later), from config.json -- e.g. the
// PC's v2rayN on the LAN first, then the AWS way out (deploy/nas/egress.sh). Each candidate is probed with a CONNECT
// to the target host; the first that answers wins and is remembered for a few minutes.
'use strict';
const net = require('net');

const KEEP_MS = 5 * 60e3;

function createEgress({ proxies = [], log = () => {} } = {}) {
  const cached = new Map(); // host -> { url, at } (Codex and Claude Code reach different hosts)

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
    const c = cached.get(host);
    if (c && Date.now() - c.at < KEEP_MS) return c.url;
    for (const url of proxies) {
      if (await probe(url, host)) {
        if (!c || c.url !== url) log(`egress: using ${url} for ${host}`);
        cached.set(host, { url, at: Date.now() });
        return url;
      }
    }
    cached.delete(host);
    log(`egress: no proxy reaches ${host}`);
    return null;
  }

  // environment for a child process (codex) that should go out through url
  function env(url, base = process.env) {
    const e = { ...base };
    for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete e[k];
    return { ...e, HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1' };
  }

  // forget(host): ask again next time for that host (none: for all)
  return { pick, env, probe, forget: (host) => { if (host) cached.delete(host); else cached.clear(); } };
}

module.exports = { createEgress };
