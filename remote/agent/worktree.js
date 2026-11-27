'use strict';
// Git worktree lifecycle & zero-token working-tree boundary audit for AmeMesh worker isolation.

const child_process = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GIT_EXEC_OPTS = { timeout: 10000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,80}$/;

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
  return { ok: true, worktreePath: wtPath, worktreeBranch: branch, worktreeParentRepo: repoRoot };
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
    return { checked: true, isGit: false, changedFiles: [], fingerprints: {} };
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
  return { checked: true, isGit: true, changedFiles: files.slice(0, 200), fingerprints };
}

module.exports = {
  createGitWorktree,
  checkGitWorktree,
  removeGitWorktree,
  collectGitAudit,
};
