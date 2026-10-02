// Search over what the NAS keeps: daily reports, the artifact index, and every stored conversation (data/<day>/
// <machine>/<session>.jsonl). Every word of the query must occur (case-insensitive) -- in a report, or somewhere in
// a conversation (a record holding them all ranks that conversation first; then newest first). Conversations are
// looked up in the SQLite index (server/search-index.js) once it is built; until then, or if it fails, the files are
// scanned (read when they change, kept in memory as lines of searchable text).
'use strict';
const fs = require('fs');
const path = require('path');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SNIP = 60;

function snippet(text, terms) {
  const low = text.toLowerCase();
  let i = -1; for (const t of terms) { i = low.indexOf(t); if (i >= 0) break; }
  const s = Math.max(0, i - SNIP), e = Math.min(text.length, i + SNIP * 2);
  return (s > 0 ? '…' : '') + text.slice(s, e).replace(/\s+/g, ' ') + (e < text.length ? '…' : '');
}
const matches = (low, terms) => terms.every((t) => low.includes(t));

// deps: storeDir (data/), reports (reports.js), artifacts (server/artifacts.js or null), sessions() -> store.sessions()
// notes (server/notes.js, optional): the notepad's notes are searched too
// index (server/search-index.js, optional): conversations are looked up there once it is ready; scanned until then
function createSearch({ storeDir, reports, artifacts, notes = null, sessions, index = null }) {
  const cache = new Map();                            // file -> { key, lines: [{ t, role, text, low }] }

  // a stored conversation file as searchable lines (what was said, tool lines, full commands and paths)
  function linesOf(file) {
    let st; try { st = fs.statSync(file); } catch { return []; }
    const key = st.size + ':' + st.mtimeMs;
    const c = cache.get(file);
    if (c && c.key === key) return c.lines;
    const lines = [];
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (r.role === 'title' || r.role === 'mode' || r.role === 'ctx') continue;
      const parts = [r.text || '', ...(r.items || [])];
      if (r.x) parts.push(r.x.cmd || '', ...(r.x.p || []), ...((r.x.todos || []).map((t) => t[0])), r.x.plan ? r.x.plan.slice(0, 4000) : '');
      const text = parts.filter(Boolean).join(' · ');
      if (text) lines.push({ t: r.t, role: r.role, text, low: text.toLowerCase() });
    }
    cache.set(file, { key, lines });
    return lines;
  }

  function reportText(r) {
    const p = (r.projects || []).map((x) => [x.name, x.summary, ...(x.done || []), ...(x.decisions || []), ...(x.unfinished || [])].join(' '));
    return [r.headline, ...(r.keywords || []), ...p, ...(r.open || []).map((o) => o.text), ...(r.plans || []).map((x) => x.title),
      ...(r.artifacts || []).map((a) => `${a.path} ${a.note || ''}`)].filter(Boolean).join(' · ');
  }

  // q -> { reports: [{ date, headline, snippet }], artifacts: [index entries + snippet], sessions: [{ machine, id, title, hits: [{ t, role, snippet }] }] }
  // scope 'sessions': conversations only (the dashboard list's search)
  function search(q, { maxSessions = 30, hitsPerSession = 3, scope = 'all' } = {}) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const out = { reports: [], artifacts: [], sessions: [], notes: [] };
    if (!terms.length) return out;
    if (scope !== 'sessions') everythingElse(terms, out);
    sessionsMatching(terms, out, maxSessions, hitsPerSession);
    return out;
  }
  function everythingElse(terms, out) {
    for (const it of reports.list()) {
      const r = reports.get(it.date); if (!r) continue;
      const text = reportText(r);
      if (matches(text.toLowerCase(), terms)) out.reports.push({ date: it.date, headline: r.headline || '', brief: !!r.brief, snippet: snippet(text, terms) });
    }
    for (const e of notes ? notes.list() : []) {
      const n = notes.get(e.id); if (!n) continue;
      if (matches(n.text.toLowerCase(), terms)) out.notes.push({ id: e.id, title: e.title, updated: e.updated, snippet: snippet(n.text, terms) });
    }
    for (const a of artifacts ? artifacts.list() : []) {
      const text = `${a.path} ${a.note || ''} ${a.machine}`;
      if (matches(text.toLowerCase(), terms)) out.artifacts.push({ ...a, snippet: snippet(text, terms) });
    }
    out.artifacts.sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
  }
  function sessionsMatching(terms, out, maxSessions, hitsPerSession) {
    // conversations: newest day first; a session found on several days is one result
    // stored file names are the session ids made safe (store.js): map them back to the sessions
    const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || '_';
    const titles = new Map();
    for (const [m, list] of Object.entries(sessions())) for (const s of list) titles.set(safe(m) + '|' + safe(s.id), { ...s, machine: m });
    if (index && index.ready()) {
      let found = null;
      try { found = index.find(terms, { maxSessions, hitsPerSession }); } catch { found = null; }   // (a broken index: scan)
      if (found) {
        out.sessions = found.map((f) => {
          const meta = titles.get(f.machine + '|' + f.session) || {};
          return { machine: meta.machine || f.machine, id: meta.id || f.session, title: meta.title || meta.project || f.session.slice(0, 8), project: meta.project || '', last: f.last,
            hits: f.hits.map((h) => ({ t: h.t, role: h.role, snippet: snippet(h.text, terms) })) };
        });
        return;
      }
    }
    const bySession = new Map();
    let days = []; try { days = fs.readdirSync(storeDir).filter((d) => DAY.test(d)).sort().reverse(); } catch {}
    for (const day of days) {
      let machines = []; try { machines = fs.readdirSync(path.join(storeDir, day)); } catch { continue; }
      for (const m of machines) {
        let files = []; try { files = fs.readdirSync(path.join(storeDir, day, m)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
        for (const f of files) {
          const id = f.slice(0, -6), key = m + '|' + id;
          for (const l of linesOf(path.join(storeDir, day, m, f))) {
            const has = terms.filter((t) => l.low.includes(t));
            if (!has.length) continue;
            let s = bySession.get(key);
            if (!s) {
              const meta = titles.get(key) || {};
              s = { machine: meta.machine || m, id: meta.id || id, title: meta.title || meta.project || id.slice(0, 8), project: meta.project || '', last: 0, seen: new Set(), full: [], first: [] };
              bySession.set(key, s);
            }
            for (const t of has) s.seen.add(t);
            s.last = Math.max(s.last, l.t || 0);
            if (has.length === terms.length) s.full.push(l); else if (has.includes(terms[0])) s.first.push(l);
          }
        }
      }
    }
    // every term somewhere in the session (as the index does: search-index.js); a record holding them all ranks first
    const newest = (a, b) => (b.t || 0) - (a.t || 0);
    out.sessions = [...bySession.values()].filter((s) => s.seen.size === terms.length)
      .sort((a, b) => (!!b.full.length - !!a.full.length) || (b.last - a.last)).slice(0, maxSessions)
      .map(({ seen, full, first, ...s }) => ({ ...s, hits: (full.length ? full : first).sort(newest).slice(0, hitsPerSession)
        .map((l) => ({ t: l.t, role: l.role, snippet: snippet(l.text, terms) })) }));
  }
  return { search };
}

module.exports = { createSearch };
