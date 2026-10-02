// 邮件: the mailboxes kept on the NAS (remote/server/mail). The list on the left (newest first, unread in bold; 直 sent
// to you, 抄 a copy, 群 a list or bulk mail, 附 attachments; the same mail in both mailboxes once, ×2), the message on
// the right with its links clickable and 标为已读 / 未读 (in the mailboxes themselves, every copy); a narrow window
// shows one side at a time. What the model made of a mail (mail/triage.js) is shown with it: 要办 / 通知 / 推荐, one
// line saying what it is, the deadline; the message adds what to do and the papers it picked.
// The mailboxes are set up in 设置 (mail-accounts.js). New mail and account changes arrive by the server's 'mail'
// event. open(key) shows one message.
import { h } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import * as settings from './mail-accounts.js';
import { kindOf, due, show as showAlerts } from './mail-alerts.js';      // (also puts the bell in the tray)

let app = null;
const pad = (n) => String(n).padStart(2, '0');
const when = (t) => {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()}${d.getFullYear() !== now.getFullYear() ? '/' + String(d.getFullYear()).slice(2) : ''}`;
};
const full = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const who = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
// the text with its web / mail links clickable (opened in a new tab; nothing else is turned into a link)
const LINK = /(https?:\/\/[^\s<>"'（）()【】「」，。；]+[^\s<>"'（）()【】「」，。；.,;:!?]|mailto:[^\s<>"']+)/g;
function linked(text) {
  const out = [];
  let at = 0;
  for (const m of String(text).matchAll(LINK)) {
    if (m.index > at) out.push(document.createTextNode(text.slice(at, m.index)));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer', text: m[0] }));
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

// the tray: a warning while a mailbox's password is refused (the 客户端专用密码 was removed or replaced in the webmail);
// a click opens 邮箱设置 to enter the new one. Passing network trouble is not shown there (it mends itself).
let warn = null;
async function checkTray() {
  let accs = []; try { accs = (await (await fetch('/api/mail')).json()).accounts || []; } catch { return; }
  const bad = accs.filter((a) => a.auth), tray = document.getElementById('tray');
  if (!bad.length || !tray) { if (warn) { warn.remove(); warn = null; } return; }
  if (!warn) {
    warn = h('button', { id: 'mwarn', type: 'button', onclick: () => settings.open() }, h('img', { src: '/icons/outlook_express-16.png', alt: '邮件' }));
    tray.insertBefore(warn, document.getElementById('conn'));
  }
  warn.title = bad.map((a) => `邮箱 ${a.address} 登录被拒：客户端专用密码可能失效了`).join('；') + '（点这里填新的）';
}
net.on('mail', (d) => { if (!d || d.what !== 'new') checkTray(); });
net.on('status', (up) => { if (up) checkTray(); });

export function open(key) {
  if (app) { wm.open({ id: 'mail' }); if (typeof key === 'string') app.show(key); return; }
  app = mount(typeof key === 'string' ? key : null);
  wm.open({ id: 'mail', title: '邮件', icon: '/icons/outlook_express-16.png', content: app.root, width: 920, height: 600,
    onClose: () => { app.destroy(); app = null; } });
}

function mount(first) {
  const accSel = h('select', { class: 'ml-acc', title: '看哪个邮箱' });
  const status = h('span', { class: 'ml-st' });
  const back = h('button', { class: 'btn ml-back', type: 'button', text: '‹ 列表', onclick: () => root.classList.remove('reading') });
  const syncBtn = h('button', { class: 'btn', type: 'button', text: '收信', title: '现在就看看有没有新邮件' });
  const setBtn = h('button', { class: 'btn', type: 'button', text: '设置', title: '添加 / 修改邮箱' });
  const allBtn = h('button', { class: 'btn', type: 'button', text: '全部标为已读', title: '列表里未读的都标为已读（邮箱里也是）' });
  const alertBtn = h('button', { class: 'btn', type: 'button', text: '提醒', title: 'GPT 读过新邮件后觉得要告诉你的', onclick: () => showAlerts() });
  const listEl = h('div', { class: 'ml-list' });
  const view = h('div', { class: 'ml-view' });
  const root = h('div', { class: 'mail' }, h('div', { class: 'ml-bar' }, back, accSel, syncBtn, allBtn, alertBtn, setBtn, status), h('div', { class: 'ml-main' }, listEl, view));
  let accounts = [], items = [], cur = null, more = false;

  const accOf = (id) => accounts.find((a) => a.id === id);
  function showStatus() {
    const sel = accSel.value ? [accOf(accSel.value)].filter(Boolean) : accounts;
    const bad = sel.filter((a) => a.state === 'error');
    status.classList.toggle('bad', bad.length > 0);
    status.textContent = !accounts.length ? '还没有邮箱：点「设置」添加'
      : bad.length ? bad.map((a) => `${a.name}：${a.error}`).join('；')
        : sel.some((a) => a.state === 'connecting') ? '连接中…'
          : '已连接' + (sel.length === 1 && sel[0].lastSync ? ` · ${when(sel[0].lastSync)} 收过信` : '');
  }
  async function loadAccounts() {
    try { accounts = (await (await fetch('/api/mail')).json()).accounts || []; } catch { return; }
    const keep = accSel.value;
    accSel.replaceChildren(h('option', { value: '', text: accounts.length > 1 ? '全部邮箱' : accounts.length ? accounts[0].name : '（没有邮箱）' }),
      ...(accounts.length > 1 ? accounts.map((a) => h('option', { value: a.id, text: `${a.name}（${a.address}）` })) : []));
    accSel.value = accounts.some((a) => a.id === keep) ? keep : '';
    showStatus();
  }
  async function loadList(append) {
    const before = append && items.length ? items[items.length - 1].date : '';
    let got = [];
    try { got = (await (await fetch(`/api/mail/list?acc=${encodeURIComponent(accSel.value)}&n=60${before ? '&before=' + before : ''}`)).json()).items || []; } catch { return; }
    items = append ? items.concat(got) : got;
    more = got.length === 60;
    render();
  }
  function render() {
    const rows = items.map((m) => h('div', { class: 'ml-i' + (cur === m.key ? ' sel' : '') + (m.bulk ? ' bulk' : '') + (m.seen ? '' : ' unread'), dataset: { key: m.key } },
      h('div', { class: 'ml-l1' }, h('b', { text: (m.from && (m.from.name || m.from.address)) || '（无发件人）' }),
        m.copies && m.copies.length > 1 ? h('i', { class: 'tag n', text: '×' + m.copies.length, title: '同一封发到了 ' + m.copies.map((c) => (accOf(c.acc) || {}).name || c.acc).join('、') }) : null,
        h('small', { text: when(m.date) })),
      h('div', { class: 'ml-l2' },
        m.direct ? h('i', { class: 'tag d', text: '直', title: '直接发给你的' }) : m.copy ? h('i', { class: 'tag c', text: '抄', title: '抄送给你的' }) : null,
        m.bulk ? h('i', { class: 'tag b', text: '群', title: '邮件列表 / 群发' }) : null,
        m.att && m.att.length ? h('i', { class: 'tag a', text: '附', title: m.att.map((a) => a.name).join('、') }) : null,
        h('span', { text: m.subject || '（无主题）' })),
      ...triaged(m)));
    if (more) rows.push(h('button', { class: 'btn ml-more', type: 'button', text: '更早的邮件', onclick: () => loadList(true) }));
    listEl.replaceChildren(...(rows.length ? rows : [h('p', { class: 'ml-empty', text: accounts.length ? '这里还没有邮件。第一次会收最近 30 天的。' : '先点「设置」添加邮箱。' })]));
  }
  // read / unread, in the mailboxes (every copy of the mail)
  async function mark(keys, seen) {
    if (!keys.length) return;
    status.textContent = seen ? '标为已读…' : '标为未读…';
    const r = await net.post('/api/mail/seen', { keys, seen });
    if (!r.ok) { status.textContent = r.msg || '没能改'; status.classList.add('bad'); return; }
    await loadList(); showStatus();
    if (cur) show(cur, true);
  }
  // the model's view in the list: its label (要办 / 通知 / 推荐; nothing for the rest), the deadline, its one line
  function triaged(m) {
    const t = m.t;
    if (!t) return [h('div', { class: 'ml-l3', text: m.snippet || '' })];
    const k = kindOf(t.important || t.kind === 'reading' ? t.kind : '');
    return [h('div', { class: 'ml-l3 ml-t' }, k ? h('i', { class: 'tag ' + k[1], text: k[0] }) : null,
      t.deadline ? h('em', { text: '截止 ' + t.deadline.slice(5).replace('-', '/') + ' ' }) : null, h('span', { text: t.summary || m.snippet || '' }))];
  }
  async function show(key, quiet) {
    let m = null; try { const r = await fetch('/api/mail/msg?key=' + encodeURIComponent(key)); if (r.ok) m = await r.json(); } catch {}
    if (!m) return;
    cur = key;
    const it = items.find((x) => x.key === key || (x.copies || []).some((c) => c.key === key));
    const copies = it && it.copies ? it.copies : [{ key, acc: m.acc, seen: m.seen }];
    const unread = copies.some((c) => !c.seen);
    for (const el of listEl.querySelectorAll('.ml-i')) el.classList.toggle('sel', el.dataset.key === key);
    const a = accOf(m.acc);
    const line = (k, v) => (v ? h('div', { class: 'ml-hl' }, h('b', { text: k }), h('span', { text: v })) : null);
    view.replaceChildren(h('div', { class: 'ml-head' },
      h('h3', { text: m.subject || '（无主题）' }),
      line('发件人', who(m.from)),
      line('收件人', (m.to || []).map(who).join('，')),
      line('抄送', (m.cc || []).map(who).join('，')),
      line('时间', full(m.date) + (a && accounts.length > 1 ? ` · ${a.name} 收到` : '')),
      copies.length > 1 ? line('重复', (() => {
        const names = [...new Set(copies.map((c) => (accOf(c.acc) || {}).name || c.acc))];
        return (names.length > 1 ? `${names.join('、')} 各收到一封` : `${names[0]} 收到 ${copies.length} 封`) + '（内容相同，只显示一封）';
      })()) : null,
      m.att && m.att.length ? line('附件', m.att.map((x) => `${x.name}（${kb(x.size)}）`).join('，')) : null,
      h('div', { class: 'ml-acts' }, h('button', { class: 'btn', type: 'button', text: unread ? '标为已读' : '标为未读',
        onclick: () => mark(copies.map((c) => c.key), unread) }))),
    m.t ? judged(m.t) : null,
    h('pre', { class: 'ml-text' }, ...(m.text ? linked(m.text) : [document.createTextNode('（没有正文）')])));
    if (!quiet) view.scrollTop = 0;
    root.classList.add('reading');
  }

  // what the model made of it, above the text
  function judged(t) {
    const k = kindOf(t.important || t.kind === 'reading' ? t.kind : '');
    return h('div', { class: 'ml-judge' },
      h('div', {}, h('b', { text: 'GPT：' }), k ? h('i', { class: 'tag ' + k[1], text: k[0] }) : h('i', { class: 'tag', text: t.kind === 'notice' ? '通知（与你关系不大）' : '不用管' }), ' ' + (t.summary || '')),
      t.todo ? h('div', {}, h('b', { text: '要做：' }), t.todo) : null,
      t.deadline ? h('div', {}, h('b', { text: '截止：' }), due(t.deadline), t.deadlineText ? h('q', { text: t.deadlineText }) : null) : null,
      t.picks && t.picks.length ? h('ul', { class: 'mal-picks' }, ...t.picks.map((p) => h('li', {},
        p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', text: p.title }) : h('span', { text: p.title }),
        p.fun ? h('i', { class: 'tag fun', text: '有趣' }) : null, h('small', { text: ' ' + p.why })))) : null);
  }
  listEl.addEventListener('click', (e) => { const it = e.target.closest('.ml-i'); if (it) show(it.dataset.key); });
  accSel.addEventListener('change', () => { cur = null; view.replaceChildren(); showStatus(); loadList(); });
  syncBtn.addEventListener('click', async () => {
    const ids = accSel.value ? [accSel.value] : accounts.map((a) => a.id);
    status.textContent = '收信中…';
    for (const id of ids) await net.post('/api/mail/sync', { acc: id });
    setTimeout(() => { loadAccounts(); loadList(); }, 1500);
  });
  setBtn.addEventListener('click', () => settings.open());
  allBtn.addEventListener('click', () => {
    const keys = items.filter((m) => !m.seen).flatMap((m) => m.copies.filter((c) => !c.seen).map((c) => c.key));
    if (!keys.length) { status.textContent = '列表里没有未读的'; return; }
    if (confirm(`把列表里 ${items.filter((m) => !m.seen).length} 封未读的都标为已读？（邮箱里也会变成已读）`)) mark(keys, true);
  });

  const off = net.on('mail', (d) => { if (d && (d.what === 'new' || d.what === 'seen' || d.what === 'alerts')) loadList(); else loadAccounts(); });
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 620));
  ro.observe(root);
  view.replaceChildren(h('p', { class: 'ml-empty', text: '点左边的一封邮件看全文。' }));
  loadAccounts().then(() => loadList()).then(() => { if (first) show(first); });
  return { root, show, destroy() { off(); ro.disconnect(); } };
}
