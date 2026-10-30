// 我的电脑 / 资源管理器 for one remote computer: its roots (drives or allowed folders), then folder listings.
// Double-click (a tap on touch screens) opens a folder, or a file in a viewer window. In a folder, Claude Code or Codex
// can be started there (a new session on that computer: tmux on Linux, a Windows Terminal window on Windows). 下载
// saves the file picked in the list to this device without opening it (download.js); a folder picked, all that is in
// it, as one .zip (download-folder.js). 上传 (or files dropped on the window) puts files from this device into the
// folder open, where that computer's agent allows it (upload.js).
// Each folder can also carry dual-track notes on the NAS (fs-catalog.js): a role tag (e.g. CEM求解器, 求解结果),
// "我的备注" (user note) and "AI 备注" (AI note), plus a cached shallow directory tree for fast project planning.
import { h, icon, prefs, $ as $q } from '../util.js';
import * as wm from '../wm.js';
import * as fsc from '../fs.js';
import * as catalog from '../fs-catalog.js';
import * as ctx from '../ctxmenu.js';
import * as net from '../net.js';
import * as rpath from '../rpath.js';
import { iconOf, size } from '../filetypes.js';
import { openFile } from './viewer.js';
import { download } from './download.js';
import { downloadFolder } from './download-folder.js';
import { uploadFiles } from './upload.js';

const touch = matchMedia('(pointer: coarse)').matches;
const views = new Map();                  // machine -> view
let switchTo = (m) => open(m);            // main.js: pick that computer (网上邻居, the desktop) and open its 我的电脑
export function setSwitch(fn) { switchTo = fn; }

const when = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

// Modal dialog for editing a folder's role tag, User Note ("我的备注") and AI Note ("AI 备注")
export function openNoteDialog(machine, folderPath) {
  return new Promise((resolve) => {
    const existing = catalog.get(machine, folderPath) || {};
    const tags = catalog.tagMap();
    const tagSel = h('select', { class: 'field' },
      h('option', { value: '', text: '（无特定标签）' }),
      ...Object.entries(tags).map(([k, label]) => h('option', { value: k, text: `${label} (${k})` })),
      h('option', { value: '__custom__', text: '自定义标签…' })
    );
    const customTag = h('input', { class: 'field', type: 'text', maxlength: 40, placeholder: '输入自定义标签（如：FEKO模型库）', hidden: true });
    if (existing.tag && !tags[existing.tag]) {
      tagSel.value = '__custom__';
      customTag.value = existing.tag;
      customTag.hidden = false;
    } else {
      tagSel.value = existing.tag || '';
    }
    tagSel.addEventListener('change', () => {
      customTag.hidden = tagSel.value !== '__custom__';
      if (!customTag.hidden) customTag.focus();
    });

    const userArea = h('textarea', { class: 'field xnote-ta', rows: 3, maxlength: 2000, placeholder: '我的备注（最高优先级，AI 只读不可覆盖。例如：CEM求解器主代码库 / G盘大体积结果存放处）' });
    userArea.value = existing.userNote || '';
    const aiArea = h('textarea', { class: 'field xnote-ta', rows: 3, maxlength: 2000, placeholder: 'AI 备注（AI 在此目录工作后可自动总结环境、入口脚本与产物规律，你也可以手动修改）' });
    aiArea.value = existing.aiNote || '';

    const snapInfo = existing.snapshot
      ? `已缓存目录树（${existing.snapshot.count || 0} 项${existing.snapshot.gitBranch ? ` · Git: ${existing.snapshot.gitBranch}` : ''}${existing.snapshot.freeBytes != null ? ` · 可用空间: ${size(existing.snapshot.freeBytes)}` : ''}）`
      : '保存后将自动向群晖同步该文件夹的浅层目录结构树';

    const done = (v) => { wrap.remove(); resolve(v); };
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '文件夹备注与项目标签' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: () => done(null) })),
      h('div', { class: 'dlgb' },
        h('div', { class: 'xnote-path', text: `${machine} : ${folderPath}` }),
        h('label', { class: 'xnote-lbl', text: '角色标签（关联项目语义）：' }),
        tagSel,
        customTag,
        h('label', { class: 'xnote-lbl', text: '我的备注（人工指令与说明）：' }),
        userArea,
        h('label', { class: 'xnote-lbl', text: 'AI 备注（AI 自动维护的环境与结构摘要）：' }),
        aiArea,
        h('div', { class: 'xnote-snap', text: snapInfo }),
        h('div', { class: 'dlga' },
          existing.tag || existing.userNote || existing.aiNote
            ? h('button', { class: 'btn no', type: 'button', text: '清除备注', onclick: async () => {
                await catalog.setNote({ machine, path: folderPath, tag: '', userNote: '', aiNote: '' });
                done(true);
              } })
            : null,
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => done(null) }),
          h('button', { class: 'btn go', type: 'submit', text: '保存并同步结构树' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const tag = tagSel.value === '__custom__' ? customTag.value.trim() : tagSel.value;
      await catalog.setNote({ machine, path: folderPath, tag, userNote: userArea.value.trim(), aiNote: aiArea.value.trim() });
      done(true);
    });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    const wrap = h('div', { class: 'dlg' }, form);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(null); });
    document.body.append(wrap);
    userArea.focus();
  });
}

