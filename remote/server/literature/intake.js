// 收下: a pushed paper goes into Zotero -- into 每日文献 (config "inboxCollection"), tagged "Windose推送" -- through the
// local API, and from there into a folder by research topic under it: the model picks one of the folders there or
// names a new one, which is then made (the folders by month of earlier versions stay as they are, and are not offered). An open-access PDF (OpenAlex / arXiv / NTRS / Unpaywall) is fetched and handed to Zotero as
// the paper's attachment (Zotero files it and syncs it to WebDAV). Then the module waits a little for a PDF to be there
// (`pdfWaitMs`, default 3 minutes -- whatever put it there): with one, the card is made from the full text; without,
// from the abstract, and the card says whether the full text is worth getting by hand (paywalled papers: through the
// institute). A PDF that turns up later (dragged into Zotero) is noticed on the next library refresh and the card is
// made again from it. Without an open-access copy the paper is put in the queue of the library access (pdfqueue.js: the
// browser signed in to the institution's subscriptions), which brings the PDF the same way a little later.
'use strict';
const { toZotero } = require('./sources/normalize');
const { FOLDER_SCHEMA, folderPrompt } = require('./prompts/feed');

const TAG = 'Windose推送';
const MONTH = /^\d{4}-\d{2}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ask / profile: for choosing the folder (without them a paper stays in 每日文献 itself)
function createIntake({ cfg = {}, api, mirror, fulltext, cards, feed, http, unpaywall = null, ask = null, profile = null, pdfq = null, log = () => {}, onChange = () => {}, now = () => Date.now() }) {
  const C = () => (typeof cfg === 'function' ? cfg() : cfg) || {};
  const pdfWaitMs = C().pdfWaitMs != null ? +C().pdfWaitMs : 180e3, pollMs = C().pollMs != null ? +C().pollMs : 20e3;
  const working = new Set();

  // 每日文献 (made when missing)
  async function inbox() {
    const name = C().inboxCollection || '每日文献';
    let top = mirror.collectionByName(name);
    if (!top) { await api.write('POST', 'collections', [{ name }]); await mirror.refresh(true); top = mirror.collectionByName(name); }
    if (!top) throw new Error(`Zotero 里建不了「${name}」分类`);
    return top;
  }
  // the paper just put into 每日文献 moves into the topic folder the model picks (an existing one, or a new one made
  // here); when that fails it simply stays where it is
  async function file(id, key, p) {
    if (!ask) return;
    const top = await inbox();
    const subs = () => mirror.collections().filter((c) => c.parent === top.key && !MONTH.test(c.name));
    const a = await ask(folderPrompt((profile && profile.get()) || {}, p, subs().map((c) => ({ name: c.name, n: mirror.inCollection(c.key, false).length })), top.name), FOLDER_SCHEMA);
    const name = String((a && a.folder) || '').replace(/[\\/\n\r]+/g, ' ').trim().slice(0, 24);
    if (!name) return;
    let sub = subs().find((c) => c.name === name);
    if (!sub) { await api.write('POST', 'collections', [{ name, parentCollection: top.key }]); await mirror.refresh(true); sub = subs().find((c) => c.name === name); log(`文献：在「${top.name}」下新建了文件夹「${name}」`); }
    if (!sub) throw new Error(`建不了文件夹「${name}」`);
    const move = async () => { const it = mirror.item(key); if (!it) throw new Error('条目还没同步过来'); await api.patchItem(key, it.version, { collections: [...new Set([...it.collections.filter((c) => c !== top.key), sub.key])] }); };
    try { await move(); } catch (e) { if (e.status !== 412) throw e; await mirror.refresh(true); await move(); }      // (the copy here was behind Zotero's)
    feed.decide(id, null, { folder: name, folderWhy: String((a && a.why) || '').slice(0, 200) }); onChange('feed');
    log(`文献：「${p.title.slice(0, 40)}」归入 ${top.name}/${name}`);
  }
  // an open-access PDF for the paper: the source's own link, else Unpaywall's; checked to really be a PDF
  async function fetchPdf(p) {
    const urls = [p.dticPdf, p.pdf, p.doi && unpaywall ? await unpaywall.pdfFor(p.doi) : ''].filter(Boolean);
    for (const url of [...new Set(urls)]) {
      try {
        const r = await http.get(url, { timeoutMs: 90e3, maxBytes: 80 * 1024 * 1024, headers: { Accept: 'application/pdf,*/*' } });
        if (r.status === 200 && r.body.slice(0, 5).toString('latin1') === '%PDF-') return { buf: r.body, url };
      } catch (e) { log(`文献：下载 PDF 失败（${url}）：${e.message}`); }
    }
    return null;
  }

  function setStage(e, stage, msg = '') { feed.decide(e.id, null, { intake: { stage, msg, at: now() } }); onChange('feed'); }

  async function keep(id) {
    const e = feed.get(id);
    if (!e) return { ok: false, msg: '找不到这条推送' };
    if (e.kind !== 'new') return { ok: false, msg: '复习的文献已经在库里了' };
    if (e.zkey) return { ok: true, key: e.zkey };
    if (!api.canWrite()) return { ok: false, need: 'authorize', msg: '需要先授权写入 Zotero' };
    if (working.has(id)) return { ok: false, msg: '正在收下' };
    working.add(id);
    try {
      const p = e.paper;
      const dup = (p.doi && mirror.findDoi(p.doi)) || mirror.findTitle(p.title);
      let key = dup ? dup.key : null;
      if (!key) {
        const top = await inbox();
        [key] = await api.createItems([toZotero(p, { collections: [top.key], tags: [TAG] })]);
        if (!key) throw new Error('Zotero 没有收下这个条目');
      }
      feed.decide(id, 'kept', { zkey: key, intake: { stage: 'pdf', msg: '找开放获取的 PDF…', at: now() } });
      log(`文献：已收下「${p.title.slice(0, 60)}」→ Zotero ${key}`);
      after(id, key, p, !dup).catch((err) => { setStage(feed.get(id), 'error', err.message); log('文献：收下后处理失败：' + err.message); }).finally(() => working.delete(id));
      return { ok: true, key };
    } catch (err) { working.delete(id); return { ok: false, msg: err.message, need: err.need }; }
  }

  // fresh: the item was made just now (one already in the library stays in its own folders)
  async function after(id, key, p, fresh = false) {
    await mirror.refresh(true).catch(() => {});
    if (fresh) await file(id, key, p).catch((err) => log('文献：归类失败（留在原处）：' + err.message));
    if (!fulltext.hasPdf(key)) {
      const got = await fetchPdf(p);
      if (got) {
        const name = (p.arxiv ? `arXiv-${p.arxiv}` : p.ntrs ? `NTRS-${p.ntrs}` : p.dtic ? `DTIC-${p.dtic}` : (p.doi || 'paper').replace(/[^\w.-]+/g, '_')).slice(0, 80) + '.pdf';
        try { const att = await api.attachPdf(key, got.buf, { filename: name, url: got.url }); fulltext.remember(att, got.buf); log(`文献：PDF 已交给 Zotero（${att}）`); }
        catch (err) { log('文献：把 PDF 交给 Zotero 失败：' + err.message); }
        await mirror.refresh(true).catch(() => {});
      }
    }
    // wait for a PDF to be there, whatever brings it (the library access, when no open copy was found)
    const queued = !fulltext.hasPdf(key) && pdfq && pdfq.add(key, p, { front: true });
    setStage(feed.get(id), 'waiting', queued ? '没有开放获取的版本，走图书馆通道下载…' : '等 PDF…');
    const until = now() + pdfWaitMs;
    while (!fulltext.hasPdf(key) && now() < until) { await sleep(pollMs); await mirror.refresh(true).catch(() => {}); }
    const has = fulltext.hasPdf(key);
    setStage(feed.get(id), 'card', has ? '有 PDF，生成速读卡…' : '没有 PDF，按摘要生成速读卡…');
    const r = cards.run(key, 'quick');
    if (r.wait) await r.wait;
    const st = cards.state(key) || {};
    if (st.error) return setStage(feed.get(id), 'error', st.error);
    const gp = st.result && st.result.getPdf;
    const via = !has && pdfq ? pdfq.note(key) : '';
    setStage(feed.get(id), has ? 'ready' : 'needs-pdf', has ? '' : (via ? via + '。' : '') + (gp && gp.worth ? '建议手动获取全文：' + (gp.why || '') : '按摘要看，不一定需要全文' + (gp && gp.why ? '：' + gp.why : '')));
  }

  // called after each library refresh: a kept paper still without a PDF that now has one gets its card from the full text
  async function onLibrary() {
    for (const e of feed.entries()) {
      if (!e.zkey || !e.intake || e.intake.stage !== 'needs-pdf' || working.has(e.id) || !fulltext.hasPdf(e.zkey)) continue;
      working.add(e.id);
      try {
        setStage(e, 'card', 'PDF 到了，重新生成速读卡…');
        const r = cards.run(e.zkey, 'quick'); if (r.wait) await r.wait;
        const st = cards.state(e.zkey) || {};
        setStage(feed.get(e.id), st.error ? 'error' : 'ready', st.error || '');
        log(`文献：「${e.paper.title.slice(0, 40)}」的 PDF 到了，速读卡已按全文更新`);
      } finally { working.delete(e.id); }
    }
  }
  return { keep, onLibrary, fetchPdf, TAG };
}

module.exports = { createIntake };
