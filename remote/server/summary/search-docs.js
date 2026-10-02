// Search over the NAS's documents -- daily reports, notes, artifacts, mail -- for summary/search.js. Every word of the
// query must occur in the one document; newest first, up to LIMIT of each kind.
// With the SQLite index (server/search-index/docs.js) they are brought up to date just before each search (only what
// changed: report files by time, notes by edit time, artifacts by their entry, mail files by size) and looked up
// there; without it, or if it fails, they are scanned as before.
'use strict';
const fs = require('fs');
const path = require('path');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LIMIT = 50;

function reportText(r) {
  const p = (r.projects || []).map((x) => [x.name, x.summary, ...(x.done || []), ...(x.decisions || []), ...(x.unfinished || [])].join(' '));
  const notes = (r.sessions || []).map((s) => s.note ? [s.note.did, ...(s.note.open || []), ...(s.note.ideas || [])].join(' ') : '');
  return [r.headline, ...(r.keywords || []), ...p, ...(r.open || []).map((o) => o.text), ...(r.plans || []).map((x) => x.title),
    ...(r.artifacts || []).map((a) => `${a.path} ${a.note || ''}`), ...notes].filter(Boolean).join(' · ');
}
const artText = (a) => `${a.path} ${a.note || ''} ${a.machine}`;
// (the text first: a passage is shown from it when a word is there; the subject and sender are shown beside it anyway)
const mailText = (r) => [r.text, r.subject, r.from && r.from.name, r.from && r.from.address, ...((r.to || []).map((x) => x.name || x.address)),
  ...((r.att || []).map((x) => x.name))].filter(Boolean).join('\n');

// deps: storeDir (data/), reports, notes, artifacts, mail() -> the mail store (or null), index (or null),
// snippet(text, terms), matches(low, terms)
function createDocSearch({ storeDir, reports, notes = null, artifacts = null, mail = () => null, index = null, snippet, matches }) {
  const mailRoot = path.join(storeDir, 'mail');
  function mailFiles() {
    const out = [];
    let accs = []; try { accs = fs.readdirSync(mailRoot); } catch {}
    for (const acc of accs) {
      let fs2 = []; try { fs2 = fs.readdirSync(path.join(mailRoot, acc)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)); } catch { continue; }
      for (const f of fs2) out.push({ abs: path.join(mailRoot, acc, f), rel: `mail/${acc}/${f}` });
    }
    return out;
  }
  // the index brought up to date with what is on disk now
  function sync(D) {
    D.sync('report', (reports.versions ? reports.versions() : []).map((v) => ({ ref: v.date, ver: v.mtime, t: Date.parse(v.date + 'T12:00:00') })),
      (date) => { const r = reports.get(date); return r ? reportText(r) : ''; });
    if (notes) D.sync('note', notes.list().map((e) => ({ ref: e.id, ver: e.updated, t: e.updated })),
      (id) => { const n = notes.get(id); return n ? n.text : ''; });
    if (artifacts) {
      const byRef = new Map(artifacts.list().map((a) => [a.machine + '|' + a.path, a]));
      D.sync('artifact', [...byRef].map(([ref, a]) => ({ ref, ver: [a.note, a.last, a.sha, a.size].join('|'), t: Date.parse(a.last || 0) || 0 })),
        (ref) => artText(byRef.get(ref) || {}));
    }
    D.tail('mail', mailFiles(), (r) => (r && r.key ? { ref: r.key, t: r.date, text: mailText(r) } : null));
  }

  // results as the page shows them
  const reportOut = (date, text, terms) => { const r = reports.get(date) || {}; return { date, headline: r.headline || '', brief: !!r.brief, snippet: snippet(text, terms) }; };
  const noteOut = (e, text, terms) => ({ id: e.id, title: e.title, updated: e.updated, snippet: snippet(text, terms) });
  const mailOut = (h, text, terms) => ({ key: h.key, acc: h.acc, subject: h.subject || '（无主题）', from: h.from || {}, date: h.date, snippet: snippet(text, terms) });
  // the same notice in two mailboxes (mail/store.js's dup fingerprint): one result
  const oneOfEach = (list) => { const seen = new Set(); return list.filter((m) => { const k = m.dup || m.key; if (seen.has(k)) return false; seen.add(k); return true; }); };

  function viaIndex(terms, out) {
    const D = index.docs;
    sync(D);
    out.reports = D.find(terms, 'report', LIMIT).map((x) => reportOut(x.ref, x.text, terms));
    const noteById = new Map((notes ? notes.list() : []).map((e) => [e.id, e]));
    out.notes = D.find(terms, 'note', LIMIT).filter((x) => noteById.has(x.ref)).map((x) => noteOut(noteById.get(x.ref), x.text, terms));
    const artByRef = new Map((artifacts ? artifacts.list() : []).map((a) => [a.machine + '|' + a.path, a]));
    out.artifacts = D.find(terms, 'artifact', LIMIT).filter((x) => artByRef.has(x.ref)).map((x) => ({ ...artByRef.get(x.ref), snippet: snippet(x.text, terms) }));
    const M = mail();
    out.mail = M ? oneOfEach(D.find(terms, 'mail', LIMIT * 2).map((x) => ({ x, h: M.brief(x.ref) })).filter((y) => y.h)
      .map((y) => ({ ...mailOut(y.h, y.x.text, terms), dup: y.h.dup }))).slice(0, LIMIT).map(({ dup, ...m }) => m) : [];
  }

  function viaScan(terms, out) {
    for (const it of reports.list()) {
      const r = reports.get(it.date); if (!r) continue;
      const text = reportText(r);
      if (matches(text.toLowerCase(), terms)) out.reports.push(reportOut(it.date, text, terms));
    }
    for (const e of notes ? notes.list() : []) {
      const n = notes.get(e.id); if (!n) continue;
      if (matches(n.text.toLowerCase(), terms)) out.notes.push(noteOut(e, n.text, terms));
    }
    for (const a of artifacts ? artifacts.list() : []) {
      const text = artText(a);
      if (matches(text.toLowerCase(), terms)) out.artifacts.push({ ...a, snippet: snippet(text, terms) });
    }
    out.artifacts.sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
    // mail without the index: what is kept in memory (subject, sender, the start of the text)
    const M = mail();
    if (M) {
      out.mail = M.list({ limit: Infinity }).filter((h) => matches([h.subject, h.from && h.from.name, h.from && h.from.address, h.snippet].join(' ').toLowerCase(), terms))
        .slice(0, LIMIT).map((h) => mailOut(h, [h.subject, h.snippet].join(' · '), terms));
    }
    for (const k of ['reports', 'notes', 'artifacts']) out[k] = out[k].slice(0, LIMIT);
  }

  function search(terms, out) {
    out.mail = [];
    if (index) {
      try { viaIndex(terms, out); return; } catch { out.reports = []; out.notes = []; out.artifacts = []; out.mail = []; }   // (the index failing: scan)
    }
    viaScan(terms, out);
  }
  return { search, reportText };
}

module.exports = { createDocSearch, reportText, DAY };
