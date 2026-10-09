// The Claude API in AI 模型 (remote/server/ai/api-key.js, anthropic-api.js): the key with which Claude's models are
// asked over the API first (the monthly API credit) -- put in here once (it asks for a code), kept on the NAS and
// never shown again but for its last four characters -- and whether the API takes it (「测试」 asks for the list of models: that costs nothing).
import { h } from '../util.js';
import * as net from '../net.js';
import { confirmBox, alertBox } from '../dialog.js';
import { when } from './ai-cli.js';

// changed(): the key was put in or taken away
export function apiBox(changed = () => {}) {
  const root = h('div', { class: 'aim-codex aim-cli', dataset: { tool: 'api' } });
  async function send(key) {
    const r = await net.post('/api/ai/api/key', { key });
    if (!r.ok) return alertBox(r.msg || '没能保存', { title: 'Claude API', bad: true });
    show(r.api || {}); changed();
  }
  function show(c) {
    const k = c.checked;
    const input = h('input', { class: 'field aim-key', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: c.has ? '换一个 key：sk-ant-…' : 'sk-ant-…' });
    const save = () => { const v = input.value.trim(); if (v) send(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    root.replaceChildren(...[
      h('p', { class: 'ghint', text: 'Max / Team 订阅每月送的 API 赠金只能通过 API 用：在 claude.ai 的「设置 → 账单」里把订阅关联到一个 Console 组织并领取，再到 Console 里新建一个 API key 填到这里。填了之后，凡是用 Claude 模型的任务都先走 API；API 出错或赠金用完时自动改走 Claude Code（订阅用量），再不行才用后备模型。不用另外选。' }),
      h('div', { class: 'aim-kv' }, h('b', { text: 'API key' }), h('span', { class: c.has ? '' : 'aim-bad', text: c.has ? `已填（…${c.tail}）` : '还没填' }),
        c.has && c.setAt ? h('small', { text: `  ${when(c.setAt)} 填的` }) : null),
      c.has ? h('div', { class: 'aim-kv' }, h('b', { text: '状态' }), h('span', { class: k && !k.ok ? 'aim-bad' : '', text: !k ? '还没试过' : k.ok ? '可用' : k.error }),
        k ? h('small', { text: `  ${when(k.at)} 试的` }) : null) : null,
      h('div', { class: 'gbtns' }, input,
        h('button', { class: 'btn', type: 'button', text: c.has ? '换成这个' : '保存', onclick: save }),
        c.has ? h('button', { class: 'btn', type: 'button', text: '测试', onclick: () => load(true) }) : null,
        c.has ? h('button', { class: 'btn', type: 'button', text: '删除 key', onclick: async () => {
          if (await confirmBox('删除群晖上保存的 Claude API key？\nClaude 的模型之后只走 Claude Code（订阅用量）。', { title: 'Claude API', ok: '删除', danger: true })) send('');
        } }) : null)].filter(Boolean));
  }
  async function load(check) {
    root.replaceChildren(h('p', { class: 'ghint', text: check ? '正在测试…' : '读取中…' }));
    let c = {}; try { c = await (await fetch('/api/ai/api' + (check ? '?check=1' : ''))).json(); } catch {}
    show(c);
  }
  load(false);
  return { root, destroy() {} };
}
