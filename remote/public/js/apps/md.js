// Markdown in a viewer window: rendered with marked, cleaned with DOMPurify (no scripts, forms, frames, inline
// styles), then the pictures it references by relative path are fetched from the same remote folder -- the part a
// plain file manager cannot do. Pictures on the internet are not loaded (the page never talks to other sites).
// LaTeX formulas ($$…$$, $…$, \[…\], \(…\)) are drawn by KaTeX (md-math.js).
import { Marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.js';
import { h } from '../util.js';
import * as fsc from '../fs.js';
import * as rpath from '../rpath.js';
import { mimeOf } from '../filetypes.js';
import { createMath, drawMath } from './md-math.js';

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

async function pool(items, n, fn) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
}

export async function renderMd(el, text, { machine, path, urls, openPath }) {
  const math = createMath();
  const html = new Marked({ gfm: true }, { extensions: math.extensions }).parse(text);       // (an instance per page: its own formulas)
  const frag = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style'], RETURN_DOM_FRAGMENT: true });
  // the pictures' addresses come off while the HTML is still inert: in the page the browser would at once ask this
  // server for "img/mesh.png" (a 404) before the picture is fetched from the remote folder below
  const pics = [];
  for (const img of frag.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (/^data:image\//i.test(src)) continue;
    img.removeAttribute('src');
    pics.push({ img, src });
  }
  el.replaceChildren(frag);
  await drawMath(el, math.found);
  const dir = rpath.dirname(path);
  const local = (ref) => {
    const r = decodeURI(ref.split(/[?#]/)[0]);
    return r.startsWith('/') && !rpath.isWin(path) ? r : rpath.resolve(dir, r);   // POSIX absolute paths stay as they are
  };

  // links: in-page anchors as they are, the internet in a new tab, relative ones open the remote file / folder
  for (const a of el.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) continue;
    if (EXTERNAL.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; continue; }
    a.addEventListener('click', (e) => { e.preventDefault(); openPath(local(href)); });
    a.title = local(href);
  }

  // pictures: relative ones from the remote folder, internet ones named but not loaded
  const imgs = [];
  for (const { img, src } of pics) {
    if (EXTERNAL.test(src)) { img.replaceWith(h('span', { class: 'mdimg-note', text: `［外链图片未加载：${img.alt || src}］`, title: src })); continue; }
    img.classList.add('loading'); img.alt = img.alt || src;
    imgs.push({ img, target: local(src), src });
  }
  await pool(imgs, 3, async ({ img, target, src }) => {
    const r = await fsc.read(machine, target, null, mimeOf(target)).promise;
    if (!r.ok) { img.replaceWith(h('span', { class: 'mdimg-note', text: `［图片读取失败：${src}（${r.msg}）］` })); return; }
    const url = URL.createObjectURL(r.blob); urls.push(url);
    img.src = url; img.classList.remove('loading');
  });
}
