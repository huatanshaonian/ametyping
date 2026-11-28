// Infrastructure modal dialogs for adding/editing nodes and links (used by infra.js).
import { h } from '../util.js';
import * as net from '../net.js';
import { confirmBox } from '../dialog.js';
import { effectiveTier } from './infra-topo.js';

export function openNodeDialog(existing, { onSelectNode, fetchState }) {
  const isEdit = !!(existing && existing.id);
  const idIn = h('input', { class: 'field', type: 'text', value: existing ? existing.id : '', disabled: isEdit, placeholder: '与令牌电脑名一致，如 aws1, gcp1, openwrt' });
  const labelIn = h('input', { class: 'field', type: 'text', value: existing ? existing.label : '', placeholder: '显示名称，如：AWS 东京 (aws1)' });
  const hostIn = h('input', { class: 'field', type: 'text', value: existing ? existing.host : '', placeholder: 'IP 或 Tailscale 地址，如 100.120.53.46' });
  const roleSel = h('select', { class: 'field' },
    h('option', { value: 'cloud', text: '云端服务器 (AWS / GCP / VPS)' }),
    h('option', { value: 'router', text: '网关路由器 (OpenWrt)' }),
    h('option', { value: 'nas', text: '核心存储与容器宿主 (NAS)' }),
    h('option', { value: 'workstation', text: '开发工作站 / GPU 算力机' })
  );
  if (existing && existing.role) roleSel.value = existing.role;
  const tierSel = h('select', { class: 'field' },
    h('option', { value: '0', text: '第 1 列：终端与算力工作站' }),
    h('option', { value: '1', text: '第 2 列：局域网核心 (网关 / NAS)' }),
    h('option', { value: '2', text: '第 3 列：云端出口与穿透节点' })
  );
  tierSel.value = String(existing ? effectiveTier(existing) : 2);

  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: isEdit ? `编辑节点「${existing.id}」` : '添加监控设备节点' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      h('label', { class: 'xnote-lbl', text: '节点标识 ID（需与「设备接入与令牌」里的电脑名字一致）：' }),
      idIn,
      h('label', { class: 'xnote-lbl', text: '显示名称与地址说明：' }),
      h('div', { style: 'display:flex;gap:6px' }, labelIn, hostIn),
      h('label', { class: 'xnote-lbl', text: '设备角色与拓扑图所在列：' }),
      h('div', { style: 'display:flex;gap:6px' }, roleSel, tierSel),
      h('div', { class: 'dlga' },
        isEdit && existing.id !== 'nas' ? h('button', {
          class: 'btn no',
          type: 'button',
          style: 'margin-right:auto',
          text: '删除节点',
          onclick: async () => {
            if (await confirmBox(`确定从拓扑图中移除节点「${existing.label || existing.id}」吗？`, { danger: true })) {
              done();
              await net.post('/api/infra/node', { op: 'delete', id: existing.id });
              await fetchState();
            }
          },
        }) : null,
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '保存' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = idIn.value.trim();
    if (!id) return;
    done();
    await net.post('/api/infra/node', {
      id,
      label: labelIn.value.trim() || id,
      host: hostIn.value.trim(),
      role: roleSel.value,
      tier: Number(tierSel.value),
    });
    onSelectNode(id);
    await fetchState();
  });
  const wrap = h('div', { class: 'dlg' }, form);
  document.body.append(wrap);
}

export function openLinkDialog(existing, { nodes, fetchState }) {
  const isEdit = !!(existing && existing.id);
  const fromSel = h('select', { class: 'field' }, ...nodes.map((n) => h('option', { value: n.id, text: `${n.label} (${n.id})` })));
  const toSel = h('select', { class: 'field' }, ...nodes.map((n) => h('option', { value: n.id, text: `${n.label} (${n.id})` })));
  if (existing && existing.from) fromSel.value = existing.from;
  if (existing && existing.to) toSel.value = existing.to;
  else if (nodes.length > 1) toSel.value = nodes[nodes.length - 1].id;

  const labelIn = h('input', { class: 'field', type: 'text', value: (existing && existing.label) || '', placeholder: '如：Tailscale SOCKS5 :1080 或 Claude HTTP :18888' });
  const svcIn = h('input', { class: 'field', type: 'text', value: (existing && existing.service) || '', placeholder: '关联服务名，如 danted, claude-gcp-proxy, sing-box' });
  const hostIn = h('input', { class: 'field', type: 'text', value: (existing && existing.probeHost) || '', placeholder: '探测目标 IP/域名，如 100.120.53.46' });
  const portIn = h('input', { class: 'field', type: 'number', value: (existing && existing.probePort) || '', placeholder: '探测端口，如 1080' });
  const standbyChk = h('input', { type: 'checkbox', checked: !!(existing && existing.standby) });

  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: isEdit ? '编辑网络互联链路' : '添加网络互联链路' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      h('label', { class: 'xnote-lbl', text: '起点设备 → 终点设备：' }),
      h('div', { style: 'display:flex;gap:6px;align-items:center' }, fromSel, h('span', { text: '→' }), toSel),
      h('label', { class: 'xnote-lbl', text: '链路显示名称与依赖的服务名：' }),
      h('div', { style: 'display:flex;gap:6px' }, labelIn, svcIn),
      h('label', { class: 'xnote-lbl', text: '实时延迟探测目标 IP 与 TCP 端口（可选）：' }),
      h('div', { style: 'display:flex;gap:6px' }, hostIn, portIn),
      h('label', { style: 'display:flex;align-items:center;gap:6px;margin-top:6px' }, standbyChk, '设为备用待命通道（拓扑图中以蓝色虚线显示，如 NAS 备用出口）'),
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '保存链路' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    done();
    await net.post('/api/infra/link', {
      id: existing && existing.id ? existing.id : undefined,
      from: fromSel.value,
      to: toSel.value,
      label: labelIn.value.trim(),
      service: svcIn.value.trim(),
      probeHost: hostIn.value.trim(),
      probePort: Number(portIn.value) || 0,
      standby: standbyChk.checked,
    });
    await fetchState();
  });
  const wrap = h('div', { class: 'dlg' }, form);
  document.body.append(wrap);
}
