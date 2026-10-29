// Slash command suggestions in 糖糖看板's reply box, like Claude Code's own: type "/" and the commands that match show
// above the box -- the built-in ones here, plus the machine's own commands, skills and plugin commands (sent by its
// agent, /api/commands). ↑ ↓ choose, Tab (or Enter, unless the command is already typed out) fills it in, Esc closes;
// on a phone, tap one.
import { h } from '../util.js';

const BUILTIN = [
  ['add-dir', '添加一个工作目录'], ['agents', '管理子代理'], ['btw', '顺带问一句，不打断当前任务'], ['clear', '清空对话，重新开始'],
  ['compact', '压缩上下文（可附要点）'], ['config', '打开设置'], ['context', '查看上下文占用'], ['cost', '本次会话的花费和用时'],
  ['doctor', '检查安装和配置'], ['exit', '退出 Claude Code'], ['export', '导出这段对话'], ['feedback', '反馈问题'],
  ['help', '帮助和命令列表'], ['hooks', '管理 hooks'], ['ide', '连接 IDE'], ['init', '为项目生成 CLAUDE.md'],
  ['login', '登录'], ['logout', '退出登录'], ['mcp', '管理 MCP 服务器'], ['memory', '编辑记忆文件（CLAUDE.md）'],
  ['model', '切换模型'], ['output-style', '切换输出风格'], ['permissions', '权限规则'], ['plugin', '管理插件'],
  ['pr-comments', '读取 PR 评论'], ['release-notes', '更新说明'], ['rename', '重命名这个会话'], ['resume', '恢复以前的会话'],
  ['review', '审查 PR'], ['rewind', '回退到之前的某一步'], ['security-review', '安全审查当前改动'], ['status', '版本、模型、账号等状态'],
  ['statusline', '设置状态栏'], ['terminal-setup', '终端按键设置'], ['theme', '切换配色'], ['todos', '当前待办'],
  ['usage', '用量和限额'], ['vim', 'Vim 编辑模式'],
].map(([name, desc]) => ({ name, desc, src: 'builtin' }));
const MAX = 8, CACHE_MS = 5 * 60e3;
const CODEX = [
  ['model', '切换模型和推理强度'], ['permissions', '设置权限'], ['plan', '切换计划模式'], ['status', '会话、上下文和用量'],
  ['resume', '恢复已有会话'], ['new', '开始新会话'], ['clear', '清屏并开始新会话'], ['rename', '重命名当前会话'],
  ['fork', '从当前会话分支'], ['compact', '压缩上下文'], ['review', '审查代码改动'], ['diff', '查看代码改动'],
  ['init', '生成 AGENTS.md'], ['skills', '选择技能'], ['mcp', '查看 MCP 服务器'], ['hooks', '管理 hooks'],
  ['ps', '查看后台终端'], ['stop', '停止后台终端'], ['quit', '退出 Codex'], ['feedback', '提交反馈'],
].map(([name, desc]) => ({ name, desc, src: 'builtin' }));

export function createSlash({ say, machine, provider = () => 'claude', onFill }) {
  const el = h('div', { class: 'slash', hidden: true });
  const cache = new Map();                           // machine -> { at, list }
  let items = [], idx = 0, prefix = null;

  async function own(m, p) {
    const key = m + '|' + p, c = cache.get(key);
    if (c && Date.now() - c.at < CACHE_MS) return c.list;
    cache.set(key, { at: Date.now(), list: c ? c.list : [] });
    try { const r = await fetch('/api/commands?machine=' + encodeURIComponent(m) + '&provider=' + p); if (r.ok) cache.set(key, { at: Date.now(), list: (await r.json()).list || [] }); } catch {}
    return cache.get(key).list;
  }
  // the command word being typed: "/" at the very start, the caret still inside the word
  function token() {
    const v = say.value, c = say.selectionStart;
    if (!(v.startsWith('/') || (provider() === 'codex' && v.startsWith('$'))) || say.selectionEnd !== c) return null;
    const word = v.slice(1, c);
    return /\s/.test(word) ? null : word;
  }
  async function refresh() {
    const t = say.disabled ? null : token();
    if (t == null) return close();
    const m = machine();
    const p = provider(), leader = say.value[0];
    const all = [...(m ? await own(m, p) : []), ...(leader === '$' ? [] : p === 'codex' ? CODEX : p === 'opencode' ? [] : BUILTIN)];
    if (say.disabled || token() !== t || provider() !== p || machine() !== m || say.value[0] !== leader) return;
    const low = t.toLowerCase();
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(low));
    const inside = low ? all.filter((c) => !c.name.toLowerCase().startsWith(low) && c.name.toLowerCase().includes(low)) : [];
    const seen = new Set();
    items = [...starts, ...inside].filter((c) => !seen.has(c.name) && seen.add(c.name)).slice(0, MAX);
    if (!items.length) return close();
    if (prefix !== t) idx = 0;
    prefix = t;
    render();
  }
  function render() {
    el.replaceChildren(...items.map((c, i) => h('div', { class: 'sl' + (i === idx ? ' on' : ''), dataset: { i } },
      h('b', { text: trigger(c) + c.name }), h('span', { text: c.desc || '' }), c.src !== 'builtin' ? h('i', { text: c.src === 'skill' ? '技能' : '自定义' }) : null)));
    el.hidden = false;
  }
  function close() { el.hidden = true; items = []; prefix = null; }
  const trigger = (c) => provider() === 'codex' && c.src === 'skill' ? '$' : '/';
  function fill(i) {
    const c = items[i]; if (!c) return;
    const v = say.value, end = say.selectionStart;
    say.value = trigger(c) + c.name + ' ' + v.slice(end).replace(/^\S*\s?/, '');
    const pos = c.name.length + 2;
    say.setSelectionRange(pos, pos);
    close();
    onFill();
  }
  // (capture: before the box's own keys -- Enter sends, keys go to the terminal when it is empty)
  say.addEventListener('keydown', (e) => {
    if (el.hidden || e.isComposing) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { idx = (idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; render(); stop(); }
    else if (e.key === 'Tab' && !e.shiftKey) { fill(idx); stop(); }
    else if (e.key === 'Enter' && !e.shiftKey && say.value.trim() !== trigger(items[idx]) + items[idx].name) { fill(idx); stop(); }
    else if (e.key === 'Escape') { close(); stop(); }
  }, true);
  say.addEventListener('input', refresh);
  say.addEventListener('click', refresh);
  say.addEventListener('blur', () => setTimeout(close, 150));
  el.addEventListener('pointerdown', (e) => { const r = e.target.closest('.sl'); if (r) { e.preventDefault(); fill(+r.dataset.i); } });
  return { el, close };
}
