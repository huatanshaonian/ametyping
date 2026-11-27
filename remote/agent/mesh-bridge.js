'use strict';
// Local loopback bridge (127.0.0.1:3941) for AmeMesh CLI/MCP tools, Windose MCP proxy,
// offline event queue, and folder file-ready triggers.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { collectGitAudit } = require('./worktree');

const MCP_MAX = 100 * 1024 * 1024;
const IGNORED_WATCH_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vs']);

function globToRegex(glob = '*') {
  const normalized = String(glob || '*').replace(/\\/g, '/');
  if (!normalized || normalized === '*') return /^.*$/;
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function scanDirFiles(dirPath, globRe, maxDepth = 4, maxFiles = 5000, matchRelPath = false) {
  const depthLimit = Math.max(1, Math.min(6, Math.floor(+maxDepth || 4)));
  const fileLimit = Math.max(1, Math.floor(+maxFiles || 5000));
  const useRelPath = matchRelPath || globRe.source.includes('/');
  const result = [];

  function walk(curDir, relPrefix, depth) {
    if (result.length >= fileLimit || depth > depthLimit) return;
    let entries;
    try { entries = fs.readdirSync(curDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (result.length >= fileLimit) break;
      const fullPath = path.join(curDir, ent.name);
      const relPath = relPrefix ? path.join(relPrefix, ent.name) : ent.name;
      if (ent.isFile()) {
        const target = useRelPath ? relPath.replace(/\\/g, '/') : ent.name;
        if (globRe.test(target)) {
          try {
            const st = fs.statSync(fullPath);
            result.push({ relPath, size: st.size, mtimeMs: st.mtimeMs });
          } catch {}
        }
      } else if (ent.isDirectory() && !IGNORED_WATCH_DIRS.has(ent.name) && depth < depthLimit) {
        walk(fullPath, relPath, depth + 1);
      }
    }
  }
  walk(dirPath, '', 1);
  return result;
}

function createMeshBridge({
  name,
  controlEnabled,
  mcpEnabled,
  meshPort,
  meshTokenFile,
  stateList,
  sendJSON,
  isOnline,
}) {
  const meshPending = new Map();
  const mcpPending = new Map();
  const MESH_TOKEN = crypto.randomBytes(24).toString('hex');

  let meshFolderTriggers = [];
  const folderWatchState = new Map();

  function savePendingMeshEvent(evt) {
    try {
      const dir = path.join(os.homedir(), '.ametyping');
      fs.mkdirSync(dir, { recursive: true });
      const pendingFile = path.join(dir, 'pending-mesh-events.json');
      let list = [];
      try {
        list = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
        if (!Array.isArray(list)) list = [];
      } catch {}
      list.push(evt);
      const tmpFile = `${pendingFile}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpFile, pendingFile);
    } catch {}
  }

  function flushPendingMeshEvents() {
    if (!isOnline()) return;
    const pendingFile = path.join(os.homedir(), '.ametyping', 'pending-mesh-events.json');
    if (!fs.existsSync(pendingFile)) return;
    const flushingFile = `${pendingFile}.flushing-${Date.now()}`;
    try {
      fs.renameSync(pendingFile, flushingFile);
    } catch {
      return;
    }
    try {
      const events = JSON.parse(fs.readFileSync(flushingFile, 'utf8'));
      if (Array.isArray(events) && events.length > 0) {
        if (!isOnline()) {
          // Connection dropped mid-flush: restore queue file instead of dropping events
          try { fs.renameSync(flushingFile, pendingFile); } catch {}
          return;
        }
        for (const evt of events) {
          const rid = 'evt_' + crypto.randomBytes(4).toString('hex');
          sendJSON({ ...evt, t: 'mesh-req', rid, op: 'event', fromMachine: name });
        }
      }
    } catch {}
    try { fs.unlinkSync(flushingFile); } catch {}
  }

  function mcpCall(req, res, out) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let d = {};
      try { d = JSON.parse(body || '{}'); } catch { return out(400, { ok: false, msg: 'invalid json' }); }
      if (!mcpEnabled) return out(200, { ok: false, msg: '这台电脑的 agent 关掉了 MCP 转发（agent.json 里 "mcp": false）' });
      if (!['literature', 'research', 'hpc'].includes(d.service) || !['info', 'call', 'pdf'].includes(d.op)) {
        return out(400, { ok: false, msg: '不支持的请求' });
      }
      if (!isOnline()) return out(200, { ok: false, msg: '本机 agent 还没连上看板服务器' });
      const rid = 'mcp-' + crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        if (mcpPending.delete(rid)) out(200, { ok: false, msg: '看板服务器响应超时' });
      }, d.op === 'pdf' ? 600e3 : 120e3);
      if (timer.unref) timer.unref();
      mcpPending.set(rid, {
        parts: [],
        size: 0,
        done: (r) => {
          clearTimeout(timer);
          const { t, rid: _r, file, ...rest } = r;
          const p = mcpPending.get(rid);
          mcpPending.delete(rid);
          if (file && p) {
            const buf = Buffer.concat(p.parts);
            if (buf.length !== file.bytes) return out(200, { ok: false, msg: 'PDF 传到一半断了' });
            res.writeHead(200, {
              'Content-Type': 'application/pdf',
              'Content-Length': buf.length,
              'X-Job': encodeURIComponent(JSON.stringify(file.job || null)),
            });
            return res.end(buf);
          }
          out(200, rest);
        },
      });
      sendJSON({
        t: 'mcp-req',
        rid,
        service: d.service,
        op: d.op,
        args: d.args && typeof d.args === 'object' ? d.args : {},
        client: String(d.client || '').slice(0, 40),
      });
    });
  }

  function mcpFromServer(d) {
    const p = mcpPending.get(d.rid);
    if (!p) return;
    if (d.t === 'mcp-chunk') {
      const b = Buffer.from(String(d.b64 || ''), 'base64');
      p.size += b.length;
      if (p.size > MCP_MAX) return p.done({ ok: false, msg: '文件太大' });
      p.parts.push(b);
    } else {
      p.done(d);
    }
  }

  function onMeshRes(d) {
    const f = meshPending.get(d.rid);
    if (f) {
      meshPending.delete(d.rid);
      f(d);
    }
  }

  function onDisconnect() {
    for (const p of [...mcpPending.values()]) p.done({ ok: false, msg: '和看板服务器的连接断了' });
    for (const [rid, f] of [...meshPending.entries()]) {
      meshPending.delete(rid);
      f({ ok: false, msg: '和看板服务器的连接断了' });
    }
  }

  function sendMcpStatus() {
    let clients = [];
    try {
      clients = require('../../install-mesh-mcp')
        .status()
        .map(({ id, label, present, servers, error }) => ({ id, label, present, servers, error }));
    } catch {}
    sendJSON({
      t: 'mcp-status',
      clients,
      forward: mcpEnabled,
      auto: controlEnabled && !process.env.AME_NO_MCP_INSTALL && meshPort === 3941,
    });
  }

  function startMeshBridge() {
    const srv = http.createServer((req, res) => {
      const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.origin || req.headers['x-ame-mesh'] !== MESH_TOKEN) return out(403, { ok: false, msg: 'unauthorized' });
      if (req.method === 'GET' && req.url === '/mesh/local-info') {
        return out(200, {
          ok: true,
          machine: name,
          online: isOnline(),
          sessions: stateList().map((s) => ({ id: s.id, label: s.label, project: s.project, state: s.state })),
        });
      }
      if (req.method === 'POST' && req.url === '/mcp/call') return mcpCall(req, res, out);
      if (req.method !== 'POST' || req.url !== '/mesh/rpc') return out(404, { ok: false });
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        let d = {};
        try { d = JSON.parse(body || '{}'); } catch { return out(400, { ok: false, msg: 'invalid json' }); }
        if (!isOnline()) {
          if (d.op === 'event') {
            savePendingMeshEvent(d);
            return out(200, { ok: true, queued: true, msg: 'agent 离线，事件已加入暂存队列，将在重新连接时自动上报' });
          }
          return out(200, { ok: false, msg: '本机 agent 尚未连接上群晖服务器' });
        }
        if ((d.op === 'report' || (d.op === 'board_post' && d.done === true))
          && !d.gitAudit && typeof d.callerCwd === 'string' && d.callerCwd.trim()) {
          d.gitAudit = collectGitAudit(d.callerCwd.trim());
        }
        const rid = 'mrpc-' + crypto.randomBytes(8).toString('hex');
        const timer = setTimeout(() => {
          if (meshPending.delete(rid)) out(200, { ok: false, msg: '群晖服务器响应超时' });
        }, 20000);
        if (timer.unref) timer.unref();
        meshPending.set(rid, (reply) => {
          clearTimeout(timer);
          const { t, rid: _r, ...rest } = reply;
          out(200, rest);
        });
        sendJSON({ ...d, t: 'mesh-req', rid, fromMachine: d.fromMachine || name });
      });
    });
    srv.on('error', () => {});
    srv.listen(meshPort, '127.0.0.1', () => {
      try {
        fs.mkdirSync(path.dirname(meshTokenFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(meshTokenFile, JSON.stringify({ port: meshPort, token: MESH_TOKEN, machine: name }), { mode: 0o600 });
      } catch {}
      if (controlEnabled && !process.env.AME_NO_MCP_INSTALL && meshPort === 3941) {
        try { require('../../install-mesh-mcp').installAll({ quiet: true }); } catch {}
      }
      sendMcpStatus();
    });
    srv.unref();

    const folderPollMs = +process.env.AME_FOLDER_POLL_MS || 15000;
    const folderTimer = setInterval(pollFolderTriggers, folderPollMs);
    if (folderTimer.unref) folderTimer.unref();
  }

  function pollFolderTriggers() {
    for (const trig of meshFolderTriggers) {
      if (!trig || !trig.path) continue;
      let state = folderWatchState.get(trig.id);
      if (!state) {
        state = { initialized: false, files: new Map() };
        folderWatchState.set(trig.id, state);
      }
      const globStr = trig.glob || '*';
      const globRe = globToRegex(globStr);
      const matchRelPath = /[\\/]/.test(globStr);
      const maxDepth = Math.max(1, Math.min(6, Math.floor(+(trig.maxDepth || 4))));
      const scanned = scanDirFiles(trig.path, globRe, maxDepth, 5000, matchRelPath);
      const scannedKeys = new Set();
      const readyFiles = [];

      if (!state.initialized) {
        for (const f of scanned) state.files.set(f.relPath, { size: f.size, mtimeMs: f.mtimeMs, stableCount: 2 });
        state.initialized = true;
        continue;
      }

      for (const f of scanned) {
        scannedKeys.add(f.relPath);
        const prev = state.files.get(f.relPath);
        if (!prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs) {
          state.files.set(f.relPath, { size: f.size, mtimeMs: f.mtimeMs, stableCount: 1 });
        } else if (prev.stableCount === 1) {
          prev.stableCount = 2;
          readyFiles.push(f.relPath);
        }
      }

      for (const key of state.files.keys()) {
        if (!scannedKeys.has(key)) state.files.delete(key);
      }

      if (readyFiles.length > 0) {
        const rid = 'evt_' + crypto.randomBytes(4).toString('hex');
        sendJSON({
          t: 'mesh-req',
          rid,
          op: 'event',
          fromMachine: name,
          projectId: trig.projectId,
          triggerId: trig.id,
          source: 'folder',
          kind: 'files_ready',
          path: trig.path,
          files: readyFiles,
          label: trig.label,
        });
      }
    }
  }

  function updateMeshFolderTriggers(triggers) {
    meshFolderTriggers = Array.isArray(triggers) ? triggers : [];
    const curIds = new Set(meshFolderTriggers.map((t) => t.id));
    for (const id of folderWatchState.keys()) {
      if (!curIds.has(id)) folderWatchState.delete(id);
    }
  }

  return {
    startMeshBridge,
    onMeshRes,
    mcpFromServer,
    sendMcpStatus,
    updateMeshFolderTriggers,
    flushPendingMeshEvents,
    onDisconnect,
  };
}

module.exports = { createMeshBridge, globToRegex, scanDirFiles };
