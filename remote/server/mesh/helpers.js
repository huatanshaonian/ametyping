// Pure helpers, constants, path/boundary utilities, and prompt formatters for AmeMesh.
'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const { checkBoundaries } = require('../mesh-board');

const MAX_PROJECTS = 50;
const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_INBOX = 30;
const MAX_TRANSFERS = 100;
const AUTO_FILE_LIMIT = 50 * 1024 * 1024; // 50 MB threshold before suggesting manual disk handoff
const TOOLS = ['claude', 'codex', 'opencode', 'agy', 'kiro']; // coding agents a node / spawn may be

const NOISE_CWD_RE = /^(?:\/tmp(?:\/|$)|\/var\/tmp|[a-z]:\/windows\/system32|[a-z]:\/users\/[^/]+(?:\/desktop|\/downloads|\/documents\/codex|\/appdata\/local\/temp|\/appdata\/roaming\/claude\/scratch-workspaces|\/\.claude\/projects)(?:\/|$)|.*\/\.claude\/worktrees\/|.*\/\.ame-worktrees\/|.*\/ame-(?:launch|mode|key|perm)test)/i;

const SPAWN_ALLOWED_KEYS = new Set([
  'projectId', 'projectName', 'machine', 'cwd', 'role', 'pool', 'tool', 'model', 'api',
  'alias', 'goal', 'stopCondition', 'prompt', 'boundaries', 'doneWhen', 'checks',
  'workspaceMode', 'branch',
  // Internal RPC / caller identity fields
  't', 'rid', 'op', 'sessionId', 'nodeId', 'fromNodeId', 'fromMachine', 'fromSessionId', 'callerCwd',
]);

const cleanStr = (v, n) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, n) : '');
const normalizeStrArray = (arr, maxLen, itemMax) =>
  (Array.isArray(arr) ? arr.map((x) => cleanStr(x, itemMax)).filter(Boolean).slice(0, maxLen) : []);
const idGen = (prefix = 'p') => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

let CRC_TABLE = null;
function crc32Of(buf, crc = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, crc);
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function normFolderPath(p) {
  let s = String(p || '').trim().replace(/^(?:\\\\\?\\|\/\/\?\/)/, '').replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(s)) return s.toLowerCase() + '\\';
  if (/^[A-Za-z]:/.test(s)) return s.replace(/[\\/]+/g, '\\').toLowerCase();
  return s.replace(/\/+/g, '/');
}

function isSubPath(parentPath, childPath) {
  const p = normFolderPath(parentPath);
  const c = normFolderPath(childPath);
  if (!p || !c) return false;
  if (p === c) return true;
  const sep = /^[A-Za-z]:/.test(p) ? '\\' : '/';
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(prefix);
}

// Format a structured message envelope injected into a coding agent's terminal or resume prompt
function formatEnvelope({ project, fromNode, toNode, type, text, goal, stopCondition, artifacts }) {
  const senderLabel = fromNode ? `${fromNode.alias || fromNode.id} (${fromNode.machine})` : '项目管理中心';
  const lines = [];
  if (type === 'report') {
    lines.push(`[AmeMesh 节点汇报 | 项目：${project.name} | 来自：${senderLabel} -> ${toNode.alias || toNode.id}]`);
    lines.push(`汇报内容：${text}`);
    if (Array.isArray(artifacts) && artifacts.length) {
      lines.push(`产出文件/图表：${artifacts.join(', ')}`);
    }
    lines.push(`请检视（Review）上述结果并决定下一步操作。`);
  } else if (type === 'cowork') {
    lines.push(`[AmeMesh 平级协同消息 (Cowork) | 项目：${project.name} | 来自：${senderLabel}]`);
    if (goal) lines.push(`协同目标：${goal}`);
    lines.push(`消息内容：${text}`);
    if (stopCondition) lines.push(`阶段边界（达成即停）：${stopCondition}`);
  } else if (type === 'handoff_ready') {
    lines.push(`[AmeMesh 大文件就位通知 | 项目：${project.name}]`);
    lines.push(text);
  } else {
    lines.push(`[AmeMesh 主控任务指令 | 项目：${project.name} | 来自：${senderLabel}]`);
    if (goal || toNode.goal) lines.push(`执行目标（Goal）：${goal || toNode.goal}`);
    lines.push(`具体指令：${text}`);
    if (stopCondition || toNode.stopCondition) {
      lines.push(`停机与检视边界（Stop & Review Gate）：${stopCondition || toNode.stopCondition}（达成此条件或遇阻塞时请停止继续发散，调用 mesh_report 汇报并等待检视）`);
    }
  }
  return lines.join('\n');
}

function mentionTokenOf(node) {
  if (!node) return '@master';
  const alias = String(node.alias || '').trim();
  if (alias && !/\s/.test(alias)) return `@${alias}`;
  if (node.role === 'master') return '@master';
  return `@${node.id}`;
}

