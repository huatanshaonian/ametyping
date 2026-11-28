// the 早安日报 window's page: fills in the note (morning.js), section clicks deep-link to their matching Windose view
// (#report=<date|week-...>, #calendar=<today>, #mail-alerts, #lit), × just closes.
const $ = (id) => document.getElementById(id);
const md = (d) => { const [, m, day] = d.split('-'); return `${+m}月${+day}日`; };
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const line = (el, text) => { if (!el) return; el.textContent = text; el.style.display = text ? '' : 'none'; };

let currentNote = null;

function openTarget(hash) {
  window.__morningTarget = hash || '';
  try { history.replaceState(null, '', '#' + encodeURIComponent(hash || '')); } catch {}
  window.morning.open(hash);
}

window.morning.onNote((n) => {
  if (!n) return;
  currentNote = n;
  window.__morningTarget = '#report=' + n.date;
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

  // the mail alerts still open (邮件提醒)
  const m = t && t.mail;
  line($('mail'), m && (m.todo || m.reading) ? '邮件：' + [m.todo ? `${m.todo} 件要办${m.due ? `（${md(m.due)}截止）` : ''}` : '', m.reading ? `${m.reading} 篇推荐` : ''].filter(Boolean).join('、') : '');
  $('mail').title = m && m.top.length ? m.top.join('；') : '';

  // today's literature feed & unread cards (#lit)
  const p = t && t.papers;
  const pNewTotal = p ? (p.new || 0) + (p.review || 0) : 0;
  const litParts = p ? [
    pNewTotal ? `${pNewTotal} 篇待看` : '',
    p.cards ? `${p.cards} 张待读卡片` : '',
  ].filter(Boolean) : [];
  line($('lit'), litParts.length ? `今日文献：${litParts.join('、')}` : '');
  if ($('lit')) $('lit').title = p && p.top && p.top.length ? p.top.join('；') : '';
});

$('close').addEventListener('click', (e) => { e.stopPropagation(); window.morning.close(); });
$('week').addEventListener('click', (e) => {
  if (!currentNote || !currentNote.week) return;
  e.stopPropagation();
  openTarget('#report=week-' + currentNote.week.start);
});
$('events').addEventListener('click', (e) => {
  e.stopPropagation();
  const d = (currentNote && currentNote.today && currentNote.today.date) || todayStr();
  openTarget('#calendar=' + d);
});
$('due').addEventListener('click', (e) => {
  e.stopPropagation();
  const d = (currentNote && currentNote.today && currentNote.today.date) || todayStr();
  openTarget('#calendar=' + d);
});
$('mail').addEventListener('click', (e) => {
  e.stopPropagation();
  openTarget('#mail-alerts');
});
if ($('lit')) {
  $('lit').addEventListener('click', (e) => {
    e.stopPropagation();
    openTarget('#lit');
  });
}
$('box').addEventListener('click', () => {
  openTarget(currentNote ? '#report=' + currentNote.date : '#reports');
});
