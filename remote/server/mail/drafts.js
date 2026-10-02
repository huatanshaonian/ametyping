// 草稿: mail being written, kept on the NAS so the PC and the phone carry on the same one (saved as you type).
//   <dataDir>/mail-drafts.json   [{ id, acc, mode ('new' | 'reply' | 'all' | 'forward'), ref (the mail answered /
//                                  forwarded), to, cc, bcc (as typed), subject, text (what you write), quote (the
//                                  original, put under it when includeQuote), includeQuote, atts, created, updated }]
//   <dataDir>/mail-uploads/<id>  files you attached (atts: { id, name, size, type, src: 'upload' }); a forward's own
//                                  attachments are taken from the mailbox when it is sent (src: 'orig', i: their place)
// A draft sent or deleted takes its uploads with it; drafts untouched for 60 days go.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_DRAFTS = 100, OLD_MS = 60 * 86400e3;
const FILE_MAX = 20 * 1024 * 1024, TOTAL_MAX = 25 * 1024 * 1024;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

function createDrafts({ dataDir }) {
  const file = path.join(dataDir, 'mail-drafts.json'), up = path.join(dataDir, 'mail-uploads');
  let items = []; try { items = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(items), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  const upPath = (attId) => path.join(up, attId.replace(/[^a-f0-9]/g, ''));
  const dropUploads = (d) => { for (const a of d.atts || []) if (a.src === 'upload') try { fs.rmSync(upPath(a.id), { force: true }); } catch {} };

  // the old ones go (and their files)
  const now = Date.now();
  const stale = items.filter((d) => now - (d.updated || 0) > OLD_MS);
  if (stale.length) { stale.forEach(dropUploads); items = items.filter((d) => !stale.includes(d)); save(); }

  const list = () => [...items].sort((a, b) => b.updated - a.updated);
  const get = (id) => items.find((d) => d.id === id) || null;

  // a new draft from what compose.js prepared
  function create(d) {
    if (items.length >= MAX_DRAFTS) { const old = list().pop(); dropUploads(old); items = items.filter((x) => x !== old); }
    const x = { id: crypto.randomBytes(6).toString('hex'), acc: str(d.acc, 20), mode: ['new', 'reply', 'all', 'forward'].includes(d.mode) ? d.mode : 'new',
      ref: str(d.ref, 200), to: str(d.to, 4000), cc: str(d.cc, 4000), bcc: str(d.bcc, 4000), subject: str(d.subject, 500), text: str(d.text, 200000),
      quote: str(d.quote, 200000), includeQuote: d.includeQuote !== false, atts: Array.isArray(d.atts) ? d.atts : [], inReplyTo: str(d.inReplyTo, 300),
      references: Array.isArray(d.references) ? d.references.slice(-20).map((r) => str(r, 300)) : [], created: Date.now(), updated: Date.now() };
    items.push(x); save();
    return x;
  }
  // what you typed (the fields you can change)
  function update(d) {
    const x = get(String(d.id || ''));
    if (!x) return { ok: false, msg: '这份草稿已经没有了（发出或删掉了）' };
    for (const k of ['acc', 'to', 'cc', 'bcc', 'subject', 'text']) if (typeof d[k] === 'string') x[k] = str(d[k], k === 'text' ? 200000 : k === 'subject' ? 500 : 4000);
    if (typeof d.includeQuote === 'boolean') x.includeQuote = d.includeQuote;
    x.updated = Date.now(); save();
    return { ok: true, updated: x.updated };
  }
  function remove(id) { const x = get(id); if (!x) return { ok: false }; dropUploads(x); items = items.filter((d) => d !== x); save(); return { ok: true }; }

  // a file you attached: streamed to disk (req), within the size limits. Too big: known from Content-Length at once,
  // else when it gets there -- the rest is read and dropped (the answer goes back on the same connection)
  function upload(id, name, type, req) {
    return new Promise((resolve) => {
      const x = get(id);
      const tooBig = (n, total) => (n > FILE_MAX ? '单个附件不能超过 20 MB' : total + n > TOTAL_MAX ? '一封信的附件合计不能超过 25 MB' : '');
      const drain = (msg) => { req.on('end', () => resolve({ ok: false, msg })); req.on('error', () => resolve({ ok: false, msg })); req.resume(); };
      if (!x) return drain('这份草稿已经没有了');
      const total = x.atts.reduce((n, a) => n + (a.size || 0), 0);
      const said = tooBig(+req.headers['content-length'] || 0, total);
      if (said) return drain(said);
      fs.mkdirSync(up, { recursive: true, mode: 0o700 });
      const att = { id: crypto.randomBytes(8).toString('hex'), name: str(name, 200).replace(/[\\/\r\n]/g, '_') || '附件', type: str(type, 100) || 'application/octet-stream', size: 0, src: 'upload' };
      const out = fs.createWriteStream(upPath(att.id), { mode: 0o600 });
      let n = 0, over = '';
      req.on('data', (c) => {
        n += c.length;
        if (over) return;
        over = tooBig(n, total);
        if (over) { req.unpipe(out); out.destroy(); fs.rmSync(upPath(att.id), { force: true }); }
      });
      req.on('end', () => { if (over) resolve({ ok: false, msg: over }); });
      req.pipe(out);
      out.on('finish', () => { if (over) return; att.size = n; x.atts.push(att); x.updated = Date.now(); save(); resolve({ ok: true, att }); });
      out.on('error', () => { if (!over) resolve({ ok: false, msg: '附件没能存下' }); });
    });
  }
  function removeAtt(id, attId) {
    const x = get(id);
    if (!x) return { ok: false };
    const a = x.atts.find((y) => y.id === attId);
    if (!a) return { ok: false };
    if (a.src === 'upload') try { fs.rmSync(upPath(a.id), { force: true }); } catch {}
    x.atts = x.atts.filter((y) => y !== a); x.updated = Date.now(); save();
    return { ok: true };
  }
  const readUpload = (attId) => fs.readFileSync(upPath(attId));

  return { list, get, create, update, remove, upload, removeAtt, readUpload, TOTAL_MAX };
}

module.exports = { createDrafts };
