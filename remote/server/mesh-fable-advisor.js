// Devin / Fable 5.2 Expiring-Quota Hard-Problem Advisor (deterministic, zero-token).
// When Devin's 7d or 1d quota window is nearing reset with ample remaining budget (>= 50%),
// surfaces the top high-leverage hard problems from active projects & todos so the user
// can optionally launch a read-only advisor session with 1 click.
'use strict';

const HARD_SIGNAL_RE = /阻塞|blocked|收敛|奇异|误差|精度|推导|公式|耦合|优化|架构|死锁|并发|竞态|漏洞|性能|瓶颈|评审|重构|root\s*cause|bug|fail|crash|hang/i;

function parseResetMs(w) {
  if (!w || !w.resetsAt) return null;
  const ms = typeof w.resetsAt === 'number' ? w.resetsAt : Date.parse(w.resetsAt);
  return Number.isFinite(ms) ? ms : null;
}

function windowRemainingPct(w) {
  if (!w || w.unlimited === true || typeof w.remaining !== 'number' || !Number.isFinite(w.remaining)) return null;
  if (typeof w.limit === 'number' && w.limit > 0) return Math.max(0, Math.min(100, (w.remaining / w.limit) * 100));
  if (w.limit == null && w.remaining >= 0 && w.remaining <= 100) return w.remaining;
  return null;
}

function findDevinExpiringWindow(magpieStatus, nowMs) {
  const accounts = Array.isArray(magpieStatus && magpieStatus.accounts) ? magpieStatus.accounts : [];
  const devinAccts = accounts.filter((a) => {
    if (!a || a.status === 'error') return false;
    const p = String(a.provider || '').toLowerCase();
    return p === 'devin' || p.endsWith('/devin');
  });
  if (!devinAccts.length) return { found: false, due: false, reason: '未在 Magpie 中检测到 Devin 账号' };

  let bestWindow = null;
  let anyExhausted = false;
  for (const a of devinAccts) {
    const wins = Array.isArray(a.windows) ? a.windows : [];
    for (const w of wins) {
      const pct = windowRemainingPct(w);
      if (pct === null) continue;
      if (pct <= 0) { anyExhausted = true; continue; }
      const resetMs = parseResetMs(w);
      const hoursLeft = resetMs && resetMs > nowMs ? (resetMs - nowMs) / 3600e3 : null;
      const isWeek = /7\s*day|7天|week/i.test(String(w.name || ''));
      const isDay = /1\s*day|24\s*h|1天|day/i.test(String(w.name || ''));
      const due = hoursLeft !== null && pct >= 50 && (
        (isWeek && hoursLeft <= 36) ||
        (isDay && hoursLeft <= 6) ||
        (!isWeek && !isDay && hoursLeft <= 12)
      );
      const info = {
        name: w.name || 'quota',
        remainingPct: Math.round(pct * 10) / 10,
        hoursLeft: hoursLeft !== null ? Math.round(hoursLeft * 10) / 10 : null,
        resetsAt: w.resetsAt || null,
        due,
      };
      if (!bestWindow || (info.due && !bestWindow.due) || (info.due === bestWindow.due && (info.hoursLeft ?? 9999) < (bestWindow.hoursLeft ?? 9999))) {
        bestWindow = info;
      }
    }
  }

  if (!bestWindow) {
    return { found: true, due: false, exhausted: anyExhausted, reason: anyExhausted ? 'Devin 额度已耗尽' : '无有效窗口数据' };
  }
  return {
    found: true,
    due: !anyExhausted && bestWindow.due,
    exhausted: anyExhausted,
    window: bestWindow,
  };
}

function buildAdvisorPrompt({ title, detail, projectName = '', source = '' }) {
  return [
    '[Fable 5.2 独立总师顾问模式 · 只读诊断与方案拍板]',
    '- 你的角色：你是高深度推理顾问，不负责写样板代码或直接修改业务文件。请用最精炼、严谨的逻辑一次性给出直击本质的分析。',
    projectName ? `- 所属项目：${projectName}` : null,
    `- 问题来源：${source || '待办/阻塞难题'}`,
    `- 核心问题：${title}`,
    detail ? `- 已知上下文：\n${detail}` : null,
    '- 请输出：',
    '  1. 根因假设 / 关键瓶颈（指出最容易被普通模型忽略的隐蔽前提或边界漏洞）；',
    '  2. 2~3 个备选技术/数学方案的优劣对比与明确推荐；',
    '  3. 可直接交给下游 Coder（AGY/Codex）执行的最小验证步骤与验收指标。',
  ].filter(Boolean).join('\n');
}

