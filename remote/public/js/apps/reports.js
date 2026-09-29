// 工作日报: the reports the server writes every morning (remote/server/summary), newest first on the left, one report
// on the right (report-view.js). 「总结到现在」 asks for a draft covering everything since the last report.
import { h } from '../util.js';
import * as wm from '../wm.js';
import { render, dayName, minutes } from './report-view.js';

let app = null;

export function open() {
  if (app) { wm.open({ id: 'reports' }); app.refresh(); return; }
  app = mount();
  wm.open({ id: 'reports', title: '工作日报', icon: '/icons/notepad_file-16.png', content: app.root, width: 860, height: 580,
    onClose: () => { app.destroy(); app = null; } });
}

function mount() {
  const listEl = h('div', { class: 'rl' });
  const view = h('div', { class: 'rv' }, h('p', { class: 'rp-empty', text: '加载中…' }));
  const status = h('span', { class: 'rs' });
  const back = h('button', { class: 'btn rback', type: 'button', text: '‹ 返回', onclick: () => root.classList.remove('viewing') });
  const draftBtn = h('button', { class: 'btn', type: 'button', text: '总结到现在', title: '把上一份日报之后的会话现在就总结一次（草稿，不影响每天早上的日报）' });
  const root = h('div', { class: 'reports' },
    h('div', { class: 'rbar' }, back, draftBtn, status),
    h('div', { class: 'rmain' }, listEl, view));
  let sel = null, data = { items: [], status: {} }, poll = null;

  async function load(date, show = true) {
    sel = date; if (show) root.classList.add('viewing');
    for (const el of listEl.children) el.classList.toggle('sel', el.dataset.date === date);
    view.replaceChildren(h('p', { class: 'rp-empty', text: '加载中…' }));
    try {
      const r = await fetch('/api/report?date=' + encodeURIComponent(date));
      if (sel !== date) return;
      view.replaceChildren(r.ok ? render(await r.json()) : h('p', { class: 'rp-empty', text: '没找到这份日报。' }));
      view.scrollTop = 0;
    } catch { view.replaceChildren(h('p', { class: 'rp-empty', text: '加载失败。' })); }
  }

  function renderList() {
    const rows = [];
    if (data.draft) rows.push(h('div', { class: 'ri draft', dataset: { date: 'draft' } }, h('b', { text: '到现在为止（草稿）' }), h('small', { text: data.draft.headline })));
    for (const it of data.items) rows.push(h('div', { class: 'ri', dataset: { date: it.date } },
      h('b', { text: dayName(it.date) }), h('small', { text: `${it.minutes ? minutes(it.minutes) + ' · ' : ''}${it.headline}` })));
    if (!rows.length) rows.push(h('p', { class: 'rp-empty', text: '还没有日报。每天早上 4:30 以后、所有电脑安静半小时就会写好前一天的。' }));
    listEl.replaceChildren(...rows);
    for (const el of listEl.children) el.classList.toggle('sel', el.dataset.date === sel);
  }

  function renderStatus() {
    const s = data.status || {};
    draftBtn.disabled = !!s.running;
    status.classList.toggle('bad', !!(s.lastError && !s.running));
    status.textContent = s.running ? (s.running.draft ? '正在总结到现在…（几分钟）' : '正在写日报…（几分钟）')
      : s.lastError ? `上次失败：${s.lastError}（半小时后自动重试）`
      : s.waiting ? '今天的日报等所有电脑安静半小时后生成' : '';
  }

  async function refresh() {
    const wasRunning = data.status && data.status.running;
    try { const r = await fetch('/api/reports'); if (r.ok) data = await r.json(); } catch { return; }
    renderList(); renderStatus();
    if (!sel) { const first = listEl.querySelector('.ri'); if (first) load(first.dataset.date, false); }
    else if (wasRunning && !data.status.running) load(sel, false);
    clearTimeout(poll);
    if (data.status.running) poll = setTimeout(refresh, 5000);
  }

  listEl.addEventListener('click', (e) => { const it = e.target.closest('.ri'); if (it) load(it.dataset.date); });
  draftBtn.addEventListener('click', async () => {
    draftBtn.disabled = true;
    try { await fetch('/api/report/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
    sel = 'draft';
    refresh();
  });
  // a narrow window shows the list or one report
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 560));
  ro.observe(root);
  refresh();
  return { root, refresh, destroy() { clearTimeout(poll); ro.disconnect(); } };
}
