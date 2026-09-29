// 工作日报: the reports the server writes every morning (remote/server/summary), newest first on the left, one report
// on the right (report-view.js); weekly reports sit before their week's days. 「总结到现在」 asks for a draft covering
// everything since the last report. open(date) shows one report (the pet's morning bubble links to #report=<date>).
import { h } from '../util.js';
import * as wm from '../wm.js';
import { render, renderWeek, weekNo, dayName, minutes } from './report-view.js';
import { renderResults, renderAnswer } from './report-search.js';

let app = null;

export function open(date) {
  if (app) { wm.open({ id: 'reports' }); app.refresh(); if (typeof date === 'string') app.show(date); return; }
  app = mount(typeof date === 'string' ? date : null);
  wm.open({ id: 'reports', title: '工作日报', icon: '/icons/history-16.png', content: app.root, width: 860, height: 580,
    onClose: () => { app.destroy(); app = null; } });
}

function mount(first) {
  const listEl = h('div', { class: 'rl' });
  const view = h('div', { class: 'rv' }, h('p', { class: 'rp-empty', text: '加载中…' }));
  const status = h('span', { class: 'rs' });
  const back = h('button', { class: 'btn rback', type: 'button', text: '‹ 返回', onclick: () => root.classList.remove('viewing') });
  const draftBtn = h('button', { class: 'btn', type: 'button', text: '总结到现在', title: '把上一份日报之后的会话现在就总结一次（草稿，不影响每天早上的日报）' });
  const fillBtn = h('button', { class: 'btn', type: 'button', text: '补录旧日报', title: '给最近 30 天里还没有日报的日子补写简略的日报（每天调用一次 Codex）' });
  const q = h('input', { class: 'field rq', type: 'search', placeholder: '搜索日报、对话、文件（空格分开多个词）', maxlength: 200 });
  const searchBtn = h('button', { class: 'btn', type: 'button', text: '搜索' });
  const askBtn = h('button', { class: 'btn', type: 'button', text: '问一问', title: '用一句话问（例如「上次画 RCS 图的脚本在哪」），从日报、对话和产出物里找答案' });
  const root = h('div', { class: 'reports' },
    h('div', { class: 'rbar' }, back, q, searchBtn, askBtn),
    h('div', { class: 'rbar' }, draftBtn, fillBtn, status),
    h('div', { class: 'rmain' }, listEl, view));
  let sel = first, data = { items: [], weeks: [], status: {} }, poll = null;
  const md = (d) => d.slice(5).replace('-', '/');

  async function load(date, show = true) {
    sel = date; view.dataset.loaded = '1'; if (show) root.classList.add('viewing');
    for (const el of listEl.children) el.classList.toggle('sel', el.dataset.date === date);
    view.replaceChildren(h('p', { class: 'rp-empty', text: '加载中…' }));
    try {
      const r = await fetch('/api/report?date=' + encodeURIComponent(date));
      if (sel !== date) return;
      const rep = r.ok ? await r.json() : null;
      view.replaceChildren(!rep ? h('p', { class: 'rp-empty', text: '没找到这份日报。' }) : rep.start ? renderWeek(rep, { openReport: (d) => load(d) }) : render(rep));
      view.scrollTop = 0;
    } catch { view.replaceChildren(h('p', { class: 'rp-empty', text: '加载失败。' })); }
  }

  function renderList() {
    const rows = [];
    if (data.draft) rows.push(h('div', { class: 'ri draft', dataset: { date: 'draft' } }, h('b', { text: '到现在为止（草稿）' }), h('small', { text: data.draft.headline })));
    // newest first; a week's report comes before its Sunday
    const weeks = [...(data.weeks || [])];
    const weekRow = (w) => h('div', { class: 'ri week', dataset: { date: 'week-' + w.start } }, h('b', { text: `第 ${weekNo(w.start)} 周周报 ${md(w.start)}–${md(w.end || w.start)}` }), h('small', { text: w.headline }));
    for (const it of data.items) {
      while (weeks.length && (weeks[0].end || '') >= it.date) rows.push(weekRow(weeks.shift()));
      rows.push(h('div', { class: 'ri', dataset: { date: it.date } },
        h('b', { text: dayName(it.date) + (it.brief ? '（补录）' : '') }), h('small', { text: `${it.minutes ? minutes(it.minutes) + ' · ' : ''}${it.headline}` })));
    }
    for (const w of weeks) rows.push(weekRow(w));
    if (!rows.length) rows.push(h('p', { class: 'rp-empty', text: '还没有日报。每天早上 4:30 以后、所有电脑安静半小时就会写好前一天的。' }));
    listEl.replaceChildren(...rows);
    for (const el of listEl.children) el.classList.toggle('sel', el.dataset.date === sel);
  }

  function renderStatus() {
    const s = data.status || {};
    draftBtn.disabled = fillBtn.disabled = !!s.running;
    status.classList.toggle('bad', !!(s.lastError && !s.running));
    status.textContent = s.running ? (s.running.backfill ? `补录中：${s.running.date || ''}（${s.running.done}/${s.running.total}）`
      : s.running.draft ? '正在总结到现在…（几分钟）' : s.running.weekly ? '正在写周报…' : '正在写日报…（几分钟）')
      : s.lastError ? `上次失败：${s.lastError}（半小时后自动重试）`
      : s.waiting ? '今天的日报等所有电脑安静半小时后生成' : '';
  }

  async function refresh() {
    const wasRunning = data.status && data.status.running;
    try { const r = await fetch('/api/reports'); if (r.ok) data = await r.json(); } catch { return; }
    renderList(); renderStatus();
    if (!sel) { const f = listEl.querySelector('.ri'); if (f) load(f.dataset.date, false); }
    else if (!view.dataset.loaded) { view.dataset.loaded = '1'; load(sel); }
    else if (wasRunning && !data.status.running && sel) load(sel, false);
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
  fillBtn.addEventListener('click', async () => {
    let days = [];
    try { days = (await (await fetch('/api/report/backfill')).json()).days || []; } catch {}
    if (!days.length) { status.textContent = '最近 30 天都有日报了，没有要补的'; return; }
    if (!confirm(`补录 ${days.length} 天（${md(days[0])} ~ ${md(days[days.length - 1])}）的简略日报。\n没有会话的日子会跳过；每天调用一次 Codex（很长的会话另算），总共大约 ${Math.ceil(days.length * 0.7)} 分钟。\n\n开始吗？`)) return;
    fillBtn.disabled = true;
    try { const r = await (await fetch('/api/report/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json(); if (!r.ok) status.textContent = r.msg || '没能开始'; } catch {}
    refresh();
  });
  // ---- search / 问一问 (results in the right pane; the list keeps its selection off meanwhile) ----
  const openReport = (date) => load(date);
  const showPane = (el) => { sel = null; for (const x of listEl.children) x.classList.remove('sel'); root.classList.add('viewing'); view.replaceChildren(el); view.scrollTop = 0; };
  async function doSearch() {
    const text = q.value.trim(); if (!text) return;
    showPane(h('p', { class: 'rp-empty', text: '搜索中…' }));
    try { const r = await (await fetch('/api/search?q=' + encodeURIComponent(text))).json(); showPane(renderResults(text, r, { openReport })); }
    catch { showPane(h('p', { class: 'rp-empty', text: '搜索失败' })); }
  }
  let askT = null;
  async function pollAsk() {
    clearTimeout(askT);
    let job = null; try { job = (await (await fetch('/api/ask')).json()).job; } catch {}
    if (!job) return;
    showPane(renderAnswer(job, { openReport }));
    askBtn.disabled = job.running;
    if (job.running) askT = setTimeout(pollAsk, 2000);
  }
  async function doAsk() {
    const text = q.value.trim(); if (!text) return;
    askBtn.disabled = true;
    let r = {}; try { r = await (await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: text }) })).json(); } catch {}
    if (!r.ok) { askBtn.disabled = false; showPane(h('p', { class: 'rp-empty bad', text: r.msg || '没能提问' })); return; }
    pollAsk();
  }
  searchBtn.addEventListener('click', doSearch);
  askBtn.addEventListener('click', doAsk);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doSearch(); } });

  // a narrow window shows the list or one report
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 560));
  ro.observe(root);
  refresh();
  return { root, refresh, show: (date) => load(date), destroy() { clearTimeout(poll); clearTimeout(askT); ro.disconnect(); } };
}
