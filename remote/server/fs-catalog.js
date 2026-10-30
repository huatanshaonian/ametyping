// On-demand VFS structure catalog and dual-track folder annotations (User Note + AI Note + Role Tag) kept on the NAS.
// Lets the user and the master session inspect folder roles, notes, disk space and shallow file trees across machines
// without fetching actual files over Tailscale.
//   <dataDir>/fs-catalog.json   { items: { "machine|normPath": { machine, path, tag, userNote, aiNote, updatedAt, snapshot } } }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 1000;
const TAG_LABELS = {
  solver: 'CEM求解器',
  results: '求解结果',
  code: '核心代码',
  data: '数据集',
  docs: '文档资料',
  scratch: '临时实验',
};

function normKey(machine, p) {
  const m = String(machine || '').trim();
  let s = String(p || '').trim().replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(s)) s += '\\';
  // Windows paths are case-insensitive in keys
  const k = /^[A-Za-z]:/.test(s) ? s.replace(/\//g, '\\').toLowerCase() : s;
  return `${m}|${k}`;
}

function cleanStr(v, max) {
  return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

function cleanTree(nodes, depth = 1, countObj = { n: 0 }) {
  if (!Array.isArray(nodes) || depth > 5) return [];
  const out = [];
  for (const x of nodes) {
    if (!x || typeof x.name !== 'string' || !x.name || countObj.n >= 800) break;
    countObj.n++;
    const item = {
      name: x.name.slice(0, 200),
      dir: !!x.dir,
      size: x.dir ? 0 : (+x.size || 0),
      mtime: +x.mtime || 0,
    };
    if (x.skipped) item.skipped = true;
    if (x.dir && Array.isArray(x.children) && depth < 5) {
      item.children = cleanTree(x.children, depth + 1, countObj);
    }
    out.push(item);
  }
  return out;
}

function createFsCatalog({ dataDir, machines, onChange = () => {}, audit = () => {} }) {
  const file = path.join(dataDir, 'fs-catalog.json');
  let data = { items: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw.items === 'object' && !Array.isArray(raw.items)) data = raw;
  } catch {}

  const pendingSyncs = new Map(); // rid -> { key, machine, path, resolve, timer }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch {}
    onChange();
  }

  function agentSock(name) {
    const m = machines && machines.get(name);
    return m && m.online && m.sockets && m.sockets.size ? [...m.sockets].pop() : null;
  }

  // List all catalog entries (optionally filtered by machine), with summary metadata
  function list(machine = '') {
    const out = [];
    for (const [key, it] of Object.entries(data.items)) {
      if (machine && it.machine !== machine) continue;
      out.push({
        key,
        machine: it.machine,
        path: it.path,
        tag: it.tag || '',
        tagLabel: TAG_LABELS[it.tag] || it.tag || '',
        userNote: it.userNote || '',
        aiNote: it.aiNote || '',
        updatedAt: it.updatedAt || 0,
        snapshot: it.snapshot || null,
      });
    }
    return out.sort((a, b) => a.machine.localeCompare(b.machine) || a.path.localeCompare(b.path));
  }

  function get(machine, p) {
    return data.items[normKey(machine, p)] || null;
  }

  // Update user note / tag / AI note.
  // byAi: true when invoked by an AI agent tool -> userNote is strictly read-only and never overwritten by AI.
  function setNote({ machine, path: p, tag, userNote, aiNote, byAi = false }) {
    const m = cleanStr(machine, 80);
    const cleanP = cleanStr(p, 1024);
    if (!m || !cleanP) return { ok: false, msg: '无效的机器或路径' };
    const key = normKey(m, cleanP);
    let cur = data.items[key];
    if (!cur) {
      if (Object.keys(data.items).length >= MAX_ITEMS) return { ok: false, msg: '备注目录数量已达上限' };
      cur = { machine: m, path: cleanP, tag: '', userNote: '', aiNote: '', updatedAt: Date.now(), snapshot: null };
    } else {
      cur = { ...cur };
    }
    if (!byAi) {
      if (typeof tag === 'string') cur.tag = cleanStr(tag, 40);
      if (typeof userNote === 'string') cur.userNote = cleanStr(userNote, 2000);
    } else if (!cur.tag && typeof tag === 'string') {
      cur.tag = cleanStr(tag, 40);
    }
    if (typeof aiNote === 'string') cur.aiNote = cleanStr(aiNote, 2000);
    cur.updatedAt = Date.now();

    // If all notes and tags are cleared and there's no reason to keep it, remove entry
    if (!cur.tag && !cur.userNote && !cur.aiNote && !byAi && tag === '' && userNote === '' && aiNote === '') {
      delete data.items[key];
      save();
      return { ok: true, removed: true, key };
    }
    data.items[key] = cur;
    save();
    // Trigger background tree snapshot sync if machine is online
    syncTree(m, cleanP).catch(() => {});
    return { ok: true, item: cur, key };
  }

  // Request shallow directory tree from the target machine's agent and store in NAS catalog
  function syncTree(machine, p, depth = 3) {
    const m = cleanStr(machine, 80);
    const cleanP = cleanStr(p, 1024);
    if (!m || !cleanP) return Promise.resolve({ ok: false, msg: '无效参数' });
    const sock = agentSock(m);
    if (!sock) return Promise.resolve({ ok: false, msg: '这台电脑当前不在线，已保存备注，上线后可同步目录结构' });
    const key = normKey(m, cleanP);
    const rid = 'cat-' + crypto.randomBytes(10).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingSyncs.delete(rid)) resolve({ ok: false, msg: '读取目录结构超时' });
      }, 15000);
      if (timer.unref) timer.unref();
      pendingSyncs.set(rid, { key, machine: m, path: cleanP, resolve, timer });
      try {
        sock.send(JSON.stringify({ t: 'fs', rid, op: 'tree', path: cleanP, depth: Math.max(1, Math.min(5, +depth || 3)), maxNodes: 400 }));
      } catch {
        clearTimeout(timer);
        pendingSyncs.delete(rid);
        resolve({ ok: false, msg: '发送同步请求失败' });
      }
    });
  }

  // Intercept `fs-res` messages with `cat-*` rid from agent
  function fromAgent(m, d) {
    if (!d || typeof d.rid !== 'string' || !d.rid.startsWith('cat-')) return false;
    const p = pendingSyncs.get(d.rid);
    if (!p || p.machine !== m.name) return true;
    clearTimeout(p.timer);
    pendingSyncs.delete(d.rid);
    if (!d.ok) {
      p.resolve({ ok: false, msg: d.msg || '目录扫描失败' });
      return true;
    }
    const realPath = typeof d.path === 'string' && d.path ? d.path : p.path;
    const realKey = normKey(m.name, realPath);
    let cur = data.items[realKey] || data.items[p.key];
    if (cur && realKey !== p.key) {
      delete data.items[p.key];
    }
    if (!cur) {
      cur = { machine: m.name, path: realPath, tag: '', userNote: '', aiNote: '', updatedAt: Date.now() };
    }
    cur.path = realPath;
    cur.snapshot = {
      sep: d.sep === '\\' ? '\\' : '/',
      freeBytes: Number.isFinite(d.freeBytes) ? d.freeBytes : null,
      totalBytes: Number.isFinite(d.totalBytes) ? d.totalBytes : null,
      gitBranch: typeof d.gitBranch === 'string' ? d.gitBranch.slice(0, 80) : null,
      count: +d.count || 0,
      truncated: !!d.truncated,
      scannedAt: +d.scannedAt || Date.now(),
      tree: cleanTree(d.tree),
    };
    data.items[realKey] = cur;
    save();
    p.resolve({ ok: true, item: cur, key: realKey });
    return true;
  }

  // When a machine comes online, refresh snapshots for its annotated folders that have no snapshot or are older than 1h
  function onMachineOnline(machineName) {
    const now = Date.now();
    const listToSync = Object.values(data.items).filter((it) =>
      it.machine === machineName && (!it.snapshot || now - (it.snapshot.scannedAt || 0) > 3600e3)
    ).slice(0, 15);
    listToSync.forEach((it, idx) => {
      setTimeout(() => syncTree(it.machine, it.path).catch(() => {}), 800 * (idx + 1));
    });
  }

  async function handle(req, res, url, ip, json, readBody) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/fs-catalog') {
      const m = url.searchParams.get('machine') || '';
      json(res, 200, { ok: true, items: list(m), tags: TAG_LABELS });
      return true;
    }
    if (req.method === 'POST' && p === '/api/fs-catalog/note') {
      let d = {}; try { d = JSON.parse(await readBody(req, 16384)); } catch {}
      const r = setNote({ machine: d.machine, path: d.path, tag: d.tag, userNote: d.userNote, aiNote: d.aiNote, byAi: false });
      if (r.ok) audit('fs-catalog-note', ip, String(d.machine || '').slice(0, 40), String(d.path || '').slice(0, 200));
      json(res, 200, r);
      return true;
    }
    if (req.method === 'POST' && p === '/api/fs-catalog/sync') {
      let d = {}; try { d = JSON.parse(await readBody(req, 4096)); } catch {}
      const r = await syncTree(d.machine, d.path, d.depth);
      json(res, 200, r);
      return true;
    }
    return false;
  }

  return { list, get, setNote, syncTree, fromAgent, onMachineOnline, handle, normKey, TAG_LABELS };
}

module.exports = { createFsCatalog, normKey, TAG_LABELS };
