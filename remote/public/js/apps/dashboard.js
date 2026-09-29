// 糖糖看板 as a desktop window: every computer's sessions (newest first, the current computer on top), the chosen
// session's conversation, its permission cards, navigation keys for the terminal's menus, and the reply box.
// Where the machine allows it, replies / keys / decisions are carried out by the pet (or headless service) there.
import { $, h, esc, hhmm, ago, stateOf } from '../util.js';
import * as net from '../net.js';
import * as wm from '../wm.js';

const PAGE = 50;
const PLACEHOLDER = {
  terminal: '回复（Enter 发送，Shift+Enter 换行）— 会打进那台机器的终端',
  resume: '会话已关闭：发送会在那台机器后台用 claude -p --resume 续上',
  busy: '后台续聊进行中…',
  none: '这个会话不在终端里（IDE / 桌面 App），只能看',
  unknown: '还不知道它在哪个终端（等它下一次有动静）',
  codex: 'Codex 会话请在 Codex 里继续；这里可以处理权限',
  off: '这台机器没开远程控制（或糖糖没在运行），只能看',
};
const KEYS = [['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'], ['enter', '回车'], ['esc', 'Esc'], ['tab', 'Tab']];
const coarse = matchMedia('(pointer: coarse)').matches;      // phones: Enter is a newline, the button sends

let app = null;                                              // the open instance

export function open(current) {
  if (app) { app.setCurrent(current); wm.open({ id: 'dashboard' }); return; }
  app = mount(current);
  wm.open({ id: 'dashboard', title: '糖糖看板', icon: '/asset/icon256.png', content: app.root, width: 900, height: 560,
    onClose: () => { app.destroy(); app = null; } });
}
export function setCurrent(current) { if (app) app.setCurrent(current); }

