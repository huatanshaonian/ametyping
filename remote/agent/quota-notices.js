'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
function cleanNotice(n, now = Date.now()) {
  if (!n || !/^[a-f0-9]{24}$/.test(n.id) || !/^AGY Claude (周额度|5小时额度)即将重置$/.test(n.title) ||
      !/^(周额度|5小时额度)将在 \d{1,4}(小时|分钟)后重置。$/.test(n.body) ||
      !Number.isFinite(n.resetAt) || !Number.isFinite(n.expiresAt) || !Number.isFinite(n.createdAt) ||
      n.resetAt <= now || n.expiresAt <= now || n.createdAt > now + 120000) return null;
  const left = n.resetAt - now, time = left >= 3600000 ? Math.ceil(left / 3600000) + '小时' : Math.ceil(left / 60000) + '分钟';
  const label = n.title.includes('周额度') ? '周额度' : '5小时额度';
  return { id: n.id, title: n.title, body: `${label}将在 ${time}后重置。`, resetAt: n.resetAt, expiresAt: Math.min(n.expiresAt, n.resetAt), createdAt: n.createdAt };
}
function createQuotaNotices({ deliver, file = path.join(os.homedir(), '.ametyping', 'quota-notices.json'), now = Date.now, autoStart = true }) {
  let items = [], busy = false;
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); items = (s.items || []).filter(n => cleanNotice(n, now())); } catch {}
  function save() {
    items = items.filter(n => cleanNotice(n, now())).slice(-100);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, updatedAt: now(), items }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  async function flush() {
    if (busy) return; busy = true;
    try {
      for (const n of items.filter(n => !n.petDeliveredAt && cleanNotice(n, now()))) {
        const result = await deliver(cleanNotice(n, now()));
        if (result?.ok) n.petDeliveredAt = now();
      }
      save();
    } catch {} finally { busy = false; }
  }
  function add(input) {
    const n = cleanNotice(input, now()); if (!n) return false;
    if (!items.some(i => i.id === n.id)) { items.push(n); save(); }
    void flush(); return true;
  }
  let timer;
  if (autoStart) { timer = setInterval(flush, 30000); timer.unref(); setImmediate(flush); }
  return { add, flush, stop() { clearInterval(timer); }, items: () => items.slice() };
}
module.exports = { cleanNotice, createQuotaNotices };
