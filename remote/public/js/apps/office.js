// 编辑 a Word / Excel / PowerPoint file of a computer in OnlyOffice (the server's office/; a container on the NAS).
// The viewer hands over the file it already read; the server keeps it and gives back a signed editor config, and the
// editor (its pages under /office) opens in this window. Each time the editor saves -- its Save button / Ctrl+S, and
// once more when it is closed with changes -- the server says so ({t:'office'}), and this page writes that version
// back over the file on the computer through the ordinary upload (fs-upload.js: the code check, the CRC). So the
// page that opened the editor has to stay open until the last version is written; the window itself may be closed.
import { h, icon, hhmm } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import { upload } from '../fs-upload.js';
import { mimeOf } from '../filetypes.js';

const edits = new Map();                  // server id -> { machine, path, name, win, say, wrote, changed, open, chain }
let status = null;                        // the server's answer to GET /api/office (asked again after a minute)

// -> { on, up }: editing is set up on the server, the document service answers
export async function available() {
  if (status && Date.now() - status.at < 60e3) return status.p;
  const p = fetch('/api/office').then((r) => r.ok ? r.json() : { on: false }).catch(() => ({ on: false }));
  status = { at: Date.now(), p };
  return p;
}

let apiP = null;
function loadApi(src) {
  if (window.DocsAPI) return Promise.resolve();
  if (!apiP) apiP = new Promise((resolve, reject) => {
    const s = h('script', { src });
    s.onload = () => window.DocsAPI ? resolve() : reject(new Error('编辑器没有加载出来'));
    s.onerror = () => { apiP = null; s.remove(); reject(new Error('编辑器加载失败')); };
    document.head.append(s);
  });
  return apiP;
}

// the folder a path is in, as the computer writes it ('C:\a.docx' -> 'C:\', '/a.docx' -> '/')
function dirOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i < 0) return p;
  const d = p.slice(0, i);
  return d === '' ? p[0] : /^[A-Za-z]:$/.test(d) ? d + '\\' : d;
}

// a word in the corner, for when the window is gone
function toast(text, bad) {
  const t = h('div', { class: 'office-toast' + (bad ? ' bad' : ''), text });
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 12e3 : 5e3);
}

async function writeBack(e, v, final) {
  if (v <= e.wrote) return;
  e.say(`正在存回 ${e.machine}…`);
  let blob;
  try { const r = await fetch(`/api/office/file?id=${e.id}&v=${v}`); if (!r.ok) throw new Error(r.status); blob = await r.blob(); }
  catch { return e.say('取不到编辑器保存的这一版', true); }
  const file = new File([blob], e.name, { type: mimeOf(e.name), lastModified: Date.now() });
  const job = upload(e.machine, dirOf(e.path), file, { overwrite: true,
    progress: (have, size, checking) => e.say(checking ? `存回 ${e.machine}：那台电脑在校验…` : `存回 ${e.machine}：${Math.round((have / (size || 1)) * 100)}%`),
    waiting: (m) => e.say(`存回 ${e.machine}：${m}`) });
  const r = await job.promise;
  e.dl(`/api/office/file?id=${e.id}&v=${v}`);
  if (!r.ok) return e.say(`没能存回 ${e.machine}（${r.msg || '失败'}）。可以点「下载」把这一版存下来`, true);
  e.wrote = v;
  if (v === e.saved) e.changed = false;
  e.say(`${hhmm(Date.now())} 已存回 ${e.machine}${final ? '' : '，可以接着改'}`);
  if (!e.open) toast(`「${e.name}」的修改已存回 ${e.machine}`);
}

net.on('office', (d) => {
  const e = edits.get(d.id);
  if (!e) return;
  if (d.msg) { e.say(d.msg, true); if (!e.open) toast(`「${e.name}」：${d.msg}`, true); }
  else if (d.v) { e.saved = d.v; e.chain = e.chain.then(() => writeBack(e, d.v, d.final)); }
  if (d.final || d.closed) e.chain.then(() => { if (!e.open) edits.delete(d.id); e.closed = true; });
});

// open the editor on a file read from a computer; blob: its content
export function editFile({ machine, path, name, blob }) {
  const win = 'office:' + machine + ':' + path;
  if (wm.has(win)) { wm.open({ id: win }); return; }
  const state = h('span', { class: 'vinfo office-state', text: '打开编辑器…' });
  const dl = h('a', { class: 'btn', text: '下载', hidden: true, title: '编辑器最后保存的这一版' });
  const holder = h('div', { id: 'oo-' + Math.random().toString(36).slice(2) });
  const body = h('div', { class: 'vbody office-body' }, holder);
  const root = h('div', { class: 'viewer office' }, h('div', { class: 'vbar' }, h('span', { class: 'vpath', text: path, title: path }), state, dl), body);
  let editor = null, e = null;
  wm.open({ id: win, title: `编辑 ${name} — ${machine}`, icon: icon('document', true), content: root, width: 1000, height: 700,
    onClose: () => {
      window.removeEventListener('blur', focusIn);
      try { if (editor) editor.destroyEditor(); } catch {}
      if (!e) return;
      e.open = false;
      if (e.closed) edits.delete(e.id);
      else if (e.changed) toast(`「${name}」关掉了，编辑器保存好最后的修改后会自动存回 ${machine}（十几秒），这期间别关这个页面`);
    } });
  const say = (text, bad) => { state.textContent = text; state.classList.toggle('bad', !!bad); };
  // a click in the editor's frame does not reach this page: bring its window to the front when the frame takes focus
  const focusIn = () => setTimeout(() => { const f = body.querySelector('iframe'); if (f && document.activeElement === f) wm.focus(win); }, 0);
  window.addEventListener('blur', focusIn);

  (async () => {
    let r;
    try {
      const q = new URLSearchParams({ machine, path, name });
      const res = await fetch('/api/office/open?' + q, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
      r = await res.json();
    } catch { r = { ok: false, msg: '连不上服务器' }; }
    if (!r.ok) return say(r.msg || '打不开编辑器', true);
    try { await loadApi(r.api); } catch (err) { return say(err.message, true); }
    if (!wm.has(win)) return;                                       // closed meanwhile
    e = { id: r.id, machine, path, name, win, say, wrote: 0, saved: 0, changed: false, open: true, closed: false, chain: Promise.resolve(),
      dl: (href) => { Object.assign(dl, { href, download: name }); dl.hidden = false; } };
    edits.set(r.id, e);
    const phone = matchMedia('(pointer: coarse)').matches && innerWidth < 800;
    // (on a slow connection the editor's own files can time out loading, and it then never says it is ready)
    const slow = setTimeout(() => { if (wm.has(win)) say('编辑器还没加载出来，网络可能太慢：关掉这个窗口再点一次「编辑」', true); }, 90e3);
    editor = new window.DocsAPI.DocEditor(holder.id, { ...r.config, type: phone ? 'mobile' : 'desktop', width: '100%', height: '100%',
      events: {
        onAppReady: () => { clearTimeout(slow); say(`编辑中 · 点编辑器里的「保存」或按 Ctrl+S 存回 ${machine}`); },
        onDocumentStateChange: (ev) => { if (ev && ev.data) e.changed = true; },
        onError: (ev) => say('编辑器出错：' + ((ev && ev.data && (ev.data.errorDescription || ev.data.errorCode)) || '未知'), true),
      } });
  })();
}
