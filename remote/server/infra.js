// Infrastructure & Network Topology Monitor (网络与设备):
//   - Tracks workstations, OpenWrt router, Synology NAS (local collector), and cloud servers (AWS/GCP).
//   - Accepts reports from both existing agent.js WebSockets ({ t: 'infra' }) and zero-dependency shell probes
//     (POST /api/infra/report with Bearer token, plus GET /api/infra/poll long-polling for <1s remote control).
//   - Event-driven: service/container state changes or node offline transitions record events and trigger Web Push.
'use strict';
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');
const { createCollector, stateSignature } = require('../agent/infra-probe');
const { readJsonSafe, writeJsonAtomic } = require('./lib/json-store');
const {
  OFFLINE_MS,
  STALL_MS,
  ALERT_COOLDOWN_MS,
  MAX_EVENTS,
  UPGRADE_EVENTS,
  DEFAULT_NODES,
  DEFAULT_LINKS,
  SERVICE_META,
  str,
  sanitizeReport,
} = require('./infra-model');

function createInfra({
  dataDir,
  getAgents = () => [],
  machines = new Map(),
  control = true,
  onChange = () => {},
  audit = () => {},
  notify = null,
  localNas = process.platform === 'linux',
  nasRoot = '/volume2/docker/ame-remote',
  offlineMs = OFFLINE_MS,
} = {}) {
  const file = path.join(dataDir, 'infra.json');
  let cfg = {
    nodes: DEFAULT_NODES.map((n) => ({ ...n, watched: [...n.watched], muted: [] })),
    links: DEFAULT_LINKS.map((l) => ({ ...l })),
    events: [],
  };
  const raw = readJsonSafe(file);
  if (raw && Array.isArray(raw.nodes) && Array.isArray(raw.links)) {
    cfg = {
      nodes: raw.nodes.map((n) => ({
        ...n,
        watched: Array.isArray(n.watched) ? n.watched : [],
        muted: Array.isArray(n.muted) ? n.muted : [],
      })),
      links: raw.links,
      events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
    };
  }
  // The OpenWrt probe now reports procd service names; its init service is "tailscale".
  let migrated = false;
  for (const n of cfg.nodes) {
    if (n.role !== 'router') continue;
    for (const list of [n.watched, n.muted]) {
      const i = list.indexOf('tailscaled');
      if (i >= 0) { if (list.includes('tailscale')) list.splice(i, 1); else list[i] = 'tailscale'; migrated = true; }
    }
  }
  for (const l of cfg.links) {
    const from = cfg.nodes.find((n) => n.id === l.from);
    if (l.service === 'tailscaled' && from && from.role === 'router') { l.service = 'tailscale'; migrated = true; }
  }

  function save() {
    try {
      writeJsonAtomic(file, cfg, { indent: 2, mode: 0o600 });
    } catch {}
  }
  if (migrated) save();

  // Runtime state per node id
  const runtime = new Map();       // nodeId -> { lastSeen, report, sig, online }
  const alertCooldown = new Map(); // key -> timestamp
  const longPolls = new Map();     // nodeId -> Set<{ send, timer }>
  const pendingCtl = new Map();    // rid -> { resolve, timer, nodeId }
  const queuedActions = new Map(); // nodeId -> Array<action>
  let fastUntil = 0;               // timestamp until which fast 10s interval is active

  const isFast = () => Date.now() < fastUntil;
  const currentIntervalSec = () => (isFast() ? 10 : 60);

  function ensureNode(id, defaults = {}) {
    let n = cfg.nodes.find((x) => x.id === id);
    if (!n) {
      n = {
        id: str(id, 40),
        label: str(defaults.label || id, 60),
        role: ['router', 'nas', 'cloud', 'workstation'].includes(defaults.role) ? defaults.role : 'cloud',
        host: str(defaults.host || '', 80),
        tier: Number.isFinite(defaults.tier) ? defaults.tier : 2,
        watched: Array.isArray(defaults.watched) ? defaults.watched : [],
        muted: Array.isArray(defaults.muted) ? defaults.muted : [],
      };
      cfg.nodes.push(n);
      save();
    }
    if (!Array.isArray(n.watched)) n.watched = [];
    if (!Array.isArray(n.muted)) n.muted = [];
    return n;
  }

  function recordEvent(nodeId, kind, summary, level = 'warn') {
    const ev = {
      id: 'ev_' + crypto.randomBytes(4).toString('hex'),
      ts: Date.now(),
      nodeId,
      kind,
      summary: str(summary, 200),
      level,
    };
    cfg.events.push(ev);
    if (cfg.events.length > MAX_EVENTS) cfg.events = cfg.events.slice(-MAX_EVENTS);
    save();

    if (level === 'err' && notify) {
      const key = `${nodeId}:${kind}:${summary}`;
      const last = alertCooldown.get(key) || 0;
      if (Date.now() - last > ALERT_COOLDOWN_MS) {
        alertCooldown.set(key, Date.now());
        try {
          notify({
            title: `⚠️ 网络与设备告警 (${nodeId})`,
            body: ev.summary,
            tag: `infra-${nodeId}`,
            url: '/#infra',
          });
        } catch {}
      }
    }
    return ev;
  }

  function probeTargetsFor(nodeId) {
    return cfg.links
      .filter((l) => l.from === nodeId && l.probeHost && l.probePort)
      .map((l) => ({ id: l.id, host: l.probeHost, port: l.probePort }));
  }

  function ingestReport(nodeId, rawReport, meta = {}) {
    const nodeCfg = ensureNode(nodeId, meta);
    if (meta.host && !nodeCfg.host) { nodeCfg.host = str(meta.host, 80); save(); }
    const rep = sanitizeReport(rawReport);

    // Ensure every watched item is present in services / containers so missing ones show as stopped
    const svcMap = new Map(rep.services.map((s) => [s.name, s]));
    const cntMap = new Map(rep.containers.map((c) => [c.name, c]));
    for (const w of nodeCfg.watched || []) {
      if (w.startsWith('docker:')) {
        const cname = w.slice(7);
        if (cname && !cntMap.has(cname)) {
          const item = { name: cname, state: 'stopped', status: '未运行', ports: '', image: '' };
          rep.containers.push(item);
          cntMap.set(cname, item);
        }
      } else if (w && !svcMap.has(w)) {
        const svcMeta = Object.prototype.hasOwnProperty.call(SERVICE_META, w) ? SERVICE_META[w] : null;
        const item = { name: w, label: (svcMeta && svcMeta.label) || w, state: 'stopped', kind: 'service', port: (svcMeta && svcMeta.port) || undefined };
        rep.services.push(item);
        svcMap.set(w, item);
      }
    }

    const prev = runtime.get(nodeId);
    const prevRep = prev && prev.report;
    const wasOnline = prev ? prev.online : false;

    if (!wasOnline && prev && prev.lastSeen > 0) {
      recordEvent(nodeId, 'node-online', `节点 ${nodeCfg.label || nodeId} 已恢复在线`, 'ok');
    }

    // Detect state transitions on watched services & containers
    if (prevRep) {
      const mutedSet = new Set(nodeCfg.muted || []);
      const prevSvc = new Map((prevRep.services || []).map((s) => [s.name, s.state]));
      for (const s of rep.services) {
        const old = prevSvc.get(s.name);
        const isWatched = (nodeCfg.watched || []).includes(s.name);
        const isMuted = mutedSet.has(s.name);
        if (old && old !== s.state) {
          if (s.state === 'stopped' && !isMuted) {
            recordEvent(nodeId, 'service-down', `服务 ${s.label || s.name} 已停止`, isWatched ? 'err' : 'warn');
          } else if (old === 'stopped' && s.state === 'running') {
            recordEvent(nodeId, 'service-up', `服务 ${s.label || s.name} 已恢复运行`, 'ok');
          }
        }
      }
      const prevCnt = new Map((prevRep.containers || []).map((c) => [c.name, c.state]));
      for (const c of rep.containers) {
        const old = prevCnt.get(c.name);
        const isWatched = (nodeCfg.watched || []).includes('docker:' + c.name);
        const isMuted = mutedSet.has('docker:' + c.name);
        if (old && old !== c.state) {
          if (c.state === 'stopped' && !isMuted) {
            recordEvent(nodeId, 'docker-down', `容器 ${c.name} 已停止 (${c.status || 'Exited'})`, isWatched ? 'err' : 'warn');
          } else if (old === 'stopped' && c.state === 'running') {
            recordEvent(nodeId, 'docker-up', `容器 ${c.name} 已恢复运行`, 'ok');
          }
        }
      }
      const prevUp = new Map((prevRep.containers || []).map((c) => [c.name, c.upgrade]));
      for (const c of rep.containers) {
        const u = c.upgrade, p = prevUp.get(c.name);
        if (!u || !UPGRADE_EVENTS[u.state] || (p && p.state === u.state && p.at === u.at)) continue;
        const [level, word] = UPGRADE_EVENTS[u.state];
        recordEvent(nodeId, 'docker-upgrade', `容器 ${c.name} ${word}${u.from && u.to && u.from !== u.to ? `（${u.from} → ${u.to}）` : ''}${u.state === 'failed' || u.state === 'rolledback' ? `：${u.msg}` : ''}`, level);
      }
    }

    const sig = stateSignature(rep);
    runtime.set(nodeId, {
      lastSeen: Date.now(),
      report: rep,
      sig,
      online: true,
    });
    onChange();
  }

  function touchNode(nodeId) {
    const rt = runtime.get(nodeId);
    if (!rt) return;
    const wasOnline = rt.online;
    rt.lastSeen = Date.now();
    rt.online = true;
    if (!wasOnline && rt.lastSeen > 0) {
      const nodeCfg = ensureNode(nodeId);
      recordEvent(nodeId, 'node-online', `节点 ${nodeCfg.label || nodeId} 已恢复在线`, 'ok');
      onChange();
    }
  }

  function isNodeOnline(nodeId) {
    const m = machines.get(nodeId);
    if (m && m.online) return true;
    const rt = runtime.get(nodeId);
    if (!rt || !rt.lastSeen) return false;
    return Date.now() - rt.lastSeen <= offlineMs;
  }

  // Local NAS collector
  const nasCollector = localNas ? createCollector({ isNas: true, nasRoot }) : null;
  async function collectNasNow() {
    if (!nasCollector) return;
    try {
      const nodeCfg = ensureNode('nas');
      const rep = await nasCollector.collect({
        watched: nodeCfg.watched || [],
        probeTargets: probeTargetsFor('nas'),
      });
      ingestReport('nas', rep);
    } catch {}
  }

  // Periodic sweep: check offline transitions with event-loop stall compensation
  let lastSweepAt = Date.now();
  function sweepOffline(now = Date.now()) {
    const elapsed = now - lastSweepAt;
    lastSweepAt = now;
    if (elapsed > STALL_MS) {
      for (const rt of runtime.values()) {
        if (rt.online && rt.lastSeen > 0) {
          rt.lastSeen = Math.min(now, rt.lastSeen + elapsed);
        }
      }
      return false;
    }
    let changed = false;
    for (const [id, rt] of runtime.entries()) {
      if (rt.online && now - rt.lastSeen > offlineMs && !(machines.get(id) && machines.get(id).online)) {
        rt.online = false;
        const n = cfg.nodes.find((x) => x.id === id);
        const level = (n && n.role === 'workstation') ? 'warn' : 'err';
        recordEvent(id, 'node-offline', `节点 ${(n && n.label) || id} 心跳超时离线`, level);
        changed = true;
      }
    }
    if (changed) onChange();
    return changed;
  }

  const sweepTimer = setInterval(() => {
    setImmediate(() => sweepOffline(Date.now()));
  }, 15000);
  if (sweepTimer.unref) sweepTimer.unref();

  let nasLoopTimer = null;
  function scheduleNasLoop() {
    if (!nasCollector) return;
    clearTimeout(nasLoopTimer);
    const ms = isFast() ? 10000 : 60000;
    nasLoopTimer = setTimeout(async () => {
      await collectNasNow();
      scheduleNasLoop();
    }, ms);
    if (nasLoopTimer.unref) nasLoopTimer.unref();
  }
  if (nasCollector) {
    collectNasNow().then(scheduleNasLoop);
  }

  function snapshot() {
    for (const [name] of machines.entries()) {
      if (!cfg.nodes.some((n) => n.id === name)) {
        ensureNode(name, { label: name, role: 'workstation', tier: 0 });
      }
    }

    const nodes = cfg.nodes.map((n) => {
      const rt = runtime.get(n.id);
      const m = machines.get(n.id);
      const online = isNodeOnline(n.id);
      const rep = (rt && rt.report) || null;
      const watchedSet = new Set(n.watched || []);
      const mutedSet = new Set(n.muted || []);

      const services = (rep ? rep.services : []).map((s) => ({
        ...s,
        watched: watchedSet.has(s.name),
        muted: mutedSet.has(s.name),
      }));
      const containers = (rep ? rep.containers : []).map((c) => ({
        ...c,
        watched: watchedSet.has('docker:' + c.name),
        muted: mutedSet.has('docker:' + c.name),
      }));

      let alertCount = 0;
      if (!online && rt && rt.lastSeen > 0) alertCount++;
      for (const s of services) if (s.watched && !s.muted && s.state !== 'running') alertCount++;
      for (const c of containers) if (c.watched && !c.muted && c.state !== 'running') alertCount++;

      return {
        id: n.id,
        label: n.label || n.id,
        role: n.role || 'cloud',
        host: n.host || '',
        tier: Number.isFinite(n.tier) ? n.tier : 1,
        watched: n.watched || [],
        muted: n.muted || [],
        online,
        lastSeen: (rt && rt.lastSeen) || (m && m.online ? Date.now() : 0),
        uptimeSec: rep ? rep.uptimeSec : 0,
        load1: rep ? rep.load1 : 0,
        cpuPct: rep ? rep.cpuPct : null,
        mem: rep ? rep.mem : null,
        disk: rep ? rep.disk : null,
        net: rep ? rep.net : null,
        gpus: rep ? rep.gpus : [],
        proxy: rep ? rep.proxy : null,
        services,
        containers,
        alertCount,
      };
    });

    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const links = cfg.links.map((l) => {
      const fromNode = nodeById.get(l.from);
      const toNode = nodeById.get(l.to);
      const fromRt = runtime.get(l.from);
      const probe = fromRt && fromRt.report && fromRt.report.links ? fromRt.report.links[l.id] : null;
      const nasRt = runtime.get('nas');
      const nasProbe = nasRt && nasRt.report && nasRt.report.links ? nasRt.report.links[l.id] : null;
      const effProbe = probe || nasProbe || null;

      let status = 'unknown';
      const ms = effProbe && effProbe.ok ? effProbe.ms : null;

      let svcOk = true;
      if (l.service) {
        const targetSvcs = [...((toNode && toNode.services) || []), ...((fromNode && fromNode.services) || [])];
        const found = targetSvcs.find((s) => s.name === l.service);
        if (found && found.state !== 'running') svcOk = false;
      }

      if ((fromNode && !fromNode.online && fromNode.lastSeen > 0) || (toNode && !toNode.online && toNode.lastSeen > 0)) {
        status = 'down';
      } else if (effProbe) {
        if (!effProbe.ok || !svcOk) status = 'down';
        else status = l.standby ? 'standby' : 'ok';
      } else if (!svcOk) {
        status = 'down';
      } else if ((fromNode && fromNode.online) && (toNode && toNode.online)) {
        status = l.standby ? 'standby' : 'ok';
      }

      return {
        ...l,
        status,
        ms,
        err: effProbe && !effProbe.ok ? effProbe.err : '',
      };
    });

    return {
      nodes,
      links,
      events: [...cfg.events].reverse().slice(0, 50),
      fast: isFast(),
      intervalSec: currentIntervalSec(),
    };
  }

  function dispatchControl(nodeId, action) {
    if (!control) return Promise.resolve({ ok: false, msg: '服务器关闭了远程控制' });
    if (nodeId === 'nas' && nasCollector) {
      return nasCollector.executeControl(action).then(async (r) => {
        await collectNasNow();
        return r;
      });
    }

    const rid = 'ic_' + crypto.randomBytes(8).toString('hex');
    const payload = { ...action, rid };

    const m = machines.get(nodeId);
    const sock = m && m.sockets && [...m.sockets].reverse().find((s) => s.readyState === 1);
    if (sock) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingCtl.delete(rid);
          resolve({ ok: false, msg: '节点响应超时' });
        }, 18000);
        if (timer.unref) timer.unref();
        pendingCtl.set(rid, { resolve, timer, nodeId });
        try { sock.send(JSON.stringify({ t: 'infra-ctl', ...payload })); }
        catch { clearTimeout(timer); pendingCtl.delete(rid); resolve({ ok: false, msg: '发送控制指令失败' }); }
      });
    }

    const polls = longPolls.get(nodeId);
    if (polls && polls.size > 0) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingCtl.delete(rid);
          resolve({ ok: false, msg: '探针执行响应超时' });
        }, 20000);
        if (timer.unref) timer.unref();
        pendingCtl.set(rid, { resolve, timer, nodeId });
        const waiter = [...polls][0];
        polls.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.send({ ok: true, intervalSec: currentIntervalSec(), actions: [payload] });
      });
    }

    if (isNodeOnline(nodeId)) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingCtl.delete(rid);
          resolve({ ok: true, msg: '指令已加入队列，将在节点下次心跳时执行' });
        }, 15000);
        if (timer.unref) timer.unref();
        pendingCtl.set(rid, { resolve, timer, nodeId });
        if (!queuedActions.has(nodeId)) queuedActions.set(nodeId, []);
        queuedActions.get(nodeId).push(payload);
      });
    }

    return Promise.resolve({ ok: false, msg: '该节点当前离线，无法下发控制指令' });
  }

  function finishControl(nodeId, d) {
    if (!d || typeof d.rid !== 'string') return false;
    const p = pendingCtl.get(d.rid);
    if (!p || p.nodeId !== nodeId) return false;
    pendingCtl.delete(d.rid);
    clearTimeout(p.timer);
    if (d.report) ingestReport(nodeId, d.report);
    p.resolve({ ok: !!d.ok, msg: str(d.msg || (d.ok ? '操作成功' : '操作失败'), 200) });
    return true;
  }

  function wakeAllProbes(forceCollect = false) {
    if (forceCollect && nasCollector) collectNasNow();
    for (const [nodeId, polls] of longPolls.entries()) {
      for (const w of [...polls]) {
        polls.delete(w);
        clearTimeout(w.timer);
        w.send({
          ok: true,
          intervalSec: currentIntervalSec(),
          collectNow: forceCollect,
          probeTargets: probeTargetsFor(nodeId),
          watched: (ensureNode(nodeId).watched || []),
          actions: queuedActions.get(nodeId) || [],
        });
        queuedActions.delete(nodeId);
      }
    }
    for (const [name, m] of machines.entries()) {
      if (!m.online || !m.sockets) continue;
      const msg = JSON.stringify({
        t: 'infra-cfg',
        intervalSec: currentIntervalSec(),
        collectNow: forceCollect,
        probeTargets: probeTargetsFor(name),
        watched: (ensureNode(name, { label: name, role: 'workstation', tier: 0 }).watched || []),
      });
      for (const s of m.sockets) {
        if (s.readyState === 1) { try { s.send(msg); } catch {} }
      }
    }
  }

  function authProbe(req, url) {
    const hdr = String(req.headers['authorization'] || '');
    const tok = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : (url.searchParams.get('token') || '').trim();
    if (!tok) return null;
    const agents = getAgents();
    return auth.matchAgent(agents, tok);
  }

  async function handleProbe(req, res, url, ip, json, readBody) {
    const p = url.pathname;
    if (p !== '/api/infra/report' && p !== '/api/infra/poll' && p !== '/api/infra/control-result') return false;

    const agent = authProbe(req, url);
    if (!agent) {
      audit('infra-probe-reject', ip);
      json(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }
    const nodeId = agent.name;

    if (req.method === 'POST' && p === '/api/infra/report') {
      let d = {};
      try { d = JSON.parse(await readBody(req, 128 * 1024)); } catch {}
      ingestReport(nodeId, d.report || d, { role: d.role, host: d.host || ip });
      const actions = queuedActions.get(nodeId) || [];
      queuedActions.delete(nodeId);
      const nodeCfg = ensureNode(nodeId);
      json(res, 200, {
        ok: true,
        intervalSec: currentIntervalSec(),
        watched: nodeCfg.watched || [],
        probeTargets: probeTargetsFor(nodeId),
        actions,
      });
      return true;
    }

    if (req.method === 'POST' && p === '/api/infra/control-result') {
      let d = {};
      try { d = JSON.parse(await readBody(req, 128 * 1024)); } catch {}
      finishControl(nodeId, d);
      json(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && p === '/api/infra/poll') {
      touchNode(nodeId);
      const queued = queuedActions.get(nodeId);
      if (queued && queued.length) {
        queuedActions.delete(nodeId);
        json(res, 200, { ok: true, intervalSec: currentIntervalSec(), actions: queued });
        return true;
      }
      if (!longPolls.has(nodeId)) longPolls.set(nodeId, new Set());
      const polls = longPolls.get(nodeId);
      const waiter = {
        send: (payload) => { touchNode(nodeId); try { json(res, 200, payload); } catch {} },
        timer: setTimeout(() => {
          polls.delete(waiter);
          touchNode(nodeId);
          const nodeCfg = ensureNode(nodeId);
          try {
            json(res, 200, {
              ok: true,
              intervalSec: currentIntervalSec(),
              watched: nodeCfg.watched || [],
              probeTargets: probeTargetsFor(nodeId),
              actions: [],
            });
          } catch {}
        }, 25000),
      };
      if (waiter.timer.unref) waiter.timer.unref();
      polls.add(waiter);
      req.on('close', () => {
        if (polls.has(waiter)) {
          polls.delete(waiter);
          clearTimeout(waiter.timer);
        }
      });
      return true;
    }

    return false;
  }

  async function handleBrowser(req, res, url, ip, json, readBody, isFresh) {
    const p = url.pathname;
    if (!p.startsWith('/api/infra/')) return false;

    if (req.method === 'GET' && p === '/api/infra/state') {
      json(res, 200, { ok: true, ...snapshot() });
      return true;
    }

    if (req.method !== 'POST') return false;
    let d = {};
    try { d = JSON.parse(await readBody(req, 32 * 1024)); } catch {}

    if (p === '/api/infra/watch') {
      const wasFast = isFast();
      if (d.on) {
        fastUntil = Date.now() + 35000;
        scheduleNasLoop();
        if (!wasFast) wakeAllProbes(true);
      } else {
        fastUntil = 0;
        scheduleNasLoop();
      }
      json(res, 200, { ok: true, fast: isFast(), intervalSec: currentIntervalSec() });
      return true;
    }

    if (p === '/api/infra/refresh') {
      fastUntil = Date.now() + 35000;
      wakeAllProbes(true);
      json(res, 200, { ok: true, ...snapshot() });
      return true;
    }

    if (p === '/api/infra/pin') {
      const nodeId = str(d.nodeId, 40);
      const item = str(d.item, 80);
      const node = cfg.nodes.find((n) => n.id === nodeId);
      if (!node || !item) { json(res, 200, { ok: false, msg: '节点或服务名无效' }); return true; }
      if (!Array.isArray(node.watched)) node.watched = [];
      if (!Array.isArray(node.muted)) node.muted = [];
      if (d.mute != null || d.op === 'mute') {
        const mIdx = node.muted.indexOf(item);
        const wantMute = d.mute != null ? !!d.mute : mIdx < 0;
        if (!wantMute) {
          if (mIdx >= 0) node.muted.splice(mIdx, 1);
        } else if (mIdx < 0) {
          node.muted.push(item);
        }
      } else {
        const idx = node.watched.indexOf(item);
        if (d.watch === false || (d.watch == null && idx >= 0)) {
          if (idx >= 0) node.watched.splice(idx, 1);
        } else if (idx < 0) {
          node.watched.push(item);
        }
      }
      save();
      onChange();
      json(res, 200, { ok: true, watched: node.watched, muted: node.muted });
      return true;
    }

    if (p === '/api/infra/node') {
      const id = str(d.id, 40);
      if (!id || !/^[A-Za-z0-9._\u4e00-\u9fa5-]{1,40}$/.test(id)) {
        json(res, 200, { ok: false, msg: '节点 ID 无效' });
        return true;
      }
      if (d.op === 'delete') {
        cfg.nodes = cfg.nodes.filter((n) => n.id !== id);
        cfg.links = cfg.links.filter((l) => l.from !== id && l.to !== id);
        runtime.delete(id);
        save();
        onChange();
        json(res, 200, { ok: true });
        return true;
      }
      const node = ensureNode(id, d);
      if (d.label != null) node.label = str(d.label, 60) || id;
      if (d.role && ['router', 'nas', 'cloud', 'workstation'].includes(d.role)) node.role = d.role;
      if (d.host != null) node.host = str(d.host, 80);
      if (Number.isFinite(+d.tier)) node.tier = Math.max(0, Math.min(3, +d.tier));
      if (Array.isArray(d.watched)) node.watched = d.watched.map((x) => str(x, 80)).filter(Boolean);
      save();
      onChange();
      json(res, 200, { ok: true, node });
      return true;
    }

    if (p === '/api/infra/link') {
      if (d.op === 'delete' && d.id) {
        cfg.links = cfg.links.filter((l) => l.id !== d.id);
        save();
        onChange();
        json(res, 200, { ok: true });
        return true;
      }
      const from = str(d.from, 40), to = str(d.to, 40);
      if (!from || !to || from === to) {
        json(res, 200, { ok: false, msg: '请选择不同的起点和终点设备' });
        return true;
      }
      const id = str(d.id, 40) || ('l_' + crypto.randomBytes(4).toString('hex'));
      let link = cfg.links.find((l) => l.id === id);
      if (!link) {
        link = { id, from, to, label: '', service: '', probeHost: '', probePort: 0, standby: false };
        cfg.links.push(link);
      }
      link.from = from;
      link.to = to;
      link.label = str(d.label, 60) || `${from} → ${to}`;
      link.service = str(d.service, 64);
      link.probeHost = str(d.probeHost, 80);
      link.probePort = Math.max(0, Math.min(65535, +d.probePort || 0)) || undefined;
      link.standby = !!d.standby;
      save();
      onChange();
      wakeAllProbes(true);
      json(res, 200, { ok: true, link });
      return true;
    }

    if (p === '/api/infra/control') {
      if (!isFresh()) {
        json(res, 200, { ok: false, need: 'totp', msg: '操作前请再输一次验证码' });
        return true;
      }
      const nodeId = str(d.nodeId, 40);
      const kind = str(d.kind, 20);
      const target = str(d.target, 64);
      const op = str(d.op, 20);
      if (!nodeId || !['service', 'docker', 'egress', 'singbox'].includes(kind) || !['restart', 'start', 'stop', 'retest', 'upgrade'].includes(op) || (op === 'upgrade' && kind !== 'docker')) {
        json(res, 200, { ok: false, msg: '无效的控制参数' });
        return true;
      }
      audit('infra-control', ip, nodeId, kind, target, op);
      const r = await dispatchControl(nodeId, { kind, target, op });
      if (r.ok) {
        recordEvent(nodeId, 'control', `手动执行 ${kind} ${target} ${op}：${r.msg}`, 'ok');
      }
      json(res, 200, r);
      return true;
    }

    return false;
  }

  function fromAgentMessage(machineName, d) {
    if (!d || typeof d !== 'object') return false;
    if (d.t === 'infra' && d.report) {
      ingestReport(machineName, d.report, { role: 'workstation' });
      return true;
    }
    if (d.t === 'infra-ctl-res') {
      return finishControl(machineName, d);
    }
    return false;
  }

  function close() {
    clearInterval(sweepTimer);
    clearTimeout(nasLoopTimer);
    for (const polls of longPolls.values()) {
      for (const w of polls) clearTimeout(w.timer);
    }
    longPolls.clear();
    for (const p of pendingCtl.values()) clearTimeout(p.timer);
    pendingCtl.clear();
  }

  return {
    snapshot,
    ingestReport,
    isNodeOnline,
    handleProbe,
    handleBrowser,
    fromAgentMessage,
    probeTargetsFor,
    ensureNode,
    collectNasNow,
    sweepOffline,
    close,
  };
}

module.exports = { createInfra, DEFAULT_NODES, DEFAULT_LINKS, OFFLINE_MS };
