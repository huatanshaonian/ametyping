// the 邮件提醒 bubble's page: fills in the alert (mail-notice.js); a click opens the mail, × closes
const $ = (id) => document.getElementById(id);
const LABEL = { action: '要办', notice: '通知', reading: '推荐文献' };
const md = (d) => { const [, m, day] = d.split('-'); return `${+m}月${+day}日`; };
const line = (el, text) => { el.textContent = text; el.style.display = text ? '' : 'none'; };
window.mailNotice.onAlert((a) => {
  if (!a) return;
  $('kind').textContent = LABEL[a.kind] || '邮件';
  $('kind').className = 'k-' + a.kind;
  $('head').textContent = a.summary || a.subject;
  line($('todo'), a.todo ? '要做：' + a.todo : a.picks && a.picks.length ? '看看：' + a.picks.join('；') : '');
  line($('due'), a.deadline ? `截止：${md(a.deadline)}` : '');
  $('hint').textContent = '点这里看这封邮件' + (a.more ? `（还有 ${a.more} 条提醒）` : '');
});
$('close').addEventListener('click', (e) => { e.stopPropagation(); window.mailNotice.close(); });
$('box').addEventListener('click', () => window.mailNotice.open());