// open the explorer of a machine (at a folder, or at its roots); pick: the name of an entry there to select and show
export function open(machine, path = null, pick = null) {
  const v = views.get(machine);
  if (v) { wm.open({ id: v.id }); if (path) v.load(path, false, pick); return; }
  views.set(machine, create(machine, path, pick));
}

// something to open from a link: a folder (no extension) in the explorer, anything else in a viewer
export function openPath(machine, path) {
  if (/\.[A-Za-z0-9]{1,8}$/.test(rpath.basename(path))) openFile(machine, path, { name: rpath.basename(path), size: 0 }, openPath);
  else open(machine, path);
}

function create(machine, startPath, startPick) {
  const id = 'explorer:' + machine;
  // the computers (网上邻居's): this one shown; another one picked opens its own 我的电脑
  const pcs = h('select', { class: 'field xpc', title: '切换到网上邻居里的另一台电脑' });
  function renderPcs() {
    const ms = net.state.sessions.length ? net.state.sessions : [{ machine, online: true, files: true }];
    const list = ms.some((m) => m.machine === machine) ? ms : [{ machine, online: false }, ...ms];
    pcs.replaceChildren(...list.map((m) => h('option', { value: m.machine, text: m.machine + (!m.online ? '（离线）' : !m.files ? '（未开放文件）' : '') })));
    pcs.value = machine;
  }
  pcs.addEventListener('change', () => { const to = pcs.value; pcs.value = machine; if (to !== machine) switchTo(to); });
  const offPcs = net.on('sessions', renderPcs);
  renderPcs();
  const up = h('button', { class: 'btn', type: 'button', text: '↑ 上一级', title: '上一级 (Backspace)' });
  const refresh = h('button', { class: 'btn', type: 'button', text: '刷新' });
  const noteBtn = h('button', { class: 'btn', type: 'button', disabled: true, title: '给选中的文件夹（或当前文件夹）添加「我的备注」「AI备注」与角色标签，并同步目录结构到群晖' },
    h('img', { src: icon('folder_tag', true), alt: '', style: 'vertical-align:-3px;margin-right:3px' }), '备注');
  const dlBtn = h('button', { class: 'btn', type: 'button', text: '下载', disabled: true, title: '把列表里选中的文件下载到这台设备（文件夹打包成 .zip）' });
  const upBtn = h('button', { class: 'btn', type: 'button', text: '上传', disabled: true, title: '把这台设备上的文件上传到这个文件夹（也可以直接把文件拖进来）' });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, class: 'xupin' });
  const addr = h('input', { class: 'field addr', type: 'text', spellcheck: 'false', placeholder: '我的电脑' });
  const launchBtn = h('button', { class: 'btn', type: 'button', title: '在这个文件夹里启动一个新的 Claude Code 或 Codex 会话' },
    h('img', { src: icon('console_prompt', true), alt: '', style: 'vertical-align:-3px;margin-right:4px' }), '在这里启动');
  const tool = h('select', { class: 'field xtool', title: '启动哪一个：Claude Code 的某个 API 别名、Codex、OpenCode，或 Antigravity (agy)' },
    h('option', { value: 'claude', text: 'Claude Code' }), h('option', { value: 'codex', text: 'Codex' }), h('option', { value: 'opencode', text: 'OpenCode' }), h('option', { value: 'agy', text: 'Antigravity (agy)' }));
  tool.value = 'claude';
  tool.addEventListener('change', () => prefs.set('files.tool', tool.value));
  // the aliases this machine has (claude-deepseek, claude-nebula, ...); each machine resolves its own variant
  async function refreshTools() {
    let list = {};
    try { list = await (await fetch('/api/claude-apis?machine=' + encodeURIComponent(machine))).json(); } catch {}
    const aliases = Array.isArray(list.aliases) ? list.aliases.filter((a) => a && /^[A-Za-z0-9._-]{1,40}$/.test(a.id)) : [];
    const keep = tool.value || prefs.get('files.tool', '');
    const opts = aliases.map((a) => h('option', { value: 'claude:' + a.id, text: 'claude-' + a.id, title: a.label || a.id }));
    if (!aliases.length) opts.push(h('option', { value: 'claude', text: 'Claude Code' }));
    opts.push(h('option', { value: 'codex', text: 'Codex' }), h('option', { value: 'opencode', text: 'OpenCode' }), h('option', { value: 'agy', text: 'Antigravity (agy)' }));
    tool.replaceChildren(...opts);
    const has = (v) => [...tool.options].some((o) => o.value === v);
    const def = list.default && aliases.some((a) => a.id === list.default) ? 'claude:' + list.default : '';
    tool.value = has(keep) ? keep : (def || (aliases[0] ? 'claude:' + aliases[0].id : 'claude'));
  }
  refreshTools();
  const first = h('input', { class: 'field', type: 'text', placeholder: '第一句话（可不填）' });
  const go = h('button', { class: 'btn go', type: 'submit', text: '启动' });
  const launchBar = h('form', { class: 'xlaunch', hidden: true, autocomplete: 'off' }, h('span', { class: 'xlh' }), tool, first, go,
    h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => { launchBar.hidden = true; } }));
  const curBanner = h('div', { class: 'xnote-banner', hidden: true });
  const body = h('div', { class: 'xbody', tabindex: 0 });
  const status = h('div', { class: 'xstatus' });
  const root = h('div', { class: 'explorer' }, h('div', { class: 'xbar' }, h('img', { src: icon('computer_2', true), alt: '', class: 'xpci' }), pcs, up, refresh, addr, noteBtn, dlBtn, upBtn, launchBtn, picker), launchBar, curBanner, body, status);
  let cur = null, parent = null, seq = 0, picked = null, job = null, upJob = null, quiet = false, lastEntries = [], lastTrunc = false, lastRoots = [];

  // (uploads: only into a folder, only where that computer's agent allows them)
  const canUp = () => cur != null && !!(net.state.sessions.find((m) => m.machine === machine) || {}).upload;
  const syncUp = () => {
    upBtn.disabled = !upJob && !canUp();
    noteBtn.disabled = cur == null && !(picked && picked.dir);
  };
  const offUp = net.on('sessions', syncUp);
  const offCat = catalog.subscribe(() => {
    renderBanner();
    if (cur == null && lastRoots.length) renderRoots(lastRoots);
    else if (cur != null) renderList(lastEntries, lastTrunc);
  });

  function renderBanner() {
    if (cur == null) { curBanner.hidden = true; return; }
    const info = catalog.get(machine, cur);
    if (!info || (!info.tag && !info.userNote && !info.aiNote)) { curBanner.hidden = true; return; }
    curBanner.hidden = false;
    curBanner.replaceChildren(
      info.tag ? h('span', { class: 'xtag', text: info.tagLabel || info.tag }) : null,
      info.userNote ? h('span', { class: 'xunote', text: '我的备注：' + info.userNote }) : null,
      info.aiNote ? h('span', { class: 'xainote', text: 'AI备注：' + info.aiNote }) : null,
      h('button', { class: 'btn xact', type: 'button', text: '编辑备注', onclick: () => openNoteDialog(machine, cur) })
    );
  }

  function setTitle() { win.setTitle(`${machine} — ${cur || '我的电脑'}`); addr.value = cur || ''; up.disabled = cur == null; launchBtn.disabled = cur == null; syncUp(); renderBanner(); }
  // keep: the status line left as it is (the list read again after an upload, which is telling how it goes)
  // pick: the name of an entry to select and scroll to once listed (a file shown in its folder)
  async function load(path, keep = false, pick = null) {
    const my = ++seq;
    quiet = keep;
    if (!keep) status.textContent = '读取中…';
    const r = path == null ? await fsc.roots(machine) : await fsc.list(machine, path);
    if (my !== seq) return;                               // a newer navigation won
    if (!r.ok) { if (!keep) status.textContent = r.msg || '打不开'; return; }
    picked = null; dlBtn.disabled = !job;                 // (a download still running can still be stopped)
    const top = body.scrollTop;
    if (path == null) { cur = null; parent = null; lastRoots = r.roots || []; renderRoots(lastRoots); }
    else { cur = r.path; parent = r.parent; lastEntries = r.entries || []; lastTrunc = r.truncated; renderList(lastEntries, lastTrunc); }
    setTitle();
    body.scrollTop = keep ? top : 0;
    if (pick && cur != null) {
      const tr = [...body.querySelectorAll('.xlist tbody tr')].find((x) => x.entry && x.entry.name === pick);
      if (tr) { choose(tr, tr.entry); tr.scrollIntoView({ block: 'center' }); tr.focus({ preventScroll: true }); }
    }
  }
  function choose(el, entry) {
    for (const x of body.querySelectorAll('.sel')) x.classList.remove('sel');
    el.classList.add('sel');
    picked = entry;
    if (!job) dlBtn.disabled = !picked;
    syncUp();
  }
  function activate(el, fn, entry = null) {
    el.entry = entry;
    el.addEventListener('dblclick', fn);
    el.addEventListener('click', () => { choose(el, entry); if (touch) fn(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') fn(); });
  }
  function badgeNodes(folderPath) {
    const info = catalog.get(machine, folderPath);
    if (!info) return [];
    const out = [];
    if (info.tag) out.push(h('span', { class: 'xtag', text: info.tagLabel || info.tag }));
    if (info.userNote) out.push(h('span', { class: 'xunote', text: info.userNote, title: '我的备注：' + info.userNote }));
    if (info.aiNote) out.push(h('span', { class: 'xainote', text: 'AI: ' + info.aiNote, title: 'AI 备注：' + info.aiNote }));
    return out;
  }
  function renderRoots(roots) {
    const grid = h('div', { class: 'xroots' }, ...roots.map((r) => {
      const info = catalog.get(machine, r.path);
      const el = h('div', { class: 'xroot', tabindex: 0, title: r.path + (info && info.userNote ? '\n我的备注：' + info.userNote : '') },
        h('img', { src: icon('hard_disk_drive'), alt: '' }),
        h('span', { text: r.name }),
        info && info.tag ? h('small', { class: 'xtag', text: info.tagLabel || info.tag }) : null
      );
      activate(el, () => load(r.path), { name: r.name, dir: true, fullPath: r.path });
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        choose(el, { name: r.name, dir: true, fullPath: r.path });
        ctx.show(ev.clientX, ev.clientY, [
          { label: '打开', onClick: () => load(r.path) },
          { label: '备注与项目标签…', onClick: () => openNoteDialog(machine, r.path) },
        ]);
      });
      return el;
    }));
    body.replaceChildren(roots.length ? grid : h('div', { class: 'notice', text: '这台电脑没有可浏览的位置。' }));
    if (!quiet) status.textContent = `${roots.length} 个位置`;
  }
  function renderList(entries, truncated) {
    const rows = entries.map((e) => {
      const full = cur ? rpath.join(cur, e.name) : e.name;
      const notes = e.dir ? badgeNodes(full) : [];
      const tr = h('tr', { tabindex: 0 },
        h('td', { class: 'xn' }, h('div', {}, h('img', { src: icon(notes.length ? 'folder_tag' : iconOf(e), true), alt: '' }), h('span', { text: e.name, title: e.name }))),
        h('td', { class: 'xrem' }, h('div', { class: 'xrem-box' }, ...notes)),
        h('td', { class: 'xs', text: e.dir ? '' : size(e.size) }),
        h('td', { class: 'xt', text: when(e.mtime) }));
      activate(tr, () => (e.dir ? load(full) : openFile(machine, full, e, openPath)), e);
      if (e.dir) {
        tr.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          choose(tr, e);
          ctx.show(ev.clientX, ev.clientY, [
            { label: '打开文件夹', onClick: () => load(full) },
            { label: '备注与项目标签…', onClick: () => openNoteDialog(machine, full) },
            { label: '同步结构树到群晖', onClick: async () => {
              status.textContent = `正在同步 ${e.name} 的目录结构树…`;
              const r = await catalog.syncTree(machine, full);
              status.textContent = r.ok ? `已同步 ${e.name} 的目录结构树` : (r.msg || '同步失败');
            } },
          ]);
        });
      }
      return tr;
    });
    body.replaceChildren(h('table', { class: 'xlist' },
      h('thead', {}, h('tr', {}, h('th', { text: '名称' }), h('th', { class: 'xrem', text: '标签 / 备注' }), h('th', { class: 'xs', text: '大小' }), h('th', { class: 'xt', text: '修改时间' }))),
      h('tbody', {}, ...rows)));
    if (!quiet) status.textContent = `${entries.length} 个项目${truncated ? '（太多了，只显示前 5000 个）' : ''}`;
  }

  noteBtn.addEventListener('click', () => {
    const targetPath = picked && picked.dir ? (picked.fullPath || (cur ? rpath.join(cur, picked.name) : null)) : cur;
    if (targetPath) openNoteDialog(machine, targetPath);
  });

  launchBtn.addEventListener('click', async () => {
    if (cur == null) return;
    launchBar.hidden = false; $q('.xlh', launchBar).textContent = `在 ${cur} 启动：`; first.focus();
    await refreshTools();
  });
  launchBar.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true; status.textContent = '启动中…';
    const pick = tool.value;
    const api = pick.startsWith('claude:') ? pick.slice(7) : '';
    const r = await net.act({ t: 'launch', machine, cwd: cur, prompt: first.value, tool: ['codex', 'opencode', 'agy'].includes(pick) ? pick : 'claude', api });
    go.disabled = false;
    status.textContent = r.ok ? (r.msg || '已启动') + ' —— 会话出现后可在糖糖看板里查看和回复' : r.msg || '启动失败';
    if (r.ok) { launchBar.hidden = true; first.value = ''; }
  });
  // (one download at a time; while it runs the button stops it)
  dlBtn.addEventListener('click', () => {
    if (job) { job.cancel(); return; }
    if (!picked || cur == null) return;
    const e = picked;
    // (a folder too large for a .zip asks, in the status line, for a place on this device to save it: a button there)
    const say = (msg, act) => {
      status.replaceChildren(msg);
      if (act) status.append(' ', h('button', { class: 'btn xact', type: 'button', text: act.label, onclick: act.run }));
    };
    job = (e.dir ? downloadFolder : download)(machine, rpath.join(cur, e.name), e, say);
    dlBtn.textContent = '取消下载'; dlBtn.disabled = false;
    job.promise.then(() => { job = null; dlBtn.textContent = '下载'; dlBtn.disabled = !picked; });
  });
  // 上传: files picked, or dropped on the window, into the folder open; one batch at a time, the button stops it
  function startUpload(files) {
    if (upJob || !canUp() || !files.length) return;
    const dir = cur;
    upJob = uploadFiles(machine, dir, files, (msg) => { status.textContent = msg; }, () => { if (cur === dir) load(cur, true); });
    upBtn.textContent = '取消上传'; upBtn.disabled = false;
    upJob.promise.then(() => { upJob = null; upBtn.textContent = '上传'; syncUp(); });
  }
  upBtn.addEventListener('click', () => { if (upJob) upJob.cancel(); else if (canUp()) picker.click(); });
  picker.addEventListener('change', () => { const files = [...picker.files]; picker.value = ''; startUpload(files); });
  const dragging = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  root.addEventListener('dragover', (e) => { if (!dragging(e) || !canUp() || upJob) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; root.classList.add('xdrop'); });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('xdrop'); });
  root.addEventListener('drop', (e) => {
    root.classList.remove('xdrop');
    if (!dragging(e) || !canUp() || upJob) return;
    e.preventDefault();
    // (a folder dropped comes as an entry that is a directory: files only)
    const items = [...e.dataTransfer.items];
    const files = [...e.dataTransfer.files].filter((f, i) => { const en = items[i] && items[i].webkitGetAsEntry && items[i].webkitGetAsEntry(); return !(en && en.isDirectory); });
    if (files.length < e.dataTransfer.files.length) status.textContent = '文件夹不能上传，只上传了里面拖进来的文件';
    startUpload(files);
  });

  up.addEventListener('click', () => { if (cur != null) load(parent); });
  refresh.addEventListener('click', () => load(cur));
  addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = addr.value.trim(); load(v || null); } });
  body.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && cur != null) { e.preventDefault(); load(parent); } });

  const win = wm.open({ id, title: `${machine} — 我的电脑`, icon: icon('computer_explorer', true), width: 680, height: 460, content: root,
    onClose: () => { if (job) job.cancel(); if (upJob) upJob.cancel(); offPcs(); offUp(); offCat(); views.delete(machine); } });
  load(startPath, false, startPick);
  return { id, load };
}