function mount(current) {
  // ---- markup ----
  const list = h('div', { class: 'list' }, h('div', { class: 'empty', text: '还没有会话。' }));
  const hname = h('b', { text: '选择一个会话' }), hmeta = h('span', { class: 'meta' });
  const back = h('button', { class: 'btn back', type: 'button', text: '‹ 返回' });
  const rcmd = h('code', { class: 'rcmd' });
  const resume = h('div', { class: 'resume', hidden: true }, h('span', { text: '继续：' }), rcmd, h('button', { class: 'btn', type: 'button', text: '复制', onclick: copyResume }));
  const convEl = h('div', { class: 'conv' }, h('div', { class: 'pick', text: '从左边选一个会话查看完整对话。' }));
  const permsEl = h('div', { class: 'perms' });
  const note = h('div', { class: 'note' });
  const keys = h('div', { class: 'keys', hidden: true },
    ...KEYS.map(([k, l]) => h('button', { class: 'btn', type: 'button', dataset: { key: k }, text: l })),
    h('span', { class: 'kh', text: '操作终端里的菜单（如 /model、/resume）' }));
  const say = h('textarea', { class: 'say', rows: 1, placeholder: '先选一个会话', disabled: true });
  const sendBtn = h('button', { class: 'btn go', type: 'submit', text: '发送', disabled: true });
  const compose = h('form', { class: 'compose', autocomplete: 'off' }, say, sendBtn);
  const right = h('div', { class: 'right' }, h('div', { class: 'head' }, h('span', { style: 'min-width:0;display:flex;align-items:center' }, back, hname), hmeta),
    resume, convEl, permsEl, note, keys, compose);
  const root = h('div', { class: 'dash' }, list, right);

  let sel = null;                                   // "machine|id"
  const cards = new Map(), heads = new Map(), shown = new Map(), permCards = new Map();
  let sending = false, noteTimer = null;

  const allSessions = () => net.state.sessions.flatMap((m) => m.sessions.map((s) => ({ ...s, machine: m.machine, online: m.online })));
  const find = (key) => { if (!key) return null; const [machine, id] = key.split('|'); return allSessions().find((x) => x.machine === machine && x.id === id) || null; };
  const lastLine = (s) => { for (let i = (s.lines || []).length - 1; i >= 0; i--) if (s.lines[i].text) return s.lines[i].text; return s.state === 'history' ? '（历史会话）' : '…'; };

  // ---- list (nodes are reused so a click is never lost to a rebuild) ----
  function renderList() {
    const machines = [...net.state.sessions].sort((a, b) => (b.machine === current) - (a.machine === current));
    if (!machines.some((m) => m.sessions.length)) { list.replaceChildren(h('div', { class: 'empty', text: '还没有会话。开着 agent 的电脑一有 Claude 活动就会出现在这里。' })); cards.clear(); heads.clear(); return; }
    const order = [];
    const wanted = new Set();
    for (const m of machines) {
      if (!m.sessions.length) continue;
      const limit = shown.get(m.machine) || PAGE;
      let mc = heads.get(m.machine);
      if (!mc) { mc = h('div'); heads.set(m.machine, mc); }
      mc.className = 'mc' + (m.online ? ' on' : '') + (m.machine === current ? ' cur' : '');
      const mtext = `${m.machine} · ${m.sessions.length} 个会话${m.online ? '' : '（离线）'}${m.online && !m.control ? ' · 只读' : ''}`;
      if (mc.dataset.t !== mtext) { mc.dataset.t = mtext; mc.replaceChildren(h('span', { class: 'dot' }), mtext); }
      order.push(mc);
      for (const s of m.sessions.slice(0, limit)) {
        const key = m.machine + '|' + s.id;
        wanted.add(key);
        let c = cards.get(key);
        if (!c) { c = h('div', { class: 'card', dataset: { key } }, h('div', { class: 'nm' }), h('div', { class: 'sm' }), h('div', { class: 'st' })); cards.set(key, c); }
        const [cls, name] = stateOf(s.state), n = (s.perms || []).length;
        c.className = 'card' + (sel === key ? ' sel' : '');
        const nmHtml = esc(s.label) + (n ? `<span class="pb">待确认 ${n}</span>` : '');
        if ($('.nm', c).innerHTML !== nmHtml) $('.nm', c).innerHTML = nmHtml;
        if ($('.sm', c).textContent !== lastLine(s)) $('.sm', c).textContent = lastLine(s);
        const st = $('.st', c); st.className = 'st ' + cls; st.textContent = `${name}${s.project ? ' · ' + s.project : ''} · ${ago(s.last)}`;
        order.push(c);
      }
      if (m.sessions.length > limit) {
        const k = 'more|' + m.machine;
        let mo = heads.get(k);
        if (!mo) { mo = h('div', { class: 'more', dataset: { machine: m.machine } }); heads.set(k, mo); }
        mo.textContent = `显示更多（还有 ${m.sessions.length - limit} 个）`;
        order.push(mo);
      }
    }
    for (const [k, el] of cards) if (!wanted.has(k)) { el.remove(); cards.delete(k); }
    for (const [k, el] of heads) if (!order.includes(el)) { el.remove(); heads.delete(k); }
    const empty = $('.empty', list); if (empty) empty.remove();
    order.forEach((el, i) => { if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null); });
    while (list.children.length > order.length) list.lastElementChild.remove();
  }
  list.addEventListener('click', (e) => {
    const mo = e.target.closest('.more');
    if (mo) { shown.set(mo.dataset.machine, (shown.get(mo.dataset.machine) || PAGE) + PAGE); renderList(); return; }
    const c = e.target.closest('.card'); if (c) select(c.dataset.key);
  });
  back.addEventListener('click', () => root.classList.remove('viewing'));

  function select(key) {
    sel = key;
    renderList();
    root.classList.add('viewing');
    const s = find(key), [machine, id] = key.split('|');
    convEl.replaceChildren(h('div', { class: 'pick', text: '加载对话…' }));
    permsEl.replaceChildren(); permCards.clear(); showNote('');
    header(s);
    renderControls();
    net.send({ t: 'watch', machine, id });
  }
  function header(s) {
    const [machine] = (sel || '|').split('|');
    hname.textContent = s ? s.label : '选择一个会话';
    hmeta.textContent = s ? `${machine}${s.project ? ' · ' + s.project : ''}${s.online ? '' : ' · 离线'}` : '';
    resume.hidden = !(s && s.resume);
    if (s && s.resume && rcmd.textContent !== s.resume) rcmd.textContent = s.resume;
  }
  async function copyResume() {
    try { await navigator.clipboard.writeText(rcmd.textContent); showNote('已复制继续命令'); }
    catch { const r = document.createRange(); r.selectNodeContents(rcmd); const sl = getSelection(); sl.removeAllRanges(); sl.addRange(r); showNote('已选中，按 Ctrl+C 复制'); }
  }
  function showNote(msg, bad, ms = 6000) {
    clearTimeout(noteTimer);
    note.textContent = msg || ''; note.classList.toggle('show', !!msg); note.classList.toggle('bad', !!bad);
    if (msg) noteTimer = setTimeout(() => note.classList.remove('show'), ms);
  }

  // ---- reply box + keys ----
  function renderControls() {
    const s = find(sel);
    const via = s ? (s.online ? s.via || 'off' : 'off') : null;
    say.disabled = !s || sending || !['terminal', 'resume'].includes(via);
    say.placeholder = !s ? '先选一个会话' : s.online ? PLACEHOLDER[via] || PLACEHOLDER.off : '这台机器离线了';
    if (s && s.state === 'history') say.placeholder = '历史会话（Claude Code 已不在运行）：用上面的命令在那台电脑上继续';
    if (s && (s.perms || []).length) { say.disabled = true; if (via === 'terminal') say.placeholder = '它在等你确认，先处理下面的确认卡片'; }
    sendBtn.disabled = say.disabled || !say.value.trim();
    keys.hidden = !(s && s.online && via === 'terminal');
    renderPerms(s);
  }
  const fitSay = () => { say.style.height = 'auto'; say.style.height = Math.min(140, say.scrollHeight + 2) + 'px'; };
  say.addEventListener('input', () => { fitSay(); sendBtn.disabled = say.disabled || !say.value.trim(); });
  say.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); compose.requestSubmit(); } });
  compose.addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = find(sel), text = say.value;
    if (!s || say.disabled || !text.trim()) return;
    sending = true; renderControls(); showNote('发送中…', false, 30000);
    const r = await net.act({ t: 'send', machine: s.machine, id: s.id, text });
    sending = false;
    if (r.ok) { if (say.value === text) { say.value = ''; fitSay(); } showNote(r.msg || '已发送'); } else showNote(r.msg || '发送失败', true);
    renderControls();
  });
  keys.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-key]'), s = find(sel);
    if (!b || !s) return;
    b.disabled = true;
    const r = await net.act({ t: 'key', machine: s.machine, id: s.id, key: b.dataset.key });
    b.disabled = false;
    if (!r.ok) showNote(r.msg || '按键失败', true);
  });

  // ---- permission cards (stable across updates) ----
  function renderPerms(s) {
    const perms = s && s.online ? s.perms || [] : [];
    const ids = new Set(perms.map((p) => p.id));
    for (const [id, el] of permCards) if (!ids.has(id)) { el.remove(); permCards.delete(id); }
    for (const p of perms) {
      if (permCards.has(p.id)) continue;
      let i = {}; try { i = JSON.parse(p.input); } catch {}
      const choices = [['allow', '允许', 'btn go'], ['deny', '拒绝', 'btn no']];
      if (p.provider === 'codex') choices.push(['defer', '在 Codex 中处理', 'btn']);
      const card = h('div', { class: 'perm', dataset: { id: p.id } },
        h('div', { class: 'pt', text: `需要你确认 · ${p.tool}${p.subagent ? ' · ' + p.subagent : ''}` }),
        h('pre', { text: [p.cwd && `工作目录：${p.cwd}`, i.description, i.command && `${p.tool === 'apply_patch' ? '修改补丁' : '命令'}：${i.command}`,
          (i.file_path || i.notebook_path) && `文件：${i.file_path || i.notebook_path}`, p.input].filter(Boolean).join('\n') }),
        h('div', { class: 'pa' }, ...choices.map(([c, l, cls]) => h('button', { class: cls, type: 'button', dataset: { choice: c }, text: l })),
          h('span', { class: 'ps', text: '也可在那台机器上回答' })));
      permCards.set(p.id, card); permsEl.append(card);
    }
  }
  permsEl.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const card = b.closest('.perm'), s = find(sel); if (!s) return;
    for (const x of card.querySelectorAll('button')) x.disabled = true;
    const st = $('.ps', card); st.textContent = '提交中…';
    const r = await net.act({ t: 'decide', machine: s.machine, id: s.id, perm: card.dataset.id, choice: b.dataset.choice });
    st.textContent = r.ok ? '已提交' : (r.msg || '提交失败');
    if (!r.ok) for (const x of card.querySelectorAll('button')) x.disabled = false;
  });

  // ---- conversation ----
  const inline = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  function md(text) {
    const out = [];
    String(text).split(/```[^\n]*\n?/).forEach((part, i) => {
      if (i % 2) out.push(`<pre>${esc(part.replace(/\n$/, ''))}</pre>`);
      else for (const para of part.split(/\n{2,}/)) if (para.trim()) out.push(`<p>${inline(para.trim())}</p>`);
    });
    return out.join('');
  }
  function msgEl(m) {
    const d = h('div', { class: 'm ' + m.role });
    const tm = `<span class="tm">${m.t ? hhmm(m.t) : ''}</span>`;
    if (m.role === 'assistant') d.innerHTML = md(m.text || '');
    else if (m.role === 'tool') d.innerHTML = `<b>⚙</b> ${(m.items || []).slice(-5).map(esc).join(' · ')}${tm}`;
    else if (m.role === 'user') { d.textContent = m.text || ''; d.insertAdjacentHTML('beforeend', tm); }
    else d.textContent = m.text || '';
    return d;
  }
  function renderConv(msgs) {
    const atBottom = convEl.scrollHeight - convEl.scrollTop - convEl.clientHeight < 60;
    if (!msgs.length) { convEl.replaceChildren(h('div', { class: 'pick', text: '这个会话还没有内容。' })); return; }
    convEl.replaceChildren(...msgs.map(msgEl));
    if (atBottom || convEl.dataset.for !== sel) convEl.scrollTop = convEl.scrollHeight;
    convEl.dataset.for = sel;
  }

  // ---- wiring ----
  const offs = [
    net.on('sessions', () => { renderList(); if (sel) header(find(sel)); renderControls(); }),
    net.on('conv', (d) => { if (sel === d.machine + '|' + d.id) renderConv(d.msgs || []); }),
    net.on('open', () => { if (sel) { const [machine, id] = sel.split('|'); net.send({ t: 'watch', machine, id }); } }),
  ];
  const tickT = setInterval(renderList, 15000);               // "N分前" labels
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 620));
  ro.observe(root);
  renderList();

  return {
    root,
    setCurrent(c) { current = c; renderList(); list.scrollTop = 0; },
    destroy() { for (const off of offs) off(); clearInterval(tickT); ro.disconnect(); net.send({ t: 'unwatch' }); },
  };
}
