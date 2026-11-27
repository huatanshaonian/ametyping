// Live machine registry, session list snapshot builder, and browser -> agent control dispatcher (`server.js`).
'use strict';
const crypto = require('crypto');

const VIA = ['terminal', 'resume', 'busy', 'none', 'unknown', 'codex', 'off'];
const AGENT_STATES = ['run', 'done', 'stop'];
const ACTION_MAX = 60;
const ACTION_WIN = 60e3;
const MODES = new Set(['auto', 'manual', 'acceptEdits', 'plan', 'bypassPermissions']);
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

// How to continue a session on its machine (Windows paths get PowerShell syntax)
function resumeCmd(cwd, id, api = '') {
  const claude = /^[A-Za-z0-9._-]{1,40}$/.test(String(api || '')) ? `claude-${api}` : 'claude';
  const cmd = id.startsWith('codex:') ? `codex resume ${id.slice(6)}`
    : id.startsWith('opencode:') ? `opencode -s ${id.slice(9)}`
    : id.startsWith('agy:') ? `agy --conversation ${id.slice(4)}`
    : id.startsWith('kiro:') ? `kiro-cli chat --resume-id ${id.slice(5)}`
    : `${claude} --resume ${id}`;
  if (!cwd) return cmd;
  const q = `'${cwd.replace(/'/g, "''")}'`;
  return /^[A-Za-z]:[\\/]/.test(cwd) ? `cd ${q}; ${cmd}` : `cd '${cwd.replace(/'/g, `'\\''`)}' && ${cmd}`;
}

function agentRows(a) {
  if (!Array.isArray(a)) return [];
  return a.filter((x) => x && typeof x.id === 'string' && AGENT_STATES.includes(x.state)).slice(0, 12).map((x) => ({
    id: str(x.id, 64),
    type: str(x.type, 40),
    name: x.name ? str(x.name, 40) : undefined,
    desc: str(x.desc, 120),
    bg: x.bg === true || undefined,
    state: x.state,
    act: x.act ? str(x.act, 120) : undefined,
    t0: +x.t0 || 0,
    last: +x.last || 0,
    end: +x.end || undefined,
  }));
}

function createSessionControl({
  control = true,
  machines,
  store,
  auth,
  audit = () => {},
  machineProfiles = () => ({ aliases: [] }),
}) {
  const pending = new Map(); // rid -> { c, crid, machine, timer }

  function machine(name) {
    let m = machines.get(name);
    if (!m) {
      m = { name, online: false, since: 0, sessions: new Map() };
      machines.set(name, m);
    }
    return m;
  }

  function updateMachineCapabilities(m) {
    const sockets = [...(m.sockets || [])].filter((s) => s.readyState === 1);
    m.control = sockets.some((s) => s.remoteControlAllowed === true);
    m.files = sockets.some((s) => s.filesAllowed === true);
    m.upload = sockets.some((s) => s.filesAllowed === true && s.uploadAllowed === true);
  }

  function snapshot() {
    const stored = store.sessions();
    const names = new Set([...machines.keys(), ...Object.keys(stored)]);
    const out = [];
    for (const name of names) {
      const m = machines.get(name) || { name, online: false, since: 0, sessions: new Map() };
      const ctl = control && m.online && !!m.control;
      const saved = new Map((stored[name] || []).map((e) => [e.id, e]));
      const list = [...m.sessions.values()].map((s) => {
        const e = saved.get(s.id);
        return {
          id: s.id,
          label: s.label,
          project: s.project,
          state: s.state,
          steps: s.steps,
          t0: s.t0,
          last: Math.max(s.last, e ? e.last : 0),
          lines: s.lines.slice(-8),
          bg: s.bg || undefined,
          via: ctl ? s.via : 'off',
          perms: ctl ? s.perms : [],
          resume: resumeCmd(e && e.cwd, s.id, s.api || (e && e.api)),
          api: s.api || (e && e.api) || '',
          cwd: (e && e.cwd) || undefined,
          mode: e ? e.mode : '',
          ctx: e ? e.ctx : null,
          model: s.model || (e && e.model) || undefined,
          ai: s.ai || (e && e.ai) || undefined,
          agents: s.agents && s.agents.length ? s.agents : undefined,
        };
      });
      for (const e of saved.values()) {
        if (m.sessions.has(e.id)) continue;
        list.push({
          id: e.id,
          label: e.title || e.project || (
            e.id.startsWith('codex:') ? 'Codex'
            : e.id.startsWith('opencode:') ? 'OpenCode'
            : e.id.startsWith('agy:') ? 'Antigravity'
            : e.id.startsWith('kiro:') ? 'Kiro'
            : 'Claude'
          ),
          project: e.project,
          state: 'history',
          steps: 0,
          t0: e.first,
          last: e.last,
          lines: [],
          via: 'off',
          perms: [],
          resume: resumeCmd(e.cwd, e.id, e.api),
          api: e.api || '',
          cwd: e.cwd || undefined,
          mode: e.mode,
          ctx: e.ctx,
          parked: (m.parked && m.parked.has(e.id)) || undefined,
          model: e.model || undefined,
          ai: e.ai || undefined,
        });
      }
      out.push({
        machine: name,
        online: m.online,
        since: m.since,
        control: ctl,
        files: m.online && !!m.files,
        upload: m.online && !!m.files && !!m.upload,
        sessions: list.sort((a, b) => b.last - a.last),
      });
    }
    return out.sort((a, b) => a.machine.localeCompare(b.machine));
  }

  function finishAction(rid, machineName, ok, msg, mode, screen) {
    const p = pending.get(rid);
    if (!p || p.machine !== machineName) return;
    pending.delete(rid);
    clearTimeout(p.timer);
    try {
      p.c.ws.send(JSON.stringify({
        t: 'result',
        rid: p.crid,
        ok,
        msg,
        mode: MODES.has(mode) ? mode : undefined,
        screen,
      }));
    } catch {}
  }

  function onBrowserAction(c, d) {
    const reply = (ok, msg, need) => { try { c.ws.send(JSON.stringify({ t: 'result', rid: d.rid, ok, msg, need })); } catch {} };
    if (!control) return reply(false, '服务器关闭了远程控制');
    const now = Date.now();
    c.acts = (c.acts || []).filter((t) => now - t < ACTION_WIN);
    if (c.acts.length >= ACTION_MAX) return reply(false, '操作太频繁，稍后再试');
    c.acts.push(now);
    const m = typeof d.machine === 'string' && machines.get(d.machine);
    const s = m && typeof d.id === 'string' && m.sessions.get(d.id);
    if (!m || !m.online || !m.sockets || !m.sockets.size) return reply(false, '这台机器不在线');
    if (!m.control) return reply(false, '这台机器没开远程控制');
    if (!s && d.t !== 'launch' && d.t !== 'resume') return reply(false, '这个会话已经不在了');
    if (d.t === 'launch' && !m.files) return reply(false, '这台电脑没开放文件浏览，没法选文件夹启动');
    const sess = auth.checkSession(c.sid);
    if (!auth.isFresh(sess)) { c.acts.pop(); return reply(false, '操作前请再输一次验证码', 'totp'); }
    let out;
    const resolveApi = (id) => (id && machineProfiles(m).aliases.some((p) => p.id === id) ? { id, local: true } : null);

    if (d.t === 'resume') {
      const id = typeof d.id === 'string' ? d.id : '';
      const opencodeId = /^opencode:ses_[A-Za-z0-9]{6,80}$/.test(id);
      if (!opencodeId && !/^(codex:|agy:|kiro:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
        return reply(false, '无效请求');
      }
      if (s && s.via === 'terminal') return reply(false, '这个会话还开着，直接在这里回复就行');
      const saved = store.sessions()[m.name] || [];
      if (!s && !saved.some((e) => e.id === id)) return reply(false, '这台电脑没有这个会话');
      if (id.startsWith('codex:') || id.startsWith('agy:') || id.startsWith('kiro:') || opencodeId) {
        out = { t: 'resume', id };
        audit('control-resume', c.ip, m.name, id);
      } else {
        const explicit = d.api === '__none__' ? 'none' : (typeof d.api === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(d.api) ? d.api : '');
        const stored = saved.find((e) => e.id === id);
        const wanted = explicit === 'none' ? '' : explicit || (s && s.api) || (stored && stored.api) || '';
        let api = null;
        if (wanted) {
          api = resolveApi(wanted);
          if (!api) {
            return reply(false, `API 别名「${wanted}」现在不可用；请换一个别名，或恢复它后再试。`);
          }
        }
        out = { t: 'resume', id, api: api || undefined };
        audit('control-resume', c.ip, m.name, id, explicit === 'none' ? 'none' : api ? api.id : '');
      }
    } else if (d.t === 'launch') {
      const cwd = typeof d.cwd === 'string' ? d.cwd : '', prompt = typeof d.prompt === 'string' ? d.prompt : '';
      if (!cwd || cwd.length > 1000 || prompt.length > 8000) return reply(false, '无效请求');
      const tool = ['codex', 'opencode', 'agy', 'kiro'].includes(d.tool) ? d.tool : 'claude';
      const requested = typeof d.api === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(d.api) ? d.api : '';
      const api = tool === 'claude' ? resolveApi(requested) : null;
      if (requested && tool === 'claude' && !api) return reply(false, '这台电脑没有这个本地启动入口，请刷新或配置后再试');
      out = { t: 'launch', cwd, prompt, tool, api: api || undefined };
      audit('control-launch', c.ip, m.name, JSON.stringify(cwd).slice(0, 300), `prompt=${prompt.length}`, tool, api ? api.id : '');
    } else if (d.t === 'send') {
      const text = typeof d.text === 'string' ? d.text : '';
      if (!text.trim() || text.length > 8000) return reply(false, '内容为空或太长（最多 8000 字）');
      out = { t: 'send', id: s.id, text };
      audit('control-send', c.ip, m.name, s.id, `len=${text.length}`);
    } else if (d.t === 'key') {
      if (typeof d.key !== 'string' || !/^(up|down|left|right|enter|esc|tab|btab|bksp|ctrlxs|ctrl[abe-y]|btwfork|c:[^\x00-\x1f\x7f]{1,200})$/.test(d.key)) {
        return reply(false, '不支持的按键');
      }
      out = { t: 'key', id: s.id, key: d.key, screen: d.screen === true, hl: d.hl === true };
      audit('control-key', c.ip, m.name, s.id, d.key.length > 3 && d.key.startsWith('c:') ? `c:(len=${d.key.length - 2})` : d.key);
    } else if (d.t === 'screen') {
      out = { t: 'screen', id: s.id, hl: d.hl === true };
      audit('control-screen', c.ip, m.name, s.id);
    } else {
      if (typeof d.perm !== 'string' || !['allow', 'always', 'deny', 'defer', 'answer', 'chat'].includes(d.choice)) return reply(false, '无效请求');
      if (!s.perms.some((p) => p.id === d.perm)) return reply(false, '这个确认已经结束了');
      out = { t: 'decide', id: s.id, perm: d.perm, choice: d.choice };
      if (d.choice === 'answer') {
        const a = d.answers, ks = a && typeof a === 'object' && !Array.isArray(a) ? Object.keys(a) : [];
        if (!ks.length || ks.length > 8 || !ks.every((k) => k.length <= 2000 && typeof a[k] === 'string' && a[k].length <= 4000)) {
          return reply(false, '无效请求');
        }
        out.answers = Object.fromEntries(ks.map((k) => [k, a[k]]));
      }
      audit('control-decide', c.ip, m.name, s.id, d.choice);
    }
    const sock = [...m.sockets].reverse().find((sockItem) =>
      sockItem.readyState === 1 &&
      sockItem.remoteControlAllowed === true &&
      (out.t !== 'launch' || sockItem.filesAllowed === true) &&
      (!out.api || (sockItem.claudeProfilesVersion === 1 && sockItem.claudeProfilesAllowed === true))
    );
    if (!sock) return reply(false, '没有支持这次操作的 agent 连接，请更新并重启这台电脑的 agent');
    const rid = crypto.randomBytes(12).toString('hex');
    const timer = setTimeout(() => { if (pending.delete(rid)) reply(false, '机器没有回应，结果不确定，请看对话确认'); }, 20000);
    if (timer.unref) timer.unref();
    pending.set(rid, { c, crid: d.rid, machine: m.name, timer });
    try {
      sock.send(JSON.stringify({ ...out, rid }));
    } catch {
      pending.delete(rid);
      clearTimeout(timer);
      reply(false, '发送失败');
    }
  }

  function dropClientPending(c) {
    for (const [rid, p] of pending) {
      if (p.c === c) {
        clearTimeout(p.timer);
        pending.delete(rid);
      }
    }
  }

  return {
    machine,
    updateMachineCapabilities,
    snapshot,
    finishAction,
    onBrowserAction,
    dropClientPending,
  };
}

module.exports = {
  VIA,
  str,
  resumeCmd,
  agentRows,
  createSessionControl,
};
