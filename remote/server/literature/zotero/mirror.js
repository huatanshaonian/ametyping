// The Zotero library as the literature module sees it: a copy of every item, collection, attachment, note and
// annotation, taken through the local API and refreshed whenever the library's version moves (checked every minute;
// a full read is cheap -- nothing leaves the NAS). Zotero stays the truth; this is only what the module reads from.
//   <dataDir>/literature/zotero.json   { serverId, version, at, items: { key: item }, collections: { key: {...} } }
// An item here: { key, type, title, creators: [ 'Last, First' ], year, date, venue, doi, url, abstract, tags, collections,
//   citekey, added, modified, extra, number } -- children are kept apart: attachments, notes, annotations (by parent).
'use strict';
const fs = require('fs');
const path = require('path');

const TOP_SKIP = new Set(['attachment', 'note', 'annotation']);
const strip = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
const normDoi = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
const normTitle = (t) => String(t || '').toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const yearOf = (d) => { const m = /\b(1[89]\d\d|20\d\d)\b/.exec(String(d || '')); return m ? +m[1] : 0; };

function creatorName(c) { return c.name || [c.lastName, c.firstName].filter(Boolean).join(', '); }

// a citation key for an item without one: lastname + year + first real title word (ascii only); clashes get a, b, ...
const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'by', 'at', 'from', 'towards', 'toward', 'via', 'using']);
function baseKey(it) {
  const c = it._c && it._c[0];
  const last = String(c ? (c.lastName || c.name || '') : '').normalize('NFKD').replace(/[^A-Za-z]/g, '').toLowerCase();
  const word = (String(it.title || '').normalize('NFKD').toLowerCase().match(/[a-z]+/g) || []).find((w) => !STOP.has(w) && w.length > 2) || '';
  return (last || 'anon') + (it.year || '') + word;
}

function slim(d) {
  const it = {
    key: d.key, type: d.itemType, title: String(d.title || '').trim(), creators: (d.creators || []).filter((c) => c.creatorType !== 'editor').map(creatorName).filter(Boolean),
    date: d.date || '', year: yearOf(d.date), venue: d.publicationTitle || d.proceedingsTitle || d.conferenceName || d.bookTitle || d.institution || d.publisher || d.university || '',
    doi: normDoi(d.DOI || (/^DOI:\s*(\S+)/im.exec(d.extra || '') || [])[1]), url: d.url || '', abstract: String(d.abstractNote || '').trim(),
    tags: (d.tags || []).map((t) => t.tag), collections: d.collections || [], citekey: d.citationKey || (/^Citation Key:\s*(\S+)/im.exec(d.extra || '') || [])[1] || '',
    added: Date.parse(d.dateAdded) || 0, modified: Date.parse(d.dateModified) || 0, number: d.reportNumber || d.number || '', version: d.version || 0,
    // a NASA report's NTRS id ("NTRS: 19700001" in Extra, as 收下 writes it; or its ntrs.nasa.gov link)
    ntrs: (/^NTRS:\s*(\d{6,})/im.exec(d.extra || '') || /ntrs\.nasa\.gov\/(?:citations|api\/citations)\/(\d{6,})/.exec(d.url || '') || [])[1] || '',
    dtic: (/^DTIC:\s*(AD[A-Z]?\d{6,7})/im.exec(d.extra || '') || /archive\.org\/details\/DTIC_(AD[A-Z]?\d{6,7})/.exec(d.url || '') || [])[1] || '',
    // (the field often holds two run together, "0018-926X1045-9243", or none of the hyphens: each one, as NNNN-NNNN)
    issns: [...new Set((String(d.ISSN || '').toUpperCase().match(/\d{4}-?\d{3}[\dX]/g) || []).map((s) => s.replace(/^(\d{4})-?/, '$1-')))],
  };
  it.issn = it.issns[0] || '';
  Object.defineProperty(it, '_c', { value: (d.creators || []).filter((c) => c.creatorType !== 'editor'), enumerable: false });
  return it;
}

