// 添加 / 移除电脑 from the dashboard (instead of running setup.js add-agent on the server): the machines allowed to
// connect live in config.json "agents" (name + token hash). Adding one returns its token once. Both need a code
// entered within the last hour (like acting on a machine) and are written to the audit log.
'use strict';
const fs = require('fs');
const auth = require('./auth');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function createAgentsAdmin({ configFile, machines, audit }) {
  const load = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  function save(c) {
    fs.writeFileSync(configFile + '.tmp', JSON.stringify(c, null, 2), { mode: 0o600 });
    fs.renameSync(configFile + '.tmp', configFile);
  }

  // [{ name, added, online }]
  function list() {
    const c = load();
    return (c.agents || []).map((a) => ({ name: a.name, added: a.added || '', online: !!(machines.get(a.name) && machines.get(a.name).online) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // a new token for `name` (replacing the old one of that name, whose connection is then closed)
  function add(name, ip) {
    if (typeof name !== 'string' || !NAME.test(name)) return { ok: false, msg: '名字只能用字母、数字、点、横线、下划线（最多 40 个）' };
    const c = load();
    const replaced = (c.agents || []).some((a) => a.name === name);
    const t = auth.token();
    c.agents = (c.agents || []).filter((a) => a.name !== name).concat({ name, hash: auth.hashToken(t), added: new Date().toISOString() });
    save(c);
    if (replaced) kick(name);
    audit('agent-add', ip, name, replaced ? '(replaced)' : '');
    return { ok: true, name, token: t, replaced };
  }

  function remove(name, ip) {
    const c = load();
    if (!(c.agents || []).some((a) => a.name === name)) return { ok: false, msg: '没有这台电脑' };
    c.agents = c.agents.filter((a) => a.name !== name);
    save(c);
    kick(name);
    audit('agent-remove', ip, name);
    return { ok: true };
  }

  // close the live connections of a machine whose token is no longer valid
  function kick(name) {
    const m = machines.get(name);
    if (m && m.sockets) for (const s of [...m.sockets]) { try { s.close(4403, 'token revoked'); } catch {} }
  }

  return { list, add, remove };
}

module.exports = { createAgentsAdmin };