function sanitizeForOpenCode(text) {
  return String(text || '').replace(/(^|[\s([{"'（【「，。；：、！？])@([#A-Za-z0-9_\u4e00-\u9fa5-]+)/g, '$1＠$2');
}

function deliverPromptFor(tool, text) {
  return tool === 'opencode' ? sanitizeForOpenCode(text) : text;
}

function inferToolFromSessionId(sid = '') {
  const s = String(sid || '');
  if (s.startsWith('agy:')) return 'agy';
  if (s.startsWith('codex:')) return 'codex';
  if (s.startsWith('opencode:')) return 'opencode';
  if (s.startsWith('kiro:')) return 'kiro';
  return 'claude';
}

function summarizeSnapshot(snap, includeTree = false) {
  if (!snap || typeof snap !== 'object') return null;
  if (includeTree) return snap;
  return {
    sep: snap.sep,
    freeBytes: snap.freeBytes,
    totalBytes: snap.totalBytes,
    gitBranch: snap.gitBranch ?? null,
    count: snap.count || 0,
    truncated: !!snap.truncated,
    scannedAt: snap.scannedAt || 0,
  };
}

function summarizeCatalogItem(item, includeTree = false) {
  if (!item || typeof item !== 'object') return item;
  return {
    ...item,
    snapshot: summarizeSnapshot(item.snapshot, includeTree),
  };
}

function compactProjectForRpc(proj) {
  if (!proj || typeof proj !== 'object') return proj;
  return {
    id: proj.id,
    name: proj.name,
    groupId: proj.groupId || '',
    workspacesLocked: !!proj.workspacesLocked,
    boardSeq: proj.boardSeq || 0,
    workspaces: (proj.workspaces || []).map((w) => ({
      machine: w.machine,
      path: w.path,
      mode: w.mode,
      tag: w.tag || '',
    })),
    nodes: (proj.nodes || []).map((n) => ({
      id: n.id,
      machine: n.machine,
      sessionId: n.sessionId || '',
      alias: n.alias || '',
      role: n.role || 'worker',
      tool: n.tool || '',
      pool: n.pool || '',
      model: n.model || '',
      cwd: n.cwd || '',
      workspaceMode: n.workspaceMode || 'inherit',
      worktreeBranch: n.worktreeBranch || '',
      reviewStatus: n.reviewStatus || 'running',
      liveState: n.liveState || '',
      lastReport: n.lastReport || '',
    })),
    edges: proj.edges || [],
    tasks: proj.tasks || [],
    channels: proj.channels || [],
    eventsCount: (proj.events || []).length,
    transfersCount: (proj.transfers || []).length,
    triggersCount: (proj.triggers || []).length,
  };
}

function evaluateGitAudit(node, gitAudit, explicitBoundaries) {
  if (!gitAudit || !gitAudit.checked || !gitAudit.isGit) return null;
  const boundaries = (Array.isArray(explicitBoundaries) && explicitBoundaries.length)
    ? explicitBoundaries
    : (node && Array.isArray(node.boundaries) ? node.boundaries : []);
  const rawChangedFiles = Array.isArray(gitAudit.changedFiles) ? gitAudit.changedFiles : [];
  const curFingerprints = (gitAudit.fingerprints && typeof gitAudit.fingerprints === 'object') ? gitAudit.fingerprints : null;
  const baseline = node && node.gitBaseline && Array.isArray(node.gitBaseline.files) ? node.gitBaseline : null;
  let changedFiles = rawChangedFiles;
  let baselineExcludedCount = 0;
  if (baseline && baseline.files.length) {
    const baseSet = new Set(baseline.files.map((f) => String(f || '').replace(/\\/g, '/')));
    const baseFp = (baseline.fingerprints && typeof baseline.fingerprints === 'object') ? baseline.fingerprints : null;
    changedFiles = rawChangedFiles.filter((f) => {
      const nf = String(f || '').replace(/\\/g, '/');
      if (!baseSet.has(nf)) return true;
      if (baseFp && curFingerprints && typeof baseFp[nf] === 'string' && typeof curFingerprints[nf] === 'string') {
        if (baseFp[nf] !== curFingerprints[nf]) return true;
      }
      baselineExcludedCount += 1;
      return false;
    });
  }
  const res = checkBoundaries(boundaries, changedFiles);
  const emptyChange = changedFiles.length === 0 && boundaries.length > 0;
  return {
    checked: true,
    isGit: true,
    changedFiles: changedFiles.slice(0, 100),
    outOfBounds: res.outOfBounds,
    emptyChange,
    ...(baselineExcludedCount > 0 ? { baselineExcludedCount } : {}),
    ok: res.outOfBounds.length === 0 && !emptyChange,
  };
}

function formatAuditWarnings(auditRes) {
  if (!auditRes || auditRes.ok) return [];
  const warnings = [];
  if (auditRes.outOfBounds.length) {
    warnings.push(`[边界对账告警] 改动了允许边界之外的文件：${auditRes.outOfBounds.join(', ')}`);
  }
  if (auditRes.emptyChange) {
    warnings.push('[边界对账告警] 声明完成但工作区 git status 未检测到任何文件改动');
  }
  return warnings;
}

module.exports = {
  MAX_PROJECTS,
  MAX_NODES,
  MAX_EDGES,
  MAX_INBOX,
  MAX_TRANSFERS,
  AUTO_FILE_LIMIT,
  TOOLS,
  NOISE_CWD_RE,
  SPAWN_ALLOWED_KEYS,
  cleanStr,
  normalizeStrArray,
  idGen,
  crc32Of,
  normFolderPath,
  isSubPath,
  formatEnvelope,
  mentionTokenOf,
  sanitizeForOpenCode,
  deliverPromptFor,
  inferToolFromSessionId,
  summarizeSnapshot,
  summarizeCatalogItem,
  compactProjectForRpc,
  evaluateGitAudit,
  formatAuditWarnings,
};
