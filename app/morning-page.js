// the 早安日报 window's page: fills in the note (morning.js), a click opens the report, × just closes. Today's agenda
// (Google events, tasks and 重要计划 due) only when it is today's.
const $ = (id) => document.getElementById(id);
const md = (d) => { const [, m, day] = d.split('-'); return `${+m}月${+day}日`; };
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const line = (el, text) => { el.textContent = text; el.style.display = text ? '' : 'none'; };
window.morning.onNote((n) => {
  if (!n) return;
  $('head').textContent = `${md(n.date)}：${n.headline || '这天没有记录'}`;
  const bits = [];
  if (n.projects.length) bits.push('做了 ' + n.projects.join('、'));
  if (n.done) bits.push(`完成了 ${n.done} 件重要计划`);
  if (n.open) bits.push(`重要计划还剩 ${n.open} 件`);
  if (n.chores) bits.push(`杂活 ${n.chores} 件`);
  $('more').textContent = bits.join(' · ');
  $('week').textContent = n.week ? `上周周报也好了：${n.week.headline}` : '';
  $('week').style.cssText = n.week ? 'font-size:12px;color:rgb(77,35,207);overflow:hidden;white-space:nowrap;text-overflow:ellipsis' : 'display:none';
  const t = n.today && n.today.date === todayStr() ? n.today : null;
  line($('events'), !t ? '' : t.events.length ? `今天 ${t.events.length} 个日程：` + t.events.map((e) => (e.time ? e.time + ' ' : '') + e.title).join('、')
    : t.google ? '今天没有日程' : '');
  const due = t ? [...t.todos, ...t.tasks] : [];
  line($('due'), due.length ? '今天到期：' + due.join('、') : '');
});
$('close').addEventListener('click', (e) => { e.stopPropagation(); window.morning.close(); });
$('box').addEventListener('click', () => window.morning.open());
