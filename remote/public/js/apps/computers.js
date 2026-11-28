// 设备与算力中心 › 设备接入与令牌 (was 控制面板 › 电脑):
// Manages machines allowed to connect (/api/agents), generates one-time install tokens + 4-platform install commands,
// and optionally registers the new machine directly into the network topology monitor (/api/infra/node) in one step.
import { h, icon } from '../util.js';
import * as net from '../net.js';
import { confirmBox } from '../dialog.js';
import { effectiveTier } from './infra-topo.js';

const RAW = 'https://raw.githubusercontent.com/huatanshaonian/ametyping/main/install';
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Backward-compatible forwarding: opens 设备与算力中心 › 设备接入与令牌
export function open() {
  import('./infra.js').then((m) => m.open({ tab: 'agents' }));
}

export function panel({ onAdded } = {}) {
  const listBox = h('div', { class: 'cmplist' });
  const name = h('input', { class: 'field', type: 'text', placeholder: '新电脑的名字（字母、数字、点、横线）', maxlength: 40, spellcheck: 'false' });
  const syncTopoChk = h('input', { type: 'checkbox', checked: true });
  const roleSel = h('select', { class: 'field', style: 'flex:0 1 170px', title: '拓扑图中的设备角色' },
    h('option', { value: 'workstation', text: '角色：开发工作站 / 算力机' }),
    h('option', { value: 'cloud', text: '角色：云端服务器 (AWS/GCP)' }),
    h('option', { value: 'router', text: '角色：网关路由器 (OpenWrt)' }),
    h('option', { value: 'nas', text: '角色：核心存储 / NAS' })
  );
  const hostIn = h('input', { class: 'field', type: 'text', style: 'flex:0 1 180px', placeholder: 'IP 或 Tailscale 地址（可选）', maxlength: 80 });
  const addBtn = h('button', { class: 'btn go', type: 'submit', text: '添加并生成令牌' });
  const result = h('div', { class: 'cmpresult', hidden: true });
  const msg = h('div', { class: 'wallmsg' });
  const say = (t, bad) => { msg.textContent = t || ''; msg.classList.toggle('bad', !!bad); };

  const syncRoleFields = () => {
    roleSel.disabled = !syncTopoChk.checked;
    hostIn.disabled = !syncTopoChk.checked;
  };
  syncTopoChk.addEventListener('change', syncRoleFields);

  async function refresh() {
    let items = [];
    try { const r = await fetch('/api/agents'); items = (await r.json()).items || []; } catch {}
    listBox.replaceChildren(...(items.length ? items.map((a) => h('div', { class: 'cmp' },
      h('img', { src: icon('computer_2', true), alt: '', class: a.online ? '' : 'off' }),
      h('b', { text: a.name }),
      h('span', { class: 'cmpi', text: `${a.online ? '在线' : '离线'}${a.added ? ' · 添加于 ' + a.added.slice(0, 10) : ''}` }),
      h('button', { class: 'btn', type: 'button', text: '查看拓扑', onclick: () => { location.hash = '#infra?tab=topo&node=' + encodeURIComponent(a.name); } }),
      h('button', { class: 'btn no', type: 'button', text: '移除', onclick: () => remove(a.name) }))) : [h('div', { class: 'notice', text: '还没有登记的电脑。' })]));
  }
  async function remove(n) {
    if (!(await confirmBox(`移除「${n}」？\n它的令牌会作废、立刻断开；已经存下的对话记录保留。`, { title: '移除电脑', ok: '移除', danger: true }))) return;
    const r = await net.post('/api/agents/remove', { name: n });
    say(r.ok ? `已移除 ${n}` : r.msg || '移除失败', !r.ok);
    refresh();
  }
  const copyRow = (label, text) => {
    const code = h('code', { class: 'rcmd', text });
    return h('div', { class: 'cmpcmd' }, h('span', { text: label }), code,
      h('button', { class: 'btn', type: 'button', text: '复制', onclick: async () => {
        try { await navigator.clipboard.writeText(text); say('已复制'); }
        catch { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); say('已选中，按 Ctrl+C 复制'); }
      } }));
  };
  const syncRow = h('div', { class: 'wallbar', style: 'padding-top:0;border-top:0' },
    h('label', { style: 'display:inline-flex;align-items:center;gap:6px;cursor:pointer' }, syncTopoChk, '同步加入网络监控拓扑图'),
    roleSel,
    hostIn
  );
  const form = h('form', { class: 'cmpadd', autocomplete: 'off' },
    h('div', { class: 'wallbar' }, name, addBtn),
    syncRow
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) return;
    addBtn.disabled = true; say('');
    const r = await net.post('/api/agents/add', { name: n });
    addBtn.disabled = false;
    if (!r.ok) { say(r.msg || '添加失败', true); return; }
    let syncedTopo = false;
    if (syncTopoChk.checked) {
      const role = roleSel.value || 'workstation';
      const nr = await net.post('/api/infra/node', {
        id: r.name,
        label: r.name,
        host: hostIn.value.trim(),
        role,
        tier: effectiveTier({ role }),
      });
      syncedTopo = !!(nr && nr.ok);
    }
    name.value = '';
    hostIn.value = '';
    result.hidden = false;
    result.replaceChildren(
      h('p', { text: `「${r.name}」的令牌（只显示这一次${r.replaced ? '；原来同名电脑的令牌已作废' : ''}）${syncedTopo ? ' · 已同步加入网络监控拓扑图' : ''}：` }),
      copyRow('令牌', r.token),
      h('p', { text: '在新电脑上粘贴运行下面的命令即可装好（需要已加入 Tailscale）。命令里带着令牌，运行完可清掉终端历史。' }),
      copyRow('Windows（PowerShell）', `$env:AME_NAME=${psq(r.name)}; $env:AME_TOKEN=${psq(r.token)}; irm ${RAW}/install-windows.ps1 | iex`),
      copyRow('Windows 无头（不显示糖糖，省资源）', `$env:AME_MODE='headless'; $env:AME_NAME=${psq(r.name)}; $env:AME_TOKEN=${psq(r.token)}; irm ${RAW}/install-windows.ps1 | iex`),
      copyRow('Linux（开发机，带 Claude/Codex 会话控制）', `curl -fsSL ${RAW}/install-linux.sh | AME_NAME='${r.name}' AME_TOKEN='${r.token}' bash`),
      copyRow('Linux / OpenWrt 轻量监控探针（AWS / GCP / 软路由，零依赖）', `curl -fsSL ${RAW}/install-infra.sh | AME_NAME='${r.name}' AME_TOKEN='${r.token}' sh`));
    refresh();
    if (onAdded) onAdded(r.name);
  });

  refresh();
  const content = h('div', { class: 'computers', style: 'flex:1;min-height:0;overflow:auto' },
    h('div', { class: 'cmphead', text: '已登记的电脑' }), listBox,
    h('div', { class: 'cmphead', text: '添加一台电脑' }), form, result, msg);
  return { root: content, show: refresh, destroy() {} };
}
