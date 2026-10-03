// Zotero's local API (Zotero 10+, http://127.0.0.1:23119/api/ -- the Zotero running in the NAS's container, docs in
// deploy/nas/zotero/). The same JSON as the web API; reads need nothing, writes a local key that the user grants once in
// Zotero's own window ("Always Allow", POST /api/local/authorize) plus the instance's Zotero-Server-ID header.
//   <dataDir>/literature/zotero-key.json  { key, serverId }   (0600)
// Files: an attachment item is created, then the bytes go through the upload flow (authorize -> upload -> register);
// Zotero files them in its storage and syncs them to WebDAV itself.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_NAME = 'Windose 文献';

function createLocalApi({ base = 'http://127.0.0.1:23119', http, dir, log = () => {} }) {
  const keyFile = path.join(dir, 'zotero-key.json');
  let cred = {}; try { cred = JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch {}
  const saveCred = () => { fs.writeFileSync(keyFile + '.tmp', JSON.stringify(cred), { mode: 0o600 }); fs.renameSync(keyFile + '.tmp', keyFile); };
  let serverId = cred.serverId || '';
  let authorizing = null;
  const U = (p) => base.replace(/\/$/, '') + p;

  // GET /api/users/0/<p> -> { data, version } (data: parsed JSON)
  async function get(p, opts = {}) {
    const r = await http.request(U('/api/users/0/' + p.replace(/^\//, '')), { headers: { 'Zotero-API-Version': '3', Accept: 'application/json' }, timeoutMs: opts.timeoutMs || 60e3 });
    if (r.headers['zotero-server-id']) serverId = String(r.headers['zotero-server-id']);
    if (r.status === 403) throw Object.assign(new Error('Zotero 的本地 API 没有打开（设置 → 高级 → 允许其他应用通讯）'), { status: 403 });
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`Zotero 返回 ${r.status}：${r.body.toString('utf8').slice(0, 120)}`), { status: r.status });
    let data = null; try { data = JSON.parse(r.body.toString('utf8')); } catch { data = r.body.toString('utf8'); }
    return { data, version: +r.headers['last-modified-version'] || 0, total: +r.headers['total-results'] || 0 };
  }
  // the library's version only (cheap: is there anything new?)
  async function version() { return (await get('items/top?limit=1')).version; }

  const canWrite = () => !!cred.key;
  // ask Zotero for a key: a dialog appears in Zotero's window, this waits for the click (up to 10 minutes)
  function authorize() {
    if (authorizing) return authorizing;
    authorizing = (async () => {
      try {
        if (!serverId) await version().catch(() => {});
        const r = await http.request(U('/api/local/authorize'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appName: APP_NAME }), timeoutMs: 10 * 60e3 });
        if (r.status === 403) return { ok: false, msg: '在 Zotero 里点了拒绝' };
        if (r.status === 429) return { ok: false, msg: '请求太频繁，一分钟后再试' };
        if (r.status !== 200) return { ok: false, msg: `Zotero 返回 ${r.status}` };
        const j = JSON.parse(r.body.toString('utf8'));
        if (!j.key) return { ok: false, msg: 'Zotero 没有给出密钥' };
        cred = { key: j.key, remember: !!j.remember, serverId, at: Date.now() };
        saveCred();
        log('文献：已获得 Zotero 写入授权' + (j.remember ? '' : '（一次性）'));
        return { ok: true, remember: !!j.remember };
      } catch (e) { return { ok: false, msg: e.message }; }
      finally { authorizing = null; }
    })();
    return authorizing;
  }

  async function write(method, p, body, extra = {}) {
    if (!cred.key) throw Object.assign(new Error('还没有 Zotero 写入授权'), { need: 'authorize' });
    if (!serverId) await version();
    const isForm = typeof body === 'string' && extra['Content-Type'] === 'application/x-www-form-urlencoded';
    const r = await http.request(U('/api/users/0/' + p.replace(/^\//, '')), { method,
      headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': cred.key, 'Zotero-Server-ID': serverId, ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: body == null ? null : isForm ? body : JSON.stringify(body), timeoutMs: 60e3 });
    if (r.status === 401) {                                      // the key was single-use or revoked
      cred = {}; try { fs.unlinkSync(keyFile); } catch {}
      throw Object.assign(new Error('Zotero 的写入授权失效了，需要重新授权'), { need: 'authorize' });
    }
    if (r.status === 412 && /Server-ID/i.test(r.body.toString('utf8'))) { serverId = ''; }
    let data = null; try { data = JSON.parse(r.body.toString('utf8')); } catch { data = r.body.toString('utf8'); }
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`Zotero 写入失败（${r.status}）：${String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 160)}`), { status: r.status });
    return { status: r.status, data, version: +r.headers['last-modified-version'] || 0 };
  }

  // create items: [itemJSON] -> [key | null] (in order); failures are logged
  async function createItems(items) {
    const r = await write('POST', 'items', items);
    const ok = (r.data && r.data.successful) || {}, bad = (r.data && r.data.failed) || {};
    for (const [i, f] of Object.entries(bad)) log(`文献：Zotero 没收下第 ${+i + 1} 个条目：${f.message || JSON.stringify(f)}`);
    return items.map((_, i) => (ok[i] ? ok[i].key || (ok[i].data && ok[i].data.key) : null));
  }
  // change some fields of an item (PATCH semantics)
  const patchItem = (key, version, fields) => write('PATCH', `items/${key}`, fields, version ? { 'If-Unmodified-Since-Version': String(version) } : {});

  // a PDF (Buffer) as an imported attachment of `parentKey`: the item, then the bytes
  async function attachPdf(parentKey, buf, { filename = 'paper.pdf', url = '', title = 'Full Text PDF' } = {}) {
    const [key] = await createItems([{ itemType: 'attachment', parentItem: parentKey, linkMode: url ? 'imported_url' : 'imported_file', title, url, contentType: 'application/pdf', filename, tags: [], relations: {} }]);
    if (!key) throw new Error('Zotero 没能建立附件条目');
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const fh = { 'Content-Type': 'application/x-www-form-urlencoded', 'If-None-Match': '*' };
    const a = await write('POST', `items/${key}/file`, form({ md5, filename, filesize: buf.length, mtime: Date.now() }), fh);
    if (a.data && a.data.exists) return key;
    const up = await http.request(a.data.url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf, timeoutMs: 120e3 });
    if (up.status !== 201 && up.status !== 200) throw new Error(`上传 PDF 失败（${up.status}）`);
    await write('POST', `items/${key}/file`, form({ upload: a.data.uploadKey }), fh);
    return key;
  }

  return { get, version, canWrite, authorize, authorizing: () => !!authorizing, createItems, patchItem, attachPdf, write, serverId: () => serverId };
}

module.exports = { createLocalApi, APP_NAME };
