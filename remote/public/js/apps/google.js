// Google 账户: set up once with your own OAuth client (steps below), then connect; afterwards the daily reports become
// diary events in Google Calendar (switchable), 重要计划 are mirrored to a Google Tasks list (switchable), the calendar
// window shows your events and tasks, notes can be copied to Drive. A sign-in from before a feature's permission was
// added is asked to connect once more.
// Anything that changes the account asks for the code again (js/net.js post()).
import { h } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';

let st = null;
const listeners = new Set();
// the account's state for other windows (notepad's Drive button, the calendar)
export async function status() {
  try { st = await (await fetch('/api/google')).json(); } catch {}
  for (const fn of listeners) fn(st);
  return st;
}
export function onStatus(fn) { listeners.add(fn); if (st) fn(st); return () => listeners.delete(fn); }

let win = null;
export function open(message) {
  if (win) { wm.open({ id: 'google' }); win.render(message); return; }
  win = mount();
  wm.open({ id: 'google', title: 'Google 账户', icon: '/icons/key_win-16.png', content: win.root, width: 520, height: 470, onClose: () => { win = null; } });
  win.render(message);
}

function mount() {
  const root = h('div', { class: 'gacc' });
  const note = (text, bad) => h('p', { class: 'gnote' + (bad ? ' bad' : ''), text });
  async function render(message) {
    const s = await status() || {};
    const parts = [];
    if (message) parts.push(note(message, /失败|没能/.test(message)));
    if (s.error) parts.push(note(s.error, true));
    if (s.connected) {
      const toggle = (what, on, label) => {
        const box = h('input', { type: 'checkbox', checked: on });
        box.addEventListener('change', async () => { const r = await net.post('/api/google/' + what, { on: box.checked }); if (!r.ok) box.checked = !box.checked; else if (what === 'tasks') setTimeout(() => render(), 8000); });
        return h('label', { class: 'gline' }, box, ' ' + label);
      };
      const missing = s.missing || [];
      const sync = s.sync || {};
      const synced = sync.last ? new Date(sync.last) : null;
      parts.push(h('p', {}, '已连接：', h('b', { text: s.email || 'Google 账户' })),
        missing.length ? h('div', { class: 'gnote' }, '新功能「Google 任务」需要多授权一项权限，请重新连接一次（不用重填客户端）：',
          h('div', { class: 'gbtns' }, connectBtn('重新授权'))) : null,
        toggle('diary', s.diary, '每天的日报写进 Google 日历（全天事件，标为空闲）'),
        missing.includes('tasks') ? null : toggle('tasks', s.tasks, `重要计划同步到 Google 任务（列表「${sync.list || 'Windose 重要计划'}」，双向）`),
        !missing.includes('tasks') && s.tasks ? h('p', { class: 'ghint' + (sync.error ? ' bad' : ''),
          text: sync.error ? '上次同步失败：' + sync.error : synced ? `上次同步：${synced.getMonth() + 1} 月 ${synced.getDate()} 日 ${String(synced.getHours()).padStart(2, '0')}:${String(synced.getMinutes()).padStart(2, '0')}` : '还没有同步过（几秒后开始）' }) : null,
        h('p', { class: 'ghint', text: '日历窗口会显示 Google 日历上的日程和 Google 任务；记事本里可以「转存到 Google 云端硬盘」（只能访问本程序自己建的文件）。' }),
        h('div', { class: 'gbtns' }, h('button', { class: 'btn', type: 'button', text: '断开', onclick: async () => {
          if (!confirm('断开 Google？（授权会被撤销，之后要用需重新连接）')) return;
          await net.post('/api/google/disconnect', {}); render('已断开');
        } })));
      for (let i = parts.length - 1; i >= 0; i--) if (!parts[i]) parts.splice(i, 1);     // (replaceChildren would print null)
    } else if (s.configured) {
      parts.push(h('p', { text: '客户端已设置。点下面的按钮去 Google 授权（会跳到 Google 的页面，授权后自动回来）。' }),
        h('div', { class: 'gbtns' }, connectBtn('连接 Google'),
          h('button', { class: 'btn', type: 'button', text: '换一个客户端', onclick: () => { root.replaceChildren(...setup(s)); } })));
    } else parts.push(...setup(s));
    root.replaceChildren(...parts);
  }
  function connectBtn(text) {
    return h('button', { class: 'btn go', type: 'button', text, onclick: async () => {
      const r = await net.post('/api/google/connect', {});
      if (r.ok && r.url) location.href = r.url; else if (r.msg) render(r.msg);
    } });
  }
  function setup(s) {
    const id = h('input', { class: 'field', placeholder: '客户端 ID（…apps.googleusercontent.com）', value: s.clientId || '' });
    const secret = h('input', { class: 'field', type: 'password', placeholder: '客户端密钥', autocomplete: 'off' });
    const msg = h('p', { class: 'gnote' });
    const steps = [
      '打开 console.cloud.google.com，新建一个项目。',
      '「API 和服务 → 库」里启用 Google Calendar API 和 Google Drive API。',
      '「OAuth 同意屏幕」：用户类型选「外部」，填好应用名；把它「发布」为正式版（测试版的授权 7 天就失效）。',
      '「凭据 → 创建凭据 → OAuth 客户端 ID」：类型选「Web 应用」，已获授权的重定向 URI 填下面这一行。',
      '把生成的客户端 ID 和密钥填到这里，保存，再点「连接 Google」。',
    ];
    return [
      h('p', { text: '第一次使用要在 Google Cloud 建一个自己的授权客户端（只给你自己用，免费）：' }),
      h('ol', { class: 'gsteps' }, ...steps.map((t) => h('li', { text: t }))),
      h('div', { class: 'gline' }, h('code', { class: 'rcmd', text: s.redirect || '' }),
        h('button', { class: 'btn', type: 'button', text: '复制', onclick: () => navigator.clipboard.writeText(s.redirect || '').catch(() => {}) })),
      id, secret,
      h('div', { class: 'gbtns' }, h('button', { class: 'btn go', type: 'button', text: '保存', onclick: async () => {
        const r = await net.post('/api/google/client', { clientId: id.value, clientSecret: secret.value });
        if (r.ok) render('已保存。现在可以连接 Google 了。'); else msg.textContent = r.msg || '保存失败';
      } })), msg,
      h('p', { class: 'ghint', text: '客户端密钥和授权只保存在群晖上（仅本机可读），不会出现在网页里。' }),
    ];
  }
  return { root, render };
}
