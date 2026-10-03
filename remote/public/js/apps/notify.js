// 控制面板 → 通知: notifications on this device (and which), installing Windose as an app, every device that gets them.
// The work is in js/push.js (page side) and server/push/ (sending).
import { h } from '../util.js';
import * as push from '../push.js';

const KIND_LABEL = { approval: '有确认在等你（审批卡片）', done: '长任务做完了（工作超过 2 分钟后停下）', ctx: '会话的上下文快满了（剩 10%）', mail: '邮件提醒（要办的事、推荐文献）' };
const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export function panel() {
  const status = h('p', { class: 'nt-st' });
  const note = h('p', { class: 'nt-note' });
  const onBtn = h('button', { class: 'btn go', type: 'button', text: '在这台设备上开启通知' });
  const offBtn = h('button', { class: 'btn', type: 'button', text: '关闭', hidden: true });
  const testBtn = h('button', { class: 'btn', type: 'button', text: '发一条测试通知', hidden: true });
  const kinds = h('div', { class: 'nt-kinds' });
  const installBox = h('div', { class: 'nt-inst' });
  const devices = h('div', { class: 'nt-devs' });
  const root = h('div', { class: 'nt' },
    h('h3', { text: '这台设备' }), status, h('div', { class: 'nt-btns' }, onBtn, offBtn, testBtn), kinds, note,
    h('h3', { text: '安装为应用' }), installBox,
    h('h3', { text: '收通知的设备' }), devices,
    h('p', { class: 'nt-foot', text: '通知经 Google（安卓 / 电脑上的 Chrome、Edge）或苹果（iPhone）的推送服务送到设备上，内容是加密的，它们看不到；手机不连 Tailscale 也能收到，点开时才需要能连上 Windose。正在看 Windose 的那台设备不会再收到通知。' }));
  let mine = null, data = null;
  const say = (msg, bad) => { note.textContent = msg || ''; note.classList.toggle('bad', !!bad); };

  async function load() {
    data = await push.info();
    mine = await push.myId();
    const me = data && mine ? data.devices.find((d) => d.id === mine) : null;
    // this device
    if (!push.supported()) {
      status.textContent = window.isSecureContext ? '这个浏览器不支持网页通知。iPhone 要 iOS 16.4 以上，先用 Safari 把 Windose「添加到主屏幕」，再从主屏幕打开它来开启。' : '要通过 https 打开 Windose 才能开启通知。';
      onBtn.hidden = true; offBtn.hidden = true; testBtn.hidden = true;
    } else {
      status.textContent = me ? `已开启：${me.name}` : Notification.permission === 'denied' ? '通知被浏览器拦住了：到浏览器的网站设置里把通知改成允许，再点开启。' : '未开启。';
      onBtn.hidden = !!me; offBtn.hidden = !me; testBtn.hidden = !me;
    }
    kinds.replaceChildren(...(me ? (data.kinds || []).map((k) => {
      const box = h('input', { type: 'checkbox' }); box.checked = me.kinds[k] !== false;
      box.addEventListener('change', async () => { const r = await push.update(me.id, { kinds: { [k]: box.checked } }); if (!r.ok) say(r.msg, true); });
      return h('label', {}, box, h('span', { text: KIND_LABEL[k] || k }));
    }) : []));
    // installing
    installBox.replaceChildren(push.installed() ? h('p', { text: '正在以应用的方式打开 Windose。' })
      : push.canInstall() ? h('div', {}, h('p', { text: '可以把 Windose 装成一个应用：有自己的图标，打开时没有地址栏。' }),
        h('button', { class: 'btn go', type: 'button', text: '安装 Windose', onclick: async () => { if (await push.install()) say('已安装'); load(); } }))
      : h('p', { text: /iPhone|iPad/.test(navigator.userAgent) ? '在 Safari 里点「分享」→「添加到主屏幕」。' : '在 Chrome 的菜单（右上角 ⋮）里选「安装应用」或「添加到主屏幕」；已经装过的话这里不再显示按钮。' }));
    // every device
    const list = data ? data.devices : [];
    devices.replaceChildren(...(list.length ? list.map((d) => h('div', { class: 'nt-dev' },
      h('span', { class: 'nt-dn', text: d.name + (d.id === mine ? '（这台）' : '') }),
      h('small', { text: `${when(d.created)} 开启${d.last ? ` · 最近一次${d.last.ok ? '送达' : '失败：' + (d.last.err || d.last.status)} ${when(d.last.at)}` : ''}` }),
      h('button', { class: 'btn', type: 'button', text: '测试', onclick: async () => { const r = await push.test(d.id); say(r.msg || (r.ok ? '已发出' : '没发出去'), !r.ok); load(); } }),
      h('button', { class: 'btn', type: 'button', text: '删除', onclick: async () => { if (d.id === mine) await push.disable(); else await push.remove(d.id); load(); } })))
      : [h('p', { class: 'nt-empty', text: '还没有设备开启通知。' })]));
  }
  onBtn.addEventListener('click', async () => { onBtn.disabled = true; const r = await push.enable(); onBtn.disabled = false; say(r.ok ? '已开启。可以发一条测试通知看看。' : r.msg, !r.ok); load(); });
  offBtn.addEventListener('click', async () => { await push.disable(); say('已关闭'); load(); });
  testBtn.addEventListener('click', async () => { const r = await push.test(mine); say(r.msg || '', !r.ok); load(); });
  const off = push.onChange(load);
  load();
  return { root, destroy: off };
}
