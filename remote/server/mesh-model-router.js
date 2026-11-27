// AmeMesh Model Pool Router: configurable capability pools, Magpie live quota evaluation,
// and passive cooldown circuit breaker with deterministic fallback selection.
'use strict';
const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./lib/json-store');

const DEFAULT_POOLS = {
  'fast-coder': [
    { harness: 'agy', model: 'gemini-4-hydrogen-medium', magpieProvider: 'antigravity', quirks: '' },
    { harness: 'codex', model: 'gpt-6.2-terra', magpieProvider: 'openai', quirks: '' },
    { harness: 'agy', model: 'claude-sonnet-5-5-medium', magpieProvider: 'antigravity', quirks: '' },
    { harness: 'claude', model: 'sonnet', magpieProvider: 'claude', quirks: '' },
    { harness: 'opencode', model: 'gpt-6.2-sol', magpieProvider: 'openai', quirks: '' },
  ],
  flagship: [
    { harness: 'agy', model: 'gemini-4-neon-medium', magpieProvider: 'antigravity', quirks: '' },
    { harness: 'codex', model: 'gpt-6.2-sol', magpieProvider: 'openai', quirks: '' },
    { harness: 'agy', model: 'claude-opus-5-5-medium', magpieProvider: 'antigravity', quirks: '' },
    { harness: 'claude', model: 'opus', magpieProvider: 'claude', quirks: '' },
    { harness: 'opencode', model: 'gpt-6.2-astra', magpieProvider: 'openai', quirks: '' },
  ],
  'heavy-reasoner': [
    { harness: 'agy', model: 'gemini-4-carbon-high', magpieProvider: 'antigravity', quirks: '' },
    { harness: 'opencode', model: 'magpie/devin/claude-fable-5-2', magpieProvider: 'devin', quirks: '' },
    { harness: 'codex', model: 'gpt-6.2-astra', magpieProvider: 'openai', quirks: '' },
    { harness: 'agy', model: 'claude-opus-5-5-high', magpieProvider: 'antigravity', quirks: '' },
    { harness: 'claude', model: 'opus', magpieProvider: 'claude', quirks: '' },
  ],
  'image-gen': [
    { harness: 'codex', model: 'gpt-image', quirks: '' },
  ],
};

function clonePools(pools) {
  const out = {};
  for (const [k, list] of Object.entries(pools || {})) {
    if (!Array.isArray(list)) continue;
    out[k] = list.map((c) => ({ ...c }));
  }
  return out;
}

function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const harness = String(raw.harness || '').trim();
  if (!harness) return null;
  const entry = {
    harness: harness.slice(0, 40),
    model: String(raw.model || '').trim().slice(0, 120),
    quirks: String(raw.quirks || '').trim().slice(0, 500),
  };
  if (typeof raw.magpieProvider === 'string' && raw.magpieProvider.trim()) {
    entry.magpieProvider = raw.magpieProvider.trim().slice(0, 60);
  }
  return entry;
}

function normalizePools(rawPools) {
  if (!rawPools || typeof rawPools !== 'object' || Array.isArray(rawPools)) return null;
  const out = {};
  for (const [rawName, list] of Object.entries(rawPools)) {
    const name = String(rawName || '').trim().slice(0, 60);
    if (!name || !Array.isArray(list)) continue;
    out[name] = list.map(normalizeCandidate).filter(Boolean).slice(0, 30);
  }
  return out;
}

function candidateKey(harness, model = '') {
  return `${String(harness || '').trim()}|${String(model || '').trim()}`;
}

