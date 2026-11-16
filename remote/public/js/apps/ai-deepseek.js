// DeepSeek API in 控制面板 → AI 模型 (remote/server/ai/deepseek-api.js):
// Unified management for the NAS DeepSeek API settings (key, model, base URL) used by background research extraction.
import { h } from '../util.js';
import * as net from '../net.js';
import { confirmBox, alertBox } from '../dialog.js';
import { when } from './ai-cli.js';

export function deepseekApiBox(changed = () => {}) {
  const root = h('div', { class: 'aim-codex aim-cli', dataset: { tool: 'deepseek-api' } });
  async function send(payload) {
    const r = await net.post('/api/ai/deepseek/key', payload);
    if (!r.ok) return alertBox(r.msg || '没能保存', { title: 'DeepSeek API', bad: true });
    show(r.deepseek || {});
    changed();
  }
  function show(c) {
    const k = c.checked;
    const modelInput = h('input', {
      class: 'field',
      type: 'text',
      value: c.model || 'deepseek-flash',
      placeholder: '模型名称（如 deepseek-flash）',
      style: 'width:150px',
    });
    const baseInput = h('input', {
      class: 'field',
      type: 'text',
      value: c.base || 'https://api.deepseek.com',
      placeholder: 'API 地址（如 https://api.deepseek.com）',
      style: 'width:210px',
    });
    const keyInput = h('input', {
      class: 'field aim-key',
      type: 'password',
      autocomplete: 'off',
      spellcheck: false,
      placeholder: c.has ? '换一个密钥（留空仅改模型/地址）' : 'sk-…',
    });
    const save = () => {
      send({
        model: modelInput.value.trim(),
        base: baseInput.value.trim(),
        key: keyInput.value.trim(),
      });
    };
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    root.replaceChildren(...[
      h('p', {
        class: 'ghint',
        text: '供群晖后台「研究与计算」分段抽取任务直连调用（保存在 NAS research-api.json；未单独填密钥时默认沿用 NAS 上的 cc-environments/deepseek 官方凭据）。',
      }),
      h('div', { class: 'aim-kv' },
        h('b', { text: 'API key' }),
        h('span', {
          class: c.has ? '' : 'aim-bad',
          text: c.has ? `已配置（…${c.tail}${c.explicit ? ' · 独立设置' : ' · 沿用本机凭据'}）` : '还没填',
        }),
        c.setAt ? h('small', { text: `  ${when(c.setAt)} 更新` }) : null
      ),
      h('div', { class: 'aim-kv' },
        h('b', { text: '模型与地址' }),
        h('span', { text: `${c.model || 'deepseek-flash'} · ${c.base || 'https://api.deepseek.com'}` })
      ),
      k ? h('div', { class: 'aim-kv' },
        h('b', { text: '测试状态' }),
        h('span', { class: k.ok ? '' : 'aim-bad', text: k.ok ? '可用' : k.error }),
        h('small', { text: `  ${when(k.at)} 试的` })
      ) : null,
      h('div', { class: 'gbtns', style: 'flex-wrap:wrap;gap:6px' },
        modelInput,
        baseInput,
        keyInput,
        h('button', { class: 'btn', type: 'button', text: '保存设置', onclick: save }),
        c.has ? h('button', { class: 'btn', type: 'button', text: '测试连通', onclick: () => load(true) }) : null,
        c.explicit ? h('button', {
          class: 'btn',
          type: 'button',
          text: '清除独立设置',
          onclick: async () => {
            if (await confirmBox('清除 NAS 上单独保存的 DeepSeek API 设置？', { title: 'DeepSeek API', ok: '清除', danger: true })) send({ remove: true });
          },
        }) : null
      ),
    ].filter(Boolean));
  }
  async function load(check) {
    root.replaceChildren(h('p', { class: 'ghint', text: check ? '正在测试 DeepSeek API…' : '读取中…' }));
    let c = {};
    try { c = await (await fetch('/api/ai/deepseek' + (check ? '?check=1' : ''))).json(); } catch {}
    show(c);
  }
  load(false);
  return { root, destroy() {} };
}
