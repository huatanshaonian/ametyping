// 打开 / 另存为 in the manner of Windows 98, over the computers' files (fs.js): the computer, the folder you are in, its
// folders and the files that fit. pickFile -> { machine, path, entry } | null; pickSave -> { machine, dir, name } | null
// (a folder that may be written to: the computer allows uploads and it is not a read-only place). Where each computer
// was last is remembered in this browser.
import { h, icon, prefs } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import * as rpath from '../rpath.js';
import * as fsc from '../fs.js';
import { size as fmtSize } from '../filetypes.js';

const when = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const lastDir = (m) => prefs.get('filedlg.dir', {})[m] || null;
const keepDir = (m, dir) => { const o = prefs.get('filedlg.dir', {}); o[m] = dir; prefs.set('filedlg.dir', o); };

// choose a file: accept(name) -> whether it is shown; icon16: the icon of such files
export function pickFile({ title, accept, icon16, machine }) {
  return dialog({ mode: 'open', title, accept, icon16, machine });
}
// choose where to save: name, the name offered; ext: what it must end with
export function pickSave({ title, name, ext, icon16, machine }) {
  return dialog({ mode: 'save', title, name, ext, icon16, machine, accept: (n) => n.toLowerCase().endsWith('.' + ext) });
}

function dialog(o) {
  return new Promise((resolve) => {
    const id = 'filedlg';
    if (wm.has(id)) wm.close(id);
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); if (wm.has(id)) wm.close(id); };
    const saving = o.mode === 'save';
    const usable = (m) => m.online && m.files && (!saving || m.upload);
    const pcs = h('select', { class: 'field fd-pc', title: '网上邻居里的电脑' });
    const up = h('button', { class: 'btn', type: 'button', text: '↑', title: '上一级' });
    const where = h('input', { class: 'field fd-where', type: 'text', spellcheck: 'false', placeholder: '我的电脑', title: '可以直接输入路径后回车' });
    const listEl = h('div', { class: 'fd-list', tabindex: '0' });
    const nameIn = h('input', { class: 'field fd-name', type: 'text', spellcheck: 'false', value: o.name || '' });
    const ok = h('button', { class: 'btn go', type: 'button', text: saving ? '保存' : '打开' });
    const cancel = h('button', { class: 'btn', type: 'button', text: '取消' });
    const msg = h('div', { class: 'fd-msg' });
    const root = h('div', { class: 'filedlg' },
      h('div', { class: 'fd-bar' }, h('label', { text: '电脑' }), pcs, up),
      h('div', { class: 'fd-bar' }, h('label', { text: '位置' }), where),
      listEl,
      h('div', { class: 'fd-foot' }, h('label', { text: '文件名' }), nameIn, ok, cancel),
      msg);
    if (!saving) nameIn.readOnly = true;
    wm.open({ id, title: o.title, icon: icon(saving ? 'directory_open_cool' : 'directory_closed', true), content: root, width: 560, height: 420,
      onClose: () => { offSessions(); finish(null); } });

    let machine = null, dir = null, parent = null, sep = '/', rootsList = [], entries = [], chosen = null, seq = 0;
    const say = (t, bad) => { msg.textContent = t || ''; msg.classList.toggle('bad', !!bad); };
    // the opened place a folder is in (the longest one holding it)
    const inside = (p, r) => { const b = r.replace(/[\\/]+$/, ''); return p === r || p === b || p.startsWith(b + sep); };
    const rootOf = (p) => rootsList.filter((r) => inside(p, r.path)).sort((a, b) => b.path.length - a.path.length)[0] || null;
    const writable = () => dir != null && !(rootOf(dir) || {}).readOnly;

    function renderPcs() {
      const ms = net.state.sessions;
      pcs.replaceChildren(...ms.map((m) => h('option', { value: m.machine, disabled: !usable(m),
        text: m.machine + (!m.online ? '（离线）' : !m.files ? '（未开放文件）' : saving && !m.upload ? '（不能写入）' : '') })));
      if (machine) pcs.value = machine;
    }
    const offSessions = net.on('sessions', renderPcs);

    async function go(path) {
      const my = ++seq;
      chosen = null; ok.disabled = !saving;
      listEl.replaceChildren(h('div', { class: 'fd-empty', text: '读取中…' }));
      say('');
      if (path == null) {
        const r = await fsc.roots(machine);
        if (my !== seq) return;
        if (!r.ok) { listEl.replaceChildren(); return say(r.msg, true); }
        rootsList = r.roots || [];
        dir = null; where.value = ''; up.disabled = true;
        entries = rootsList.map((x) => ({ name: x.name, path: x.path, dir: true, root: true, readOnly: x.readOnly }));
        return render();
      }
      const r = await fsc.list(machine, path);
      if (my !== seq) return;
      if (!r.ok) { listEl.replaceChildren(); if (dir == null && path === lastDir(machine)) return go(null); return say(r.msg, true); }
      dir = r.path || path; parent = r.parent || null; sep = r.sep || sep; where.value = dir; up.disabled = false;
      keepDir(machine, dir);
      entries = (r.entries || []).filter((e) => e.dir || o.accept(e.name)).map((e) => ({ ...e, path: rpath.join(dir, e.name) }))
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      render();
      if (saving && !writable()) say('这个位置只读，换一个文件夹', true);
    }

    function render() {
      if (!entries.length) return listEl.replaceChildren(h('div', { class: 'fd-empty', text: dir == null ? '这台电脑没有开放的位置' : '这里没有合适的文件' }));
      listEl.replaceChildren(...entries.map((e) => {
        const row = h('div', { class: 'fd-row' + (e.dir ? ' dir' : '') },
          h('img', { src: icon(e.root ? 'hard_disk_drive' : e.dir ? 'directory_closed' : o.icon16, true), alt: '' }),
          h('span', { class: 'fd-n', text: e.name, title: e.path }),
          h('span', { class: 'fd-s', text: e.root ? (e.readOnly ? '只读' : '') : e.dir ? '' : fmtSize(e.size) }),
          h('span', { class: 'fd-t', text: e.mtime ? when(e.mtime) : '' }));
        row.entry = e;
        row.addEventListener('click', () => select(row));
        row.addEventListener('dblclick', () => (e.dir ? go(e.path) : accept()));
        return row;
      }));
    }
    function select(row) {
      for (const r of listEl.querySelectorAll('.fd-row.sel')) r.classList.remove('sel');
      row.classList.add('sel');
      if (row.entry.dir) { if (!saving) { chosen = null; ok.disabled = true; } return; }
      chosen = row.entry; nameIn.value = row.entry.name; ok.disabled = false;
    }

    async function accept() {
      if (!saving) { if (chosen) finish({ machine, path: chosen.path, entry: chosen }); return; }
      const sel = listEl.querySelector('.fd-row.sel.dir');
      if (sel && document.activeElement !== nameIn && !nameIn.value.trim()) return go(sel.entry.path);
      if (dir == null) return say('先进入一个文件夹', true);
      if (!writable()) return say('这个位置只读，换一个文件夹', true);
      let name = nameIn.value.trim().replace(/[\\/:*?"<>|]+/g, '_');
      if (!name || name === '.' + o.ext) return say('写一个文件名', true);
      if (!name.toLowerCase().endsWith('.' + o.ext)) name += '.' + o.ext;
      const r = await fsc.list(machine, dir);
      if (r.ok && (r.entries || []).some((e) => e.name.toLowerCase() === name.toLowerCase())) return say(`这里已经有「${name}」了，换个名字`, true);
      finish({ machine, dir, name });
    }

    pcs.addEventListener('change', () => { machine = pcs.value; start(); });
    up.addEventListener('click', () => { if (dir != null) go(parent); });
    where.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const p = where.value.trim(); go(p || null); } });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') accept(); });
    listEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const s = listEl.querySelector('.fd-row.sel'); if (s) (s.entry.dir ? go(s.entry.path) : accept()); }
      else if (e.key === 'Backspace') up.click();
    });
    ok.addEventListener('click', accept);
    cancel.addEventListener('click', () => finish(null));

    renderPcs();
    const ms = net.state.sessions;
    const first = ms.find((m) => m.machine === o.machine && usable(m)) || ms.find(usable);
    if (!first) { listEl.replaceChildren(); return say(saving ? '没有在线、而且允许写入文件的电脑（agent.json 的 files 里要有 "upload": true）' : '没有在线、开放了文件浏览的电脑', true); }
    machine = first.machine; pcs.value = machine;
    start();
    // (the roots first: which places are read-only)
    function start() {
      const m = machine;
      dir = null; parent = null;
      listEl.replaceChildren(h('div', { class: 'fd-empty', text: '读取中…' }));
      fsc.roots(m).then((r) => { if (m !== machine) return; rootsList = (r.ok && r.roots) || []; go(lastDir(m)); });
    }
  });
}
