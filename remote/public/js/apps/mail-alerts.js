// 邮件提醒: what the model found in new mail (remote/server/mail/triage.js) -- things to do (with their deadlines),
// notices that matter, papers worth a look. The tray shows a bell with how many are open (a new one plays the 邮件提醒
// sound and buzzes a phone); the window lists them: open the mail, 加入重要计划 (with the deadline), 知道了.
import { h } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import * as sound from '../sound.js';

const KIND = { action: ['要办', 'k-action'], notice: ['通知', 'k-notice'], reading: ['推荐', 'k-reading'] };
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// 「10 月 15 日（还有 3 天）」
export function due(date) {
  if (!date) return '';
  const days = Math.round((new Date(date + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 86400e3);
  const [, m, d] = date.split('-');
  return `${+m} 月 ${+d} 日（${days < 0 ? `已过 ${-days} 天` : days === 0 ? '就是今天' : days === 1 ? '明天' : `还有 ${days} 天`}）`;
}
export const kindOf = (k) => KIND[k] || null;

// the tray's bell
let bell = null, open = [];
async function refresh() {
  let r = {}; try { r = await (await fetch('/api/mail/alerts')).json(); } catch { return; }
  open = r.open || [];
  const tray = document.getElementById('tray');
  if (!open.length || !tray) { if (bell) { bell.remove(); bell = null; } }
  else {
    if (!bell) {
      bell = h('button', { id: 'mbell', type: 'button', onclick: () => show() }, h('img', { src: '/icons/msg_information-16.png', alt: '邮件提醒' }), h('b'));
      tray.insertBefore(bell, document.getElementById('conn'));
    }
    bell.querySelector('b').textContent = open.length;
    bell.title = `邮件提醒 ${open.length} 条：` + open.slice(0, 3).map((a) => a.summary || a.subject).join('；');
  }
  if (win) win.render();
}
net.on('mail-alert', () => { sound.play('mail'); sound.buzz(); refresh(); });
net.on('mail', (d) => { if (d && (d.what === 'alerts' || d.what === 'seen')) refresh(); });
net.on('status', (up) => { if (up) refresh(); });

let win = null;
export function show() {
  if (win) { wm.open({ id: 'mail-alerts' }); refresh(); return; }
  win = mount();
  wm.open({ id: 'mail-alerts', title: '邮件提醒', icon: '/icons/msg_information-16.png', content: win.root, width: 560, height: 560, onClose: () => { win = null; } });
  refresh();
}

function mount() {
  const root = h('div', { class: 'mal' });
  const post = async (what, id) => { const r = await net.post('/api/mail/alerts/' + what, { id }); if (!r.ok && r.msg) alert(r.msg); refresh(); };
  function card(a) {
    const [label, cls] = KIND[a.kind] || ['邮件', ''];
    const late = a.deadline && a.deadline < today();
    return h('div', { class: 'mal-i ' + cls },
      h('div', { class: 'mal-h' }, h('i', { class: 'tag', text: label }), h('b', { text: a.summary || a.subject })),
      h('div', { class: 'mal-s', text: `${a.from} · ${a.subject}` }),
      a.todo ? h('div', { class: 'mal-todo' }, h('span', { text: '要做：' }), a.todo) : null,
      a.deadline ? h('div', { class: 'mal-due' + (late ? ' late' : '') }, h('span', { text: '截止：' }), due(a.deadline), a.deadlineText ? h('q', { text: a.deadlineText }) : null) : null,
      a.picks && a.picks.length ? h('ul', { class: 'mal-picks' }, ...a.picks.map((p) => h('li', {},
        p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', text: p.title }) : h('span', { text: p.title }),
        p.fun ? h('i', { class: 'tag fun', text: '有趣' }) : null, h('small', { text: ' ' + p.why })))) : null,
      a.done ? h('div', { class: 'ghint', text: a.todoId ? '已加入重要计划' : a.doneBy === 'read' ? '邮件已读' : '知道了' }) :
        h('div', { class: 'gbtns' },
          h('button', { class: 'btn', type: 'button', text: '打开邮件', onclick: () => import('./mail.js').then((m) => m.open(a.key)) }),
          a.kind !== 'reading' ? h('button', { class: 'btn go', type: 'button', text: a.deadline ? `加入重要计划（${a.deadline.slice(5)} 截止）` : '加入重要计划', onclick: () => post('todo', a.id) }) : null,
          h('button', { class: 'btn', type: 'button', text: '知道了', onclick: () => post('done', a.id) })));
  }
  async function render() {
    let r = {}; try { r = await (await fetch('/api/mail/alerts')).json(); } catch { return; }
    const kids = [];
    if (r.enabled === false) kids.push(h('p', { class: 'gnote bad', text: '工作日报没有开启，没有模型可以读邮件，所以不会有提醒。' }));
    if (!(r.open || []).length) kids.push(h('p', { class: 'ml-empty', text: '没有要处理的。新邮件到了会先让 GPT 读一遍：要你去做的事、和你有关的通知、值得看的文献，会出现在这里。' }));
    kids.push(...(r.open || []).map(card));
    if ((r.done || []).length) kids.push(h('details', { class: 'mal-done' }, h('summary', { text: `最近处理过的（${r.done.length}）` }), ...r.done.map(card)));
    root.replaceChildren(...kids.filter(Boolean));
  }
  return { root, render };
}
