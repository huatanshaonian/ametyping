'use strict';
const crypto = require('crypto');
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const str = (v, n = 1000) => typeof v === 'string' ? v.slice(0, n) : '';
function profileView(p) {
  if (!p || !ID.test(p.id || '')) return null;
  let baseUrl = str(p.baseUrl), proxy = str(p.proxy);
  for (const field of ['baseUrl', 'proxy']) {
    const value = field === 'baseUrl' ? baseUrl : proxy;
    if (!value || value === '__UNCHANGED__') continue;
    try {
      const u = new URL(value);
      if (u.username || u.password || u.search) { if (field === 'baseUrl') baseUrl = '__UNCHANGED__'; else proxy = '__UNCHANGED__'; }
    } catch { if (field === 'baseUrl') baseUrl = ''; else proxy = ''; }
  }
  return { id: p.id, command: 'claude-' + p.id, file: str(p.file), baseUrl, baseHost: str(p.baseHost, 200),
    model: str(p.model, 120), hasCredential: p.hasCredential === true, network: p.network === 'proxy' ? 'proxy' : 'direct', proxy };
}
function profilesView(value) {
  const v = value || {};
  const profiles = (Array.isArray(v.profiles) ? v.profiles : []).slice(0, 50).map(profileView).filter(Boolean);
  return { root: str(v.root), sharedDirectory: str(v.sharedDirectory), sharedState: str(v.sharedState), profiles,
    aliases: profiles.map(p => ({ id: p.id, label: p.command, model: p.model, network: p.network })), default: '' };
}
function createProfileRequests({ timeoutMs = 15000 } = {}) {
  const pending = new Map();
  function request(machine, action, profile) {
    const socket = machine && machine.sockets && [...machine.sockets].reverse().find(s =>
      s.readyState === 1 && s.claudeProfilesVersion === 1 && s.claudeProfilesAllowed === true);
    if (!socket) return Promise.resolve({ ok: false, msg: '这台电脑的 agent 尚未接入本地启动入口，请更新并重启 agent。' });
    const rid = crypto.randomBytes(12).toString('hex');
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(rid); resolve({ ok: false, msg: '等待这台电脑的 agent 超时，请重启 agent 后刷新；配置是否保存请以电脑上的文件为准。' });
      }, timeoutMs);
      pending.set(rid, { socket, resolve, timer });
      try { socket.send(JSON.stringify({ t: 'claude-profiles-request', rid, action, profile })); }
      catch { finish(socket, { rid, ok: false, msg: '发送失败，请刷新连接' }); }
    });
  }
  function finish(socket, data) {
    const p = pending.get(data.rid);
    if (!p || p.socket !== socket) return false;
    pending.delete(data.rid); clearTimeout(p.timer);
    p.resolve({ ok: data.ok === true, msg: data.ok === true ? undefined : str(data.msg, 240),
      view: data.ok === true ? profilesView(data.view) : undefined,
      profile: data.ok === true ? profileView(data.profile) : undefined });
    return true;
  }
  function drop(socket) {
    for (const [rid, p] of pending) if (p.socket === socket) finish(socket, { rid, ok: false, msg: '电脑连接已断开，请重连后刷新' });
  }
  return { request, finish, drop };
}
module.exports = { createProfileRequests, profilesView, profileView };
