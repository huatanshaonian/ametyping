// The Google account the NAS acts for (calendar diary events, Drive copies of notes). Your own OAuth client (Google
// Cloud console, type "Web application", redirect <origin>/api/google/callback) is entered once on the Windose page;
// connecting sends you to Google's consent screen and back. Kept in <dataDir>/google.json (mode 600): the client, the
// refresh token, the account's e-mail, settings. Access tokens are renewed when they run out.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request } = require('./http');

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/drive.file'];
const STATE_MS = 10 * 60e3;

function createAccount({ dataDir, origin, egress, log = () => {} }) {
  const file = path.join(dataDir, 'google.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 2), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  const redirect = () => String(origin || '').replace(/\/$/, '') + '/api/google/callback';
  const states = new Map();                            // state -> { sid, at }: one sign-in in progress each

  const status = () => ({ configured: !!(st.clientId && st.clientSecret), connected: !!(st.token && st.token.refresh), email: st.email || '',
    diary: st.diary !== false, redirect: redirect(), clientId: st.clientId || '', error: st.error || '' });

  function setClient(clientId, clientSecret) {
    clientId = String(clientId || '').trim(); clientSecret = String(clientSecret || '').trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) return { ok: false, msg: '客户端 ID 应该以 .apps.googleusercontent.com 结尾' };
    if (!clientSecret || clientSecret.length > 200 || /\s/.test(clientSecret)) return { ok: false, msg: '客户端密钥不对' };
    if (st.clientId !== clientId) { delete st.token; delete st.email; }        // another client: its old sign-in is void
    Object.assign(st, { clientId, clientSecret }); delete st.error; save();
    return { ok: true };
  }
  function setDiary(on) { st.diary = !!on; save(); return { ok: true }; }

  // the consent-screen address for the browser to go to
  function authUrl(sid) {
    if (!st.clientId) return null;
    for (const [k, v] of states) if (Date.now() - v.at > STATE_MS) states.delete(k);
    const state = crypto.randomBytes(18).toString('base64url');
    states.set(state, { sid, at: Date.now() });
    const q = new URLSearchParams({ client_id: st.clientId, redirect_uri: redirect(), response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
  }

  async function tokenCall(params) {
    const r = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: st.clientId, client_secret: st.clientSecret, ...params }).toString() }, egress);
    if (r.status !== 200 || !r.json) throw Object.assign(new Error('Google 拒绝了：' + ((r.json && (r.json.error_description || r.json.error)) || r.status)), { code: r.json && r.json.error });
    return r.json;
  }

  // Google sent the browser back: the state must be one this server handed out in the last 10 minutes (used once)
  async function callback(code, state) {
    const s = states.get(String(state || ''));
    states.delete(String(state || ''));
    if (!s || Date.now() - s.at > STATE_MS) return { ok: false, msg: '这次登录已过期或不是从这里发起的，请重新连接' };
    if (!code) return { ok: false, msg: 'Google 没有给出授权' };
    const t = await tokenCall({ code: String(code), grant_type: 'authorization_code', redirect_uri: redirect() });
    if (!t.refresh_token) return { ok: false, msg: 'Google 没有给长期授权（请在 Google 账户的「第三方应用」里移除后重连）' };
    let email = '';
    try { email = JSON.parse(Buffer.from(String(t.id_token).split('.')[1], 'base64url').toString('utf8')).email || ''; } catch {}
    st.token = { refresh: t.refresh_token, access: t.access_token, expiry: Date.now() + (t.expires_in || 3600) * 1000, scope: t.scope || '' };
    st.email = email; delete st.error; save();
    log(`Google 已连接：${email}`);
    return { ok: true, email };
  }

  async function accessToken() {
    if (!st.token || !st.token.refresh) throw new Error('还没有连接 Google');
    if (st.token.access && st.token.expiry > Date.now() + 60e3) return st.token.access;
    try {
      const t = await tokenCall({ refresh_token: st.token.refresh, grant_type: 'refresh_token' });
      Object.assign(st.token, { access: t.access_token, expiry: Date.now() + (t.expires_in || 3600) * 1000 }); save();
      return st.token.access;
    } catch (e) {
      if (e.code === 'invalid_grant') { delete st.token; st.error = 'Google 的授权失效了（被撤销或过期），请重新连接'; save(); }
      throw e;
    }
  }

  // a Google API call as the connected account; opts: { method, json, body, headers }
  async function api(url, opts = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken();
      const headers = { Authorization: 'Bearer ' + token, ...(opts.json !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...(opts.headers || {}) };
      const r = await request(url, { method: opts.method || 'GET', headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body }, egress);
      if (r.status === 401 && attempt === 0) { st.token.expiry = 0; continue; }
      if (r.status >= 400) throw new Error(`Google API ${r.status}：${(r.json && r.json.error && (r.json.error.message || r.json.error)) || r.body.toString('utf8').slice(0, 200)}`);
      return r.json;
    }
  }

  async function disconnect() {
    const refresh = st.token && st.token.refresh;
    delete st.token; delete st.email; delete st.error; save();
    if (refresh) try { await request('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refresh), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' }, egress); } catch {}
    return { ok: true };
  }

  // small things worth keeping next to the account (the Drive folder's id)
  const get = (k) => st[k];
  const remember = (k, v) => { st[k] = v; save(); };
  return { status, setClient, setDiary, authUrl, callback, api, disconnect, get, remember };
}

module.exports = { createAccount, SCOPES };
