// 日历: a month at a time. Each day: its daily report (the diary -- click to read it), the important items due that
// day, and the events of your Google Calendar when it is connected (Google 账户). Clicking a day shows it in full.
import { h } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import * as reports from './reports.js';
import * as google from './google.js';
import { minutes, weekNo } from './report-view.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

let app = null;
export function open() {
  if (app) { wm.open({ id: 'calendar' }); app.load(); return; }
  app = mount();
  wm.open({ id: 'calendar', title: '日历', icon: '/icons/calendar-16.png', content: app.root, width: 900, height: 600, onClose: () => { app.destroy(); app = null; } });
}

function mount() {
  let cur = new Date(); cur.setDate(1);
  let data = null, selDay = null;
  const title = h('b', { class: 'cal-title' });
  const gstat = h('span', { class: 'cal-g' });
  const grid = h('div', { class: 'cal-grid' });
  const detail = h('div', { class: 'cal-detail' });
  const move = (n) => { cur.setMonth(cur.getMonth() + n); load(); };
  const root = h('div', { class: 'calendar' },
    h('div', { class: 'cal-bar' },
      h('button', { class: 'btn', type: 'button', text: '‹', title: '上个月', onclick: () => move(-1) }), title,
      h('button', { class: 'btn', type: 'button', text: '›', title: '下个月', onclick: () => move(1) }),
      h('button', { class: 'btn', type: 'button', text: '今天', onclick: () => { cur = new Date(); cur.setDate(1); selDay = ymd(new Date()); load(); } }), gstat),
    h('div', { class: 'cal-main' }, grid, detail));

  async function load() {
    const ym = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}`;
    title.textContent = `${cur.getFullYear()} 年 ${cur.getMonth() + 1} 月`;
    try { data = await (await fetch('/api/calendar?month=' + ym)).json(); } catch { data = null; }
    if (!data || data.month !== ym) return;
    const g = data.google || {};
    gstat.replaceChildren(g.connected ? (g.error ? h('span', { class: 'bad', text: 'Google 日历读取失败：' + g.error }) : h('span', { text: 'Google 日历已连接' }))
      : h('button', { class: 'rs-link', type: 'button', text: '连接 Google 日历…', onclick: () => google.open() }));
    render();
  }

  function cell(date, inMonth) {
    const d = data.days[date] || { events: [], todos: [] };
    const today = date === ymd(new Date());
    const lines = [];
    if (d.report) lines.push(h('div', { class: 'cal-rep' + (d.report.brief ? ' brief' : ''), title: d.report.headline, text: d.report.headline || '（日报）' }));
    for (const t of d.todos) lines.push(h('div', { class: 'cal-todo' + (t.done ? ' done' : date < ymd(new Date()) ? ' late' : ''), text: (t.done ? '✓ ' : '□ ') + t.text }));
    const evs = d.events;
    for (const e of evs.slice(0, 3)) lines.push(h('div', { class: 'cal-ev', text: (e.allDay ? '' : hm(e.start) + ' ') + e.title }));
    if (evs.length > 3) lines.push(h('div', { class: 'cal-more', text: `还有 ${evs.length - 3} 项` }));
    return h('div', { class: 'cal-d' + (inMonth ? '' : ' out') + (today ? ' today' : '') + (date === selDay ? ' sel' : ''), dataset: { date } },
      h('div', { class: 'cal-n', text: String(+date.slice(8)) }), ...lines);
  }

  function render() {
    const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));      // the Monday on or before the 1st
    const cells = ['一', '二', '三', '四', '五', '六', '日'].map((w) => h('div', { class: 'cal-w', text: w }));
    const d = new Date(start);
    for (let i = 0; i < 42; i++) {
      if (i === 35 && d.getMonth() !== cur.getMonth()) break;                            // no sixth row when not needed
      cells.push(cell(ymd(d), d.getMonth() === cur.getMonth()));
      d.setDate(d.getDate() + 1);
    }
    grid.replaceChildren(...cells);
    showDay(selDay && selDay.startsWith(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}`) ? selDay : null);
  }

  function showDay(date) {
    selDay = date;
    for (const el of grid.querySelectorAll('.cal-d')) el.classList.toggle('sel', el.dataset.date === date);
    if (!date) { detail.replaceChildren(h('p', { class: 'rp-empty', text: '点一天看详情。每天的格子里：日报（点开看完整的）、到期的重要计划、Google 日历上的日程。' })); return; }
    const d = data.days[date] || { events: [], todos: [] };
    const dt = new Date(date + 'T12:00:00');
    const week = (data.weeks || []).find((w) => w.end === date);
    detail.replaceChildren(...[
      h('h3', { text: `${dt.getMonth() + 1} 月 ${dt.getDate()} 日 周${'日一二三四五六'[dt.getDay()]}` }),
      d.report ? h('div', { class: 'cal-sec' }, h('b', { text: '日报' }),
        h('p', {}, h('button', { class: 'rs-link', type: 'button', text: d.report.headline || '（打开日报）', onclick: () => reports.open(date) })),
        h('small', { text: minutes(d.report.minutes || 0) + (d.report.brief ? ' · 补录' : '') })) : null,
      week ? h('div', { class: 'cal-sec' }, h('b', { text: '周报' }), h('p', {}, h('button', { class: 'rs-link', type: 'button', text: `第 ${weekNo(week.start)} 周：${week.headline}`, onclick: () => reports.open('week-' + week.start) }))) : null,
      d.todos.length ? h('div', { class: 'cal-sec' }, h('b', { text: '到期的重要计划' }), h('ul', {}, ...d.todos.map((t) => h('li', { text: (t.done ? '✓ ' : '□ ') + t.text })))) : null,
      d.events.length ? h('div', { class: 'cal-sec' }, h('b', { text: 'Google 日历' }), h('ul', {}, ...d.events.map((e) => h('li', {},
        h('span', { text: (e.allDay ? '全天 ' : `${hm(e.start)}–${hm(e.end)} `) + e.title }), e.location ? h('small', { text: ' · ' + e.location }) : null)))) : null,
      !d.report && !d.todos.length && !d.events.length ? h('p', { class: 'rp-empty', text: '这天没有记录。' }) : null,
    ].filter(Boolean));                                            // (replaceChildren would print null)
  }
  grid.addEventListener('click', (e) => { const c = e.target.closest('.cal-d'); if (c) showDay(c.dataset.date); });

  const offs = [net.on('todos', load)];
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 700));
  ro.observe(root);
  load();
  return { root, load, destroy() { for (const off of offs) off(); ro.disconnect(); } };
}
