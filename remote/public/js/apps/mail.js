// 邮件: the mailboxes kept on the NAS (remote/server/mail). The list on the left (newest first; 直 sent to you, 抄 a
// copy, 群 a list or bulk mail, 附 attachments), the message on the right; a narrow window shows one side at a time.
// The mailboxes are set up in 设置 (mail-accounts.js). New mail and account changes arrive by the server's 'mail'
// event. open(key) shows one message.
import { h } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import * as settings from './mail-accounts.js';

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
  const listEl = h('div', { class: 'ml-list' });
  const view = h('div', { class: 'ml-view' });
  const root = h('div', { class: 'mail' }, h('div', { class: 'ml-bar' }, back, accSel, syncBtn, setBtn, status), h('div', { class: 'ml-main' }, listEl, view));
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
    const rows = items.map((m) => h('div', { class: 'ml-i' + (cur === m.key ? ' sel' : '') + (m.bulk ? ' bulk' : ''), dataset: { key: m.key } },
      h('div', { class: 'ml-l1' }, h('b', { text: (m.from && (m.from.name || m.from.address)) || '（无发件人）' }), h('small', { text: when(m.date) })),
      h('div', { class: 'ml-l2' },
        m.direct ? h('i', { class: 'tag d', text: '直', title: '直接发给你的' }) : m.copy ? h('i', { class: 'tag c', text: '抄', title: '抄送给你的' }) : null,
        m.bulk ? h('i', { class: 'tag b', text: '群', title: '邮件列表 / 群发' }) : null,
        m.att && m.att.length ? h('i', { class: 'tag a', text: '附', title: m.att.map((a) => a.name).join('、') }) : null,
        h('span', { text: m.subject || '（无主题）' })),
      h('div', { class: 'ml-l3', text: m.snippet || '' })));
    if (more) rows.push(h('button', { class: 'btn ml-more', type: 'button', text: '更早的邮件', onclick: () => loadList(true) }));
    listEl.replaceChildren(...(rows.length ? rows : [h('p', { class: 'ml-empty', text: accounts.length ? '这里还没有邮件。第一次会收最近 30 天的。' : '先点「设置」添加邮箱。' })]));
  }
  async function show(key) {
    let m = null; try { const r = await fetch('/api/mail/msg?key=' + encodeURIComponent(key)); if (r.ok) m = await r.json(); } catch {}
    if (!m) return;
    cur = key;
    for (const el of listEl.querySelectorAll('.ml-i')) el.classList.toggle('sel', el.dataset.key === key);
    const a = accOf(m.acc);
    const line = (k, v) => (v ? h('div', { class: 'ml-hl' }, h('b', { text: k }), h('span', { text: v })) : null);
    view.replaceChildren(h('div', { class: 'ml-head' },
      h('h3', { text: m.subject || '（无主题）' }),
      line('发件人', who(m.from)),
      line('收件人', (m.to || []).map(who).join('，')),
      line('抄送', (m.cc || []).map(who).join('，')),
      line('时间', full(m.date) + (a && accounts.length > 1 ? ` · ${a.name} 收到` : '')),
      m.att && m.att.length ? line('附件', m.att.map((x) => `${x.name}（${kb(x.size)}）`).join('，')) : null),
    h('pre', { class: 'ml-text', text: m.text || '（没有正文）' }));
    view.scrollTop = 0;
    root.classList.add('reading');
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

  const off = net.on('mail', (d) => { if (d && d.what === 'new') loadList(); else loadAccounts(); });
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 620));
  ro.observe(root);
  view.replaceChildren(h('p', { class: 'ml-empty', text: '点左边的一封邮件看全文。' }));
  loadAccounts().then(() => loadList()).then(() => { if (first) show(first); });
  return { root, show, destroy() { off(); ro.disconnect(); } };
}
