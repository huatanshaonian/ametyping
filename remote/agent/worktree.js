'use strict';
// Git worktree lifecycle & zero-token working-tree boundary audit for AmeMesh worker isolation.

const child_process = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GIT_EXEC_OPTS = { timeout: 10000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,80}$/;
const NODE_ID_RE = /^node_[a-zA-Z0-9_-]{4,40}$/;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
};
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isValidBranchName(name) {
  return Boolean(name && BRANCH_RE.test(name) && !name.includes('..') && !name.startsWith('-'));
}

function execGit(args, opts = GIT_EXEC_OPTS) {
  return child_process.execFileSync('git', args, opts);
}

function createGitWorktree(repoDir, alias = 'worker', requestedBranch = '') {
  if (typeof repoDir !== 'string' || !repoDir.trim()) {
    return { ok: false, msg: '目标目录不是 Git 仓库，无法创建 worktree' };
  }
  let repoRoot = '';
  try {
    repoRoot = execGit(['-C', repoDir.trim(), 'rev-parse', '--show-toplevel']).trim();
  } catch {
    return { ok: false, msg: '目标目录不是 Git 仓库，无法创建 worktree' };
  }
  if (!repoRoot) return { ok: false, msg: '目标目录不是 Git 仓库，无法创建 worktree' };
  repoRoot = path.resolve(repoRoot);
  const slug = String(alias || 'worker').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'worker';
  const shortId = crypto.randomBytes(3).toString('hex');
  const reqBr = typeof requestedBranch === 'string' ? requestedBranch.trim() : '';
  const branch = isValidBranchName(reqBr) ? reqBr : `mesh/${slug}-${shortId}`;
  const wtBase = path.join(repoRoot, '.ame-worktrees');
  const wtPath = path.join(wtBase, `${slug}-${shortId}`);
  try {
    fs.mkdirSync(wtBase, { recursive: true });
    execGit(['-C', repoRoot, 'worktree', 'add', '-b', branch, wtPath]);
  } catch (e) {
    const detail = (e && (e.stderr || e.message) ? String(e.stderr || e.message) : '').trim().slice(0, 160);
    return { ok: false, msg: '创建 git worktree 失败' + (detail ? '：' + detail : '') };
  }
  let headSha = '';
  try {
    headSha = execGit(['-C', wtPath, 'rev-parse', 'HEAD']).trim();
    if (/^[0-9a-f]{40}$/i.test(headSha)) {
      const gitMetaRel = execGit(['-C', wtPath, 'rev-parse', '--git-path', 'ame-baseline-head']).trim();
      if (gitMetaRel) {
        fs.writeFileSync(path.resolve(wtPath, gitMetaRel), headSha + '\n', 'utf8');
      }
    } else {
      headSha = '';
    }
  } catch {
    headSha = '';
  }
  // Link top-level and first-level subpackage node_modules into the worktree so CJS/ESM tests run immediately
  const linkNodeModules = (relDir = '') => {
    try {
      const src = relDir ? path.join(repoRoot, relDir, 'node_modules') : path.join(repoRoot, 'node_modules');
      const dstParent = relDir ? path.join(wtPath, relDir) : wtPath;
      const dst = path.join(dstParent, 'node_modules');
      if (fs.existsSync(src) && fs.statSync(src).isDirectory() && fs.existsSync(dstParent) && !fs.existsSync(dst)) {
        fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      }
    } catch {}
  };
  linkNodeModules('');
  try {
    for (const ent of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.ame-worktrees') continue;
      linkNodeModules(ent.name);
    }
  } catch {}
  return { ok: true, worktreePath: wtPath, worktreeBranch: branch, worktreeParentRepo: repoRoot, ...(headSha ? { headSha } : {}) };
}

