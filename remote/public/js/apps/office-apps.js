// Word / Excel / PowerPoint on the desktop: a start box in the manner of Office 97 -- 新建 a blank document (saved on a
// computer first, from public/tpl, then edited), 打开 one from a computer (filedlg.js), or one of 最近的文档
// (office-recent.js). The editing itself is office.js (OnlyOffice on the NAS); without it set up, the box says so.
import { h, icon, ago } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import * as rpath from '../rpath.js';
import * as fsc from '../fs.js';
import { upload } from '../fs-upload.js';
import { kindOf, mimeOf } from '../filetypes.js';
import { pickFile, pickSave } from './filedlg.js';
import * as recent from './office-recent.js';
import * as office from './office.js';

const EDITABLE = /\.(docx|xlsx|pptx)$/i;
const MAX = 100 * 1024 * 1024;             // as the viewer: larger files are not read into the page
export const APPS = {
  word: { label: 'Word', what: '文档', ext: 'docx', kind: 'word', blank: '新建文档', hint: '新建、打开、编辑 Word 文档（docx），存在网上邻居的电脑上' },
  excel: { label: 'Excel', what: '工作簿', ext: 'xlsx', kind: 'sheet', blank: '新建工作簿', hint: '新建、打开、编辑 Excel 表格（xlsx），存在网上邻居的电脑上' },
  powerpoint: { label: 'PowerPoint', what: '演示文稿', ext: 'pptx', kind: 'slides', blank: '新建演示文稿', hint: '新建、打开、编辑 PowerPoint 演示文稿（pptx），存在网上邻居的电脑上' },
};
const fits = (a) => (name) => kindOf(name) === a.kind && EDITABLE.test(name);

// current(): the computer the desktop shows (offered first in the dialogs)
export function open(key, current = () => null) {
  const a = APPS[key], id = 'office-app:' + key;
  if (wm.has(id)) { wm.open({ id }); return; }
  const msg = h('div', { class: 'oa-msg' });
  const say = (t, bad) => { msg.textContent = t || ''; msg.classList.toggle('bad', !!bad); };
  const newBtn = h('button', { class: 'oa-big', type: 'button' },
    h('img', { src: icon(key), alt: '' }), h('b', { text: `新建空白${a.what}` }), h('small', { text: '先选好存在哪台电脑的哪个文件夹' }));
  const openBtn = h('button', { class: 'oa-big', type: 'button' },
    h('img', { src: icon('directory_open_cool'), alt: '' }), h('b', { text: `打开${a.what}…` }), h('small', { text: `从网上邻居的电脑上选一个 .${a.ext}` }));
  const recentEl = h('div', { class: 'oa-recent' });
  const root = h('div', { class: 'office-app' },
    h('div', { class: 'oa-head' }, h('img', { src: icon(key), alt: '' }), h('div', {}, h('b', { text: a.label }), h('small', { text: '在线编辑，保存后写回原来那台电脑' }))),
    h('div', { class: 'oa-acts' }, newBtn, openBtn),
    h('div', { class: 'oa-sub', text: `最近的${a.what}` }), recentEl, msg);
  wm.open({ id, title: a.label, icon: icon(key, true), content: root, width: 520, height: 480, onClose: () => off() });

  // can it edit at all (the document service on the NAS)
  async function ready() {
    const s = await office.available();
    if (!s.on) { say('服务器上还没有装文档服务（OnlyOffice），现在只能在「我的电脑」里预览，不能编辑', true); return false; }
    if (!s.up) { say('文档服务现在没有运行，过一会再试', true); return false; }
    return true;
  }
  // read a file from its computer, then into the editor
  async function edit(machine, path, name, size = 0) {
    if (!(await ready())) return;
    if (size > MAX) return say('文件过大（超过 100 MB），打不开', true);
    say(`正在从 ${machine} 读取 ${name}…`);
    const job = fsc.read(machine, path, (got, total) => say(`正在从 ${machine} 读取 ${name}：${Math.round((got / (total || 1)) * 100)}%`), mimeOf(name));
    const r = await job.promise;
    if (!r.ok) { say(`读不到 ${name}（${r.msg}）`, true); return false; }
    say('');
    office.editFile({ machine, path, name, blob: r.blob });
    renderRecent();
    return true;
  }

  newBtn.addEventListener('click', async () => {
    if (!(await ready())) return;
    const at = await pickSave({ title: `新建${a.what} — 存到哪里`, name: `${a.blank}.${a.ext}`, ext: a.ext, icon16: key + '-doc', machine: current() });
    if (!at) return;
    say(`正在 ${at.machine} 上建立 ${at.name}…`);
    let blob;
    try { const res = await fetch(`/tpl/blank.${a.ext}`); if (!res.ok) throw new Error(res.status); blob = await res.blob(); }
    catch { return say('取不到空白模板，刷新页面再试', true); }
    const file = new File([blob], at.name, { type: mimeOf(at.name), lastModified: Date.now() });
    const r = await upload(at.machine, at.dir, file, { overwrite: false, progress: () => {}, waiting: (m) => say(m) }).promise;
    if (!r.ok) return say(r.exists ? `${at.machine} 上已经有「${at.name}」了，换个名字` : `没能在 ${at.machine} 上建立（${r.msg || '失败'}）`, true);
    say('');
    office.editFile({ machine: at.machine, path: rpath.join(at.dir, at.name), name: at.name, blob: file });
    renderRecent();
  });
  openBtn.addEventListener('click', async () => {
    if (!(await ready())) return;
    const f = await pickFile({ title: `打开${a.what}`, accept: fits(a), icon16: key + '-doc', machine: current() });
    if (f) edit(f.machine, f.path, f.entry.name, f.entry.size);
  });

  function renderRecent() {
    const ms = new Map(net.state.sessions.map((m) => [m.machine, m]));
    const items = recent.list(fits(a)).slice(0, 12);
    if (!items.length) return recentEl.replaceChildren(h('div', { class: 'oa-none', text: `还没有编辑过${a.what}。新建一个，或者打开一个已有的。` }));
    recentEl.replaceChildren(...items.map((x) => {
      const m = ms.get(x.machine), can = !!(m && m.online && m.files);
      const row = h('div', { class: 'oa-row' + (can ? '' : ' off'), title: can ? x.path : `${x.machine} 现在${m && m.online ? '没开放文件' : '离线'}` },
        h('img', { src: icon(key + '-doc', true), alt: '' }),
        h('span', { class: 'oa-n' }, h('b', { text: x.name }), h('small', { text: `${x.machine} · ${rpath.dirname(x.path)}` })),
        h('span', { class: 'oa-t', text: ago(x.at) }),
        h('button', { class: 'oa-x', type: 'button', text: '×', title: '从列表里去掉（不删文件）' }));
      row.querySelector('.oa-x').addEventListener('click', (e) => { e.stopPropagation(); recent.forget(x.machine, x.path); renderRecent(); });
      row.addEventListener('click', async () => {
        if (!can) return say(row.title, true);
        const ok = await edit(x.machine, x.path, x.name);
        if (ok === false && /不存在|找不到|ENOENT/.test(msg.textContent)) say(msg.textContent + '：可能已经移走或删掉了，点 × 从列表里去掉', true);
      });
      return row;
    }));
  }
  const off = net.on('sessions', renderRecent);
  renderRecent();
  ready();
}
