// The signatures OnlyOffice Docs and this server put on what they send each other (JWT, HS256, a shared secret).
// The secret is read from the env file the container itself is started with (JWT_SECRET=...), so it lives in one place.
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const b64 = (s) => Buffer.from(s).toString('base64url');
const HEAD = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function sign(payload, secret) {
  const h = HEAD + '.' + b64(JSON.stringify(payload));
  return h + '.' + crypto.createHmac('sha256', secret).update(h).digest('base64url');
}

// -> the payload, or null (bad signature, not HS256, expired)
function verify(token, secret) {
  const p = String(token || '').split('.');
  if (p.length !== 3) return null;
  let head, body;
  try { head = JSON.parse(Buffer.from(p[0], 'base64url')); body = JSON.parse(Buffer.from(p[1], 'base64url')); } catch { return null; }
  if (!head || head.alg !== 'HS256' || !body || typeof body !== 'object') return null;
  const want = crypto.createHmac('sha256', secret).update(p[0] + '.' + p[1]).digest();
  const got = Buffer.from(p[2], 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  if (typeof body.exp === 'number' && body.exp * 1000 < Date.now()) return null;
  return body;
}

// JWT_SECRET from an env file (KEY=value lines); null when it is not there
function readSecret(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*JWT_SECRET\s*=\s*(.*?)\s*$/.exec(line);
    if (m) { const v = m[1].replace(/^(['"])(.*)\1$/, '$2'); return v.length >= 16 ? v : null; }
  }
  return null;
}

module.exports = { sign, verify, readSecret };