function createModelRouter({
  dataDir,
  getMagpie = () => null,
  getLocalQuotas = () => [],
  getExpiringHarnesses = () => ['codex'],
  now = () => Date.now(),
}) {
  const poolsFile = path.join(dataDir, 'mesh-pools.json');
  const cooldowns = new Map(); // "harness|model" -> { status: 'cooldown', harness, model, reason, resetAt, updatedAt }

  function ensurePoolsFile() {
    if (!fs.existsSync(poolsFile)) {
      try {
        writeJsonAtomic(poolsFile, DEFAULT_POOLS, { indent: 2, trailingNewline: true, mode: 0o600, mkdirMode: 0o700 });
      } catch {}
    }
  }

  function loadPools() {
    ensurePoolsFile();
    const raw = readJsonSafe(poolsFile);
    if (raw) {
      const norm = normalizePools(raw);
      if (norm && Object.keys(norm).length > 0) return norm;
    }
    return clonePools(DEFAULT_POOLS);
  }

  function getPools() {
    return loadPools();
  }

  function savePools(pools) {
    const norm = normalizePools(pools);
    if (!norm) {
      return { ok: false, msg: '无效的模型池配置格式' };
    }
    try {
      writeJsonAtomic(poolsFile, norm, { indent: 2, trailingNewline: true, mode: 0o600, mkdirMode: 0o700 });
      return { ok: true, pools: norm };
    } catch (e) {
      return { ok: false, msg: `保存模型池配置失败：${e.message}` };
    }
  }

  const LOW_QUOTA_THRESHOLD = 0.10; // Remaining < 10% -> deprioritize in favor of healthier candidates

  const PROVIDER_ALIASES = {
    anthropic: ['anthropic', 'claude'],
    claude: ['claude', 'anthropic'],
    openai: ['openai', 'codex'],
    codex: ['codex', 'openai'],
    antigravity: ['antigravity', 'agy'],
    agy: ['agy', 'antigravity'],
  };

  function providerMatches(acct, mp) {
    if (!acct || typeof acct !== 'object' || !mp) return false;
    const prov = String(acct.provider || '').trim().toLowerCase();
    const name = String(acct.name || '').trim().toLowerCase();
    // Skip gateway /~keys connection limit cards; those are key caps, not upstream provider quotas
    if (prov.endsWith('/~keys')) return false;
    const aliases = PROVIDER_ALIASES[mp] || [mp];
    for (const a of aliases) {
      if (prov === a || name === a || prov.endsWith('/' + a)) return true;
    }
    return false;
  }

  function inferMagpieProvider(harness, model = '') {
    const h = String(harness || '').trim().toLowerCase();
    const m = String(model || '').trim().toLowerCase();
    if (m.includes('devin')) return 'devin';
    if (h === 'claude') return 'claude';
    if (h === 'codex') return 'openai';
    if (h === 'agy') return 'antigravity';
    if (h === 'kiro') return 'kiro';
    if (h === 'opencode') {
      if (m.includes('gpt') || m.includes('openai')) return 'openai';
      if (m.includes('claude')) return 'claude';
      if (m.includes('deepseek')) return 'deepseek';
    }
    return '';
  }

  function windowRatio(w) {
    if (!w || w.unlimited === true || typeof w.remaining !== 'number' || !Number.isFinite(w.remaining)) return null;
    if (typeof w.limit === 'number' && Number.isFinite(w.limit) && w.limit > 0) {
      return Math.max(0, Math.min(1, w.remaining / w.limit));
    }
    // Percentage-based windows (e.g. Magpie remote cc-ubuntu/claude: { remaining: 56, limit: null, used: 44 })
    if (w.limit == null && w.remaining >= 0 && w.remaining <= 100) {
      if (w.used == null || (typeof w.used === 'number' && Math.abs((w.remaining + w.used) - 100) <= 2)) {
        return Math.max(0, Math.min(1, w.remaining / 100));
      }
    }
    return null;
  }

  function mergedQuotaStatus(explicitStatus = null) {
    const base = explicitStatus !== null ? explicitStatus : (typeof getMagpie === 'function' ? getMagpie()?.status?.() : null);
    const baseAccounts = Array.isArray(base && base.accounts) ? base.accounts : [];
    const localList = typeof getLocalQuotas === 'function' ? (getLocalQuotas() || []) : [];
    if (!localList.length) return base;
    const merged = [...baseAccounts];
    for (const lq of localList) {
      if (!lq || typeof lq !== 'object' || !lq.provider) continue;
      // Only fill in providers not already reported by Magpie
      const lp = String(lq.provider).toLowerCase();
      if (!merged.some((a) => providerMatches(a, lp))) merged.push(lq);
    }
    return { ...(base && typeof base === 'object' ? base : {}), accounts: merged };
  }

  function evaluateMagpie(candidate, magpieStatus, lowThreshold = LOW_QUOTA_THRESHOLD) {
    const curTime = now();
    const explicitMp = String((candidate && candidate.magpieProvider) || '').trim().toLowerCase();
    const mp = explicitMp || inferMagpieProvider(candidate && candidate.harness, candidate && candidate.model);
    if (!mp || !magpieStatus || !Array.isArray(magpieStatus.accounts)) {
      return { matched: false, exhausted: false, lowQuota: false, expiring: false, expiringScore: 0, expiringInfo: '', minRatio: null, magpieInfo: '', resetAt: null };
    }
    const matched = magpieStatus.accounts.filter((a) => providerMatches(a, mp));
    if (!matched.length) {
      return { matched: false, exhausted: false, lowQuota: false, expiring: false, expiringScore: 0, expiringInfo: '', minRatio: null, magpieInfo: '', resetAt: null };
    }

    const candModel = String((candidate && candidate.model) || '').toLowerCase();
    const wantFamily = (mp === 'antigravity' || mp === 'agy')
      ? (/claude|sonnet|opus|haiku/.test(candModel) ? 'claude' : /gemini|hydrogen|neon|carbon/.test(candModel) ? 'gemini' : '')
      : '';

    let resetAt = null;
    const finiteWindowsOf = (acct) => {
      const all = (Array.isArray(acct.windows) ? acct.windows : []).filter((w) => {
        if (!w || w.unlimited === true || typeof w.remaining !== 'number' || !Number.isFinite(w.remaining)) return false;
        // If a local/cached window's resetsAt has already passed, treat it as reset rather than stale exhaustion
        if (w.resetsAt) {
          const rMs = typeof w.resetsAt === 'number' ? w.resetsAt : Date.parse(w.resetsAt);
          if (Number.isFinite(rMs) && rMs <= curTime) return false;
        }
        return true;
      });
      if (wantFamily) {
        const re = wantFamily === 'claude' ? /claude/i : /gemini/i;
        const scoped = all.filter((w) => re.test(String(w.name || '')) || re.test(String(w.pool || '')));
        if (scoped.length > 0) return scoped;
      }
      return all;
    };
    const isAcctExhausted = (acct) => {
      if (acct.status === 'error') return true;
      const finiteWindows = finiteWindowsOf(acct);
      // Bottleneck semantics: if ANY active window (e.g. 5h window) is exhausted (remaining <= 0), requests will fail now
      const exhaustedWins = finiteWindows.filter((w) => w.remaining <= 0);
      if (exhaustedWins.length > 0) {
        for (const w of exhaustedWins) {
          if (w.resetsAt) {
            const parsed = typeof w.resetsAt === 'number' ? w.resetsAt : Date.parse(w.resetsAt);
            if (Number.isFinite(parsed) && (!resetAt || parsed < resetAt)) resetAt = parsed;
            if (!resetAt && typeof w.resetsAt === 'string') resetAt = w.resetsAt;
          }
        }
        return true;
      }
      return false;
    };

    const healthyAccounts = matched.filter((a) => !isAcctExhausted(a));
    if (healthyAccounts.length === 0) {
      return {
        matched: true,
        exhausted: true,
        lowQuota: false,
        expiring: false,
        expiringScore: 0,
        expiringInfo: '',
        minRatio: 0,
        magpieInfo: matched.every((a) => a.status === 'error') ? 'Magpie 账号状态异常' : 'Magpie 额度已耗尽',
        resetAt,
      };
    }

    // Compute remaining ratio across finite windows (supports both limit-based and percentage-based windows)
    let bestAcctMinRatio = null;
    for (const a of healthyAccounts) {
      const ratios = finiteWindowsOf(a).map(windowRatio).filter((r) => r !== null);
      if (ratios.length) {
        const acctMin = Math.min(...ratios);
        if (bestAcctMinRatio === null || acctMin > bestAcctMinRatio) bestAcctMinRatio = acctMin;
      }
    }
    const lowQuota = bestAcctMinRatio !== null && bestAcctMinRatio < lowThreshold;

    // Expiring-first detection (only for whitelisted harnesses, e.g. codex — explicitly excluding manual claude)
    const expList = typeof getExpiringHarnesses === 'function' ? (getExpiringHarnesses() || []) : [];
    const expSet = new Set(expList.map((x) => String(x || '').trim().toLowerCase()));
    const candHarness = String((candidate && candidate.harness) || '').trim().toLowerCase();
    let expiring = false;
    let expiringScore = 0;
    let expiringInfo = '';
    if (!lowQuota && expSet.has(candHarness)) {
      for (const a of healthyAccounts) {
        for (const w of finiteWindowsOf(a)) {
          if (!w.resetsAt) continue;
          const rMs = typeof w.resetsAt === 'number' ? w.resetsAt : Date.parse(w.resetsAt);
          if (!Number.isFinite(rMs) || rMs <= curTime) continue;
          const ratio = windowRatio(w);
          if (ratio === null) continue;
          const hoursLeft = (rMs - curTime) / 3600e3;
          const mins = Number(w.windowMinutes) || 0;
          const isLong = mins >= 1440 || /7\s*day|7天|week|day|天/i.test(String(w.name || ''));
          const isExpiringWin = isLong
            ? (hoursLeft <= 24 && ratio >= 0.25)
            : (hoursLeft <= 0.75 && ratio >= 0.30);
          if (isExpiringWin) {
            const score = ratio / Math.max(0.1, hoursLeft);
            if (score > expiringScore) {
              expiring = true;
              expiringScore = Math.round(score * 100) / 100;
              const pct = Math.round(ratio * 100);
              const leftLabel = hoursLeft >= 1 ? `${Math.round(hoursLeft * 10) / 10}h` : `${Math.max(1, Math.round(hoursLeft * 60))}m`;
              expiringInfo = `临近重置优先（${w.name || '额度'}剩 ${pct}%，${leftLabel} 后重置）`;
            }
          }
        }
      }
    }

    // Build concise remaining summary from the first healthy account
    let info = '';
    for (const a of healthyAccounts) {
      const wins = finiteWindowsOf(a);
      const firstWin = wins.find((w) => w && w.display) || wins.find((w) => w && typeof w.remaining === 'number');
      if (firstWin) {
        info = firstWin.display || `${firstWin.remaining}${firstWin.unit ? ' ' + firstWin.unit : (firstWin.limit == null ? '%' : '')}`;
        break;
      }
      if (a.balance && typeof a.balance.amount === 'number') {
        info = `${a.balance.currency ? a.balance.currency + ' ' : ''}${a.balance.amount}`;
        break;
      }
    }
    if (lowQuota) {
      const pct = Math.round(bestAcctMinRatio * 100);
      info = info ? `${info}（低余额 ${pct}%）` : `低余额 ${pct}%`;
    } else if (expiring && expiringInfo) {
      info = info ? `${info} · ${expiringInfo}` : expiringInfo;
    }
    return { matched: true, exhausted: false, lowQuota, expiring, expiringScore, expiringInfo, minRatio: bestAcctMinRatio, magpieInfo: info, resetAt: null };
  }

  function evaluateCandidate(candidate, magpieStatus = null) {
    const curTime = now();
    const key = candidateKey(candidate.harness, candidate.model);
    let cd = cooldowns.get(key) || null;
    if (cd && cd.resetAt <= curTime) {
      cooldowns.delete(key);
      cd = null;
    }

    const mpStatus = mergedQuotaStatus(magpieStatus);
    const mpEval = evaluateMagpie(candidate, mpStatus);

    if (cd) {
      return {
        status: 'cooldown',
        healthy: false,
        lowQuota: false,
        expiring: false,
        expiringScore: 0,
        minRatio: mpEval.minRatio,
        reason: cd.reason,
        resetAt: cd.resetAt,
        remainingMs: Math.max(0, cd.resetAt - curTime),
        magpieInfo: mpEval.magpieInfo,
      };
    }
    if (mpEval.exhausted) {
      return {
        status: 'exhausted',
        healthy: false,
        lowQuota: false,
        expiring: false,
        expiringScore: 0,
        minRatio: 0,
        reason: mpEval.magpieInfo,
        resetAt: mpEval.resetAt,
        magpieInfo: mpEval.magpieInfo,
      };
    }
    if (mpEval.lowQuota) {
      return {
        status: 'low_quota',
        healthy: true,
        lowQuota: true,
        expiring: false,
        expiringScore: 0,
        minRatio: mpEval.minRatio,
        reason: '剩余额度不足 10%，优先避让',
        resetAt: null,
        magpieInfo: mpEval.magpieInfo,
      };
    }
    return {
      status: mpEval.expiring ? 'expiring_priority' : 'healthy',
      healthy: true,
      lowQuota: false,
      expiring: !!mpEval.expiring,
      expiringScore: mpEval.expiringScore || 0,
      minRatio: mpEval.minRatio,
      reason: mpEval.expiringInfo || '',
      resetAt: null,
      magpieInfo: mpEval.magpieInfo,
    };
  }

  function markCooldown(harness, model = '', reason = 'quota', resetAt = now() + 15 * 60e3) {
    const key = candidateKey(harness, model);
    const curTime = now();
    const entry = {
      status: 'cooldown',
      harness: String(harness || '').trim(),
      model: String(model || '').trim(),
      reason: String(reason || 'quota').slice(0, 200),
      resetAt: Number(resetAt) || (curTime + 15 * 60e3),
      updatedAt: curTime,
    };
    cooldowns.set(key, entry);
    return entry;
  }

  function resetCooldown(harness, model) {
    if (!harness) {
      cooldowns.clear();
      return { ok: true, cleared: 'all' };
    }
    if (typeof model === 'string') {
      cooldowns.delete(candidateKey(harness, model));
      return { ok: true, cleared: candidateKey(harness, model) };
    }
    const prefix = `${String(harness).trim()}|`;
    for (const k of [...cooldowns.keys()]) {
      if (k.startsWith(prefix)) cooldowns.delete(k);
    }
    return { ok: true, cleared: harness };
  }

  function selectCandidate(poolName, { exclude = [], activeCounts = null, availableHarnesses = null, projectHarnessCounts = null, maxPerHarness = null } = {}) {
    const pools = loadPools();
    const list = pools[poolName];
    if (!Array.isArray(list) || !list.length) {
      return { ok: false, exhausted: true, pool: poolName, msg: `模型池「${poolName}」未配置或为空` };
    }
    const excludeSet = new Set((Array.isArray(exclude) ? exclude : []).map((x) => String(x)));
    const availSet = Array.isArray(availableHarnesses) && availableHarnesses.length
      ? new Set(availableHarnesses.map((x) => String(x).toLowerCase()))
      : null;
    const mpStatus = mergedQuotaStatus(null);
    const byHarness = (activeCounts && activeCounts.byHarness) || {};
    const byCandidate = (activeCounts && activeCounts.byCandidate) || {};
    const projHarness = (projectHarnessCounts && typeof projectHarnessCounts === 'object') ? projectHarnessCounts : {};
    const caps = (maxPerHarness && typeof maxPerHarness === 'object') ? maxPerHarness : {};

    const AGY_HIGH_CONCURRENCY = 10;
    const viable = [];
    list.forEach((cand, idx) => {
      const key = candidateKey(cand.harness, cand.model);
      if (excludeSet.has(key) || excludeSet.has(cand.harness)) return;
      if (availSet && !availSet.has(String(cand.harness || '').toLowerCase())) return;
      const cap = Number(caps[cand.harness]);
      if (Number.isFinite(cap) && cap > 0 && (projHarness[cand.harness] || 0) >= cap) return;
      const evalRes = evaluateCandidate(cand, mpStatus);
      if (!evalRes.healthy) return;
      const hLoad = byHarness[cand.harness] || 0;
      const isAgy = cand.harness === 'agy';
      // AGY supports high concurrency (up to 10 total) before spilling over to Codex/Claude Code
      const overflowTier = isAgy ? (hLoad >= AGY_HIGH_CONCURRENCY ? 1 : 0) : 0;
      const spreadLoad = isAgy ? 0 : hLoad;
      viable.push({
        cand,
        evalRes,
        idx,
        lowTier: evalRes.lowQuota ? 1 : 0,
        expiringTier: evalRes.expiring ? 0 : 1,
        expiringScore: evalRes.expiringScore || 0,
        overflowTier,
        harnessLoad: spreadLoad,
        candLoad: isAgy ? 0 : (byCandidate[key] || 0),
      });
    });

    if (viable.length) {
      // Tier 1: non-low-quota (>=10%) before low-quota (<10%)
      // Tier 2: expiring-first whitelisted candidates (e.g. Codex nearing reset with >=25% left)
      // Tier 3: non-overflowing candidates (AGY < 10 stays in priority order before spilling to Codex/Claude)
      // Tier 4: spread load across non-AGY harnesses, then configured priority order
      viable.sort((a, b) =>
        (a.lowTier - b.lowTier) ||
        (a.expiringTier - b.expiringTier) ||
        (b.expiringScore - a.expiringScore) ||
        (a.overflowTier - b.overflowTier) ||
        (a.harnessLoad - b.harnessLoad) ||
        (a.candLoad - b.candLoad) ||
        (a.idx - b.idx)
      );
      const best = viable[0];
      return {
        ok: true,
        pool: poolName,
        candidate: {
          ...best.cand,
          ...best.evalRes,
        },
      };
    }

    return {
      ok: false,
      exhausted: true,
      pool: poolName,
      msg: `模型池「${poolName}」内所有可用候选均处于冷却、未安装或额度耗尽状态`,
    };
  }

  function getPoolsStatus() {
    const pools = loadPools();
    const mpStatus = mergedQuotaStatus(null);
    const out = {};
    for (const [name, list] of Object.entries(pools)) {
      out[name] = list.map((cand) => ({
        ...cand,
        ...evaluateCandidate(cand, mpStatus),
      }));
    }
    return out;
  }

  function getPoolsSummary() {
    const statusMap = getPoolsStatus();
    return Object.entries(statusMap).map(([name, candidates]) => ({
      name,
      total: candidates.length,
      healthy: candidates.filter((c) => c.healthy).length,
      primary: candidates[0] ? `${candidates[0].harness}:${candidates[0].model}` : '',
    }));
  }

  function evaluateToolQuota(harness, model = '') {
    const h = String(harness || '').trim().toLowerCase();
    const m = String(model || '').trim();
    const mp = inferMagpieProvider(h, m);
    return evaluateCandidate({ harness: h, model: m, ...(mp ? { magpieProvider: mp } : {}) });
  }

  return {
    getPools,
    savePools,
    getPoolsStatus,
    getPoolsSummary,
    markCooldown,
    resetCooldown,
    selectCandidate,
    evaluateToolQuota,
  };
}

module.exports = {
  createModelRouter,
};
