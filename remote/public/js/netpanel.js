// 网上邻居: every remote computer with its state; clicking one makes it the desktop's current computer.
// On phones the panel is a sheet opened from the tray / start menu.
import { $, h, icon, isWorking } from './util.js';

const panel = $('#netpanel'), box = $('#machines');
let onSelect = () => {};

export function init(select) {
  onSelect = select;
  $('#netbtn').addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('pointerdown', (e) => { if (panel.classList.contains('open') && !panel.contains(e.target) && !$('#netbtn').contains(e.target)) panel.classList.remove('open'); });
}
export function toggle(force) { panel.classList.toggle('open', force); }

// counts shown for a computer
export function summary(m) {
  const live = m.sessions.filter((s) => s.state !== 'history');
  return { live: live.length, total: m.sessions.length, working: live.filter((s) => isWorking(s.state)).length,
    perms: m.sessions.reduce((n, s) => n + (s.perms || []).length, 0) };
}

export function render(machines, current) {
  if (!machines.length) { box.replaceChildren(h('div', { class: 'empty', text: '还没有电脑连上来。' })); return; }
  box.replaceChildren(...machines.map((m) => {
    const c = summary(m);
    const info = m.online ? `${c.live} 个会话${c.working ? ` · ${c.working} 个进行中` : ''}${m.control ? '' : ' · 只读'}` : `离线 · ${c.total} 个历史会话`;
    return h('button', { class: `mach${m.online ? ' on' : ' off'}${m.machine === current ? ' sel' : ''}`, type: 'button',
      onclick: () => { onSelect(m.machine); panel.classList.remove('open'); } },
    h('img', { src: icon('computer_2'), alt: '' }),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'mn' }, h('span', { class: 'dot' }), m.machine),
      h('div', { class: 'mi', text: info }),
      c.perms ? h('span', { class: 'mb', text: `待确认 ${c.perms}` }) : null));
  }));
}
