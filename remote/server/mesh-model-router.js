// AmeMesh Model Pool Router: configurable capability pools, Magpie live quota evaluation,
// and passive cooldown circuit breaker with deterministic fallback selection.
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_POOLS = {
  'fast-coder': [
    { harness: 'claude', model: 'sonnet', magpieProvider: 'anthropic', quirks: '' },
    { harness: 'agy', model: 'claude-sonnet-5-5-medium', quirks: '' },
    { harness: 'agy', model: 'gemini-4-hydrogen-medium', quirks: '' },
    { harness: 'opencode', model: 'gpt-6.2-sol', magpieProvider: 'openai', quirks: '' },
  ],
  flagship: [
    { harness: 'claude', model: 'opus', magpieProvider: 'anthropic', quirks: '' },
    { harness: 'agy', model: 'claude-opus-5-5-medium', quirks: '' },
    { harness: 'agy', model: 'gemini-4-neon-medium', quirks: '' },
    { harness: 'opencode', model: 'gpt-6.2-astra', magpieProvider: 'openai', quirks: '' },
  ],
  'heavy-reasoner': [
    { harness: 'agy', model: 'gemini-4-carbon-medium', quirks: '' },
    { harness: 'agy', model: 'claude-opus-5-5-high', quirks: '' },
    { harness: 'claude', model: 'opus', magpieProvider: 'anthropic', quirks: '' },
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

function createModelRouter({ dataDir, getMagpie = () => null, now = () => Date.now() }) {
  const poolsFile = path.join(dataDir, 'mesh-pools.json');
  const cooldowns = new Map(); // "harness|model" -> { status: 'cooldown', harness, model, reason, resetAt, updatedAt }

  function ensurePoolsFile() {
    if (!fs.existsSync(poolsFile)) {
      try {
        fs.mkdirSync(path.dirname(poolsFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(poolsFile, JSON.stringify(DEFAULT_POOLS, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      } catch {}
    }
  }

  function loadPools() {
    ensurePoolsFile();
    try {
      const raw = JSON.parse(fs.readFileSync(poolsFile, 'utf8'));
      const norm = normalizePools(raw);
      if (norm && Object.keys(norm).length > 0) return norm;
    } catch {}
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
      fs.mkdirSync(path.dirname(poolsFile), { recursive: true, mode: 0o700 });
      const tmpFile = poolsFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(norm, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpFile, poolsFile);
      return { ok: true, pools: norm };
    } catch (e) {
      return { ok: false, msg: `保存模型池配置失败：${e.message}` };
    }
  }

  const LOW_QUOTA_THRESHOLD = 0.10; // Remaining < 10% -> deprioritize in favor of healthier candidates

  function evaluateMagpie(candidate, magpieStatus, lowThreshold = LOW_QUOTA_THRESHOLD) {
    const mp = String((candidate && candidate.magpieProvider) || '').trim().toLowerCase();
    if (!mp || !magpieStatus || !Array.isArray(magpieStatus.accounts)) {
      return { matched: false, exhausted: false, lowQuota: false, minRatio: null, magpieInfo: '', resetAt: null };
    }
    const matched = magpieStatus.accounts.filter((a) => {
      if (!a || typeof a !== 'object') return false;
      return String(a.provider || '').toLowerCase() === mp || String(a.name || '').toLowerCase() === mp;
    });
    if (!matched.length) {
      return { matched: false, exhausted: false, lowQuota: false, minRatio: null, magpieInfo: '', resetAt: null };
    }

    let resetAt = null;
    const finiteWindowsOf = (acct) => (Array.isArray(acct.windows) ? acct.windows : []).filter(
      (w) => w && w.unlimited !== true && typeof w.remaining === 'number' && Number.isFinite(w.remaining)
    );
    const isAcctExhausted = (acct) => {
      if (acct.status === 'error') return true;
      const finiteWindows = finiteWindowsOf(acct);
      if (finiteWindows.length > 0 && finiteWindows.every((w) => w.remaining <= 0)) {
        for (const w of finiteWindows) {
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
        minRatio: 0,
        magpieInfo: matched.every((a) => a.status === 'error') ? 'Magpie 账号状态异常' : 'Magpie 额度已耗尽',
        resetAt,
      };
    }

    // Compute remaining ratio across finite windows with positive limits
    let bestAcctMinRatio = null;
    for (const a of healthyAccounts) {
      const ratios = finiteWindowsOf(a)
        .filter((w) => typeof w.limit === 'number' && w.limit > 0)
        .map((w) => Math.max(0, Math.min(1, w.remaining / w.limit)));
      if (ratios.length) {
        const acctMin = Math.min(...ratios);
        if (bestAcctMinRatio === null || acctMin > bestAcctMinRatio) bestAcctMinRatio = acctMin;
      }
    }
    const lowQuota = bestAcctMinRatio !== null && bestAcctMinRatio < lowThreshold;

    // Build concise remaining summary from the first healthy account
    let info = '';
    for (const a of healthyAccounts) {
      const wins = Array.isArray(a.windows) ? a.windows : [];
      const firstWin = wins.find((w) => w && w.display) || wins.find((w) => w && typeof w.remaining === 'number');
      if (firstWin) {
        info = firstWin.display || `${firstWin.remaining}${firstWin.unit ? ' ' + firstWin.unit : ''}`;
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
    }
    return { matched: true, exhausted: false, lowQuota, minRatio: bestAcctMinRatio, magpieInfo: info, resetAt: null };
  }

  function evaluateCandidate(candidate, magpieStatus = null) {
    const curTime = now();
    const key = candidateKey(candidate.harness, candidate.model);
    let cd = cooldowns.get(key) || null;
    if (cd && cd.resetAt <= curTime) {
      cooldowns.delete(key);
      cd = null;
    }

    const mpStatus = magpieStatus !== null ? magpieStatus : (typeof getMagpie === 'function' ? getMagpie()?.status?.() : null);
    const mpEval = evaluateMagpie(candidate, mpStatus);

    if (cd) {
      return {
        status: 'cooldown',
        healthy: false,
        lowQuota: false,
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
        minRatio: mpEval.minRatio,
        reason: '剩余额度不足 10%，优先避让',
        resetAt: null,
        magpieInfo: mpEval.magpieInfo,
      };
    }
    return {
      status: 'healthy',
      healthy: true,
      lowQuota: false,
      minRatio: mpEval.minRatio,
      reason: '',
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

  function selectCandidate(poolName, { exclude = [], activeCounts = null, availableHarnesses = null } = {}) {
    const pools = loadPools();
    const list = pools[poolName];
    if (!Array.isArray(list) || !list.length) {
      return { ok: false, exhausted: true, pool: poolName, msg: `模型池「${poolName}」未配置或为空` };
    }
    const excludeSet = new Set((Array.isArray(exclude) ? exclude : []).map((x) => String(x)));
    const availSet = Array.isArray(availableHarnesses) && availableHarnesses.length
      ? new Set(availableHarnesses.map((x) => String(x).toLowerCase()))
      : null;
    const mpStatus = typeof getMagpie === 'function' ? getMagpie()?.status?.() : null;
    const byHarness = (activeCounts && activeCounts.byHarness) || {};
    const byCandidate = (activeCounts && activeCounts.byCandidate) || {};

    const viable = [];
    list.forEach((cand, idx) => {
      const key = candidateKey(cand.harness, cand.model);
      if (excludeSet.has(key) || excludeSet.has(cand.harness)) return;
      if (availSet && !availSet.has(String(cand.harness || '').toLowerCase())) return;
      const evalRes = evaluateCandidate(cand, mpStatus);
      if (!evalRes.healthy) return;
      viable.push({
        cand,
        evalRes,
        idx,
        lowTier: evalRes.lowQuota ? 1 : 0,
        harnessLoad: byHarness[cand.harness] || 0,
        candLoad: byCandidate[key] || 0,
      });
    });

    if (viable.length) {
      // Tier 1: non-low-quota (>=10%) always before low-quota (<10%)
      // Tier 2: spread load across harnesses first, then specific candidate, then configured priority
      viable.sort((a, b) =>
        (a.lowTier - b.lowTier) ||
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
    const mpStatus = typeof getMagpie === 'function' ? getMagpie()?.status?.() : null;
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

  return {
    getPools,
    savePools,
    getPoolsStatus,
    getPoolsSummary,
    markCooldown,
    resetCooldown,
    selectCandidate,
  };
}

module.exports = {
  DEFAULT_POOLS,
  createModelRouter,
};
