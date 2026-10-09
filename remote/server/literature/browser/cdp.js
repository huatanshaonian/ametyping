// A small client for a browser's DevTools protocol: the Chromium of the Zotero container's web desktop, started with
// --remote-debugging-port on 127.0.0.1 (deploy/nas/zotero/). One socket to the browser, a session per tab ("flat"
// sessions); every command has a timeout.
'use strict';
const http = require('http');
const WebSocket = require('ws');

const SEND_MS = 30e3;

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (d) => { b += d; if (b.length > 2e6) req.destroy(new Error('回答太长')); });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('浏览器的调试端口回的不是 JSON')); } });
    });
    req.on('timeout', () => req.destroy(new Error('浏览器的调试端口没有回应')));
    req.on('error', reject);
  });
}

// connect(port) -> { send(method, params, sessionId), on(fn) -> off, attach(targetId) -> sessionId,
//                    evaluate(sessionId, expression, contextId?) -> value, close() }
async function connect(port, host = '127.0.0.1') {
  const v = await getJson(`http://${host}:${port}/json/version`);
  if (!v || !v.webSocketDebuggerUrl) throw new Error('浏览器没有给出调试地址');
  const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0, closed = false;
  const wait = new Map(), subs = new Set();
  const fail = (why) => { closed = true; for (const [, w] of wait) { clearTimeout(w.t); w.rej(new Error(why)); } wait.clear(); };
  ws.on('close', () => fail('和浏览器的连接断了'));
  ws.on('error', () => {});
  ws.on('message', (m) => {
    let d; try { d = JSON.parse(m); } catch { return; }
    if (d.id && wait.has(d.id)) {
      const w = wait.get(d.id); wait.delete(d.id); clearTimeout(w.t);
      if (d.error) w.rej(new Error(d.error.message || 'DevTools 报错')); else w.res(d.result);
    } else for (const f of subs) { try { f(d); } catch {} }
  });
  const send = (method, params = {}, sessionId, timeoutMs = SEND_MS) => new Promise((res, rej) => {
    if (closed) return rej(new Error('和浏览器的连接断了'));
    const i = ++id;
    const t = setTimeout(() => { wait.delete(i); rej(new Error(`浏览器没有回应（${method}）`)); }, timeoutMs);
    wait.set(i, { res, rej, t });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  const on = (f) => { subs.add(f); return () => subs.delete(f); };
  const attach = async (targetId) => (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  async function evaluate(sessionId, expression, contextId) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sessionId);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '页面里的脚本出错');
    return r.result.value;
  }
  return { send, on, attach, evaluate, close: () => { try { ws.close(); } catch {} }, version: v.Browser || '' };
}

module.exports = { connect, getJson };
