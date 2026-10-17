// Viewer windows: pictures, PDF (pdfview.js), Word .docx (docx-view.js), Markdown (with the pictures it references), CSV / TSV as a table
// (csv-view.js), text; anything else can be downloaded. Two sources: a remote file, in chunks through the agent
// (openFile; fs.js), or a URL on this server (openUrl -- a mail attachment fetched from the mailbox). A progress line
// shows while it loads.
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import * as fsc from '../fs.js';
import { kindOf, mimeOf, size as fmtSize } from '../filetypes.js';

const MAX = 100 * 1024 * 1024;
const SNIFF_MAX = 2 * 1024 * 1024;        // an unknown file this small is shown as text if it looks like text
const TABLE_MAX = 20 * 1024 * 1024;       // a CSV larger than this is shown as text (a table of it would not fit the page)
const isTable = (name) => /\.(csv|tsv)$/i.test(name);
const ICONS = { image: 'kodak_imaging_file', md: 'document', pdf: 'help_book_big', word: 'document', text: 'notepad_file', other: 'notepad_file' };

async function decodeText(blob) {
  const buf = await blob.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('gb18030').decode(buf); } catch {}   // Chinese Windows files
  return new TextDecoder().decode(buf);
}
async function looksText(blob) {
  const b = new Uint8Array(await blob.slice(0, 8192).arrayBuffer());
  return !b.includes(0);
}

// the window's frame: a bar (where it is from, 下载), the body with a progress line; returns its parts
function frame({ id, title, name, where, kind, onClose }) {
  const urls = [];                                   // object URLs to release on close
  const bar = h('div', { class: 'vprog' }, h('div'));
  const note = h('div', { class: 'vnote', text: '读取中…' });
  const body = h('div', { class: 'vbody' }, note, bar);
  const dl = h('a', { class: 'btn', text: '下载', hidden: true });
  const tools = h('span', { class: 'vtools' });                // what this kind of file offers (a CSV: 表格 / 原文)
  const root = h('div', { class: 'viewer' }, h('div', { class: 'vbar' }, h('span', { class: 'vpath', text: where, title: where }), tools, dl), body);
  const v = { urls, bar, note, body, dl, tools, cleanup: [] };
  wm.open({ id, title, icon: icon(ICONS[kind] || 'notepad_file', true), content: root,
    width: kind === 'image' ? 640 : kind === 'pdf' || kind === 'word' ? 860 : 760, height: kind === 'pdf' || kind === 'word' ? 640 : 520,
    onClose: () => { if (onClose) onClose(); for (const f of v.cleanup) f(); for (const u of urls) URL.revokeObjectURL(u); } });
  v.progress = (got, total) => {
    bar.firstChild.style.width = total ? Math.round((got / total) * 100) + '%' : '100%';
    note.textContent = `读取中… ${fmtSize(got)}${total ? ' / ' + fmtSize(total) : ''}`;
  };
  v.fail = (msg) => { note.textContent = msg || '读取失败'; bar.remove(); };
  return v;
}

