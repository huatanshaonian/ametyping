'use strict';
const fs = require('fs');
const path = require('path');
const { createClient } = require('./client');
const { catalog, snapshot } = require('./normalize');
const { modelsFor, runMagpie } = require('./ai');
const { planReminders, delivered } = require('./reminders');

// Read-only gateway monitoring. No account/configuration mutation endpoints.
function createMagpie({ config = {}, dataDir, onChange = () => {}, onNotice = () => {}, client = createClient(config), now = Date.now, autoStart = true }) {
  const file = path.join(dataDir, 'magpie-monitor.json');
  let state = {}, notices = [], models = [], quotas = null, quotaAt = null, errors = {}, busy = null, stopped = false;
  const usage = new Map();
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); state = s.state || {}; notices = Array.isArray(s.notices) ? s.notices : []; } catch {}
  function activeNotices() { return notices.filter(n => n.resetAt > now() && n.expiresAt > now()); }
  function persist() {
    notices = activeNotices().slice(-100);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ state, notices }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  async function readUsage(period) {
    try { const raw = await client.request('magpie/usage?period=' + period); usage.set(period, { raw, at: new Date(now()).toISOString() }); delete errors[period]; }
    catch (e) { errors[period] = e.status ? 'HTTP ' + e.status : '用量暂不可读'; }
  }
  async function poll() {
    if (!client.enabled || stopped) return;
    if (busy) return busy;
    busy = (async () => {
      await Promise.all([
        client.request('models').then(r => { models = catalog(r); delete errors.models; }, () => { errors.models = '模型目录暂不可读'; }),
        client.request('magpie/quotas').then(r => { quotas = r; quotaAt = new Date(now()).toISOString(); delete errors.quotas; }, () => { errors.quotas = '额度暂不可读'; }),
        ...['today', '7d', '30d'].map(readUsage),
      ]);
      if (stopped) return;
      if (quotas && !errors.quotas) {
        const p = planReminders(quotas, state, now()); state = p.state;
        for (const n of p.pending) {
          notices = notices.filter(old => old.group !== n.key);
          notices.push({ id: n.id, group: n.key, title: n.title, body: n.body, resetAt: n.resetAt, createdAt: now(), expiresAt: n.resetAt });
          delivered(state, n, now());
        }
      }
      try { persist(); for (const n of activeNotices()) onNotice(n); } catch { errors.notifications = '提醒状态暂不可保存'; }
      onChange();
    })().finally(() => { busy = null; });
    return busy;
  }
  function status(period = 'today') {
    if (!['today', '7d', '30d'].includes(period)) period = 'today';
    const u = usage.get(period);
    return { enabled: client.enabled, ...snapshot(quotas, u?.raw, period, u?.at || null), quotaAt,
      errors: { ...errors }, stale: !quotaAt || now() - Date.parse(quotaAt) > 20 * 60000, pollMs: 5 * 60000,
      models: models.map(({ id, name, provider }) => ({ id, name, provider })) };
  }
  // the catalogue as the OpenCode guide's generator needs it (read-only; no key or account leaves the server)
  function opencodeModels() {
    return { enabled: client.enabled, error: errors.models || null,
      models: models.map(({ id, name, provider, efforts, nativeMessages, context, input, output, modalities, tools, group }) =>
        ({ id, name, provider, efforts, anthropic: nativeMessages, context, input, output, modalities, tools, group })) };
  }
  let timer;
  if (autoStart && client.enabled) { timer = setInterval(poll, 5 * 60000); timer.unref(); setImmediate(poll); }
  return { status, opencodeModels, poll, models: () => modelsFor(models), activeNotices,
    run: opts => runMagpie({ client, catalog: models, ...opts }),
    stop() { stopped = true; clearInterval(timer); } };
}
module.exports = { createMagpie };
