// 控制面板 › MCP (server/mcp-hub.js): Windose's managed MCP servers -- what each does, its limits and tools -- which coding
// agents on which computer have them registered (each agent reports it), and one-click sync across online agents.
import { h, ago, codeBlock } from '../util.js';
import * as net from '../net.js';

const CLIENT_NAMES = { 'ame-mesh': '协同', 'windose-literature': '文献', 'windose-research': '档案', 'windose-hpc': '超算' };
const postFleet = (path, body) => net.post('/api/fleet/' + path, body);
const code = (title, text) => codeBlock(title, text, '复制');

export function panel() {
  const root = h('div', { class: 'mcp' });
  const msg = h('p', { class: 'gnote', 'aria-live': 'polite' });
  const body = h('div');
  let busy = false, destroyed = false, loadSeq = 0;
  root.append(h('p', { class: 'ghint', text: 'MCP 是 Claude Code、Codex、OpenCode、Antigravity 等 agent 调用外部工具的标准接口。下面这些都只连本机的 Windose agent，由它经自己和看板服务器的连接转发：别的电脑不用配 SSH，也不另发密钥；装了 Windose agent 并在线就能用。' }), msg, body);

  async function syncHooks(machine, doing) {
    if (busy) return;
    busy = true;
    msg.textContent = doing;
    msg.classList.remove('bad');
    const r = await postFleet('sync-hooks', { machine });
    busy = false;
    msg.textContent = r.msg || (r.ok ? '已同步' : '同步失败');
    msg.classList.toggle('bad', !r.ok);
    load(true);
  }

  async function load(keepMsg = false) {
    const seq = ++loadSeq;
    const r = await net.getJson('/api/mcp');
    if (destroyed || seq !== loadSeq) return;
    if (!r || !r.servers) { msg.textContent = '读不到 MCP 信息（看板服务器版本太旧？）'; return; }
    if (!keepMsg) { msg.textContent = ''; msg.classList.remove('bad'); }
    const cards = r.servers.map((s) => h('div', { class: 'mcp-card' + (s.enabled ? '' : ' off') },
      h('div', { class: 'mcp-h' }, h('b', { text: s.title }), h('code', { text: s.name }), h('i', { class: 'tag', text: s.enabled ? '可用' : '服务器上没开' })),
      h('p', { text: s.what }), h('p', { class: 'mcp-lim', text: '限制：' + s.limits }),
      h('small', { class: 'mcp-tools', text: '工具：' + s.tools.join('、') })));
    const names = r.servers.map((s) => s.name);
    const anyOnline = r.machines.some((m) => m.online);
    const rows = r.machines.map((m) => {
      const st = m.status, clients = st ? st.clients.filter((c) => c.present) : [];
      return h('tr', {}, h('td', {}, h('b', { text: m.name }), h('small', { text: m.online ? ' 在线' : ' 离线' })),
        h('td', {}, !st ? h('small', { text: '没有上报（agent 版本旧，或还没连上过）' })
          : !clients.length ? h('small', { text: '这台电脑没有装 Claude Code / Codex / OpenCode / Antigravity / Kiro' })
          : h('div', { class: 'mcp-cl' }, ...clients.map((c) => h('span', { class: 'mcp-c', title: c.error || '' }, h('b', { text: c.label }),
            c.error ? h('small', { class: 'bad', text: ' 配置读不了' }) : h('small', { text: ' ' + (names.map((n) => (c.servers.includes(n) ? '✓' : '✗') + (CLIENT_NAMES[n] || n)).join(' ')) }))))),
        h('td', {},
          h('small', { text: !st ? '' : [st.forward ? '' : '转发已关', st.auto ? '自动安装' : '不自动安装', ago(st.at)].filter(Boolean).join(' · ') }),
          m.online ? h('button', { class: 'btn fleet-sm', type: 'button', text: '同步', disabled: busy, style: 'margin-left:8px',
            onclick: () => syncHooks(m.name, `${m.name}：正在同步 MCP 与 Hook…`) }) : ''));
    });
    body.replaceChildren(
      h('h4', { class: 'aim-h', text: `${r.servers.length} 个托管 MCP` }), ...cards,
      h('h4', { class: 'aim-h', text: '各电脑的安装情况' }),
      anyOnline ? h('p', {}, h('button', { class: 'btn', type: 'button', text: '所有电脑：一键同步 MCP & Hook', disabled: busy,
        onclick: () => syncHooks('*', '正在同步所有在线电脑的 MCP 与 Hook…') })) : '',
      rows.length ? h('table', { class: 'mcp-t' }, h('thead', {}, h('tr', {}, h('th', { text: '电脑' }), h('th', { text: 'agent 客户端（✓ 已登记）' }), h('th', { text: '' }))), h('tbody', {}, ...rows))
        : h('p', { class: 'ghint', text: '还没有电脑连上来。' }),
      h('p', { class: 'ghint', text: '改了配置后要重启那个客户端（或开新会话）才会加载新的 MCP。' }),
      h('h4', { class: 'aim-h', text: '怎么安装' }),
      h('p', { text: `装好 Windose agent 的电脑（设备与算力 › 设备接入与令牌 里添加），agent 每次启动都会自动把这 ${r.servers.length} 个 MCP 登记进这台电脑上找得到的客户端，也可以直接点上面的按钮远程一键同步。要手动装、看状态或卸载，在 AmeTyping 仓库目录里运行：` }),
      code('登记（Windows / Linux 一样）', 'node install-mesh-mcp.js'),
      code('看这台电脑哪些客户端登记了', 'node install-mesh-mcp.js --status'),
      code('全部卸载', 'node install-mesh-mcp.js --remove'),
      h('p', { class: 'ghint', text: '前提：这台电脑上 Windose agent 在运行并连上了看板服务器（远程控制要开，agent 才会自动安装；agent.json 里 "mcp": false 可以关掉文献和档案的转发）。详细说明见仓库里的 docs/mcp.md。' }));
  }
  load();
  return { root, show: () => load(), destroy() { destroyed = true; } };
}
