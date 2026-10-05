// 调研工作: the new papers the profile's questions rest on (found on the web while 梳理 looked at what others asked and
// answered) go into Zotero too -- into the collection 调研工作 (settings "surveyCollection"), in folders by research
// topic the model names in one question for all of them, tagged "Windose调研". Their open-access PDFs are fetched as
// for 收下; no cards are made here: the daily push offers the unread ones first when there is room (feed.js), and the
// card comes with the reading. A question's reference then opens the paper in the library.
'use strict';
const { paper, toZotero } = require('./sources/normalize');
const { FOLDERS_SCHEMA, foldersPrompt } = require('./prompts/feed');

const TAG = 'Windose调研';

function createSurvey({ cfg = () => ({}), api, mirror, profile, openalex = null, ask = null, fetchPdf = null, fulltext = null, log = () => {}, onChange = () => {} }) {
  let job = null;
  const name = () => cfg().surveyCollection || '调研工作';
  const inLibrary = (r) => (r.doi && mirror.findDoi(r.doi)) || mirror.findTitle(r.title);

  // the references of the questions that are not in the library: [{ doi, title, year, venue, url, questions: [text] }]
  function waiting() {
    const by = new Map();
    for (const q of ((profile.get() || {}).questions || [])) for (const r of q.refs || []) {
      if (r.key || !r.title || inLibrary(r)) continue;
      const k = r.doi || r.title.toLowerCase();
      if (!by.has(k)) by.set(k, { doi: r.doi || '', title: r.title, year: r.year, venue: r.venue, url: r.url, questions: [] });
      by.get(k).questions.push(q.text);
    }
    return [...by.values()];
  }
  const collection = () => mirror.collectionByName(name());
  const status = () => { const c = collection(); return { name: name(), waiting: waiting().length, items: c ? mirror.inCollection(c.key).length : 0,
    job: job ? { running: job.running, step: job.step, done: job.done, total: job.total, error: job.error, at: job.at } : null }; };

  function run() {
    if (job && job.running) return { ok: false, msg: '正在入库' };
    if (!api.canWrite()) return { ok: false, need: 'authorize', msg: '需要先授权写入 Zotero' };
    const list = waiting();
    if (!list.length) return { ok: false, msg: '问题引用的文献都已经在库里了' };
    job = { running: true, step: '查文献信息', done: 0, total: list.length, error: '', at: Date.now() };
    onChange();
    (async () => {
      // the full record of each (authors, abstract, an open PDF) by its DOI; without one, what the reference holds
      const papers = [];
      for (const r of list) {
        let p = null;
        if (r.doi && openalex) { try { p = await openalex.byDoi(r.doi); } catch (e) { log('文献：调研文献查不到（' + r.doi + '）：' + e.message); } }
        papers.push(p && p.title ? p : paper({ source: 'survey', doi: r.doi, title: r.title, year: r.year, venue: r.venue, url: r.url }));
      }
      let top = collection();
      if (!top) { await api.write('POST', 'collections', [{ name: name() }]); await mirror.refresh(true); top = collection(); }
      if (!top) throw new Error(`Zotero 里建不了「${name()}」分类`);
      // one question for all of them: a folder by topic each (the folders there, or new ones)
      job.step = '分类'; onChange();
      const subs = () => mirror.collections().filter((c) => c.parent === top.key);
      const folderOf = new Map();
      if (ask) {
        try {
          const a = await ask(foldersPrompt(profile.get() || {}, papers.map((p, i) => ({ ref: 'P' + (i + 1), ...p })), subs().map((c) => ({ name: c.name, n: mirror.inCollection(c.key, false).length })), top.name), FOLDERS_SCHEMA);
          for (const x of (a && a.items) || []) { const i = +String(x.ref || '').replace(/\D/g, '') - 1, f = String(x.folder || '').replace(/[\\/\n\r]+/g, ' ').trim().slice(0, 24); if (papers[i] && f) folderOf.set(i, f); }
        } catch (e) { log('文献：调研文献分类失败（都放在「' + top.name + '」里）：' + e.message); }
      }
      const missing = [...new Set(folderOf.values())].filter((f) => !subs().some((c) => c.name === f));
      if (missing.length) { await api.write('POST', 'collections', missing.map((f) => ({ name: f, parentCollection: top.key }))); await mirror.refresh(true); }
      job.step = '写入 Zotero'; onChange();
      const keys = [];
      for (let i = 0; i < papers.length; i++) {
        const sub = subs().find((c) => c.name === folderOf.get(i));
        const [key] = await api.createItems([toZotero(papers[i], { collections: [sub ? sub.key : top.key], tags: [TAG] })]);
        keys.push(key || '');
        job.done = i + 1; onChange();
      }
      await mirror.refresh(true).catch(() => {});
      profile.linkRefs();
      log(`文献：调研用到的 ${keys.filter(Boolean).length} 篇文献已入库「${top.name}」${folderOf.size ? `（${new Set(folderOf.values()).size} 个文件夹）` : ''}`);
      // the open-access PDFs, one after the other
      if (fetchPdf) {
        job.step = '找开放获取的 PDF'; job.done = 0; onChange();
        let got = 0;
        for (let i = 0; i < papers.length; i++) {
          const p = papers[i], key = keys[i];
          job.done = i + 1;
          if (!key || !(p.pdf || p.doi)) continue;
          try {
            const f = await fetchPdf(p);
            if (f) { const att = await api.attachPdf(key, f.buf, { filename: ((p.doi || 'paper').replace(/[^\w.-]+/g, '_')).slice(0, 80) + '.pdf', url: f.url }); if (fulltext) fulltext.remember(att, f.buf); got++; }
          } catch (e) { log('文献：调研文献的 PDF 没拿到：' + e.message); }
          onChange();
        }
        await mirror.refresh(true).catch(() => {});
        log(`文献：调研文献里 ${got} 篇拿到了开放获取的 PDF，其余要通过所里的订阅手动下载`);
      }
    })().catch((e) => { job.error = e.message; log('文献：调研文献入库失败：' + e.message); }).finally(() => { job.running = false; job.step = ''; onChange(); });
    return { ok: true, n: list.length };
  }

  return { waiting, status, run, name, TAG };
}

module.exports = { createSurvey };
