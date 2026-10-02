// 邮箱设置: the mailboxes the NAS keeps in step (remote/server/mail/accounts.js) -- each with its state, how much mail
// is kept, when it last looked; add / change / remove (a code within the hour). The password is the mailbox's
// 客户端专用密码; it stays on the NAS (an empty field when changing keeps the old one). Servers default to 中国科技网
// (mail.cstnet.cn, IMAP 993 / SMTP 465), changeable under 服务器设置.
import { h } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';

let win = null;
export function open() {
  if (win) { wm.open({ id: 'mail-accounts' }); win.load(); return; }
  win = mount();
  wm.open({ id: 'mail-accounts', title: '邮箱设置', icon: '/icons/outlook_express-16.png', content: win.root, width: 520, height: 540,
    onClose: () => { win.destroy(); win = null; } });
}

const pad = (n) => String(n).padStart(2, '0');
const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function mount() {
  const msg = h('p', { class: 'gnote' });
  const rows = h('div', { class: 'mla-rows' }), formBox = h('div');
  // the research interests recommended papers are judged by: inferred from the daily reports, plus your own words
  const guess = h('div', { class: 'ghint' });
  const extra = h('textarea', { class: 'field mla-int', rows: 3, placeholder: '研究方向补充（可不填），例如：电磁散射、RCS、超表面、FDTD；也想看看机器学习在电磁里的应用' });
  const intMsg = h('span', { class: 'ghint' });
  const interests = h('div', { class: 'mla-form' }, h('b', { text: '推荐文献按什么判断' }), guess, extra,
    h('div', { class: 'gbtns' }, h('button', { class: 'btn', type: 'button', text: '保存', onclick: async () => {
      const r = await net.post('/api/mail/interests', { text: extra.value });
      intMsg.textContent = r.ok ? '已保存' : r.msg || '没能保存';
    } }), intMsg));
  (async () => {
    let r = {}; try { r = await (await fetch('/api/mail/interests')).json(); } catch { return; }
    guess.textContent = '从工作日报推断：' + ([...(r.projects || []), ...(r.keywords || []).slice(0, 12)].join('、') || '（日报还不多，暂时推断不出来）');
    extra.value = r.extra || '';
  })();
  const root = h('div', { class: 'mla' }, msg, rows, formBox, interests,
    h('div', { class: 'ghint mla-help' },
      h('p', { text: '密码要用「客户端专用密码」（邮箱绑定了手机后，第三方程序不能用登录密码）：网页邮箱 → 设置 → 邮箱密码 → 点「+」→ 短信验证 → 起个名字（例如 Windose），把生成的密码填在这里。两个邮箱各生成一个。' }),
      h('p', { text: '邮件只读不改：不会标成已读，也不会移动或删除邮箱里的信。密码只保存在群晖上。' })));
  let accounts = [];
  // the form below the list: a new mailbox, or changing one
  const showForm = (a) => formBox.replaceChildren(...(a || accounts.length < 10 ? [form(a || null)] : []));

  function form(a) {
    const f = (ph, v, type = 'text') => h('input', { class: 'field', placeholder: ph, value: v || '', type, autocomplete: 'off' });
    const address = f('邮箱地址，例如 zhangsan@xxx.ac.cn', a && a.address);
    const name = f('显示名（可不填，例如「所里」）', a && a.name);
    const pass = f(a ? '客户端专用密码（不改就留空）' : '客户端专用密码', '', 'password');
    const imapHost = f('收件服务器', a ? a.imap.host : 'mail.cstnet.cn'), imapPort = f('端口', a ? a.imap.port : 993);
    const smtpHost = f('发件服务器', a ? a.smtp.host : 'mail.cstnet.cn'), smtpPort = f('端口', a ? a.smtp.port : 465);
    const adv = h('details', { class: 'mla-adv' }, h('summary', { text: '服务器设置（中国科技网邮箱不用改）' }),
      h('div', { class: 'mla-srv' }, h('span', { text: '收件 IMAP（SSL）' }), imapHost, imapPort),
      h('div', { class: 'mla-srv' }, h('span', { text: '发件 SMTP（SSL）' }), smtpHost, smtpPort));
    const save = h('button', { class: 'btn go', type: 'button', text: a ? '保存' : '添加', onclick: async () => {
      const body = { id: a && a.id, address: address.value, name: name.value, pass: pass.value,
        imapHost: imapHost.value, imapPort: imapPort.value, smtpHost: smtpHost.value, smtpPort: smtpPort.value };
      const r = await net.post('/api/mail/accounts/' + (a ? 'update' : 'add'), body);
      if (r.ok) { await load(a ? '已保存，正在重新连接' : '已添加，正在连接并收取最近 30 天的邮件'); showForm(null); } else msg.textContent = r.msg || '没能保存';
    } });
    return h('div', { class: 'mla-form' }, h('b', { text: a ? `修改 ${a.address}` : '添加邮箱' }), address, name, pass, adv,
      h('div', { class: 'gbtns' }, save, a ? h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => showForm(null) }) : null));
  }

  function row(a) {
    const state = a.state === 'ok' ? '已连接' : a.state === 'connecting' ? '连接中…' : '出错：' + (a.error || '');
    return h('div', { class: 'mla-i' },
      h('div', {}, h('b', { text: a.name }), h('span', { class: 'mla-addr', text: ' ' + a.address })),
      h('div', { class: 'ghint' + (a.state === 'error' ? ' bad' : '') }, state + ` · 已收 ${a.count || 0} 封` + (a.lastSync ? ` · ${when(a.lastSync)} 收过信` : '')),
      h('div', { class: 'gbtns' },
        h('button', { class: 'btn', type: 'button', text: '修改', onclick: () => showForm(a) }),
        h('button', { class: 'btn', type: 'button', text: '删除', onclick: async () => {
          if (!confirm(`删除邮箱 ${a.address}？\n（之后不再收它的信）`)) return;
          const purge = confirm('已经收下来的邮件也一起删掉吗？\n确定：删掉；取消：保留在群晖上');
          const r = await net.post('/api/mail/accounts/remove', { id: a.id, purge });
          await load(r.ok ? '已删除' : r.msg); showForm(null);
        } })));
  }

  // the list only (the form being filled in stays as it is)
  async function load(note) {
    try { accounts = (await (await fetch('/api/mail')).json()).accounts || []; } catch { return; }
    if (note !== undefined) msg.textContent = note;
    rows.replaceChildren(...accounts.map(row));
  }
  const off = net.on('mail', () => load());
  load('').then(() => showForm(null));
  return { root, load, destroy() { off(); } };
}
