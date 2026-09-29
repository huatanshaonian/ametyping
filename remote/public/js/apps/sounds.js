// 声音: switch each event sound on or off, try it, or mute everything (same as the tray speaker).
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import * as sound from '../sound.js';

export function open() {
  const all = h('input', { type: 'checkbox' });
  const rows = sound.EVENTS.map(([ev, label]) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = sound.enabled(ev);
    box.addEventListener('change', () => sound.setEnabled(ev, box.checked));
    return h('label', {}, box, h('span', { text: label }),
      h('button', { class: 'btn', type: 'button', text: '▶ 试听', onclick: (e) => { e.preventDefault(); sound.play(ev, { force: true }); } }));
  });
  const sync = () => { all.checked = sound.muted(); };
  all.addEventListener('change', () => sound.setMuted(all.checked));
  const off = sound.onChange(sync);
  const content = h('div', { class: 'sounds' },
    h('label', {}, all, h('span', { text: '全部静音（任务栏右下角的喇叭也能切换）' })),
    ...rows,
    h('p', { class: 'notice', style: 'padding:8px 0 0;font-size:12px;opacity:.7', text: '设置只保存在这个浏览器里。浏览器要求页面先被点过一次才能出声，所以启动音可能在第一次点击时才响。' }));
  wm.open({ id: 'sounds', title: '声音', icon: icon('mixer_sound', true), content, width: 420, height: 380, onClose: off });
}
