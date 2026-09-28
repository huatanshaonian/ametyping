// Authentication for the remote panel: one account, scrypt password + TOTP (RFC 6238), in-memory sessions,
// login throttling. Only Node's own crypto is used.
'use strict';
const crypto = require('crypto');

// ---------- password (scrypt) ----------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(want, got);
}

// ---------- TOTP ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = (val << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const newTotpSecret = () => base32(crypto.randomBytes(20));
function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// accepts the current 30 s step and one on either side (clock drift); a step can be used once only
let lastStep = 0;
function verifyTotp(secret, code, now = Date.now()) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const step = Math.floor(now / 30000);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, s)), Buffer.from(code))) { lastStep = s; return true; }
  }
  return false;
}
const otpauthUri = (secret, user, issuer = 'AmeRemote') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---------- throttling ----------
// per IP: 5 failures in 15 min -> locked 15 min. Globally (it is a single account, so a spread-out
// attack still hits the same door): 20 failures in an hour -> every login locked for 30 min.
const fails = new Map();          // ip -> [times]
let globalFails = [], globalLockUntil = 0;
const IP_MAX = 5, IP_WIN = 15 * 60e3, GLOBAL_MAX = 20, GLOBAL_WIN = 60 * 60e3, GLOBAL_LOCK = 30 * 60e3;
function lockedFor(ip, now = Date.now()) {
  if (now < globalLockUntil) return globalLockUntil - now;
  const f = (fails.get(ip) || []).filter((t) => now - t < IP_WIN);
  fails.set(ip, f);
  return f.length >= IP_MAX ? f[0] + IP_WIN - now : 0;
}
function recordFail(ip, now = Date.now()) {
  const f = (fails.get(ip) || []).filter((t) => now - t < IP_WIN); f.push(now); fails.set(ip, f);
  globalFails = globalFails.filter((t) => now - t < GLOBAL_WIN); globalFails.push(now);
  if (globalFails.length >= GLOBAL_MAX) { globalLockUntil = now + GLOBAL_LOCK; globalFails = []; }
  return IP_MAX - f.length;                                   // attempts left from this IP
}
const clearFails = (ip) => fails.delete(ip);

// ---------- sessions ----------
// Logged in: 8 h idle, 24 h max. Acting on a machine (reply / permission) also needs a TOTP code entered
// within the last FRESH_MS -- logging in counts -- so a stolen cookie alone can read but not act.
const sids = new Map();
const IDLE_MS = 8 * 3600e3, MAX_MS = 24 * 3600e3, FRESH_MS = +process.env.AME_FRESH_MS || 10 * 60e3;   // env: tests only
const token = () => crypto.randomBytes(32).toString('base64url');
function newSession(ip, ua) { const t = token(), now = Date.now(); sids.set(t, { ip, ua, born: now, seen: now, fresh: now }); return t; }
function checkSession(t) {
  const s = t && sids.get(t), now = Date.now();
  if (!s) return null;
  if (now - s.seen > IDLE_MS || now - s.born > MAX_MS) { sids.delete(t); return null; }
  s.seen = now;
  return s;
}
// same check without counting as activity (an open tab alone must not keep a login alive)
function checkSessionQuiet(t) {
  const s = t && sids.get(t), now = Date.now();
  return s && now - s.seen <= IDLE_MS && now - s.born <= MAX_MS ? s : null;
}
const isFresh = (s, now = Date.now()) => !!s && now - s.fresh < FRESH_MS;
const markFresh = (s) => { if (s) s.fresh = Date.now(); };
const endSession = (t) => sids.delete(t);
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sids) if (now - s.seen > IDLE_MS || now - s.born > MAX_MS) sids.delete(t);
}, 60e3).unref();

// constant-time string compare (the username)
const sameText = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

// agent tokens are long random strings, stored as sha256
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function matchAgent(agents, t) {
  const h = Buffer.from(hashToken(t));
  return (agents || []).find((a) => a.hash && a.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(a.hash), h)) || null;
}

module.exports = {
  hashPassword, verifyPassword, newTotpSecret, totpAt, verifyTotp, otpauthUri,
  lockedFor, recordFail, clearFails, newSession, checkSession, checkSessionQuiet, endSession, isFresh, markFresh, FRESH_MS,
  sameText, token, hashToken, matchAgent,
};
