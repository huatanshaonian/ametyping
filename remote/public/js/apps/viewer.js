// Viewer windows for remote files: pictures, Markdown (with the pictures it references), text; anything else can be
// downloaded. The file comes in chunks through the agent (fs.js); a progress line shows while it loads.
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import * as fsc from '../fs.js';
import { kindOf, mimeOf, size as fmtSize } from '../filetypes.js';

const MAX = 100 * 1024 * 1024;
const SNIFF_MAX = 2 * 1024 * 1024;        // an unknown file this small is shown as text if it looks like text

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

// open a remote file; openPath(machine, path) follows relative links found in Markdown
export function openFile(machine, path, entry, openPath) {
  const id = 'view:' + machine + ':' + path;
  if (wm.has(id)) { wm.open({ id }); return; }
  const name = entry.name, kind = kindOf(name);
  const urls = [];                                   // object URLs to release on close
  const bar = h('div', { class: 'vprog' }, h('div'));
  const note = h('div', { class: 'vnote', text: '读取中…' });
  const body = h('div', { class: 'vbody' }, note, bar);
  const dl = h('a', { class: 'btn', text: '下载', hidden: true });
  const root = h('div', { class: 'viewer' }, h('div', { class: 'vbar' }, h('span', { class: 'vpath', text: path, title: path }), dl), body);
  const iconName = { image: 'kodak_imaging_file', md: 'document', text: 'notepad_file', other: 'notepad_file' }[kind];
  let job = null;
  wm.open({ id, title: `${name} — ${machine}`, icon: icon(iconName, true), content: root,
    width: kind === 'image' ? 640 : 760, height: 520,
    onClose: () => { if (job) job.cancel(); for (const u of urls) URL.revokeObjectURL(u); } });

  if (entry.size > MAX) { note.textContent = '文件过大（超过 100 MB），无法打开'; bar.remove(); return; }
  job = fsc.read(machine, path, (got, total) => {
    bar.firstChild.style.width = total ? Math.round((got / total) * 100) + '%' : '100%';
    note.textContent = `读取中… ${fmtSize(got)}${total ? ' / ' + fmtSize(total) : ''}`;
  }, mimeOf(name));
  job.promise.then(async (r) => {
    job = null;
    if (!r.ok) { note.textContent = r.msg || '读取失败'; bar.remove(); return; }
    const url = URL.createObjectURL(r.blob); urls.push(url);
    Object.assign(dl, { href: url, download: name }); dl.hidden = false;
    let k = kind;
    if (k === 'other' && r.size <= SNIFF_MAX && await looksText(r.blob)) k = 'text';
    if (k === 'image') {
      const img = h('img', { class: 'vimg', src: url, alt: name, title: '点击切换原始大小' });
      img.addEventListener('click', () => img.classList.toggle('actual'));
      body.replaceChildren(img);
    } else if (k === 'text') {
      body.replaceChildren(h('pre', { class: 'vtext', text: await decodeText(r.blob) }));
    } else if (k === 'md') {
      const { renderMd } = await import('./md.js');
      const doc = h('div', { class: 'md' });
      body.replaceChildren(doc);
      await renderMd(doc, await decodeText(r.blob), { machine, path, urls, openPath: (p) => openPath && openPath(machine, p) });
    } else {
      body.replaceChildren(h('div', { class: 'notice' }, `${name}（${fmtSize(r.size)}）`, h('br'), '这种文件不能在网页里预览，可以点右上角「下载」。'));
    }
  });
}
