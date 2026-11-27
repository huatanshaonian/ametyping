// AmeMesh auxiliary stores: Global Skills, CLI update signals, Machine hardware profiles, and Local Quotas.
'use strict';
const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic, writeFileAtomic } = require('../lib/json-store');
const { cleanStr, normFolderPath } = require('./helpers');

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function parseSkillDescription(raw) {
  const src = String(raw || '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (fm) {
    const m = /^description:\s*(?:>\s*\r?\n([\s\S]*?)(?:\r?\n[a-zA-Z0-9_-]+:|$)|(.+))$/m.exec(fm[1]);
    if (m) {
      return cleanStr((m[1] || m[2] || '').replace(/\s+/g, ' ').trim(), 240);
    }
  }
  const h1 = /^#\s+(.+)$/m.exec(src);
  return h1 ? cleanStr(h1[1], 240) : '';
}

function createMeshStores(ctx) {
  const { dataDir, machines, fsCatalog } = ctx;

  // ---------- Local harness quotas ----------
  const localQuotas = new Map(); // provider -> { ...quota, machine, reportedAt }
  function onLocalQuota(machineName, quota) {
    if (!quota || typeof quota !== 'object' || !quota.provider) return;
    const prov = cleanStr(quota.provider, 40).toLowerCase();
    if (!prov) return;
    const prev = localQuotas.get(prov);
    const nextTs = Date.parse(quota.readAt || '') || Date.now();
    const prevTs = prev ? (Date.parse(prev.readAt || '') || prev.reportedAt || 0) : 0;
    if (!prev || nextTs >= prevTs) {
      localQuotas.set(prov, {
        ...quota,
        provider: prov,
        machine: cleanStr(machineName, 60),
        reportedAt: Date.now(),
      });
    }
  }

  function listLocalQuotas() {
    return [...localQuotas.values()];
  }

  // ---------- Global Skills store ----------
  const builtinSkillsDirs = [
    path.resolve(__dirname, '../mesh-skills'),
    path.resolve(__dirname, '../../../skills'),
  ];
  const userSkillsDir = path.join(dataDir, 'mesh-skills');

  function findBuiltinSkillPath(name) {
    for (const dir of builtinSkillsDirs) {
      const p = path.join(dir, name, 'SKILL.md');
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  function listSkills() {
    const names = new Set();
    const scanDir = (dir) => {
      try {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!ent.isDirectory() || !SKILL_NAME_RE.test(ent.name)) continue;
          if (fs.existsSync(path.join(dir, ent.name, 'SKILL.md'))) names.add(ent.name);
        }
      } catch {}
    };
    for (const dir of builtinSkillsDirs) scanDir(dir);
    scanDir(userSkillsDir);
    return [...names].sort().map((name) => {
      const builtinPath = findBuiltinSkillPath(name);
      const userPath = path.join(userSkillsDir, name, 'SKILL.md');
      const hasBuiltin = Boolean(builtinPath);
      const hasUser = fs.existsSync(userPath);
      const activePath = hasUser ? userPath : builtinPath;
      let raw = '';
      let updatedAt = 0;
      try {
        raw = fs.readFileSync(activePath, 'utf8');
        updatedAt = Math.trunc(fs.statSync(activePath).mtimeMs);
      } catch {}
      return {
        name,
        description: parseSkillDescription(raw),
        raw,
        builtin: hasBuiltin,
        overridden: hasBuiltin && hasUser,
        updatedAt,
      };
    });
  }

  function saveSkill(name, raw) {
    const cleanName = String(name || '').trim().toLowerCase();
    if (!SKILL_NAME_RE.test(cleanName)) {
      return { ok: false, msg: 'Skill 名称须为小写字母/数字/连字符/下划线（1~48 字符）' };
    }
    const content = String(raw || '');
    if (!content.trim() || content.length > 100000) {
      return { ok: false, msg: 'Skill 内容不能为空且不超过 100 KB' };
    }
    try {
      const target = path.join(userSkillsDir, cleanName, 'SKILL.md');
      writeFileAtomic(target, content, { encoding: 'utf8', mode: 0o600, mkdirMode: 0o700 });
      const skills = listSkills();
      return { ok: true, skill: skills.find((s) => s.name === cleanName) || null, skills };
    } catch (e) {
      return { ok: false, msg: '保存 Skill 失败：' + e.message };
    }
  }

  function resetSkill(name) {
    const cleanName = String(name || '').trim().toLowerCase();
    if (!SKILL_NAME_RE.test(cleanName)) return { ok: false, msg: '无效的 Skill 名称' };
    try {
      const dir = path.join(userSkillsDir, cleanName);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true, skills: listSkills() };
    } catch (e) {
      return { ok: false, msg: '还原/删除 Skill 失败：' + e.message };
    }
  }

  // ---------- CLI update signals ----------
  const cliUpdatesFile = path.join(dataDir, 'mesh-cli-updates.json');
  const loadObjMap = (f) => {
    const parsed = readJsonSafe(f);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  };
  let cliUpdatesMap = loadObjMap(cliUpdatesFile);
  function persistCliUpdates() {
    try {
      writeJsonAtomic(cliUpdatesFile, cliUpdatesMap, { indent: 2, trailingNewline: true, mode: 0o600, mkdirMode: 0o700 });
    } catch {}
  }
  function onCliUpdate(machineName, d = {}) {
    const mach = cleanStr(machineName, 60);
    const tool = cleanStr(d.tool, 32).toLowerCase();
    if (!mach || !tool) return;
    const key = `${mach}|${tool}`;
    cliUpdatesMap[key] = {
      machine: mach,
      tool,
      detail: cleanStr(d.detail, 160) || 'Update available',
      at: Number(d.at) || Date.now(),
    };
    persistCliUpdates();
  }
  function listCliUpdates() {
    return Object.values(cliUpdatesMap).sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  function clearCliUpdate({ machine = '', tool = '' } = {}) {
    const m = cleanStr(machine, 60);
    const t = cleanStr(tool, 32).toLowerCase();
    if (m && t) delete cliUpdatesMap[`${m}|${t}`];
    else if (m) { for (const k of Object.keys(cliUpdatesMap)) if (k.startsWith(m + '|')) delete cliUpdatesMap[k]; }
    else cliUpdatesMap = {};
    persistCliUpdates();
    return { ok: true, updates: listCliUpdates() };
  }

  // ---------- Machine role & hardware profiles ----------
  const machineProfilesFile = path.join(dataDir, 'mesh-machine-profiles.json');
  let machineProfiles = loadObjMap(machineProfilesFile);
  function persistMachineProfiles() {
    try {
      writeJsonAtomic(machineProfilesFile, machineProfiles, { indent: 2, trailingNewline: true, mode: 0o600, mkdirMode: 0o700 });
    } catch {}
  }

  function computeSummaryForMachine(mName, liveMachine) {
    const computeQueue = ctx.computeQueue;
    const probe = (liveMachine && liveMachine.computeProbe) || null;
    const topo = computeQueue.topologyFor(mName);
    const qList = computeQueue.list({ machine: mName });
    const allJobs = (qList && Array.isArray(qList.jobs)) ? qList.jobs : [];
    const runningJobs = allJobs.filter((j) => j.status === 'running');
    const queuedJobs = allJobs.filter((j) => j.status === 'queued');
    const occupiedGpus = [];
    for (const j of runningJobs) {
      if (j.resource === 'gpu' && Array.isArray(j.assignedGpus)) {
        for (const idx of j.assignedGpus) if (!occupiedGpus.includes(idx)) occupiedGpus.push(idx);
      }
    }
    const probeGpus = Array.isArray(probe && probe.gpus) ? probe.gpus : [];
    const gpus = probeGpus.length
      ? probeGpus.map((g) => ({
          index: g.index,
          name: g.name || '',
          memUsedMiB: g.memUsedMiB || 0,
          memTotalMiB: g.memTotalMiB || 0,
          utilPct: g.utilPct || 0,
          busy: Boolean(g.busy),
          numaNode: Number.isInteger(g.numaNode) ? g.numaNode : null,
          managedBy: (runningJobs.find((j) => j.resource === 'gpu' && Array.isArray(j.assignedGpus) && j.assignedGpus.includes(g.index)) || {}).id || '',
        }))
      : topo.gpus.map((g) => ({
          index: g.index,
          name: g.name || '',
          memUsedMiB: 0,
          memTotalMiB: 0,
          utilPct: 0,
          busy: Boolean(g.busy),
          numaNode: g.numaNode,
          managedBy: (runningJobs.find((j) => j.resource === 'gpu' && Array.isArray(j.assignedGpus) && j.assignedGpus.includes(g.index)) || {}).id || '',
        }));
    return {
      hasGpu: Boolean((probe && probe.hasGpu) || probeGpus.length > 0),
      gpus,
      cpuCount: (probe && probe.cpuCount) || (probe && probe.cores) || 0,
      cpuBusy: Boolean(probe && probe.cpuBusy),
      load1: (probe && probe.load1) || 0,
      numaCount: topo.numaNodes.length,
      runningCount: runningJobs.length,
      queuedCount: queuedJobs.length,
      occupiedGpus,
      probeAt: (probe && probe.at) || 0,
    };
  }

  function computeDirsForMachine(mName) {
    const out = [];
    const seen = new Set();
    if (fsCatalog && typeof fsCatalog.list === 'function') {
      for (const f of fsCatalog.list()) {
        if (!f || f.machine !== mName || !f.path) continue;
        const k = normFolderPath(f.path);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          path: f.path,
          tag: f.tag || '',
          gitBranch: (f.snapshot && f.snapshot.gitBranch) || '',
        });
        if (out.length >= 12) break;
      }
    }
    return out;
  }

  function machinesSummary() {
    const seen = new Set();
    const list = [];
    if (machines) {
      for (const m of machines.values()) {
        seen.add(m.name);
        const clients = Array.isArray(m.mcpStatus && m.mcpStatus.clients) ? m.mcpStatus.clients : [];
        const harnesses = clients.filter((c) => c && c.present && c.id).map((c) => c.id);
        const meshReadyHarnesses = clients
          .filter((c) => c && c.present && c.id && Array.isArray(c.servers) && c.servers.includes('ame-mesh'))
          .map((c) => c.id);
        const prof = machineProfiles[m.name] || {};
        list.push({
          machine: m.name,
          online: !!m.online,
          control: !!m.control,
          files: !!m.files,
          harnesses,
          meshReadyHarnesses,
          role: prof.role || '',
          hardware: prof.hardware || '',
          software: prof.software || '',
          note: prof.note || '',
          compute: computeSummaryForMachine(m.name, m),
          computeDirs: computeDirsForMachine(m.name),
          updatedAt: prof.updatedAt || 0,
        });
      }
    }
    for (const [mName, prof] of Object.entries(machineProfiles)) {
      if (seen.has(mName)) continue;
      list.push({
        machine: mName,
        online: false,
        control: false,
        files: false,
        harnesses: [],
        meshReadyHarnesses: [],
        role: (prof && prof.role) || '',
        hardware: (prof && prof.hardware) || '',
        software: (prof && prof.software) || '',
        note: (prof && prof.note) || '',
        compute: computeSummaryForMachine(mName, null),
        computeDirs: computeDirsForMachine(mName),
        updatedAt: (prof && prof.updatedAt) || 0,
      });
    }
    return list;
  }

  function saveMachineProfile({ machine, role = '', hardware = '', software = '', note = '' } = {}) {
    const mName = cleanStr(machine, 60);
    if (!mName) return { ok: false, msg: '缺少机器名' };
    machineProfiles[mName] = {
      role: cleanStr(role, 120),
      hardware: cleanStr(hardware, 240),
      software: cleanStr(software, 400),
      note: cleanStr(note, 1000),
      updatedAt: Date.now(),
    };
    persistMachineProfiles();
    return { ok: true, profile: machineProfiles[mName], machines: machinesSummary() };
  }

  return {
    onLocalQuota,
    listLocalQuotas,
    listSkills,
    saveSkill,
    resetSkill,
    onCliUpdate,
    listCliUpdates,
    clearCliUpdate,
    saveMachineProfile,
    machinesSummary,
  };
}

module.exports = { createMeshStores };