function checkGitWorktree(wtPath, parentRepo = '', branch = '') {
  if (typeof wtPath !== 'string' || !wtPath.trim()) {
    return { ok: false, dirty: false, unmergedCommits: 0, msg: '缺少 worktreePath 参数' };
  }
  const target = path.resolve(wtPath.trim());
  try {
    if (!fs.statSync(target).isDirectory()) {
      return { ok: false, dirty: false, unmergedCommits: 0, msg: 'worktree 目录不存在' };
    }
  } catch {
    return { ok: false, dirty: false, unmergedCommits: 0, msg: 'worktree 目录不存在' };
  }
  let statusOut = '';
  try {
    statusOut = execGit(['-C', target, 'status', '--porcelain']);
  } catch {
    return { ok: false, dirty: false, unmergedCommits: 0, msg: '无法读取 worktree git 状态' };
  }
  const changedCount = String(statusOut || '').split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  const dirty = changedCount > 0;
  let targetBranch = typeof branch === 'string' ? branch.trim() : '';
  if (!targetBranch) {
    try {
      const b = execGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();
      if (b && b !== 'HEAD') targetBranch = b;
    } catch {}
  }
  const baseRepo = (typeof parentRepo === 'string' && parentRepo.trim()) ? path.resolve(parentRepo.trim()) : target;
  let unmergedCommits = 0;
  if (isValidBranchName(targetBranch)) {
    try {
      const cnt = execGit(['-C', baseRepo, 'rev-list', '--count', `HEAD..${targetBranch}`]).trim();
      unmergedCommits = Number.parseInt(cnt, 10) || 0;
    } catch {
      unmergedCommits = 0;
    }
  }
  const msg = dirty || unmergedCommits > 0
    ? `存在 ${changedCount} 处未提交改动、${unmergedCommits} 个未合并提交`
    : 'worktree 干净，无未合并提交';
  return { ok: true, dirty, changedCount, unmergedCommits, msg };
}

function removeGitWorktree(wtPath, parentRepo = '', branch = '', force = false) {
  if (typeof wtPath !== 'string' || !wtPath.trim()) {
    return { ok: false, msg: '缺少 worktreePath 参数' };
  }
  const resolvedWt = path.resolve(wtPath.trim());
  const wtParent = path.dirname(resolvedWt);
  const wtName = path.basename(resolvedWt);
  if (path.basename(wtParent) !== '.ame-worktrees' || !wtName || wtName === '.' || wtName === '..') {
    return { ok: false, msg: '安全拦截：只能清理 .ame-worktrees 目录下的 worktree' };
  }
  const repo = (typeof parentRepo === 'string' && parentRepo.trim())
    ? path.resolve(parentRepo.trim())
    : path.dirname(wtParent);
  if (typeof parentRepo === 'string' && parentRepo.trim()) {
    const expectedBase = path.join(repo, '.ame-worktrees');
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    if (norm(wtParent) !== norm(expectedBase)) {
      return { ok: false, msg: '安全拦截：worktree 不属于指定的父仓库 .ame-worktrees 目录' };
    }
  }
  const chk = checkGitWorktree(resolvedWt, repo, branch);
  if (chk.ok && !force && (chk.dirty || chk.unmergedCommits > 0)) {
    return {
      ok: false,
      dirty: chk.dirty,
      unmergedCommits: chk.unmergedCommits,
      msg: '该 worktree 存在未提交改动或未合并提交，请先合并或显式强制删除',
    };
  }
  const args = ['-C', repo, 'worktree', 'remove'];
  if (force) args.push('--force');
  args.push(resolvedWt);
  try {
    execGit(args);
  } catch (e) {
    const detail = (e && (e.stderr || e.message) ? String(e.stderr || e.message) : '').trim().slice(0, 160);
    return { ok: false, msg: '清理 worktree 失败' + (detail ? '：' + detail : '') };
  }
  return { ok: true, msg: '已清理 worktree' };
}

