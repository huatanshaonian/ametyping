'use strict';
// Discovers, aggregates, and streams local transcripts across Claude Code, Codex, OpenCode, Antigravity, and Kiro.

const fs = require('fs');
const os = require('os');
const path = require('path');
const transcript = require('../../app/transcript');
const { lineage } = require('../../app/running-sessions');
const records = require('./records');
const codex = require('../../app/codex-records');
const opencode = require('../../app/opencode-records');
const agy = require('../../app/agy-records');
const kiro = require('../../app/kiro-records');
const { aiOf } = require('../../app/ai-providers');
const { createArchive } = require('./archive');
const { agentsOf } = require('./subagents');
const codexAgents = require('./codex-subagents');
const agyAgents = require('./agy-subagents');
const opencodeAgents = require('./opencode-subagents');

const TAIL_WORK_STALE_MS = 10 * 60e3;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const lineOf = (m) => ({ text: m.role === 'tool' ? '⚙ ' + (m.items || []).slice(-1)[0] : (m.text || '').slice(0, 200), t: m.t, type: m.role });
const tailT = (s) => (s.lines.length ? s.lines[s.lines.length - 1].t : 0);

function deriveState(c) {
  const msgs = c.msgs || [];
  const last = msgs[msgs.length - 1];
  if (!last) return 'idle';
  if (last.role === 'user' || last.role === 'tool') return 'working';
  if (last.role === 'assistant') return 'done';
  return 'idle';
}

