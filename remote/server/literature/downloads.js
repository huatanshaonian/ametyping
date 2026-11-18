// 下载: papers asked for by DOI -- typed into 文献 › 文献库's box, or sent by an agent through the MCP (mcp.js, over
// the module's own socket: agent-socket.js). Each DOI becomes a job; one worker takes the jobs one at a time (so two
// requests for the same paper never make two Zotero items):
//   the paper already in the library -> its item; else its record from OpenAlex / Crossref (a DOI neither knows is
//   refused, nothing is made) -> a Zotero item in 文献下载 (settings "downloadCollection"), tagged "Windose下载";
//   a PDF already there -> done; else an open-access copy (intake.fetchPdf) -> done; else into the queue of the
//   library access (pdfqueue.js), which is shared with everything else and paced as it always is.
// Asking again for a DOI gives back its job; a failed one is tried again only after an hour (from the window: at once).
//   <dataDir>/literature/downloads.json  { jobs: { <id>: { id, doi, by, state, msg, key, title, source, created, at } } }
// state as stored: queued | working | library (handed to the queue) | done | failed; what is shown of a job in the
// queue comes from the queue itself (waiting / downloading / blocked / paused).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normDoi } = require('./zotero/mirror');
const { toZotero } = require('./sources/normalize');

const TAG = 'Windose下载';
const DOI = /^10\.\d{4,9}\/[^\s"<>]{1,250}$/;
const MAX_PER_CALL = 20, MAX_ACTIVE = 100, KEEP_MS = 30 * 86400e3, AGAIN_MS = 3600e3;
const FINAL = new Set(['done', 'failed']);

// a DOI as typed or pasted: "https://doi.org/10.x/y", "doi:10.x/y", with a full stop or a bracket after it
const cleanDoi = (s) => normDoi(String(s || '').trim()).replace(/[.,;:)\]}>'"]+$/, '');
// every DOI in a piece of text (the window's box takes several, one per line or space)
// (a DOI ends at a space, a comma, or the first character beyond ASCII: "10.1016/x，谢谢")
const doisIn = (text) => [...new Set((String(text || '').match(/10\.\d{4,9}\/[^\s"<>,;\u0080-\uffff]+/g) || []).map(cleanDoi).filter((d) => DOI.test(d)))];

// a PDF named the way Zotero names them: "Wang 等 - 2026 - Title.pdf"
function pdfName(it, fallback = 'paper.pdf') {
  if (!it || !it.title) return fallback;
  const who = it.creators && it.creators.length ? it.creators[0].split(',')[0].trim() + (it.creators.length > 1 ? ' 等' : '') : '';
  const t = it.title.length > 100 ? it.title.slice(0, 100).trim() : it.title;
  return [who, it.year || '', t].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() + '.pdf';
}

// lookups: [(doi) -> paper | null] (OpenAlex, then Crossref); fetchPdf: intake.fetchPdf
function createDownloads({ dir, cfg = () => ({}), api, mirror, fulltext, pdfq, fetchPdf, lookups = [], log = () => {}, onChange = () => {}, now = () => Date.now(), tickMs = 30e3 }) {
  const file = path.join(dir, 'downloads.json');
  let st = { jobs: {} };
  try { st = { jobs: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  for (const j of Object.values(st.jobs)) if (j.state === 'working') j.state = 'queued';          // (stopped half-way)
  const save = () => {
    for (const [k, j] of Object.entries(st.jobs)) if (FINAL.has(j.state) && now() - j.at > KEEP_MS) delete st.jobs[k];
    fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  };
  const changed = () => { save(); onChange(); };
  const C = () => cfg() || {};
  const jobs = () => Object.values(st.jobs);
  const byDoi = (doi) => jobs().find((j) => j.doi === doi) || null;
  const active = () => jobs().filter((j) => !FINAL.has(j.state)).length;

  function limits() {
    const c = C(), q = pdfq.status();
    return { serial: true, maxPerCall: MAX_PER_CALL, maxActive: MAX_ACTIVE, active: active(), gapSec: +c.pdfGapSec || 90, perDay: c.pdfPerDay != null ? +c.pdfPerDay : 30,
      today: q.today, libraryEnabled: !!q.enabled, retryFailedAfterMin: AGAIN_MS / 60e3 };
  }

  // what a job is now (one in the queue: as the queue has it). A job whose queue entry ended is stored as ended.
  let dirty = false;
  function view(j) {
    let state = j.state, msg = j.msg || '', needsUser = false;
    if (j.state === 'library') {
      const q = pdfq.info(j.key);
      if (j.key && fulltext.hasPdf(j.key)) { Object.assign(j, { state: 'done', msg: '', at: now() }); dirty = true; state = 'done'; msg = ''; }
      else if (!q) { Object.assign(j, { state: 'failed', msg: '图书馆通道里没有这篇了（被拿掉了）', at: now() }); dirty = true; state = 'failed'; msg = j.msg; }
      else if (q.state === 'failed') { Object.assign(j, { state: 'failed', msg: '图书馆通道没拿到：' + q.why, at: now() }); dirty = true; state = 'failed'; msg = j.msg; }
      else if (q.state === 'done') { state = 'waiting'; msg = 'PDF 已交给 Zotero，等同步过来'; }
      else if (q.state === 'running') { state = 'downloading'; msg = '正在通过图书馆通道下载'; }
      else if (q.block) { state = 'blocked'; needsUser = true; msg = `${q.block.name}：${q.block.msg}`; }
      else if (q.paused) { state = 'paused'; needsUser = true; msg = '图书馆通道暂停：' + q.paused; }
      else if (q.limit) { state = 'waiting'; msg = '今天的下载额度用完了，明天继续'; }
      else { state = 'waiting'; msg = q.ahead ? `图书馆通道排队，前面还有 ${q.ahead} 篇` : '图书馆通道排队，下一篇就是它'; }
    }
    if (state === 'queued' && j.needAuth) needsUser = true;
    return { id: j.id, doi: j.doi, state, msg, needsUser, key: j.key || '', title: j.title || '', by: j.by || '', source: j.source || '', created: j.created, updated: j.at, pdf: state === 'done' };
  }
  const flush = () => { if (dirty) { dirty = false; save(); } };

  // submit(['10.x/y', ...], { by, force }) -> { ok, results: [view + { duplicate }], limits } | { ok: false, msg }
  function submit(list, { by = 'windose', force = false } = {}) {
    if (!Array.isArray(list) || !list.length) return { ok: false, msg: '没有 DOI' };
    if (list.length > MAX_PER_CALL) return { ok: false, msg: `一次最多 ${MAX_PER_CALL} 个 DOI` };
    const results = [], seen = new Set();
    let added = 0;
    for (const raw of list) {
      const doi = cleanDoi(raw);
      if (!DOI.test(doi)) { results.push({ input: String(raw).slice(0, 300), ok: false, msg: '不是 DOI（要像 10.1109/TAP.2020.1234567 这样）' }); continue; }
      if (seen.has(doi)) continue;
      seen.add(doi);
      const old = byDoi(doi);
      if (old) {
        if (old.state === 'failed' && (force || now() - old.at >= AGAIN_MS)) {
          Object.assign(old, { state: 'queued', msg: '', at: now(), by: String(by).slice(0, 80), needAuth: false }); added++;
          results.push({ ok: true, ...view(old), duplicate: true, again: true });
        } else results.push({ ok: true, ...view(old), duplicate: true, ...(old.state === 'failed' ? { note: `刚失败过，${AGAIN_MS / 60e3} 分钟内不再重试` } : {}) });
        continue;
      }
      if (active() >= MAX_ACTIVE) { results.push({ doi, ok: false, msg: `排队的任务已经有 ${MAX_ACTIVE} 个，等前面的完成再提交` }); continue; }
      const j = { id: 'dl' + crypto.randomBytes(5).toString('hex'), doi, by: String(by).slice(0, 80), state: 'queued', msg: '', key: '', title: '', source: '', created: now(), at: now() };
      st.jobs[j.id] = j; added++;
      results.push({ ok: true, ...view(j), duplicate: false });
    }
    if (added) { changed(); kick(); }
    flush();
    return { ok: results.some((r) => r.ok), results, limits: limits() };
  }

  // list({ ids }) -> the jobs asked for (unknown ids: not found), else the latest 30
  function list({ ids = null, n = 30 } = {}) {
    const out = ids ? ids.map((id) => (st.jobs[id] ? view(st.jobs[id]) : { id: String(id).slice(0, 40), state: 'unknown', msg: '没有这个任务' }))
      : jobs().sort((a, b) => b.created - a.created).slice(0, n).map(view);
    flush();
    return out;
  }
  // the PDF of a finished job -> { buf, name, job } | { msg }
  function pdf(id) {
    const j = st.jobs[id];
    if (!j) return { msg: '没有这个任务' };
    const v = view(j); flush();
    if (v.state !== 'done') return { msg: '还没下好（' + (v.msg || v.state) + '）' };
    const f = fulltext.pdfBytes(j.key);
    if (!f) return { msg: 'PDF 还没同步到群晖，过一会儿再取' };
    return { buf: f.buf, name: pdfName(mirror.item(j.key), f.name), job: v };
  }

  // ---- the worker ----
  async function collection() {
    const name = C().downloadCollection || '文献下载';
    let c = mirror.collectionByName(name);
    if (!c) { await api.write('POST', 'collections', [{ name }]); await mirror.refresh(true); c = mirror.collectionByName(name); }
    if (!c) throw new Error(`Zotero 里建不了「${name}」分类`);
    return c;
  }
  async function meta(doi) {
    let err = null;
    for (const f of lookups) {
      try { const p = await f(doi); if (p && p.title) return { ...p, doi: p.doi || doi }; } catch (e) { err = e; }
    }
    if (err) throw new Error('查文献信息失败：' + err.message);
    return null;
  }
  const end = (j, state, msg = '') => { Object.assign(j, { state, msg, at: now() }); changed(); if (state === 'failed') log(`文献：下载 ${j.doi} 没成：${msg}`); };

  async function one(j) {
    // (no write access: the job waits, said once -- not written again every half minute)
    if (!api.canWrite()) { if (!j.needAuth) { Object.assign(j, { msg: '等 Zotero 写入授权（文献窗口上方「授权写入 Zotero」）', needAuth: true, at: now() }); changed(); } return false; }
    Object.assign(j, { state: 'working', msg: '查找文献信息…', needAuth: false, at: now() }); changed();
    try {
      let it = mirror.findDoi(j.doi);
      if (!it) { await mirror.refresh(true).catch(() => {}); it = mirror.findDoi(j.doi); }
      let p = null;
      if (!it) {
        p = await meta(j.doi);
        if (!p) { end(j, 'failed', '查不到这个 DOI（OpenAlex、Crossref 都没有记录）'); return true; }
        const col = await collection();
        const [key] = await api.createItems([toZotero(p, { collections: [col.key], tags: [TAG] })]);
        if (!key) throw new Error('Zotero 没有收下这个条目');
        j.key = key; j.title = p.title;
        log(`文献：按 DOI 收下「${p.title.slice(0, 60)}」→ Zotero ${key}（${j.by}）`);
        await mirror.refresh(true).catch(() => {});
      } else { j.key = it.key; j.title = it.title; }
      if (fulltext.hasPdf(j.key)) { end(j, 'done', it ? '库里本来就有 PDF' : ''); return true; }
      j.msg = '找开放获取的 PDF…'; changed();
      if (!p) p = await meta(j.doi).catch(() => null);                    // (for an item of the library: its open link)
      const got = await fetchPdf({ ...(p || {}), doi: j.doi, title: j.title });
      if (got) {
        const att = await api.attachPdf(j.key, got.buf, { filename: j.doi.replace(/[^\w.-]+/g, '_').slice(0, 80) + '.pdf', url: got.url });
        fulltext.remember(att, got.buf);
        pdfq.got(j.key, '开放获取');
        await mirror.refresh(true).catch(() => {});
        j.source = 'open';
        end(j, 'done');
        return true;
      }
      const q = pdfq.add(j.key, { doi: j.doi, title: j.title });
      if (!q) { end(j, 'failed', pdfq.status().enabled ? '没能排进图书馆通道' : '没有开放获取的版本，图书馆通道也没有开启（控制面板 › 文献）'); return true; }
      j.source = 'library';
      end(j, 'library');
      return true;
    } catch (e) {
      if (e.need === 'authorize') { Object.assign(j, { state: 'queued', msg: 'Zotero 的写入授权失效了，等重新授权', needAuth: true, at: now() }); changed(); return false; }
      end(j, 'failed', e.message);
      return true;
    }
  }
  let working = null, timer = null;
  function kick() {
    if (working) return working;
    working = (async () => {
      for (;;) {
        const j = jobs().filter((x) => x.state === 'queued').sort((a, b) => a.created - b.created)[0];
        if (!j || !(await one(j))) break;
      }
    })().catch((e) => log('文献：下载任务出错：' + e.message)).finally(() => { working = null; });
    return working;
  }
  const start = () => { if (!timer) { timer = setInterval(kick, tickMs); if (timer.unref) timer.unref(); kick(); } };
  const stop = () => { clearInterval(timer); timer = null; };

  return { submit, list, pdf, limits, start, stop, kick, idle: () => !working, TAG };
}

module.exports = { createDownloads, doisIn, cleanDoi, pdfName, MAX_PER_CALL };
