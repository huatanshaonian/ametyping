// Google AI Studio API in 控制面板 → AI 模型 (remote/server/ai/google-ai-api.js):
// Put in a Gemini API key from Google AI Studio (aistudio.google.com/apikey); kept on the NAS (0600) and never echoed
// back except its last 4 chars. Testing the key also refreshes the list of Gemini models the key can call.
import { h } from '../util.js';
import * as net from '../net.js';
import { confirmBox, alertBox } from '../dialog.js';
import { when } from './ai-cli.js';

export function googleApiBox(changed = () => {}) {
  const root = h('div', { class: 'aim-codex aim-cli', dataset: { tool: 'google-api' } });
  async function send(key) {
    const r = await net.post('/api/ai/google/key', { key });
    if (!r.ok) return alertBox(r.msg || '没能保存', { title: 'Google AI Studio API', bad: true });
    show(r.google || {});
    changed();
  }
  function show(c) {
    const k = c.checked;
    const input = h('input', {
      class: 'field aim-key',
      type: 'password',
      autocomplete: 'off',
      spellcheck: false,
      placeholder: c.has ? '换一个 key：AIzaSy…' : 'AIzaSy…',
    });
    const save = () => { const v = input.value.trim(); if (v) send(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    root.replaceChildren(...[
      h('p', {
        class: 'ghint',
        text: '在 Google AI Studio（aistudio.google.com/apikey）创建 Gemini API key 填到这里，群晖会通过现有的 Google 代理线路调用并自动拉取该账号可用的 Gemini 模型列表（保存后可在上方下拉框的「Google AI Studio」分组里选择，也可用于项目目录与总览整理）。',
      }),
      h('div', { class: 'aim-kv' },
        h('b', { text: 'API key' }),
        h('span', { class: c.has ? '' : 'aim-bad', text: c.has ? `已填（…${c.tail}）` : '还没填' }),
        c.has && c.setAt ? h('small', { text: `  ${when(c.setAt)} 填的` }) : null
      ),
      c.has ? h('div', { class: 'aim-kv' },
        h('b', { text: '状态' }),
        h('span', {
          class: k && !k.ok ? 'aim-bad' : '',
          text: !k ? '还没试过' : k.ok ? `可用（已发现 ${k.count || c.modelCount || 0} 个 Gemini 模型）` : k.error,
        }),
        k ? h('small', { text: `  ${when(k.at)} 试的` }) : null
      ) : null,
      h('div', { class: 'gbtns' },
        input,
        h('button', { class: 'btn', type: 'button', text: c.has ? '换成这个' : '保存', onclick: save }),
        c.has ? h('button', { class: 'btn', type: 'button', text: '测试并刷新模型', onclick: () => load(true) }) : null,
        c.has ? h('button', {
          class: 'btn',
          type: 'button',
          text: '删除 key',
          onclick: async () => {
            if (await confirmBox('删除群晖上保存的 Google AI Studio API key？', { title: 'Google AI Studio API', ok: '删除', danger: true })) send('');
          },
        }) : null
      ),
    ].filter(Boolean));
  }
  async function load(check) {
    root.replaceChildren(h('p', { class: 'ghint', text: check ? '正在测试并拉取模型列表…' : '读取中…' }));
    let c = {};
    try { c = await (await fetch('/api/ai/google' + (check ? '?check=1' : ''))).json(); } catch {}
    show(c);
    if (check && c.checked && c.checked.ok) changed();
  }
  load(false);
  return { root, destroy() {} };
}
