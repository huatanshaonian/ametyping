// 我的电脑 / 资源管理器 for one remote computer: its roots (drives or allowed folders), then folder listings.
// Double-click (a tap on touch screens) opens a folder, or a file in a viewer window.
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import * as fsc from '../fs.js';
import * as rpath from '../rpath.js';
import { iconOf, size } from '../filetypes.js';
import { openFile } from './viewer.js';

const touch = matchMedia('(pointer: coarse)').matches;
const views = new Map();                  // machine -> view

const when = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

// open the explorer of a machine (at a folder, or at its roots)
export function open(machine, path = null) {
  const v = views.get(machine);
  if (v) { wm.open({ id: v.id }); if (path) v.load(path); return; }
  views.set(machine, create(machine, path));
}

// something to open from a link: a folder (no extension) in the explorer, anything else in a viewer
export function openPath(machine, path) {
  if (/\.[A-Za-z0-9]{1,8}$/.test(rpath.basename(path))) openFile(machine, path, { name: rpath.basename(path), size: 0 }, openPath);
  else open(machine, path);
}

function create(machine, startPath) {
  const id = 'explorer:' + machine;
  const up = h('button', { class: 'btn', type: 'button', text: '↑ 上一级', title: '上一级 (Backspace)' });
  const refresh = h('button', { class: 'btn', type: 'button', text: '刷新' });
  const addr = h('input', { class: 'field addr', type: 'text', spellcheck: 'false', placeholder: '我的电脑' });
  const body = h('div', { class: 'xbody', tabindex: 0 });
  const status = h('div', { class: 'xstatus' });
  const root = h('div', { class: 'explorer' }, h('div', { class: 'xbar' }, up, refresh, addr), body, status);
  let cur = null, parent = null, seq = 0;

  function setTitle() { win.setTitle(`${machine} — ${cur || '我的电脑'}`); addr.value = cur || ''; up.disabled = cur == null; }
  async function load(path) {
    const my = ++seq;
    status.textContent = '读取中…';
    const r = path == null ? await fsc.roots(machine) : await fsc.list(machine, path);
    if (my !== seq) return;                               // a newer navigation won
    if (!r.ok) { status.textContent = r.msg || '打不开'; return; }
    if (path == null) { cur = null; parent = null; renderRoots(r.roots || []); }
    else { cur = r.path; parent = r.parent; renderList(r.entries || [], r.truncated); }
    setTitle();
    body.scrollTop = 0;
  }
  function activate(el, fn) {
    el.addEventListener('dblclick', fn);
    el.addEventListener('click', () => { for (const x of body.querySelectorAll('.sel')) x.classList.remove('sel'); el.classList.add('sel'); if (touch) fn(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') fn(); });
  }
  function renderRoots(roots) {
    const grid = h('div', { class: 'xroots' }, ...roots.map((r) => {
      const el = h('div', { class: 'xroot', tabindex: 0, title: r.path }, h('img', { src: icon('hard_disk_drive'), alt: '' }), h('span', { text: r.name }));
      activate(el, () => load(r.path));
      return el;
    }));
    body.replaceChildren(roots.length ? grid : h('div', { class: 'notice', text: '这台电脑没有可浏览的位置。' }));
    status.textContent = `${roots.length} 个位置`;
  }
  function renderList(entries, truncated) {
    const rows = entries.map((e) => {
      const tr = h('tr', { tabindex: 0 },
        h('td', { class: 'xn' }, h('div', {}, h('img', { src: icon(iconOf(e), true), alt: '' }), h('span', { text: e.name, title: e.name }))),
        h('td', { class: 'xs', text: e.dir ? '' : size(e.size) }),
        h('td', { class: 'xt', text: when(e.mtime) }));
      activate(tr, () => (e.dir ? load(rpath.join(cur, e.name)) : openFile(machine, rpath.join(cur, e.name), e, openPath)));
      return tr;
    });
    body.replaceChildren(h('table', { class: 'xlist' },
      h('thead', {}, h('tr', {}, h('th', { text: '名称' }), h('th', { class: 'xs', text: '大小' }), h('th', { class: 'xt', text: '修改时间' }))),
      h('tbody', {}, ...rows)));
    status.textContent = `${entries.length} 个项目${truncated ? '（太多了，只显示前 5000 个）' : ''}`;
  }

  up.addEventListener('click', () => load(parent));      // the parent of a root is the root list (null)
  refresh.addEventListener('click', () => load(cur));
  addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const p = addr.value.trim(); load(p || null); } });
  body.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && cur != null) { e.preventDefault(); load(parent); } });

  const win = wm.open({ id, title: `${machine} — 我的电脑`, icon: icon('computer_explorer', true), content: root, width: 720, height: 460,
    onClose: () => views.delete(machine) });
  load(startPath);
  return { id, load };
}