function createMirror({ api, dir, log = () => {}, everyMs = 60e3, onChange = () => {} }) {
  const file = path.join(dir, 'zotero.json');
  let st = { serverId: '', version: 0, at: 0, items: {}, collections: {}, attachments: {}, notes: {}, annotations: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let lastError = '', running = null, timer = null;
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st)); fs.renameSync(file + '.tmp', file); };
  // indexes rebuilt on every load / refresh
  let byParent = new Map(), annByAtt = new Map(), byDoi = new Map(), byTitle = new Map();
  function reindex() {
    byParent = new Map(); annByAtt = new Map(); byDoi = new Map(); byTitle = new Map();
    for (const a of Object.values(st.attachments)) { if (!byParent.has(a.parent)) byParent.set(a.parent, { att: [], notes: [] }); byParent.get(a.parent).att.push(a); }
    for (const n of Object.values(st.notes)) { if (!byParent.has(n.parent)) byParent.set(n.parent, { att: [], notes: [] }); byParent.get(n.parent).notes.push(n); }
    for (const a of Object.values(st.annotations)) { if (!annByAtt.has(a.parent)) annByAtt.set(a.parent, []); annByAtt.get(a.parent).push(a); }
    for (const it of Object.values(st.items)) { if (it.doi) byDoi.set(it.doi, it.key); const t = normTitle(it.title); if (t.length > 12) byTitle.set(t, it.key); }
  }
  reindex();

  async function refresh(force = false) {
    if (running) return running;
    running = (async () => {
      try {
        const v = await api.version();
        if (!force && v === st.version && st.at) return false;
        const [itemsR, colR] = await Promise.all([api.get('items?format=json'), api.get('collections?format=json')]);
        const items = {}, attachments = {}, notes = {}, annotations = {}, collections = {};
        const raw = Array.isArray(itemsR.data) ? itemsR.data : [];
        for (const o of raw) {
          const d = o.data || o;
          if (d.deleted) continue;
          if (d.itemType === 'attachment') attachments[d.key] = { key: d.key, parent: d.parentItem || '', linkMode: d.linkMode, contentType: d.contentType || '', filename: d.filename || '', title: d.title || '', url: d.url || '', added: Date.parse(d.dateAdded) || 0 };
          else if (d.itemType === 'note') notes[d.key] = { key: d.key, parent: d.parentItem || '', text: strip(d.note), tags: (d.tags || []).map((t) => t.tag), modified: Date.parse(d.dateModified) || 0, version: d.version || 0 };
          else if (d.itemType === 'annotation') annotations[d.key] = { key: d.key, parent: d.parentItem || '', type: d.annotationType, text: d.annotationText || '', comment: d.annotationComment || '',
            color: d.annotationColor || '', page: d.annotationPageLabel || '', sort: d.annotationSortIndex || '', position: d.annotationType === 'ink' ? d.annotationPosition : undefined, modified: Date.parse(d.dateModified) || 0 };
          else if (!TOP_SKIP.has(d.itemType)) items[d.key] = slim(d);
        }
        for (const o of Array.isArray(colR.data) ? colR.data : []) { const d = o.data || o; collections[d.key] = { key: d.key, name: d.name, parent: d.parentCollection || '' }; }
        // citation keys for items without their own (stable: oldest item first)
        const used = new Set(Object.values(items).map((it) => it.citekey).filter(Boolean));
        for (const it of Object.values(items).sort((a, b) => a.added - b.added || a.key.localeCompare(b.key))) {
          if (it.citekey) continue;
          const b = baseKey(it); let k = b, i = 0;
          while (used.has(k)) k = b + String.fromCharCode(97 + i++);
          it.citekey = k; it.autoKey = true; used.add(k);
        }
        st = { serverId: api.serverId(), version: itemsR.version || v, at: Date.now(), items, collections, attachments, notes, annotations };
        save(); reindex(); lastError = '';
        log(`文献：Zotero 库已同步（${Object.keys(items).length} 篇，${Object.keys(attachments).length} 个附件，${Object.keys(annotations).length} 条批注）`);
        onChange();
        return true;
      } catch (e) { lastError = e.message; throw e; }
      finally { running = null; }
    })();
    return running;
  }
  function start() {
    const tick = () => refresh().catch((e) => log('文献：读 Zotero 失败：' + e.message));
    tick();
    if (everyMs) { timer = setInterval(tick, everyMs); timer.unref && timer.unref(); }
  }

  // ---- reading ----
  const item = (key) => st.items[key] || null;
  const items = () => Object.values(st.items);
  const childrenOf = (key) => byParent.get(key) || { att: [], notes: [] };
  // the item's PDF: an imported (stored) PDF attachment first, else a linked one
  function pdfOf(key) {
    const att = childrenOf(key).att.filter((a) => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename));
    return att.find((a) => a.linkMode === 'imported_file' || a.linkMode === 'imported_url') || att[0] || null;
  }
  // every annotation on the item's attachments, in reading order
  function annotationsOf(key) {
    const out = [];
    for (const a of childrenOf(key).att) for (const n of annByAtt.get(a.key) || []) out.push({ ...n, attachment: a.key });
    return out.sort((x, y) => String(x.sort).localeCompare(String(y.sort)));
  }
  // a collection by name (the first match) and its sub-collections
  const collectionByName = (name) => Object.values(st.collections).find((c) => c.name === name) || null;
  function subtree(colKey) {
    const keys = new Set([colKey]);
    for (let grew = true; grew;) { grew = false; for (const c of Object.values(st.collections)) if (keys.has(c.parent) && !keys.has(c.key)) { keys.add(c.key); grew = true; } }
    return keys;
  }
  const inCollection = (colKey, deep = true) => { const ks = deep ? subtree(colKey) : new Set([colKey]); return items().filter((it) => it.collections.some((c) => ks.has(c))); };
  const findDoi = (doi) => st.items[byDoi.get(normDoi(doi))] || null;
  const findTitle = (t) => { const n = normTitle(t); return n.length > 12 ? st.items[byTitle.get(n)] || null : null; };
  const collections = () => Object.values(st.collections);
  const status = () => ({ version: st.version, at: st.at, items: Object.keys(st.items).length, attachments: Object.keys(st.attachments).length, annotations: Object.keys(st.annotations).length, error: lastError });

  return { start, refresh, stop: () => timer && clearInterval(timer), item, items, childrenOf, pdfOf, annotationsOf, collectionByName, subtree, inCollection, findDoi, findTitle, collections, status,
    annotationCount: (key) => annotationsOf(key).length };
}

module.exports = { createMirror, normDoi, normTitle, strip, yearOf };