function collectHardProblems({ projects = [], todos = [], readBoard = null, limit = 3 } = {}) {
  const candidates = [];

  // 1. Blocked tasks & alerted nodes from active mesh projects
  for (const p of (Array.isArray(projects) ? projects : [])) {
    if (!p || !p.id) continue;
    const defaultWs = (p.workspaces || []).find((w) => w && w.machine && w.path) || null;
    for (const t of (p.tasks || [])) {
      if (!t || t.status === 'done') continue;
      const text = `${t.title || ''} ${t.desc || ''}`;
      let score = 0;
      if (t.status === 'blocked') score += 50;
      else if (t.status === 'in_progress') score += 15;
      else score += 10;
      if (HARD_SIGNAL_RE.test(text)) score += 25;
      if ((t.blockedBy || []).length) score += 10;
      if (score >= 30) {
        candidates.push({
          id: `task:${p.id}:${t.id}`,
          score,
          source: `项目任务 (${t.status})`,
          projectId: p.id,
          projectName: p.name || p.id,
          machine: defaultWs ? defaultWs.machine : '',
          cwd: defaultWs ? defaultWs.path : '',
          title: String(t.title || '').slice(0, 120),
          detail: String(t.desc || '').slice(0, 500),
        });
      }
    }

    for (const n of (p.nodes || [])) {
      if (!n || n.archived) continue;
      if (n.reviewStatus === 'blocked' || n.watchdogAlert) {
        const alertText = (n.watchdogAlert && (n.watchdogAlert.detail || n.watchdogAlert.label)) || n.lastAct || '';
        candidates.push({
          id: `node:${p.id}:${n.id}`,
          score: 55,
          source: `阻塞节点 (${n.alias || n.id})`,
          projectId: p.id,
          projectName: p.name || p.id,
          machine: n.machine || (defaultWs ? defaultWs.machine : ''),
          cwd: n.cwd || (defaultWs ? defaultWs.path : ''),
          title: `${n.alias || n.id}: ${String(n.goal || alertText || '节点受阻').slice(0, 100)}`,
          detail: String(alertText || n.lastReport || '').slice(0, 500),
        });
      }
    }

    if (typeof readBoard === 'function') {
      try {
        const b = readBoard(p.id, { since: 0, limit: 30 });
        const entries = (b && b.entries) || [];
        for (const e of entries.slice(-15)) {
          if (!e || !e.text || e.kind === 'brief' || e.kind === 'control') continue;
          if (!HARD_SIGNAL_RE.test(e.text)) continue;
          candidates.push({
            id: `board:${p.id}:${e.seq}`,
            score: 28,
            source: `黑板 #${e.seq} (${e.agent || '成员'})`,
            projectId: p.id,
            projectName: p.name || p.id,
            machine: defaultWs ? defaultWs.machine : '',
            cwd: defaultWs ? defaultWs.path : '',
            title: String(e.text).replace(/\s+/g, ' ').slice(0, 110),
            detail: String(e.text).slice(0, 500),
          });
        }
      } catch {}
    }
  }

  // 2. Unfinished high-signal items from user's todos (重要计划)
  for (const td of (Array.isArray(todos) ? todos : [])) {
    if (!td || td.done || td.completed) continue;
    const text = `${td.title || td.text || ''} ${td.note || td.desc || ''}`;
    let score = 15;
    if (td.priority === 'high' || td.starred || td.pinned) score += 20;
    if (HARD_SIGNAL_RE.test(text)) score += 25;
    if (score >= 30) {
      candidates.push({
        id: `todo:${td.id || text.slice(0, 24)}`,
        score,
        source: '重要计划 (Todo)',
        projectId: '',
        projectName: '',
        machine: '',
        cwd: '',
        title: String(td.title || td.text || '').slice(0, 120),
        detail: String(td.note || td.desc || '').slice(0, 500),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = c.title.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...c,
      advisorTool: 'opencode',
      advisorModel: 'magpie/devin/claude-fable-5-2',
      advisorPrompt: buildAdvisorPrompt(c),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function evaluateFableAdvice({ magpieStatus = null, projects = [], todos = [], readBoard = null, force = false, now = () => Date.now() } = {}) {
  const curMs = now();
  const devin = findDevinExpiringWindow(magpieStatus, curMs);
  const shouldSuggest = Boolean(force || devin.due);
  const suggestions = shouldSuggest ? collectHardProblems({ projects, todos, readBoard, limit: 3 }) : [];
  return {
    ok: true,
    due: Boolean(devin.due),
    preview: Boolean(force && !devin.due),
    found: Boolean(devin.found),
    exhausted: Boolean(devin.exhausted),
    window: devin.window || null,
    reason: devin.reason || '',
    advisorModel: 'opencode:magpie/devin/claude-fable-5-2',
    suggestions,
  };
}

module.exports = {
  findDevinExpiringWindow,
  collectHardProblems,
  evaluateFableAdvice,
  buildAdvisorPrompt,
};