function projectOf(file) {
  const enc = path.basename(path.dirname(file));
  const parts = enc.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function safeAgents(file) {
  try { return agentsOf(file); } catch { return []; }
}

function createSessionScanner({
  projectsDir,
  idleDropMs,
  archiveDays = 30,
  petMap,
  sendJSON,
  getBufferedAmount,
  isOnline,
}) {
  const sess = new Map();
  const codexSess = new Map();
  const codexMeta = new Map();
  const opencodeSess = new Map();
  const agySess = new Map();
  const kiroSess = new Map();
  const tailCache = new Map();

  let line = { bg: new Set(), parked: new Set() };
  let codexAgentRows = new Map();
  let agyAgentRows = new Map();
  let opencodeAgentRows = new Map();

  let serverOff = null;
  const readers = new Map();
  const metaSent = new Set();
  const btwSent = new Set();
  const lastConv = new Map();
  let lastSig = '';

  function newestFiles() {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(projectsDir); } catch { return out; }
    for (const d of dirs) {
      const dir = path.join(projectsDir, d);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        out.push({ id: f.slice(0, -6), file: full, mtime: st.mtimeMs });
      }
    }
    return out;
  }

  const isLiveSession = (id) =>
    sess.has(id) || codexSess.has(id) || opencodeSess.has(id) || agySess.has(id) || kiroSess.has(id);

  const archive = createArchive({
    days: archiveDays,
    claudeFiles: newestFiles,
    codex,
    opencode,
    agy,
    kiro,
    projectOf,
    live: isLiveSession,
    stored: (id) => serverOff && serverOff[id],
  });

  // Deduplicated scan helper for OpenCode / Antigravity / Kiro session stores
  function scanMirrorProvider(prefix, mod, targetMap, now, skipSub) {
    const seen = new Set();
    for (const f of mod.recentFiles(Math.max(idleDropMs, 6 * 3600e3))) {
      const m = mod.metaOf(f.file);
      if (!m || (skipSub && m.sub)) continue;
      const id = `${prefix}:${m.id}`;
      if (now - f.mtime > idleDropMs && !petMap.has(id)) continue;
      seen.add(id);
      targetMap.set(id, {
        file: f.file,
        project: m.cwd ? path.basename(m.cwd) : '',
        cwd: m.cwd,
        title: mod.titleOf(m.id) || m.title,
        model: m.model || null,
        ai: aiOf(m.model),
        mtime: f.mtime,
      });
    }
    for (const [id] of petMap) {
      if (!id.startsWith(`${prefix}:`) || seen.has(id)) continue;
      const file = mod.fileOf(id);
      const m = file && mod.metaOf(file);
      if (!m || (skipSub && m.sub)) continue;
      seen.add(id);
      targetMap.set(id, {
        file,
        project: m.cwd ? path.basename(m.cwd) : '',
        cwd: m.cwd,
        title: mod.titleOf(id) || m.title,
        model: m.model || null,
        ai: aiOf(m.model),
        mtime: now,
      });
    }
    for (const id of [...targetMap.keys()]) {
      if (!seen.has(id)) targetMap.delete(id);
    }
  }

  function scan() {
    const now = Date.now();
    const files = newestFiles();
    const seen = new Set();
    try { line = lineage(os.homedir(), pidAlive); } catch {}
    for (const f of files) {
      if (line.parked.has(f.id)) continue;
      if (now - f.mtime > idleDropMs && !petMap.has(f.id)) continue;
      seen.add(f.id);
      let c = sess.get(f.id);
      if (!c || c.file !== f.file) {
        c = { file: f.file, project: projectOf(f.file) };
        sess.set(f.id, c);
      }
      try { transcript.poll(c); } catch {}
      c.mtime = f.mtime;
    }
    for (const id of [...sess.keys()]) {
      if (!seen.has(id)) sess.delete(id);
    }

    // Codex sessions + sub-threads
    const cseen = new Set();
    const cfiles = codex.recentFiles(Math.max(idleDropMs, 6 * 3600e3));
    const subs = [];
    for (const f of cfiles) {
      let m = codexMeta.get(f.file);
      if (!m) { m = codex.metaOf(f.file); if (m) codexMeta.set(f.file, m); }
      if (!m) continue;
      if (m.sub) { subs.push(f); continue; }
      const id = 'codex:' + m.id;
      if (now - f.mtime > idleDropMs && !petMap.has(id)) continue;
      cseen.add(id);
      codexSess.set(id, { file: f.file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: codex.titleOf(m.id) });
    }
    codexAgentRows = codexAgents.scan(subs);
    for (const [id] of petMap) {
      if (!id.startsWith('codex:') || cseen.has(id)) continue;
      const previous = codexSess.get(id);
      const file = previous && fs.existsSync(previous.file) ? previous.file : codex.fileOf(id.slice(6));
      const m = file && (codexMeta.get(file) || codex.metaOf(file));
      if (!m || m.sub) continue;
      cseen.add(id);
      codexSess.set(id, { file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: codex.titleOf(m.id) });
    }
    for (const id of [...codexSess.keys()]) {
      if (!cseen.has(id)) codexSess.delete(id);
    }

    scanMirrorProvider('opencode', opencode, opencodeSess, now, false);
    opencodeAgentRows = opencodeAgents.scan();

    scanMirrorProvider('agy', agy, agySess, now, true);
    agyAgentRows = agyAgents.scan();

    scanMirrorProvider('kiro', kiro, kiroSess, now, true);
  }

  const PROVIDER_STORES = {
    opencode: { map: opencodeSess, mod: opencode, flag: 'opencode' },
    agy: { map: agySess, mod: agy, flag: 'agy' },
    kiro: { map: kiroSess, mod: kiro, flag: 'kiro' },
  };

  function sessionFile(id) {
    const colon = id.indexOf(':');
    const prefix = colon > 0 ? id.slice(0, colon) : '';
    const store = PROVIDER_STORES[prefix];
    if (store) {
      const c = store.map.get(id) || archive.map.get(id);
      if (c) return { file: c.file, [store.flag]: true, cwd: c.cwd };
      const file = store.mod.fileOf(id);
      const m = file && store.mod.metaOf(file);
      return file ? { file, [store.flag]: true, cwd: m && m.cwd } : null;
    }
    if (prefix === 'codex') {
      const c = codexSess.get(id) || archive.map.get(id);
      if (c) return { file: c.file, codex: true, cwd: c.cwd };
      for (const file of codex.allFiles()) {
        let m = codexMeta.get(file);
        if (!m) { m = codex.metaOf(file); if (m) codexMeta.set(file, m); }
        if (m && 'codex:' + m.id === id) return { file, codex: true, cwd: m.cwd };
      }
      return null;
    }
    const f = newestFiles().find((x) => x.id === id);
    return f ? { file: f.file, codex: false } : null;
  }

  function tailState(file, parseFn, fallbackMtime) {
    let st;
    try { st = fs.statSync(file); } catch { return { state: 'idle', lines: [], last: fallbackMtime }; }
    const stale = Date.now() - st.mtimeMs > TAIL_WORK_STALE_MS;
    const sig = `${st.size}|${st.mtimeMs}|${stale ? 1 : 0}`;
    const hit = tailCache.get(file);
    if (hit && hit.sig === sig) return hit;
    const msgs = [];
    try {
      const from = Math.max(0, st.size - 131072);
      const buf = Buffer.alloc(st.size - from);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
      const rawLines = buf.toString('utf8').split('\n');
      if (from > 0) rawLines.shift();
      for (const l of rawLines) {
        if (!l.trim()) continue;
        let o;
        try { o = JSON.parse(l); } catch { continue; }
        for (const r of parseFn(o) || []) {
          if (!r || r.role === 'title' || r.role === 'mode' || r.role === 'ctx') continue;
          msgs.push(r);
        }
      }
    } catch {}
    let state = deriveState({ msgs });
    if (state === 'working' && stale) state = 'idle';
    const lines = msgs.slice(-8).map(lineOf).filter((l) => l.text);
    const last = msgs.length && Number.isFinite(msgs[msgs.length - 1].t) ? Math.max(st.mtimeMs, msgs[msgs.length - 1].t) : st.mtimeMs;
    const out = { sig, state, lines, last };
    tailCache.set(file, out);
    if (tailCache.size > 200) tailCache.delete(tailCache.keys().next().value);
    return out;
  }

  function stateList() {
    const out = [...sess.entries()].map(([id, c]) => {
      const msgs = c.msgs || [];
      const p = petMap.get(id);
      return {
        id,
        label: c.title || (p && p.label) || c.project || 'Claude',
        project: c.project || '',
        state: p ? p.state : deriveState(c),
        steps: 0,
        t0: msgs[0] ? msgs[0].t : c.mtime,
        last: c.mtime,
        lines: msgs.slice(-8).map(lineOf).filter((l) => l.text),
        via: p ? p.via : 'off',
        perms: p ? p.perms : [],
        bg: !!(p && p.bg) || line.bg.has(id),
        agents: safeAgents(c.file),
        api: p && typeof p.api === 'string' ? p.api : undefined,
      };
    });

    for (const [id, p] of petMap) {
      if (sess.has(id) || line.parked.has(id)) continue;
      const oc = opencodeSess.get(id), ag = agySess.get(id), ki = kiroSess.get(id);
      const defaultName = id.startsWith('codex:') ? 'Codex' : id.startsWith('opencode:') ? 'OpenCode' : id.startsWith('agy:') ? 'Antigravity' : id.startsWith('kiro:') ? 'Kiro' : 'Claude';
      out.push({
        id,
        label: codexSess.get(id)?.title || ag?.title || ki?.title || p.label || defaultName,
        project: p.project || (ag && ag.project) || (ki && ki.project) || '',
        state: p.state,
        steps: 0,
        t0: p.t0,
        last: p.last,
        lines: (p.lines || []).map((l) => ({ text: l.text, t: l.t, type: l.type })),
        via: p.via,
        perms: p.perms || [],
        agents: codexAgentRows.get(id) || agyAgentRows.get(id) || opencodeAgentRows.get(id) || [],
        api: typeof p.api === 'string' ? p.api : undefined,
        model: p.model || (oc && oc.model) || (ag && ag.model) || (ki && ki.model) || undefined,
        ai: p.ai || (oc && oc.ai) || (ag && ag.ai) || (ki && ki.ai) || undefined,
      });
    }

    for (const [id, c] of opencodeSess) {
      if (petMap.has(id) || line.parked.has(id)) continue;
      const ts = tailState(c.file, opencode.recordsOf, c.mtime);
      out.push({
        id, label: c.title || c.project || 'OpenCode', project: c.project || '', state: ts.state, steps: 0,
        t0: c.mtime, last: ts.last, lines: ts.lines, via: 'off', perms: [],
        agents: opencodeAgentRows.get(id) || [], model: c.model || undefined, ai: c.ai || undefined,
      });
    }
    for (const [id, c] of agySess) {
      if (petMap.has(id) || line.parked.has(id)) continue;
      const ts = tailState(c.file, agy.recordsOf, c.mtime);
      out.push({
        id, label: c.title || c.project || 'Antigravity', project: c.project || '', state: ts.state, steps: 0,
        t0: c.mtime, last: ts.last, lines: ts.lines, via: 'off', perms: [],
        agents: agyAgentRows.get(id) || [], model: c.model || undefined, ai: c.ai || undefined,
      });
    }
    for (const [id, c] of kiroSess) {
      if (petMap.has(id) || line.parked.has(id)) continue;
      out.push({
        id, label: c.title || c.project || 'Kiro', project: c.project || '', state: 'idle', steps: 0,
        t0: c.mtime, last: c.mtime, lines: [], via: 'off', perms: [],
        agents: [], model: c.model || undefined, ai: c.ai || undefined,
      });
    }
    return out.sort((a, b) => a.t0 - b.t0);
  }

  function convOf(id) {
    const c = sess.get(id);
    if (!c) {
      const p = petMap.get(id);
      if (!p) return [];
      const banner = p.provider === 'codex' ? 'Codex 实时进度 · 对话请回到 Codex'
        : p.provider === 'opencode' ? 'OpenCode 实时进度 · 对话见记录'
        : p.provider === 'agy' ? 'Antigravity 实时进度 · 对话见记录'
        : p.provider === 'kiro' ? 'Kiro 实时进度 · 对话见记录'
        : '实时进度';
      return [
        { role: 'sys', text: banner, t: p.t0 },
        ...(p.lines || []).map((l) => ({ role: 'sys', text: l.text, t: l.t })),
      ];
    }
    return (c.msgs || []).slice(-300).map((m) => ({ role: m.role, text: m.text, items: m.items, t: m.t }));
  }

  function sendConv(id) {
    sendJSON({ t: 'conv', id, msgs: convOf(id) });
  }

  function pushRecords() {
    if (!serverOff || !isOnline()) return;
    archive.scan();
    for (const id of [...readers.keys()]) {
      if (!isLiveSession(id) && !archive.map.has(id)) readers.delete(id);
    }
    const old = [...archive.map].filter(([id]) => !isLiveSession(id) && !line.parked.has(id));
    for (const [id, c] of [...sess, ...codexSess, ...opencodeSess, ...agySess, ...kiroSess, ...old]) {
      let r = readers.get(id);
      const isCodex = id.startsWith('codex:');
      const isOpenCode = id.startsWith('opencode:');
      const isAgy = id.startsWith('agy:');
      const isKiro = id.startsWith('kiro:');
      const isAlt = isCodex || isOpenCode || isAgy || isKiro;
      if (!r || r.file !== c.file) {
        const parseFn = isCodex ? codex.recordsOf : isOpenCode ? opencode.recordsOf : isAgy ? agy.recordsOf : isKiro ? kiro.recordsOf : undefined;
        r = records.createReader(c.file, serverOff[id] || 0, parseFn);
        readers.set(id, r);
        if (isAlt) r.cwd = c.cwd || null;
        sendJSON({ t: 'meta', id, project: c.project || '', title: c.title || '', cwd: r.cwd || undefined, api: (petMap.get(id) || {}).api, model: c.model || undefined, ai: c.ai || undefined });
        r.sentTitle = c.title || '';
      }
      if (isAlt && r.sentTitle !== (c.title || '')) {
        sendJSON({ t: 'meta', id, project: c.project || '', title: c.title || '', cwd: r.cwd || undefined, api: (petMap.get(id) || {}).api, model: c.model || undefined, ai: c.ai || undefined });
        r.sentTitle = c.title || '';
      }
      for (let k = 0; k < 8; k++) {
        if (getBufferedAmount() > 8e6) return;
        let b;
        try { b = records.readNext(r); } catch { b = null; }
        if (!b) {
          if (archive.map.has(id) && !isLiveSession(id)) {
            archive.done(id);
            readers.delete(id);
          }
          break;
        }
        sendJSON({
          t: 'rec', id, from: b.from, to: b.to, reset: b.reset || undefined, recs: b.recs,
          project: c.project || '', title: c.title || '', cwd: b.cwd || undefined,
          model: c.model || undefined, ai: c.ai || undefined,
        });
        r.offset = b.to;
        if (b.to === b.from) break;
      }
    }
  }

  function onSync(offsets) {
    serverOff = serverOff || {};
    for (const [id, off] of Object.entries(offsets)) {
      if (!Number.isFinite(off) || off < 0) continue;
      serverOff[id] = off;
      const r = readers.get(id);
      if (r) { r.offset = off; r.skipping = false; }
    }
    const ids = Object.keys(offsets);
    const files = new Map(newestFiles().map((f) => [f.id, f.file]));
    const cfiles = new Map();
    if (ids.some((id) => id.startsWith('codex:'))) {
      for (const file of codex.allFiles()) {
        const m = codexMeta.get(file) || codex.metaOf(file);
        if (m && !m.sub) cfiles.set('codex:' + m.id, m);
      }
    }
    const afiles = new Map();
    if (ids.some((id) => id.startsWith('agy:'))) {
      for (const f of agy.allFiles()) {
        const file = typeof f === 'string' ? f : f.file;
        const m = agy.metaOf(file);
        if (m && !m.sub) afiles.set('agy:' + m.id, m);
      }
    }
    const kfiles = new Map();
    if (ids.some((id) => id.startsWith('kiro:'))) {
      for (const f of kiro.allFiles()) {
        const file = typeof f === 'string' ? f : f.file;
        const m = kiro.metaOf(file);
        if (m && !m.sub) kfiles.set('kiro:' + m.id, m);
      }
    }
    for (const id of ids) {
      if (metaSent.has(id) || readers.has(id) || (!files.has(id) && !cfiles.has(id) && !afiles.has(id) && !kfiles.has(id))) continue;
      metaSent.add(id);
      const cwd = files.has(id)
        ? records.firstCwd(files.get(id))
        : cfiles.has(id) ? cfiles.get(id).cwd
        : afiles.has(id) ? afiles.get(id).cwd
        : kfiles.get(id).cwd;
      if (cwd) {
        const p = petMap.get(id);
        sendJSON({ t: 'meta', id, cwd, api: p && p.api });
      }
    }
    pushRecords();
  }

  function forwardBtw() {
    if (!isOnline()) return;
    const live = new Set();
    for (const [id, p] of petMap) {
      if (!Array.isArray(p.btw)) continue;
      for (const b of p.btw) {
        if (!b || typeof b.k !== 'string' || typeof b.q !== 'string' || !Number.isFinite(b.t)) continue;
        const k = `${id}|${b.k}`, ka = k + '|a';
        live.add(k); live.add(ka);
        const q = b.q.slice(0, 2000), a = typeof b.a === 'string' ? b.a.slice(0, 100e3) : null;
        if (!btwSent.has(k)) { btwSent.add(k); sendJSON({ t: 'btw', id, k: b.k.slice(0, 40), q, at: b.t }); }
        if (a && !btwSent.has(ka)) { btwSent.add(ka); sendJSON({ t: 'btw', id, k: b.k.slice(0, 40), q, at: b.t, a, ta: Number.isFinite(b.ta) ? b.ta : Date.now() }); }
      }
    }
    for (const k of btwSent) {
      if (!live.has(k)) btwSent.delete(k);
    }
  }

  function pushStateIfChanged(force, { controlOn, browse, profiles }) {
    const list = stateList();
    const sig = JSON.stringify([
      controlOn,
      profiles,
      [...line.parked],
      ...list.map((s) => [s.id, s.label, s.state, s.last, s.via, s.perms.map((p) => p.id), tailT(s), (s.agents || []).map((a) => a.id + a.state + (a.act || ''))]),
    ]);
    if (sig !== lastSig || force === true) {
      lastSig = sig;
      sendJSON({
        t: 'state',
        control: controlOn,
        files: browse.enabled,
        upload: browse.canUpload,
        sessions: list,
        parked: [...line.parked],
        claudeProfiles: profiles,
      });
      for (const s of list) {
        if (sess.has(s.id)) continue;
        const cs = `${s.last}|${tailT(s)}`;
        if (lastConv.get(s.id) !== cs) {
          lastConv.set(s.id, cs);
          sendConv(s.id);
        }
      }
    }
  }

  function resetConnection() {
    lastConv.clear();
    btwSent.clear();
    serverOff = null;
    readers.clear();
    metaSent.clear();
    archive.reset();
  }

  return {
    scan,
    sessionFile,
    stateList,
    sendConv,
    onSync,
    pushRecords,
    forwardBtw,
    pushStateIfChanged,
    resetConnection,
  };
}

module.exports = { createSessionScanner, deriveState, projectOf };
