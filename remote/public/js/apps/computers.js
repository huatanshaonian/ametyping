// 添加电脑: the machines allowed to connect. Adding one gives its token once, together with ready-to-paste install
// commands for Windows and Linux (install/ scripts) -- so a new device needs nothing done on the server.
// Removing one revokes its token and disconnects it (its stored conversations stay).
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';

const RAW = 'https://raw.githubusercontent.com/huatanshaonian/ametyping/main/install';
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function open() {
  const listBox = h('div', { class: 'cmplist' });
  const name = h('input', { class: 'field', type: 'text', placeholder: '新电脑的名字（字母、数字、点、横线）', maxlength: 40, spellcheck: 'false' });
  const addBtn = h('button', { class: 'btn go', type: 'submit', text: '添加' });
  const result = h('div', { class: 'cmpresult', hidden: true });
  const msg = h('div', { class: 'wallmsg' });
  const say = (t, bad) => { msg.textContent = t || ''; msg.classList.toggle('bad', !!bad); };

  async function refresh() {
    let items = [];
    try { const r = await fetch('/api/agents'); items = (await r.json()).items || []; } catch {}
    listBox.replaceChildren(...(items.length ? items.map((a) => h('div', { class: 'cmp' },
      h('img', { src: icon('computer_2', true), alt: '', class: a.online ? '' : 'off' }),
      h('b', { text: a.name }),
      h('span', { class: 'cmpi', text: `${a.online ? '在线' : '离线'}${a.added ? ' · 添加于 ' + a.added.slice(0, 10) : ''}` }),
      h('button', { class: 'btn no', type: 'button', text: '移除', onclick: () => remove(a.name) }))) : [h('div', { class: 'notice', text: '还没有登记的电脑。' })]));
  }
  async function remove(n) {
    if (!confirm(`移除「${n}」？它的令牌会作废、立刻断开；已经存下的对话记录保留。`)) return;
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
  const form = h('form', { class: 'wallbar', autocomplete: 'off' }, name, addBtn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) return;
    addBtn.disabled = true; say('');
    const r = await net.post('/api/agents/add', { name: n });
    addBtn.disabled = false;
    if (!r.ok) { say(r.msg || '添加失败', true); return; }
    name.value = '';
    result.hidden = false;
    result.replaceChildren(
      h('p', { text: `「${r.name}」的令牌（只显示这一次${r.replaced ? '；原来同名电脑的令牌已作废' : ''}）：` }),
      copyRow('令牌', r.token),
      h('p', { text: '在新电脑上粘贴运行下面的命令即可装好（需要已加入 Tailscale）。命令里带着令牌，运行完可清掉终端历史。' }),
      copyRow('Windows（PowerShell）', `$env:AME_NAME=${psq(r.name)}; $env:AME_TOKEN=${psq(r.token)}; irm ${RAW}/install-windows.ps1 | iex`),
      copyRow('Linux', `curl -fsSL ${RAW}/install-linux.sh | AME_NAME='${r.name}' AME_TOKEN='${r.token}' bash`));
    refresh();
  });

  refresh();
  const content = h('div', { class: 'computers' },
    h('div', { class: 'cmphead', text: '已登记的电脑' }), listBox,
    h('div', { class: 'cmphead', text: '添加一台电脑' }), form, result, msg);
  wm.open({ id: 'computers', title: '添加电脑', icon: icon('network_normal_two_pcs', true), content, width: 640, height: 480 });
}
