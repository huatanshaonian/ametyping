'use strict';
const crypto = require('crypto');
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v, max = 120) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
const hash = v => crypto.createHash('sha256').update(v).digest('hex').slice(0, 24);
const stamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
const mask = v => str(v).replace(/([^@\s]{1,2})[^@\s]*@([^\s]+)/g, '$1***@$2');
// Some API providers identify an account with a key, rather than an email.
// Such identifiers are hashed before the authenticated browser receives them.
const accountLabel = v => !v ? '' : /^[^@\s]+@[^@\s]+$/.test(str(v)) ? mask(v) : '账号 ' + hash(String(v)).slice(0, 6);
function balance(v) {
  const m = typeof v === 'string' && /^([¥￥$€])\s*(\d+(?:\.\d+)?)$/.exec(v);
  return m ? { amount: Number(m[2]), currency: { '¥': 'CNY', '￥': 'CNY', '$': 'USD', '€': 'EUR' }[m[1]] } : null;
}
function metrics(r) {
  if (!r) return null;
  const keys = ['calls', 'errors', 'input', 'output', 'cache_read', 'cache_write', 'cache_unknown', 'cache_unknown_calls', 'reasoning', 'cost', 'unpriced'];
  return Object.fromEntries(keys.map(k => [k, num(r[k])]));
}
function catalog(raw) {
  return (Array.isArray(raw?.data) ? raw.data : []).filter(m => typeof m?.id === 'string' && m.id.length <= 160).map(m => ({
    id: m.id, name: str(m.magpie_label || m.display_name || m.id), provider: str(m.owned_by),
    efforts: (m.reasoning_levels || []).filter(x => /^[a-z]{2,10}$/.test(x)),
    nativeMessages: (m.native_endpoints || []).includes('/v1/messages') || /claude|group\/opus/i.test(m.id),
    context: num(m.context_window || m.context_length), output: num(m.max_output_tokens),
  }));
}
function snapshot(quotas, usage, period, updatedAt) {
  const rows = Array.isArray(usage?.accounts) ? usage.accounts : [];
  const matched = new Set();
  const records = Array.isArray(quotas?.data) ? quotas.data : [];
  const parentOf = child => child?.from && child.kind === 'plan' && /\/~keys$/.test(child.provider || '')
    ? records.find(p => p.provider === child.provider.slice(0, -6) && p.from && p.from === child.from) : null;
  const windows = ws => (ws || []).map(w => ({ name: str(w.name), pool: str(w.pool), used: num(w.used), remaining: num(w.remaining), amount: num(w.amount), limit: num(w.limit), unit: str(w.unit, 24), display: str(w.display), resetsAt: stamp(w.resetsAt), unlimited: w.unlimited === true }));
  const accounts = records.filter(q => !parentOf(q)).map((q, index) => {
    const provider = str(q.provider), user = str(q.user), plan = str(q.plan);
    // Match only explicit identities. Never attribute a provider's total to
    // every account, or guess an account solely from its ordering/plan.
    const matches = rows.filter(r => r.provider === provider && user && (r.account === user || r.name === user || r.sub === user));
    const detail = matches.length === 1 ? metrics(matches[0]) : null;
    if (matches.length === 1) matched.add(matches[0]);
    // A remote provider's /~keys card describes this connection's gateway-key
    // budget, not another upstream subscription/account. Keep both scopes in
    // one source card without adding their usage or calling the upstream unlimited.
    const connections = records.filter(child => parentOf(child) === q).map(child => ({
      id: hash(`${child.provider}|${child.user || ''}`), account: accountLabel(child.user), readAt: stamp(child.readAt), windows: windows(child.windows),
    }));
    return {
      id: hash(`${provider}|${q.kind || ''}|${user || index}|${plan}`), provider,
      name: q.from ? `${provider === 'gcp' ? 'GCP' : provider} · Remote Magpie` : mask(q.name || provider), account: accountLabel(user) || `来源 ${index + 1}`, plan, kind: str(q.kind),
      status: q.error ? connections.length ? 'partial' : 'error' : (q.windows || []).length || balance(q.balance) ? 'ok' : 'unknown',
      quotaStatus: q.error ? /nothing read on that magpie yet/i.test(q.error) ? 'unread' : 'error' : 'reported',
      connectionLimits: connections,
      balance: balance(q.balance),
      readAt: stamp(q.readAt), lastServedAt: stamp(q.lastServedAt), remote: !!q.from,
      windows: windows(q.windows),
      usage: detail, usageMatched: !!detail,
    };
  });
  for (const r of rows.filter(r => !matched.has(r))) accounts.push({
    id: hash(`${r.provider}|usage|${r.id || r.account || r.name}`), provider: str(r.provider),
    name: str(r.provider), account: accountLabel(r.account || r.name) || '调用账号', plan: '', kind: 'usage',
    status: 'unknown', readAt: null, lastServedAt: null, windows: [], usage: metrics(r), usageMatched: true,
  });
  return { period, updatedAt, since: stamp(usage?.since), accounts, totals: metrics(usage),
    providers: (Array.isArray(usage?.models) ? usage.models : []).reduce((all, r) => {
      const id = str(r.provider), prior = all.find(x => x.provider === id);
      if (prior) for (const [k, value] of Object.entries(metrics(r))) prior.usage[k] = prior.usage[k] === null || value === null ? null : prior.usage[k] + value;
      else all.push({ provider: id, usage: metrics(r) });
      return all;
    }, []),
  };
}
module.exports = { metrics, catalog, snapshot };
