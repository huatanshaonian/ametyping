// Shared [[citekey]] / [cite:key, p.N] inline link parser & project-task dispatch dialog (L2 & L3).
import { h } from '../util.js';
import * as mesh from '../mesh.js';

// Matches: [[citekey]], [[citekey|label]], [[citekey, p.12]], [cite:citekey], [cite:citekey, p.12]
export const CITE_RE = /\[\[([^\]|#\n]+?)(?:,\s*p\.?\s*(\d{1,4}))?(?:\|([^\]\n]+))?\]\]|\[cite:\s*([A-Za-z0-9_.:/-]+?)(?:(?:,\s*|\s+)p\.?\s*(\d{1,4}))?\s*\]/g;

export function hasCiteLinks(text) {
  if (!text) return false;
  CITE_RE.lastIndex = 0;
  return CITE_RE.test(String(text));
}

export function openCite(citekey, page) {
  const key = String(citekey || '').trim();
  if (!key) return;
  const pg = page ? Number(page) || 0 : 0;
  const hash = '#lit?tab=library&citekey=' + encodeURIComponent(key) + (pg ? '&page=' + pg : '');
  try { location.hash = hash; } catch {}
  import('./literature.js').then((m) => {
    if (typeof m.openCitekey === 'function') m.openCitekey(key, pg || undefined);
    else if (typeof m.open === 'function') m.open({ tab: 'library', citekey: key, page: pg || undefined });
  }).catch(() => {});
}

export function createCitePill(citekey, page, label) {
  const key = String(citekey || '').trim();
  const pg = page ? Number(page) || 0 : 0;
  const text = label ? String(label).trim() : (pg ? `${key} p.${pg}` : key);
  return h('button', {
    type: 'button',
    class: 'chip mono cite-pill',
    title: `打开文献 ${key}${pg ? ` 第 ${pg} 页` : ''}`,
    text,
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCite(key, pg || undefined);
    },
  });
}

// Splits plain text into an array of Text nodes and clickable cite-pill buttons.
export function renderCiteNodes(text) {
  const src = String(text == null ? '' : text);
  if (!src) return [];
  const out = [];
  let last = 0;
  CITE_RE.lastIndex = 0;
  let m;
  while ((m = CITE_RE.exec(src)) !== null) {
    if (m.index > last) out.push(document.createTextNode(src.slice(last, m.index)));
    const key = (m[1] || m[4] || '').trim();
    const pg = m[2] || m[5] || '';
    const label = m[3] || '';
    if (key) out.push(createCitePill(key, pg ? Number(pg) : undefined, label));
    else out.push(document.createTextNode(m[0]));
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(document.createTextNode(src.slice(last)));
  return out;
}

export function renderCiteText(el, text) {
  el.replaceChildren(...renderCiteNodes(text));
  return el;
}

// Reusable modal dialog for dispatching a shared mesh_task to a collaborative project (L2 & L9).
export async function openDispatchTaskDialog({ title = '', desc = '', preferredProject = '', onSuccess = null } = {}) {
  let list = mesh.list();
  if (!list.length) list = await mesh.load();
  const projSel = h('select', { class: 'field' });
  if (list.length) {
    const pref = String(preferredProject || '').trim().toLowerCase();
    let pickedId = list[0].id;
    if (pref) {
      const hit = list.find((p) => p.id === preferredProject || String(p.name || '').toLowerCase() === pref || String(p.name || '').toLowerCase().includes(pref));
      if (hit) pickedId = hit.id;
    }
    projSel.append(...list.map((p) => h('option', { value: p.id, text: `${p.name} (${(p.tasks || []).length} 任务)`, selected: p.id === pickedId })));
  } else {
    projSel.append(h('option', { value: '', text: '（暂无协同项目，请先在「项目管理」中新建）' }));
  }

  const titleIn = h('input', { class: 'field', type: 'text', value: title, placeholder: '任务标题' });
  const descIn = h('textarea', { class: 'field xnote-ta', rows: 4, placeholder: '任务说明、文献引用 [[citekey]] 或验证步骤…' });
  descIn.value = desc || '';
  const msg = h('div', { class: 'pm-status', text: '' });
  const jumpWrap = h('div', { class: 'gbtns', style: 'margin-top:6px;display:none' });

  const done = () => wrap.remove();
  const submitBtn = h('button', { class: 'btn go', type: 'submit', text: '派发到项目任务板', disabled: !list.length });
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: '派发为项目共享任务' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      h('label', { class: 'xnote-lbl', text: '目标协同项目：' }),
      projSel,
      h('label', { class: 'xnote-lbl', text: '任务标题：' }),
      titleIn,
      h('label', { class: 'xnote-lbl', text: '任务说明与溯源：' }),
      descIn,
      msg,
      jumpWrap,
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '关闭', onclick: done }),
        submitBtn
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const projectId = projSel.value;
    const t = titleIn.value.trim();
    if (!projectId) { msg.textContent = '请先选择一个协同项目'; return; }
    if (!t) { titleIn.focus(); return; }
    submitBtn.disabled = true;
    msg.textContent = '正在创建项目共享任务…';
    const r = await mesh.task({
      action: 'add',
      projectId,
      title: t,
      desc: descIn.value.trim(),
    });
    if (r && r.ok) {
      msg.textContent = '✓ 已派发到项目共享任务板';
      jumpWrap.style.display = 'flex';
      jumpWrap.replaceChildren(
        h('button', {
          class: 'btn go',
          type: 'button',
          text: '前往项目黑板 ↗',
          onclick: () => {
            done();
            try { location.hash = '#proj=' + encodeURIComponent(projectId) + '&tab=board'; } catch {}
            import('./projects.js').then((m) => m.open(projectId, { tab: 'board' })).catch(() => {});
          },
        })
      );
      if (typeof onSuccess === 'function') onSuccess(r, projectId);
    } else {
      submitBtn.disabled = false;
      msg.textContent = (r && r.msg) || '派发任务失败';
    }
  });
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
  const wrap = h('div', { class: 'dlg' }, form);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(); });
  document.body.append(wrap);
  titleIn.focus();
}
