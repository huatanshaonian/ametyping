// Wallpapers fetched by the server: the desktop's display settings take an image URL, the server downloads it into
// its own folder (config "wallDir", default data/wall next to config.json), and every device can pick it. The page
// itself never loads anything from outside (CSP stays 'self'), so nothing here can be used to track the viewer.
// The download is guarded: https only, and the host must not resolve to this machine or any private network
// (the NAS, the tailnet, the router...) -- checked again on every redirect, and the connection goes to exactly the
// address that was checked (no second DNS lookup to rebind).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');

const MAX = 20 * 1024 * 1024;
const TIMEOUT = 30e3;
const NAME = /^[0-9]{8}-[0-9a-f]{10}\.(png|jpg|webp|gif)$/;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// addresses a download must never reach
function blocked(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||            // carrier-grade NAT / Tailscale
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return blocked(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8:');
  }
  return true;
}

// what the first bytes say the file is (the Content-Type header alone is not trusted)
function sniff(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  return null;
}

async function vetted(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('网址格式不对'); }
  if (u.protocol !== 'https:') throw new Error('只支持 https 网址');
  if (u.username || u.password) throw new Error('网址里不能带账号密码');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('解析不到这个域名');
  if (addrs.some((a) => blocked(a.address))) throw new Error('不能从内网或本机地址下载');
  return { u, addr: addrs[0] };
}

function get(url, hops) {
  return vetted(url).then(({ u, addr }) => new Promise((resolve, reject) => {
    const req = https.get(u, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (wallpaper fetch)', Accept: 'image/*' },
      // connect to the address that was checked (newer Node asks for a list: { all: true })
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= 3) return reject(new Error('跳转太多次'));
        return resolve(get(new URL(res.headers.location, u).toString(), hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`对方返回 ${res.statusCode}`)); }
      if (!/^image\//i.test(String(res.headers['content-type'] || ''))) { res.resume(); return reject(new Error('这个网址不是图片')); }
      if (+res.headers['content-length'] > MAX) { res.resume(); return reject(new Error('图片超过 20 MB')); }
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > MAX) { req.destroy(); reject(new Error('图片超过 20 MB')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  }));
}

function createWalls(dir) {
  const ensure = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  async function fetchUrl(url) {
    const buf = await get(String(url || '').trim(), 0);
    const ext = sniff(buf);
    if (!ext) throw new Error('下载到的不是 PNG / JPEG / WebP / GIF 图片');
    ensure();
    const d = new Date(), day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const name = `${day}-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10)}.${ext}`;
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) { fs.writeFileSync(f + '.tmp', buf, { mode: 0o600 }); fs.renameSync(f + '.tmp', f); }
    return name;
  }
  function list() {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => NAME.test(n)); } catch {}
    return names.map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  }
  function remove(name) {
    if (!NAME.test(String(name))) return false;
    try { fs.unlinkSync(path.join(dir, name)); return true; } catch { return false; }
  }
  // file path + type for serving, or null
  function file(name) {
    if (!NAME.test(String(name))) return null;
    const f = path.join(dir, name);
    return fs.existsSync(f) ? { f, type: TYPES[name.split('.').pop()] } : null;
  }
  return { fetchUrl, list, remove, file };
}

module.exports = { createWalls, blocked, sniff };
