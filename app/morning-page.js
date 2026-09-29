// the 早安日报 window's page: fills in the note (morning.js), a click opens the report, × just closes
const $ = (id) => document.getElementById(id);
const md = (d) => { const [, m, day] = d.split('-'); return `${+m}月${+day}日`; };
window.morning.onNote((n) => {
  if (!n) return;
  $('head').textContent = `${md(n.date)}：${n.headline || '这天没有记录'}`;
  const bits = [];
  if (n.projects.length) bits.push('做了 ' + n.projects.join('、'));
  if (n.open) bits.push(`还有 ${n.open} 件没做`);
  if (n.chores) bits.push(`杂活 ${n.chores} 件`);
  $('more').textContent = bits.join(' · ');
  $('week').textContent = n.week ? `上周周报也好了：${n.week.headline}` : '';
  $('week').style.cssText = n.week ? 'font-size:12px;color:rgb(77,35,207);overflow:hidden;white-space:nowrap;text-overflow:ellipsis' : 'display:none';
});
$('close').addEventListener('click', (e) => { e.stopPropagation(); window.morning.close(); });
$('box').addEventListener('click', () => window.morning.open());
