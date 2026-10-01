// 糖糖看板's own marks on sessions: hidden / pinned / starred, and groups that gather sessions from any machine.
// Kept on the server so every device shows the same list; a change is broadcast as `marks` and the pages reload.
//   <dataDir>/session-marks.json   { sessions: { "machine|id": { hidden, pinned, starred, group } }, groups: [{ id, name, created }] }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY = /^[^|\x00-\x1f]{1,100}\|[^|\x00-\x1f]{1,160}$/;      // "machine|session id"
const FLAGS = ['hidden', 'pinned', 'starred'];
const MAX_SESSIONS = 3000, MAX_GROUPS = 50;

function createMarks({ dataDir, onChange = () => {}, audit = () => {} }) {
  const file = path.join(dataDir, 'session-marks.json');
  let data = { sessions: {}, groups: [] };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && typeof d.sessions === 'object' && Array.isArray(d.groups)) data = d; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); onChange(); };
  const name = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 40) : '');

  // one session's marks; a field left out stays as it is, group '' takes it out of its group
  function set(d) {
    if (typeof d.key !== 'string' || !KEY.test(d.key)) return { ok: false, msg: '无效的会话' };
    const m = { ...(data.sessions[d.key] || {}) };
    for (const f of FLAGS) if (typeof d[f] === 'boolean') { if (d[f]) m[f] = true; else delete m[f]; }
    if (typeof d.group === 'string') {
      if (d.group && !data.groups.some((g) => g.id === d.group)) return { ok: false, msg: '这个群组已经不在了' };
      if (d.group) m.group = d.group; else delete m.group;
    }
    if (Object.keys(m).length) {
      if (!data.sessions[d.key] && Object.keys(data.sessions).length >= MAX_SESSIONS) return { ok: false, msg: '标记太多了' };
      data.sessions[d.key] = m;
    } else delete data.sessions[d.key];
    save();
    return { ok: true };
  }
  function group(d) {
    if (d.op === 'add') {
      const n = name(d.name);
      if (!n) return { ok: false, msg: '名字是空的' };
      if (data.groups.length >= MAX_GROUPS) return { ok: false, msg: '群组太多了' };
      const g = { id: crypto.randomBytes(5).toString('hex'), name: n, created: Date.now() };
      data.groups.push(g); save();
      return { ok: true, group: g };
    }
    const g = data.groups.find((x) => x.id === d.id);
    if (!g) return { ok: false, msg: '这个群组已经不在了' };
    if (d.op === 'rename') {
      const n = name(d.name);
      if (!n) return { ok: false, msg: '名字是空的' };
      g.name = n; save();
      return { ok: true, group: g };
    }
    if (d.op === 'delete') {
      // its sessions go back under their machines; their other marks stay
      data.groups = data.groups.filter((x) => x !== g);
      for (const [k, m] of Object.entries(data.sessions)) {
        if (m.group !== g.id) continue;
        delete m.group;
        if (!Object.keys(m).length) delete data.sessions[k];
      }
      save();
      return { ok: true };
    }
    return { ok: false, msg: '无效请求' };
  }

  // the web API (same-origin POSTs are checked by server.js); true when handled
  async function handle(req, res, p, ip, json, readBody) {
    if (req.method === 'GET' && p === '/api/marks') { json(res, 200, data); return true; }
    if (req.method !== 'POST' || !/^\/api\/marks\/(set|group)$/.test(p)) return false;
    let d = {}; try { d = JSON.parse(await readBody(req)); } catch {}
    if (!d || typeof d !== 'object') d = {};
    const r = p.endsWith('/set') ? set(d) : group(d);
    if (r.ok && p.endsWith('/group')) audit('marks-group-' + d.op, ip);
    json(res, 200, r);
    return true;
  }
  return { get: () => data, set, group, handle };
}

module.exports = { createMarks };
