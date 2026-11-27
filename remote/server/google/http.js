// HTTPS to Google from the NAS, through whichever proxy gets there (server/egress.js: the PC's v2rayN, else the AWS
// way out; none configured = direct). A CONNECT tunnel through the HTTP proxy, TLS on top, the request over that.
'use strict';
const https = require('https');
const { connectTunnel } = require('../lib/http-util');

const TIMEOUT_MS = 30e3;

const tunnel = (proxyUrl, host, port = 443) => connectTunnel(proxyUrl, host, port, { timeoutMs: TIMEOUT_MS });

// request(url, { method, headers, body (string | Buffer) }, egress) -> { status, headers, body (Buffer), json }
async function request(url, opts = {}, egress = null) {
  const u = new URL(url);
  let createConnection;
  if (egress) {
    const proxy = await egress.pick(u.hostname);
    if (!proxy) throw new Error('连不上 Google：电脑上的代理和 AWS 备用线路都不通');
    const sock = await tunnel(proxy, u.hostname).catch((e) => { egress.forget(); throw e; });
    createConnection = () => sock;
  }
  return new Promise((resolve, reject) => {
    const body = opts.body == null ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body));
    // port / defaultPort: with our own connection (no agent) Node would otherwise send "Host: <host>:80", which Google answers with 404
    const req = https.request({ hostname: u.hostname, port: 443, defaultPort: 443, path: u.pathname + u.search, method: opts.method || 'GET', createConnection,
      headers: { ...(opts.headers || {}), ...(body ? { 'Content-Length': body.length } : {}) }, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Google 没有回应')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { request, tunnel };
