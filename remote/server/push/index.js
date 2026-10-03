// Notifications on the phone (or any browser): Web Push to every device that turned them on in 控制面板 → 通知.
//   <dataDir>/push.json   { keys: { publicKey, privateKey }, subs: [{ id, endpoint, keys, name, created, kinds, last }] }
// What is sent (each device chooses): approval (a permission prompt is waiting), done (a long task finished), ctx (a
// session's context nearly full), mail (a mail alert). A device whose own Windose page is on screen right now gets
// nothing -- it shows it already. Push services that say a subscription is gone (404 / 410): it is dropped.
//   GET  /api/push            { key, devices: [...] }
//   POST /api/push/subscribe  { sub, name } -> { ok, id }      POST /api/push/update { id, name?, kinds? }
//   POST /api/push/remove     { id }                            POST /api/push/test   { id? }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wp = require('./webpush');

const KINDS = ['approval', 'done', 'ctx', 'mail'];
const MAX_SUBS = 20;
const VISIBLE_MS = 45e3;                  // a page that said "I am on screen" counts as such this long (it repeats every 20 s)

function createPush({ dataDir, request, subject = 'mailto:windose@localhost', log = () => {}, audit = () => {} }) {
  const file = path.join(dataDir, 'push.json');
  let data = { keys: null, subs: [] };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && Array.isArray(d.subs)) data = d; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  if (!data.keys) { data.keys = wp.newKeys(); save(); }
  const idOf = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 16);
  const visible = new Map();                          // sub id -> until (its page on screen)
  const view = (s) => ({ id: s.id, name: s.name, created: s.created, kinds: s.kinds, last: s.last || null, service: new URL(s.endpoint).hostname });
  const name = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '浏览器';

  function subscribe(d) {
    const sub = d && d.sub;
    if (!sub || typeof sub.endpoint !== 'string' || !wp.okEndpoint(sub.endpoint) || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return { ok: false, msg: '这个订阅不像浏览器的推送服务' };
    const id = idOf(sub.endpoint);
    const had = data.subs.find((s) => s.id === id);
    if (!had && data.subs.length >= MAX_SUBS) return { ok: false, msg: '设备太多了，先删掉几个' };
    const s = had || { id, created: Date.now(), kinds: Object.fromEntries(KINDS.map((k) => [k, true])) };
    Object.assign(s, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, name: name(d.name) });
    if (!had) data.subs.push(s);
    save();
    return { ok: true, id };
  }
  function update(d) {
    const s = data.subs.find((x) => x.id === d.id);
    if (!s) return { ok: false, msg: '这个设备已经不在了' };
    if (typeof d.name === 'string') s.name = name(d.name);
    if (d.kinds && typeof d.kinds === 'object') for (const k of KINDS) if (typeof d.kinds[k] === 'boolean') s.kinds[k] = d.kinds[k];
    save();
    return { ok: true };
  }
  function remove(id) { const n = data.subs.length; data.subs = data.subs.filter((s) => s.id !== id); if (data.subs.length !== n) save(); return { ok: data.subs.length !== n }; }

  // a page tells whether it is on screen (endpoint: its own subscription)
  function here(endpoint, on) { const id = idOf(endpoint); if (on) visible.set(id, Date.now() + VISIBLE_MS); else visible.delete(id); }

  // one notification to every device that wants this kind: { title, body, tag, url }
  async function notify(kind, msg, { only = null, force = false } = {}) {
    const to = data.subs.filter((s) => (only ? s.id === only : s.kinds[kind] !== false) && (force || !((visible.get(s.id) || 0) > Date.now())));
    const results = await Promise.all(to.map(async (s) => {
      let r;
      try { r = await wp.send(s, { kind, ...msg }, { keys: data.keys, subject, request, urgency: kind === 'approval' ? 'high' : 'normal' }); }
      catch (e) { r = { ok: false, status: 0, detail: e.message }; }
      s.last = { at: Date.now(), ok: r.ok, status: r.status, err: r.ok ? '' : String(r.detail || '').slice(0, 120) };
      if (r.gone) { log(`推送：${s.name} 的订阅已失效，删除`); data.subs = data.subs.filter((x) => x !== s); }
      else if (!r.ok) log(`推送给 ${s.name} 失败（${r.status}）：${r.detail}`);
      return r;
    }));
    if (to.length) save();
    return { sent: results.filter((r) => r.ok).length, of: to.length };
  }

  // the web API (same-origin POSTs are checked by server.js); true when handled
  async function handle(req, res, p, ip, json, readBody) {
    if (req.method === 'GET' && p === '/api/push') { json(res, 200, { key: data.keys.publicKey, kinds: KINDS, devices: data.subs.map(view) }); return true; }
    if (req.method !== 'POST' || !/^\/api\/push\/(subscribe|update|remove|test)$/.test(p)) return false;
    let d = {}; try { d = JSON.parse(await readBody(req, 8192)); } catch {}
    if (!d || typeof d !== 'object') d = {};
    const what = p.split('/').pop();
    let r;
    if (what === 'subscribe') r = subscribe(d);
    else if (what === 'update') r = update(d);
    else if (what === 'remove') r = remove(String(d.id || ''));
    else {
      const out = await notify('test', { title: 'Windose 测试通知', body: '能看到这条，说明这台设备的通知是通的。', tag: 'test', url: '/' }, { only: typeof d.id === 'string' ? d.id : null, force: true });
      r = out.of ? (out.sent ? { ok: true, msg: `已发出（${out.sent}/${out.of}）` } : { ok: false, msg: '没发出去：' + ((data.subs.find((s) => s.id === d.id) || {}).last || {}).err }) : { ok: false, msg: '还没有开启通知的设备' };
    }
    if (r.ok && what !== 'test') audit('push-' + what, ip);
    json(res, 200, r);
    return true;
  }

  return { handle, notify, here, publicKey: () => data.keys.publicKey, devices: () => data.subs.map(view), KINDS };
}

module.exports = { createPush, KINDS };