function collectGitAudit(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const targetDir = cwd.trim();
  try {
    if (!fs.statSync(targetDir).isDirectory()) return null;
  } catch {
    return null;
  }
  let out = '';
  let repoRoot = targetDir;
  try {
    out = execGit(['-C', targetDir, '-c', 'core.quotepath=false', 'status', '--porcelain'], {
      timeout: 2500,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const top = execGit(['-C', targetDir, 'rev-parse', '--show-toplevel'], {
        timeout: 1500,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (top) repoRoot = top;
    } catch {}
  } catch {
    return { checked: true, isGit: false, changedFiles: [], committedFiles: [], fingerprints: {} };
  }

  let headSha = '';
  try {
    const h = execGit(['-C', targetDir, 'rev-parse', 'HEAD'], {
      timeout: 1500,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (/^[0-9a-f]{40}$/i.test(h)) headSha = h;
  } catch {}

  let baseSha = '';
  try {
    const metaRel = execGit(['-C', targetDir, 'rev-parse', '--git-path', 'ame-baseline-head'], {
      timeout: 1500,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (metaRel) {
      const metaAbs = path.resolve(targetDir, metaRel);
      if (fs.existsSync(metaAbs)) {
        const rawBase = fs.readFileSync(metaAbs, 'utf8').trim();
        if (/^[0-9a-f]{40}$/i.test(rawBase)) baseSha = rawBase;
      }
    }
  } catch {}

  const committedFiles = [];
  if (baseSha && headSha && baseSha !== headSha) {
    try {
      const diffOut = execGit(
        ['-C', targetDir, '-c', 'core.quotepath=false', 'diff', '--name-only', `${baseSha}...HEAD`],
        {
          timeout: 2500,
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      const seenCommitted = new Set();
      for (const rawLine of String(diffOut || '').split(/\r?\n/)) {
        let p = rawLine.trim();
        if (!p) continue;
        if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
          p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        p = p.replace(/\\/g, '/');
        if (p && !seenCommitted.has(p)) {
          seenCommitted.add(p);
          committedFiles.push(p);
        }
      }
    } catch {}
  }

  const files = [];
  const fingerprints = {};
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!line || line.length < 4) continue;
    let p = line.slice(3).trim();
    if (!p) continue;
    const arrowIdx = p.indexOf(' -> ');
    if (arrowIdx >= 0) p = p.slice(arrowIdx + 4).trim();
    if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
      p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    p = p.replace(/\\/g, '/');
    if (p) {
      files.push(p);
      if (files.length <= 200) {
        try {
          const st = fs.statSync(path.join(repoRoot, p));
          fingerprints[p] = `${st.size}:${Math.trunc(st.mtimeMs)}`;
        } catch {
          fingerprints[p] = 'deleted';
        }
      }
    }
  }
  return {
    checked: true,
    isGit: true,
    ...(headSha ? { headSha } : {}),
    ...(baseSha ? { baseSha } : {}),
    changedFiles: files.slice(0, 200),
    committedFiles: committedFiles.slice(0, 200),
    fingerprints,
  };
}

function commandMatchesNodeId(cmdLine, nodeId) {
  if (typeof cmdLine !== 'string' || !cmdLine || !NODE_ID_RE.test(nodeId)) return false;
  const esc = escapeRegExp(nodeId);
  const assignRe = new RegExp(
    `(?:\\$env:AME_NODE_ID\\s*=\\s*['"]?|\\bset\\s+["']?AME_NODE_ID=|\\bexport\\s+AME_NODE_ID=['"]?|(?:^|[\\s;])AME_NODE_ID=['"]?)${esc}(?=['";\\s]|$)(?![A-Za-z0-9_-])`
  );
  if (assignRe.test(cmdLine)) return true;
  const encRe = /(?:^|\s)-(?:encodedcommand|ec|e)\s+([A-Za-z0-9+/=]{12,})(?=\s|$)/gi;
  let m;
  while ((m = encRe.exec(cmdLine)) !== null) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf16le');
      if (decoded && assignRe.test(decoded)) return true;
    } catch {}
  }
  return false;
}

function execFileAsync(file, args, opts) {
  return new Promise((resolve) => {
    child_process.execFile(file, args, opts, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function buildAncestorSet(startPid, byPid) {
  const protectedPids = new Set();
  let cur = startPid;
  while (Number.isInteger(cur) && cur > 0 && !protectedPids.has(cur)) {
    protectedPids.add(cur);
    const info = byPid.get(cur);
    cur = info ? info.ppid : 0;
  }
  return protectedPids;
}

function collectSubtreePids(rootPids, childrenOf, protectedPids) {
  const seen = new Set();
  const ordered = [];
  const queue = [...rootPids];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid) || protectedPids.has(pid)) continue;
    seen.add(pid);
    ordered.push(pid);
    const kids = childrenOf.get(pid) || [];
    for (const k of kids) {
      if (!seen.has(k) && !protectedPids.has(k)) queue.push(k);
    }
  }
  return ordered;
}

async function closeNodeTerminalWin32(nodeId) {
  const psCmd = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const { err, stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
    { timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
  );
  if (err && !stdout.trim()) {
    return { ok: false, closed: false, count: 0, detail: '枚举 Windows 进程列表失败' };
  }
  let rows = [];
  try {
    const trimmed = stdout.trim();
    if (trimmed) {
      const parsed = JSON.parse(trimmed);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {
    return { ok: false, closed: false, count: 0, detail: '解析 Windows 进程列表失败' };
  }

  const byPid = new Map();
  const childrenOf = new Map();
  for (const r of rows) {
    const pid = Number(r && r.ProcessId);
    const ppid = Number(r && r.ParentProcessId) || 0;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const cmd = typeof r.CommandLine === 'string' ? r.CommandLine : '';
    const name = typeof r.Name === 'string' ? r.Name : '';
    byPid.set(pid, { pid, ppid, name, cmd });
    if (ppid > 0 && ppid !== pid) {
      const list = childrenOf.get(ppid) || [];
      list.push(pid);
      childrenOf.set(ppid, list);
    }
  }

  const protectedPids = buildAncestorSet(process.pid, byPid);
  const rootPids = [];
  for (const proc of byPid.values()) {
    if (protectedPids.has(proc.pid)) continue;
    if (commandMatchesNodeId(proc.cmd, nodeId)) {
      rootPids.push(proc.pid);
    }
  }

  const targetPids = collectSubtreePids(rootPids, childrenOf, protectedPids);
  if (!targetPids.length) {
    return { ok: true, closed: false, count: 0, pids: [], detail: '未找到匹配 AME_NODE_ID 的终端进程' };
  }

  const rootSet = new Set(rootPids);
  const directChildren = [];
  for (const rpid of rootPids) {
    for (const cpid of childrenOf.get(rpid) || []) {
      if (!rootSet.has(cpid) && !protectedPids.has(cpid)) directChildren.push(cpid);
    }
  }

  const killTree = (pid) => execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true });

  // First terminate child CLI processes so non-NoExit PowerShell wrappers exit cleanly with code 0 (closing WT tabs gracefully)
  if (directChildren.length > 0) {
    await Promise.all(directChildren.map((cpid) => killTree(cpid)));
    await sleepMs(180);
  }

  // Terminate any remaining root shell or descendant processes
  for (const rpid of rootPids) {
    if (pidAlive(rpid)) await killTree(rpid);
  }
  for (const pid of [...targetPids].reverse()) {
    if (pidAlive(pid)) {
      try { process.kill(pid); } catch {}
    }
  }

  const deadline = Date.now() + 500;
  while (Date.now() < deadline && targetPids.some((p) => pidAlive(p))) {
    await sleepMs(50);
  }

  const closedCount = targetPids.filter((p) => !pidAlive(p)).length;
  return {
    ok: true,
    closed: closedCount > 0,
    count: closedCount,
    pids: targetPids,
    detail: closedCount > 0 ? `已按 AME_NODE_ID 终止 ${closedCount} 个节点进程` : '未能终止目标节点进程',
  };
}

async function closeNodeTerminalUnix(nodeId) {
  const byPid = new Map();
  const childrenOf = new Map();
  const rootCandidates = [];
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;

  if (fs.existsSync('/proc')) {
    let entries = [];
    try { entries = fs.readdirSync('/proc'); } catch {}
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const procDir = `/proc/${pid}`;
      if (myUid !== null) {
        try {
          const st = fs.statSync(procDir);
          if (st.uid !== myUid) continue;
        } catch {
          continue;
        }
      }
      let ppid = 0;
      let comm = '';
      try {
        const statusTxt = fs.readFileSync(`${procDir}/status`, 'utf8');
        const pm = /^PPid:\s*(\d+)/m.exec(statusTxt);
        if (pm) ppid = Number(pm[1]) || 0;
        const nm = /^Name:\s*(.+)$/m.exec(statusTxt);
        if (nm) comm = nm[1].trim();
      } catch {
        continue;
      }
      byPid.set(pid, { pid, ppid, comm });
      if (ppid > 0 && ppid !== pid) {
        const list = childrenOf.get(ppid) || [];
        list.push(pid);
        childrenOf.set(ppid, list);
      }
      if (/^tmux(?::|$)/i.test(comm)) continue;
      let matched = false;
      try {
        const envBuf = fs.readFileSync(`${procDir}/environ`);
        const envItems = envBuf.toString('utf8').split('\0');
        if (envItems.includes(`AME_NODE_ID=${nodeId}`)) matched = true;
      } catch {}
      if (!matched) {
        try {
          const cmdBuf = fs.readFileSync(`${procDir}/cmdline`);
          const cmdStr = cmdBuf.toString('utf8').replace(/\0+/g, ' ').trim();
          if (commandMatchesNodeId(cmdStr, nodeId)) matched = true;
        } catch {}
      }
      if (matched) rootCandidates.push(pid);
    }
  } else {
    const { stdout } = await execFileAsync('ps', ['eww', '-o', 'pid=,ppid=,comm=,command='], {
      timeout: 6000,
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]) || 0;
      const comm = m[3];
      const cmd = m[4];
      byPid.set(pid, { pid, ppid, comm });
      if (ppid > 0 && ppid !== pid) {
        const list = childrenOf.get(ppid) || [];
        list.push(pid);
        childrenOf.set(ppid, list);
      }
      if (/^tmux$/i.test(path.basename(comm))) continue;
      if (commandMatchesNodeId(cmd, nodeId)) rootCandidates.push(pid);
    }
  }

  const protectedPids = buildAncestorSet(process.pid, byPid);
  const rootPids = rootCandidates.filter((p) => !protectedPids.has(p));
  const targetPids = collectSubtreePids(rootPids, childrenOf, protectedPids);
  if (!targetPids.length) {
    return { ok: true, closed: false, count: 0, pids: [], detail: '未找到匹配 AME_NODE_ID 的终端进程' };
  }

  for (const pid of [...targetPids].reverse()) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const softDeadline = Date.now() + 300;
  while (Date.now() < softDeadline && targetPids.some((p) => pidAlive(p))) {
    await sleepMs(40);
  }
  for (const pid of [...targetPids].reverse()) {
    if (pidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
  const hardDeadline = Date.now() + 250;
  while (Date.now() < hardDeadline && targetPids.some((p) => pidAlive(p))) {
    await sleepMs(40);
  }

  const closedCount = targetPids.filter((p) => !pidAlive(p)).length;
  return {
    ok: true,
    closed: closedCount > 0,
    count: closedCount,
    pids: targetPids,
    detail: closedCount > 0 ? `已按 AME_NODE_ID 终止 ${closedCount} 个节点进程` : '未能终止目标节点进程',
  };
}

async function closeNodeTerminal({ nodeId, role = '' } = {}) {
  if (role === 'master') {
    return { ok: false, closed: false, count: 0, detail: '安全保护：禁止关闭主控会话终端' };
  }
  if (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId)) {
    return { ok: false, closed: false, count: 0, detail: '安全拦截：非法的 nodeId 格式' };
  }
  if (process.platform === 'win32') {
    return closeNodeTerminalWin32(nodeId);
  }
  return closeNodeTerminalUnix(nodeId);
}

module.exports = {
  createGitWorktree,
  checkGitWorktree,
  removeGitWorktree,
  collectGitAudit,
  closeNodeTerminal,
  commandMatchesNodeId,
};
