'use strict';
// Shared runtime helpers for AmeTyping CLI lifecycle & permission hooks
// (agy-hook.js, codex-hook.js, kiro-hook.js, hook-relay.js, permission-hook.js).
// Pure Node built-ins only; included in Fleet agent bundles via remote/agent/.

const fs = require('fs');
const http = require('http');
const path = require('path');

function cut(s, n = 100, ellipsis = false) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  if (str.length <= n) return str;
  return ellipsis ? str.slice(0, Math.max(0, n - 1)) + '…' : str.slice(0, n);
}

function cutRawWs(s, n = 100) {
  return String(s || '').replace(/\s+/g, ' ').slice(0, n);
}

function baseName(f) {
  return f ? path.basename(String(f).replace(/[\\/]+$/, '')) : '';
}

function looksLikeToolFailure(r) {
  if (!r || typeof r !== 'object') return false;
  return Boolean(
    r.is_error === true ||
    r.isError === true ||
    r.success === false ||
    r.status === 'error' ||
    (typeof r.exit_code === 'number' && r.exit_code !== 0)
  );
}

// Safe file tail reader: always closes file descriptor even on short read / race truncation.
function readFileTail(file, maxBytes) {
  if (!file || !fs.existsSync(file)) return '';
  const st = fs.statSync(file);
  const len = Math.min(st.size, maxBytes);
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Non-throwing loopback JSON POST with hard timeout and response size cap.
function postLoopbackJson({
  port = Number(process.env.AME_PORT) || 3940,
  route,
  body,
  timeoutMs = 700,
  maxResponseBytes = 65536,
  parseJson = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    let timer = null;
    const done = (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(val);
    };

    const payload = typeof body === 'string' ? body : JSON.stringify(body || {});
    timer = setTimeout(() => {
      if (req) { try { req.destroy(); } catch {} }
      done({ ok: false, statusCode: 0, data: null });
    }, Math.max(1, timeoutMs));
    if (timer.unref) timer.unref();

    req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      if (!parseJson) {
        res.resume();
        res.on('error', () => done({ ok: false, statusCode: res.statusCode || 0, data: null }));
        res.on('end', () => done({ ok: res.statusCode === 200, statusCode: res.statusCode || 0, data: null }));
        res.on('close', () => done({ ok: res.statusCode === 200, statusCode: res.statusCode || 0, data: null }));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        raw += c;
        if (raw.length > maxResponseBytes) {
          try { res.destroy(); } catch {}
          try { req.destroy(); } catch {}
          done({ ok: false, statusCode: res.statusCode || 0, data: null });
        }
      });
      res.on('error', () => done({ ok: false, statusCode: res.statusCode || 0, data: null }));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw || '{}'); } catch {}
        done({ ok: res.statusCode === 200, statusCode: res.statusCode || 0, data: parsed });
      });
      res.on('close', () => done({ ok: false, statusCode: res.statusCode || 0, data: null }));
    });

    req.on('error', () => done({ ok: false, statusCode: 0, data: null }));
    req.end(payload);
  });
}

// Unified streaming stdin JSON hook runner:
// - Forces UTF-8 decoding (prevents multi-byte CJK split corruption across chunks)
// - Dispatches as soon as a complete JSON object arrives on stdin (does not hang when shell leaves stdin open)
// - Preserves original notification deadline while granting long-poll budget to /permission requests
function runJsonHook({
  initialTimeoutMs = 2000,
  notifyRequestBudgetMs = 700,
  permissionTimeoutMs = 110000,
  maxInputBytes = 2e6,
  fallbackOutput = {},
  formatOutput = (v) => (typeof v === 'string' ? v : JSON.stringify(v)),
  onPayload,
}) {
  const eventAt = Date.now();
  const deadline = eventAt + initialTimeoutMs;
  let finished = false;
  let handled = false;
  let guard = null;

  const finish = (outputVal = fallbackOutput) => {
    if (finished) return;
    finished = true;
    if (guard) clearTimeout(guard);
    const outStr = formatOutput(outputVal);
    process.stdout.write(outStr, () => process.exit(0));
  };

  guard = setTimeout(() => finish(fallbackOutput), initialTimeoutMs);
  if (guard.unref) guard.unref();

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (handled || finished) return;
    raw += chunk;
    if (raw.length > maxInputBytes) return finish(fallbackOutput);
    consume(false);
  });
  process.stdin.on('error', () => finish(fallbackOutput));
  process.stdin.on('end', () => consume(true));

  function consume(ended) {
    if (handled || finished) return;
    const trimmed = raw.replace(/^\uFEFF/, '');
    if (!trimmed.trim()) {
      if (ended) finish(fallbackOutput);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      if (ended) finish(fallbackOutput);
      return;
    }
    handled = true;
    Promise.resolve(onPayload(parsed, {
      eventAt,
      deadline,
      notifyBudgetMs: () => Math.min(notifyRequestBudgetMs, deadline - Date.now()),
      setGuardTimeout: (ms, timeoutOut = fallbackOutput) => {
        if (guard) clearTimeout(guard);
        guard = setTimeout(() => finish(timeoutOut), Math.max(1, ms));
      },
      permissionTimeoutMs,
      finish,
    })).catch(() => finish(fallbackOutput));
  }
}

module.exports = {
  cut,
  cutRawWs,
  baseName,
  looksLikeToolFailure,
  readFileTail,
  postLoopbackJson,
  runJsonHook,
};