// the content, once it is all there; ctx: { machine, path, openPath } for Markdown's relative links
async function show(v, blob, name, kind, ctx = {}) {
  const url = URL.createObjectURL(blob); v.urls.push(url);
  if (!v.dl.getAttribute('href')) Object.assign(v.dl, { href: url, download: name });
  v.dl.hidden = false;
  let k = kind;
  if (k === 'other' && blob.size <= SNIFF_MAX && await looksText(blob)) k = 'text';
  if (k === 'image') {
    const img = h('img', { class: 'vimg', src: url, alt: name, title: '点击切换原始大小' });
    img.addEventListener('click', () => img.classList.toggle('actual'));
    v.body.replaceChildren(img);
  } else if (k === 'pdf') {
    const wrap = h('div', { class: 'pdf-wrap' });
    v.body.replaceChildren(wrap);
    try {
      const { renderPdf } = await import('./pdfview.js');
      const doc = await renderPdf(wrap, await blob.arrayBuffer());
      v.cleanup.push(() => doc.destroy());
    } catch (e) { v.body.replaceChildren(h('div', { class: 'notice' }, `这个 PDF 打不开（${e.message || e}）。`, h('br'), '可以点右上角「下载」用别的程序看。')); }
  } else if (k === 'word') {
    const wrap = h('div', { class: 'docx-wrap' });
    v.body.replaceChildren(wrap);
    try {
      const { renderDocx } = await import('./docx-view.js');
      const d = await renderDocx(wrap, await blob.arrayBuffer());
      v.tools.replaceChildren(h('span', { class: 'vinfo', text: `${d.pages} 页`, title: '按 Word 的版式在网页里画出来，个别复杂排版（公式、文本框、艺术字）可能和 Word 里不完全一样' }));
      const ro = new ResizeObserver(() => d.fit()); ro.observe(wrap);
      v.cleanup.push(() => ro.disconnect());
    } catch (e) { v.body.replaceChildren(h('div', { class: 'notice' }, `这个 Word 文档打不开（${e.message || e}）。`, h('br'), '可以点右上角「下载」用 Word 看。')); }
  } else if (k === 'other' && /\.doc$/i.test(name)) {
    v.body.replaceChildren(h('div', { class: 'notice' }, `${name}（${fmtSize(blob.size)}）是老版 Word 格式（.doc），网页里画不出来。`, h('br'), '可以点右上角「下载」用 Word 打开；在 Word 里另存为 .docx 后就能在这里预览。'));
  } else if (k === 'text' && isTable(name) && blob.size <= TABLE_MAX) {
    const text = await decodeText(blob);
    const { csvTable } = await import('./csv-view.js');
    const t = csvTable(text, name);
    const pre = h('pre', { class: 'vtext', text });
    const as = h('button', { class: 'btn', type: 'button', text: '原文', title: '在表格和原文之间切换' });
    let raw = false;
    as.addEventListener('click', () => { raw = !raw; as.textContent = raw ? '表格' : '原文'; v.body.replaceChildren(raw ? pre : t.el); v.body.scrollTop = 0; });
    v.tools.replaceChildren(h('span', { class: 'vinfo', text: `${t.rows} 行 × ${t.cols} 列 · ${t.sep}分隔` }), as);
    v.body.replaceChildren(t.el);
  } else if (k === 'text') {
    v.body.replaceChildren(h('pre', { class: 'vtext', text: await decodeText(blob) }));
  } else if (k === 'md') {
    const { renderMd } = await import('./md.js');
    const doc = h('div', { class: 'md' });
    v.body.replaceChildren(doc);
    await renderMd(doc, await decodeText(blob), { machine: ctx.machine, path: ctx.path, urls: v.urls, openPath: (p) => ctx.openPath && ctx.openPath(ctx.machine, p) });
  } else {
    v.body.replaceChildren(h('div', { class: 'notice' }, `${name}（${fmtSize(blob.size)}）`, h('br'), '这种文件不能在网页里预览，可以点右上角「下载」。'));
  }
}

// open a remote file; openPath(machine, path) follows relative links found in Markdown
export function openFile(machine, path, entry, openPath) {
  const id = 'view:' + machine + ':' + path;
  if (wm.has(id)) { wm.open({ id }); return; }
  const name = entry.name, kind = kindOf(name);
  let job = null;
  const v = frame({ id, title: `${name} — ${machine}`, name, where: path, kind, onClose: () => { if (job) job.cancel(); } });
  if (entry.size > MAX) { v.fail('文件过大（超过 100 MB），无法打开'); return; }
  job = fsc.read(machine, path, v.progress, mimeOf(name));
  job.promise.then(async (r) => {
    job = null;
    if (!r.ok) return v.fail(r.msg);
    await show(v, r.blob, name, kind, { machine, path, openPath });
  });
}

// open what a URL on this server gives (a mail attachment): { id, title, name, where, url, download (URL for 下载) }
export function openUrl({ id, title, name, where, url, download }) {
  if (wm.has(id)) { wm.open({ id }); return; }
  const kind = kindOf(name), ctl = new AbortController();
  const v = frame({ id, title, name, where, kind, onClose: () => ctl.abort() });
  if (download) Object.assign(v.dl, { href: download, download: name });
  (async () => {
    let res;
    try { res = await fetch(url, { signal: ctl.signal }); } catch { return v.fail('读取失败'); }
    if (!res.ok) { let msg = ''; try { msg = (await res.json()).error; } catch {} return v.fail(msg || '读取失败（' + res.status + '）'); }
    const total = +res.headers.get('Content-Length') || 0, parts = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      let r; try { r = await reader.read(); } catch { return v.fail('读取中断了'); }
      if (r.done) break;
      parts.push(r.value); got += r.value.length; v.progress(got, total);
      if (got > MAX) { ctl.abort(); return v.fail('文件过大（超过 100 MB），无法打开'); }
    }
    await show(v, new Blob(parts, { type: res.headers.get('Content-Type') || mimeOf(name) }), name, kind);
  })();
}
