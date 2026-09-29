// Google on the Windose page: the account window (client, connect, disconnect, diary on/off), the diary events the
// daily reports become, calendar events for the calendar window, notes copied to Drive. Changing anything about the
// account needs a code entered within the hour (like remote control); the callback from Google's consent screen is
// public (the login cookie is SameSite=Strict, so Google's redirect arrives without it) and checked by its one-time state.
'use strict';
const { createAccount } = require('./account');
const { createCalendar } = require('./calendar');
const { createDrive } = require('./drive');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function createGoogle({ dataDir, origin, egress, notes, log = console.log, audit = () => {} }) {
  const account = createAccount({ dataDir, origin, egress, log });
  const calendar = createCalendar({ account, origin, log });
  const drive = createDrive({ account, log });
  const connected = () => account.status().connected;

  // a finished daily report becomes that day's diary event (when connected and wanted); failures are only logged
  function onReport(r) {
    if (!r || r.draft || !connected() || !account.status().diary) return;
    calendar.diary(r).catch((e) => log('Google 日历写入失败：' + e.message));
  }
  async function events(from, to) {
    if (!connected()) return { connected: false, items: [] };
    try { return { connected: true, items: await calendar.events(from, to) }; }
    catch (e) { return { connected: true, items: [], error: e.message }; }
  }

  // GET /api/google/callback, before the login check
  async function handleCallback(req, res, url, send) {
    let r;
    try { r = await account.callback(url.searchParams.get('code'), url.searchParams.get('state')); }
    catch (e) { r = { ok: false, msg: e.message }; }
    if (url.searchParams.get('error')) r = { ok: false, msg: '在 Google 页面上取消了' };
    audit('google-callback', '-', r.ok ? 'ok' : 'failed');
    const to = r.ok ? '/#google=ok' : '/#google=fail';
    send(res, 200, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="${r.ok ? 0 : 4};url=${to}">` +
      `<title>Google</title><p style="font:14px sans-serif;padding:20px">${r.ok ? '已连接 Google，正在返回 Windose…' : '没能连接 Google：' + esc(r.msg) + '<br>几秒后返回 Windose。'}</p>`, 'text/html; charset=utf-8');
  }

  // the rest of /api/google/*; fresh(): a code was entered within the hour
  async function handle(req, res, p, ip, json, readBody, fresh) {
    if (req.method === 'GET' && p === '/api/google') { json(res, 200, account.status()); return true; }
    if (req.method !== 'POST' || !p.startsWith('/api/google/')) return false;
    let d = {}; try { d = JSON.parse(await readBody(req, 8192)); } catch {}
    const what = p.slice('/api/google/'.length);
    if (['client', 'connect', 'disconnect', 'diary'].includes(what) && !fresh()) { json(res, 200, { ok: false, need: 'totp', msg: '需要再输一次验证码' }); return true; }
    let r;
    try {
      if (what === 'client') r = account.setClient(d.clientId, d.clientSecret);
      else if (what === 'diary') r = account.setDiary(d.on);
      else if (what === 'connect') { const u = account.authUrl(); r = u ? { ok: true, url: u } : { ok: false, msg: '先填好客户端 ID 和密钥' }; }
      else if (what === 'disconnect') r = await account.disconnect();
      else if (what === 'drive-note') {
        const n = notes && notes.get(String(d.id || ''));
        if (!n) r = { ok: false, msg: '找不到这篇笔记' };
        else if (!connected()) r = { ok: false, msg: '还没有连接 Google（开始菜单 →「Google 账户」）' };
        else { const f = await drive.saveNote(n); notes.setDrive(n.id, { fileId: f.fileId, at: Date.now() }); r = { ok: true, name: f.name }; }
      } else { json(res, 404, { ok: false }); return true; }
    } catch (e) { r = { ok: false, msg: e.message }; }
    if (r.ok) audit('google-' + what, ip);
    json(res, 200, r);
    return true;
  }

  return { handle, handleCallback, onReport, events, connected, status: account.status };
}

module.exports = { createGoogle };
