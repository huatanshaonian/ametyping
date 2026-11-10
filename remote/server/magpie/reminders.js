// Shared, side-effect-free decision logic. The chosen UI/worker owns delivery
// and persistence; merely importing this file does not start any monitoring.
const { createHash } = require("node:crypto");

const MINUTE = 60000, HOUR = 60 * MINUTE;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const date = (v) => typeof v === "string" ? Date.parse(v) : NaN;
const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 24);
function periodOf(window) {
  if (!window || typeof window !== "object") return;
  const name = window.name ?? "";
  if (!/claude/i.test(name) && !/claude/i.test(window.pool ?? "")) return;
  if (/7\s*days|7天|week/i.test(name)) return "week";
  if (/5\s*hours|5小时/i.test(name)) return "5h";
}
function planReminders(quotas, saved = {}, now = Date.now()) {
  const state = structuredClone(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {});
  const pending = [];
  for (const [index, account] of (Array.isArray(quotas?.data) ? quotas.data : []).entries()) {
    if (account?.provider !== "antigravity" || account.error) continue;
    const readAt = date(account.readAt);
    // Expiring allowance is only useful when the source is recent and the
    // actual account has known usable allowance in both reported windows.
    if (!Number.isFinite(readAt) || now - readAt > 20 * MINUTE || readAt > now + 2 * MINUTE) continue;
    const windows = (Array.isArray(account.windows) ? account.windows : [])
      .map((w) => ({ ...w, period: periodOf(w) })).filter((w) => w.period);
    const usable = (w) => finite(w.remaining) && w.remaining > 0 && Number.isFinite(date(w.resetsAt)) && date(w.resetsAt) > now;
    if (!windows.some((w) => w.period === "week" && usable(w)) || !windows.some((w) => w.period === "5h" && usable(w))) continue;
    const accountId = digest(`antigravity|${account.user || "account-" + index}|${account.plan || ""}`);
    for (const window of windows) {
      if (!usable(window)) continue;
      const resetAt = date(window.resetsAt), left = resetAt - now;
      const thresholds = window.period === "week" ? [24 * HOUR, HOUR] : [30 * MINUTE];
      const due = thresholds.filter((lead) => left <= lead).at(-1);
      if (due === undefined) continue;
      const key = `${accountId}:${window.period}`;
      let mark = state[key];
      const span = window.period === "week" ? 7 * 24 * HOUR : 5 * HOUR;
      // A vendor adjusting a future reset clock is still the same cycle.
      // Only a reset that has actually passed can advance to a fresh cycle.
      if (!mark || !Array.isArray(mark.delivered) || (now >= mark.resetAt && resetAt > mark.resetAt + span / 2)) {
        mark = state[key] = { resetAt, delivered: [] };
      }
      if (mark.delivered.includes(due)) continue;
      // Only the closest pending threshold is offered after a cold start;
      // successful delivery marks all already-crossed thresholds together.
      const crossed = thresholds.filter((lead) => left <= lead);
      const hours = Math.ceil(left / HOUR), minutes = Math.ceil(left / MINUTE);
      const time = left >= HOUR ? `${hours}小时` : `${minutes}分钟`;
      const label = window.period === "week" ? "周额度" : "5小时额度";
      pending.push({ id: digest(`${key}|${mark.resetAt}|${due}`), key, crossed,
        resetAt, cycleResetAt: mark.resetAt, threshold: due, period: window.period, remaining: window.remaining,
        title: `AGY Claude ${label}即将重置`,
        body: `${label}将在 ${time}后重置。`,
      });
    }
  }
  return { state, pending };
}
function delivered(state, reminder, now = Date.now()) {
  const mark = state[reminder.key];
  if (!mark || mark.resetAt !== reminder.cycleResetAt) return state;
  mark.delivered = [...new Set([...mark.delivered, ...reminder.crossed])];
  mark.deliveredAt = now;
  return state;
}

module.exports = { planReminders, delivered };
