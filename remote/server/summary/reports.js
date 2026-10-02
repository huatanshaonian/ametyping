// Daily reports on disk, next to the conversation store:
//   <dir>/<YYYY-MM-DD>.json   one report (the day it is filed under: the day that ended at 4:30 the next morning)
//   <dir>/draft.json          the latest 「总结到现在」 (manual, does not move the schedule on)
//   <dir>/week-<Monday>.json  the weekly report of Monday..Sunday (summary/weekly.js)
//   <dir>/state.json          { lastTo }: where the last scheduled report ended -- the next one starts there
//   <dir>/cache/              summaries of long sessions, so a retry does not ask again
'use strict';
const fs = require('fs');
const path = require('path');

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function createReports(dir) {
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true, mode: 0o700 });
  const file = (name) => path.join(dir, name + '.json');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };

  const WEEK = /^week-\d{4}-\d{2}-\d{2}$/;
  const get = (date) => (date === 'draft' || DAY.test(String(date)) || WEEK.test(String(date))) ? readJson(file(date), null) : null;
  // weekly reports: week-<Monday>.json
  const getWeek = (start) => get('week-' + start);
  const hasWeek = (start) => DAY.test(String(start)) && fs.existsSync(file('week-' + start));
  function saveWeek(w) { if (!DAY.test(w.start)) throw new Error('bad week'); writeJson(file('week-' + w.start), w); }
  function listWeeks() {
    let names = []; try { names = fs.readdirSync(dir); } catch {}
    return names.filter((n) => WEEK.test(n.slice(0, -5)) && n.endsWith('.json')).map((n) => n.slice(5, -5)).sort().reverse()
      .map((start) => { const w = getWeek(start) || {}; return { start, end: w.end, headline: w.headline || '', minutes: w.stats ? w.stats.minutes : 0 }; });
  }
  function save(r) {
    if (!r.draft && !DAY.test(r.date)) throw new Error('bad report date');
    writeJson(file(r.draft ? 'draft' : r.date), r);
  }
  // newest first: what the list shows
  function list() {
    let names = []; try { names = fs.readdirSync(dir); } catch {}
    return names.filter((n) => DAY.test(n.slice(0, -5)) && n.endsWith('.json')).map((n) => n.slice(0, -5)).sort().reverse()
      .map((date) => { const r = get(date) || {}; return { date, headline: r.headline || '', from: r.from, to: r.to, minutes: r.stats ? r.stats.minutes : 0, brief: !!r.brief }; });
  }
  // the report the next one continues from (its open items carry over); backfilled ones (brief) do not count --
  // whether their loose ends were done later cannot be told
  function latest() {
    for (const it of list()) { const r = get(it.date); if (r && !r.brief) return r; }
    return null;
  }
  // one conversation's notes, day by day (newest first): from every daily report it appears in, and the latest
  // 「总结到现在」 when that covers time after them. Reports are read once and kept until their file changes.
  const parsed = new Map();                          // name -> { mtime, sessions }
  function sessionsOf(name) {
    let st; try { st = fs.statSync(file(name)); } catch { parsed.delete(name); return []; }
    const c = parsed.get(name);
    if (c && c.mtime === st.mtimeMs) return c.sessions;
    const r = readJson(file(name), {});
    const v = { mtime: st.mtimeMs, sessions: (r.sessions || []).map((s) => ({ ...s, date: r.date, draft: !!r.draft, brief: !!r.brief, to: r.to })) };
    parsed.set(name, v);
    return v.sessions;
  }
  function sessionNotes(machine, id) {
    const out = [];
    let names = []; try { names = fs.readdirSync(dir); } catch {}
    const days = names.filter((n) => DAY.test(n.slice(0, -5)) && n.endsWith('.json')).map((n) => n.slice(0, -5)).sort().reverse();
    for (const date of days) for (const s of sessionsOf(date)) if (s.machine === machine && s.id === id) out.push(s);
    const d = sessionsOf('draft').find((s) => s.machine === machine && s.id === id);
    if (d && (!out.length || d.to > out[0].to)) out.unshift(d);
    return out.map((s) => ({ date: s.date, draft: s.draft, brief: s.brief, minutes: s.minutes, title: s.title, project: s.project, note: s.note || null }));
  }
  // every daily report's date and file time (what the search index checks; no report is read)
  function versions() {
    let names = []; try { names = fs.readdirSync(dir); } catch {}
    return names.filter((n) => DAY.test(n.slice(0, -5)) && n.endsWith('.json')).map((n) => { let m = 0; try { m = fs.statSync(path.join(dir, n)).mtimeMs; } catch {} return { date: n.slice(0, -5), mtime: m }; });
  }
  const has = (date) => DAY.test(String(date)) && fs.existsSync(file(date));

  const state = () => readJson(path.join(dir, 'state.json'), {});
  const setState = (patch) => writeJson(path.join(dir, 'state.json'), { ...state(), ...patch });

  const cacheFile = (key) => path.join(dir, 'cache', key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 150) + '.json');
  const cacheGet = (key) => readJson(cacheFile(key), null);
  const cachePut = (key, v) => writeJson(cacheFile(key), v);

  return { get, save, list, latest, has, sessionNotes, versions, getWeek, hasWeek, saveWeek, listWeeks, state, setState, cacheGet, cachePut };
}

module.exports = { createReports };
