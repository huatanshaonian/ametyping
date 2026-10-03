// Web Push without a library: a notification for one browser subscription, encrypted so only that browser can read it
// (RFC 8291, aes128gcm), signed with this server's key so the push service knows who sends it (RFC 8292, VAPID).
// The push services (Google's for Chrome, Apple's for Safari, Mozilla's, Microsoft's) pass it on to the device
// without being able to read it.
'use strict';
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const MAX_PAYLOAD = 3000;                 // (a record is 4096 bytes; push services take about that much)

// this server's key pair (made once, kept in push.json): base64url, public = the uncompressed point (65 bytes)
function newKeys() {
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
}

// the Authorization header for one push service: a JWT (ES256) naming that service, valid 12 hours
function vapid(endpoint, keys, subject) {
  const pub = fromB64u(keys.publicKey);
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: keys.privateKey } });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

// the message for one subscription ({ endpoint, keys: { p256dh, auth } }): one aes128gcm record
function encrypt(sub, payload) {
  const uaPublic = fromB64u(sub.keys.p256dh), authSecret = fromB64u(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('订阅的密钥不对');
  const as = crypto.createECDH('prime256v1'); as.generateKeys();
  const asPublic = as.getPublicKey(), shared = as.computeSecret(uaPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])])).subarray(0, 32);
  const salt = crypto.randomBytes(16), prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// only the browsers' push services: a subscription is a URL the server will post to, so not just any URL
const SERVICES = /^([a-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/i;
function okEndpoint(endpoint) {
  try { const u = new URL(endpoint); return u.protocol === 'https:' && SERVICES.test(u.hostname) && !u.port; } catch { return false; }
}

// send one notification: request(url, { method, headers, body }) -> { status } (google/http.js's, through the proxies)
async function send(sub, data, { keys, subject, request, ttl = 3600, urgency = 'high' }) {
  let payload = JSON.stringify(data);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD) payload = JSON.stringify({ ...data, body: String(data.body || '').slice(0, 600) });
  const r = await request(sub.endpoint, { method: 'POST', body: encrypt(sub, payload), headers: {
    Authorization: vapid(sub.endpoint, keys, subject), TTL: String(ttl), Urgency: urgency,
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } });
  return { status: r.status, gone: r.status === 404 || r.status === 410, ok: r.status >= 200 && r.status < 300, detail: r.body ? String(r.body).slice(0, 200) : '' };
}

module.exports = { newKeys, vapid, encrypt, send, okEndpoint, b64u, fromB64u };
