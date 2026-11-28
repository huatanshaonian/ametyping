// 网上邻居: every remote computer with its state; clicking one makes it the desktop's current computer.
// Right-clicking (or long-pressing) a computer opens quick actions: 我的电脑 / 查看监控详情 / 配置 Fleet.
import { $, h, icon, isWorking, prefs } from './util.js';
import * as ctxmenu from './ctxmenu.js';

const panel = $('#netpanel'), box = $('#machines');
let onSelect = () => {};
let actions = {};

export function init(select, extraActions = {}) {
  onSelect = select;
  actions = extraActions || {};
  document.documentElement.classList.toggle('net-off', !!prefs.get('net.off', false));
  $('#hidepc').addEventListener('click', (e) => { e.stopPropagation(); toggle(false); });
  $('#netbtn').addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('pointerdown', (e) => {
    if (panel.classList.contains('open') && !panel.contains(e.target) && !$('#netbtn').contains(e.target)) panel.classList.remove('open');
  });
}
const wide = () => !window.matchMedia('(max-width: 700px)').matches;
export function toggle(force) {
  if (!wide()) return panel.classList.toggle('open', force);
  const root = document.documentElement, off = force == null ? !root.classList.contains('net-off') : !force;
  root.classList.toggle('net-off', off); prefs.set('net.off', off);
  window.dispatchEvent(new Event('resize'));       // (the desktop's width changed: whatever lays itself out by it)
}

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
    const btn = h('button', { class: `mach${m.online ? ' on' : ' off'}${m.machine === current ? ' sel' : ''}`, type: 'button',
      onclick: () => { onSelect(m.machine); panel.classList.remove('open'); } },
    h('img', { src: icon('computer_2'), alt: '' }),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'mn' }, h('span', { class: 'dot' }), m.machine),
      h('div', { class: 'mi', text: info }),
      c.perms ? h('span', { class: 'mb', text: `待确认 ${c.perms}` }) : null));

    ctxmenu.attach(btn, () => [
      {
        label: '打开我的电脑',
        onClick: () => {
          onSelect(m.machine);
          panel.classList.remove('open');
          if (actions.openMyComputer) actions.openMyComputer(m.machine);
          else location.hash = '#explorer=' + encodeURIComponent(m.machine);
        },
      },
      {
        label: '查看监控详情',
        onClick: () => {
          panel.classList.remove('open');
          if (actions.openTopo) actions.openTopo(m.machine);
          else location.hash = '#infra?tab=topo&node=' + encodeURIComponent(m.machine);
        },
      },
      {
        label: '配置 Fleet',
        onClick: () => {
          panel.classList.remove('open');
          if (actions.openFleet) actions.openFleet(m.machine);
          else location.hash = '#infra?tab=fleet&machine=' + encodeURIComponent(m.machine);
        },
      },
    ]);
    return btn;
  }));
}
