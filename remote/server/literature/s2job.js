// Semantic Scholar on its own clock. Without a key its public quota is busy more often than not, and the day's push used
// to lose its searches there whenever the one moment it asked was a busy one. Now the day's Semantic Scholar queries are
// a small list of their own: tried when the push runs and then every few hours until each has answered once; what they
// bring waits with the other candidates not scored yet (feed.js: the inbox) for the next scoring.
//   state(): the part of feed.json kept for this  { date, done: [task ids], at, found: { way: n }, error }
'use strict';

const HOUR = 3600e3;

// tasks(): the day's queries [{ id, name (the way of finding, as the run's log counts it), run: async () => papers }]
// add(name, papers): hand over what a query brought
function createS2Job({ s2, state, save, tasks, add, log = () => {}, now = () => Date.now(), gapMs = 3 * HOUR }) {
  let running = null;
  async function attempt(date) {
    const s = state();
    if (s.date !== date) Object.assign(s, { date, done: [], error: '' });
    s.done = s.done || []; s.found = s.found || {};
    const todo = tasks().filter((t) => !s.done.includes(t.id));
    if (!todo.length) return;
    s.at = now(); s.error = '';
    for (const t of todo) {
      try {
        const r = (await t.run()) || [];
        add(t.name, r); s.done.push(t.id); s.found[t.name] = (s.found[t.name] || 0) + r.length;
      } catch (e) {
        s.error = e.message;
        if (e.status === 429) break;                           // (busy: the others would be told the same)
      }
    }
    if (s.error) log(`文献：Semantic Scholar 这次没查成（${s.error}），过 ${Math.round(gapMs / HOUR)} 小时再试`);
    save();
  }
  // force: now, whenever it was last tried (the push itself); otherwise only when the gap has passed
  function tick(date, force = false) {
    if (!s2 || !s2.enabled()) return Promise.resolve();
    if (running) return running;
    if (!force && now() - (state().at || 0) < gapMs) return Promise.resolve();
    running = attempt(date).catch((e) => log('文献：Semantic Scholar 出错：' + e.message)).finally(() => { running = null; });
    return running;
  }
  // what the queries brought since this was last asked (the run's log counts them), and what is still owed today
  function take() { const s = state(), f = s.found || {}; s.found = {}; return f; }
  const pending = () => { const s = state(); return s.error ? s.error : ''; };
  return { tick, take, pending };
}

module.exports = { createS2Job };
