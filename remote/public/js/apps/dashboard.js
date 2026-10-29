// 糖糖看板 as a desktop window: every computer's sessions (newest first, the current computer on top), the chosen
// session's conversation, its permission cards, navigation keys for the terminal's menus, and the reply box.
// Where the machine allows it, replies / keys / decisions are carried out by the pet (or headless service) there.
import { $, h, esc, hhmm, prefs, ctxLeft, CTX_LOW, aiMark } from '../util.js';
import * as net from '../net.js';
import * as ctxmenu from '../ctxmenu.js';
import { inline, follow } from './dash-paths.js';
import * as wm from '../wm.js';
import { createList } from './dash-list.js';
import { createNotes } from './dash-notes.js';
import { createAgents } from './dash-agents.js';
import { createBtw } from './dash-btw.js';
import { createSlash } from './dash-slash.js';
import { createTerm, opensMenu } from './dash-term.js';
import * as backnav from '../backnav.js';
import { askCard, questionsOf } from './dash-ask.js';

// the reply box's hint, by how the session can be reached
const PLACEHOLDER = {
  terminal: '回复（空框时按键直达终端）',
  resume: '已关闭：发送会在后台续上',
  busy: '后台续聊中…',
  none: '不在终端里，只能看',
  unknown: '还不知道在哪个终端',
  codex: 'Codex 会话：只能看和审批',
  opencode: '直接回复（OpenCode 走它自己的会话 API）',
  off: '没开远程控制，只能看',
};
const provOf = (id) => (String(id || '').startsWith('codex:') ? 'codex' : String(id || '').startsWith('opencode:') ? 'opencode' : 'claude');
const KEYS = [['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'], ['enter', '回车'], ['esc', 'Esc'], ['tab', 'Tab'], ['btab', '⇧Tab']];
// Claude Code's own Ctrl combinations (buttons only): [key, label, what it does]
const COMBOS = [['ctrlb', '转后台', 'Ctrl+B：把正在跑的命令放到后台，Claude 接着往下做'],
  ['ctrlxs', '立刻发', 'Ctrl+X Ctrl+S：排队的消息和输入框里的草稿马上交给 Claude，不等这一步跑完'],
  ['ctrls', '暂存', 'Ctrl+S：把终端输入框里写了一半的话先暂存起来，输入框清空']];
// keyboard keys that go to the terminal while the reply box is empty (its menus: /model, /resume, prompts;
// Shift+Tab cycles Claude Code's permission mode)
const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', Escape: 'esc', Tab: 'tab' };
const keyOf = (e) => (e.key === 'Tab' && e.shiftKey ? 'btab' : KEYMAP[e.key]);
// Claude Code's permission mode, as its transcript records it with every message (the store keeps the latest)
const MODE = { default: '手动', auto: '自动', manual: '手动', acceptEdits: '接受编辑', plan: '计划', bypassPermissions: '跳过权限', dontAsk: '不询问' };
const ENTER_GRACE = 600;           // a card must have been on screen this long before Enter allows it
const coarse = matchMedia('(pointer: coarse)').matches;      // phones: Enter is a newline, the button sends

let app = null;                                              // the open instance

export function open(current) {
  if (app) { app.setCurrent(current); wm.open({ id: 'dashboard' }); return; }
  app = mount(current);
  wm.open({ id: 'dashboard', title: '糖糖看板', icon: '/asset/icon256.png', content: app.root, width: 900, height: 560,
    onClose: () => { app.destroy(); app = null; } });
}
export function setCurrent(current) { if (app) app.setCurrent(current); }
// open the window on one session (from the daily report)
export function openSession(machine, id) { open(machine); app.select(machine + '|' + id); }

function mount(current) {
  // ---- markup ----
  const list = h('div', { class: 'list' }, h('div', { class: 'empty', text: '还没有会话。' }));
  const hname = h('b', { text: '选择一个会话' }), hmeta = h('span', { class: 'meta' });
  const back = h('button', { class: 'btn back', type: 'button', text: '‹ 返回' });
  const rcmd = h('code', { class: 'rcmd' });
  // 「在电脑上继续」: a terminal on that machine, in the conversation's folder, `claude --resume` -- then it is live
  // here again and can be replied to (shown for a conversation that is over, on a machine that is online)
  const reopen = h('button', { class: 'btn go', type: 'button', text: '在电脑上继续', title: '在那台电脑上打开一个终端窗口（Linux：一个 tmux 会话），进到这个对话原来的文件夹并接着它', hidden: true });
  const copyResumeButton = h('button', { class: 'btn', type: 'button', text: '复制', onclick: copyResume });
  // 「在电脑上继续」用哪个 API：默认跟随这个会话的记录，也可以这次换一个（只影响这一次续聊）
  const resumeApi = h('select', { class: 'field rapi', title: '这次续聊用哪个 API 别名；默认跟随会话记录' });
  const apiWrap = h('span', { class: 'rapi-wrap' }, h('span', { text: 'API：' }), resumeApi);
  const apiCache = new Map();                    // machine -> { default, aliases }
  let apiChoice = { key: '', value: null };
  let reopening = false;
  function ensureApis(machine) {
    if (!machine || apiCache.has(machine)) return;
    apiCache.set(machine, { aliases: [], loading: true });
    fetch('/api/claude-apis?machine=' + encodeURIComponent(machine)).then((r) => r.json()).then((v) => {
      apiCache.set(machine, v && Array.isArray(v.aliases) ? v : { aliases: [] });
      const s = find(sel); if (s && s.machine === machine) renderResumeApi(s);
    }).catch(() => {
      apiCache.set(machine, { aliases: [], ready: false });
      const s = find(sel); if (s && s.machine === machine) renderResumeApi(s);
    });
  }
  // the command shown/copied follows the selector too (follow-record keeps the server's command)
  function commandFor(s, pick) {
    if (!s || !s.resume || /^(codex|opencode):/.test(String(s.id))) return s ? s.resume : '';
    if (pick === '__choose__') return s.resume;
    if (pick === '') return s.resume;
    const cmd = (pick && pick !== '__none__' ? 'claude-' + pick : 'claude') + ' --resume ' + s.id;
    const at = s.resume.lastIndexOf('claude', s.resume.indexOf('--resume'));
    return at >= 0 ? s.resume.slice(0, at) + cmd : cmd;
  }
  function renderResumeApi(s) {
    if (!s) { resumeApi.replaceChildren(); return; }
    if (/^(codex|opencode):/.test(String(s.id))) { resumeApi.replaceChildren(); reopen.disabled = reopening; copyResumeButton.disabled = false; return; }
    const key = s.machine + '|' + s.id;
    const current = apiCache.get(s.machine) || {};
    const list = current.aliases || [];
    const storedAvailable = !s.api || list.some((a) => a && a.id === s.api);
    const opts = [];
    opts.push(h('option', { value: '__choose__', text: current.loading ? '正在读取启动入口…' : '请选择启动入口', disabled: true }));
    if (s.api && storedAvailable) opts.push(h('option', { value: '', text: `跟随记录（claude-${s.api}）` }));
    opts.push(h('option', { value: '__none__', text: '本机设置（不加别名）' }));
    for (const a of list) if (a && /^[A-Za-z0-9._-]{1,40}$/.test(a.id)) opts.push(h('option', { value: a.id, text: 'claude-' + a.id, title: a.label || a.id }));
    const sig = key + '|' + (s.api || '') + '|' + list.map((a) => a.id).join(',') + '|' + storedAvailable + '|' + current.loading;
    if (resumeApi.dataset.sig === sig && opts.some((o) => o.value === resumeApi.value)) return;   // keep an open choice
    resumeApi.dataset.sig = sig;
    resumeApi.replaceChildren(...opts);
    let want = apiChoice.key === key ? apiChoice.value : null;      // only a choice the user actually made
    const fallback = s.api && storedAvailable ? '' : current.ready && !list.length && !s.api ? '__none__' : '__choose__';
    if (want == null) want = fallback;
    if (!opts.some((o) => o.value === want)) want = fallback;
    resumeApi.value = want;
    reopen.disabled = reopening || want === '__choose__';
    copyResumeButton.disabled = want === '__choose__';
  }
  resumeApi.addEventListener('change', () => {
    const s = find(sel); if (!s) return;
    apiChoice = { key: s.machine + '|' + s.id, value: resumeApi.value };
    reopen.disabled = reopening || resumeApi.value === '__choose__';
    copyResumeButton.disabled = resumeApi.value === '__choose__';
    rcmd.textContent = commandFor(s, resumeApi.value);
  });
  reopen.addEventListener('click', async () => {
    const s = find(sel); if (!s) return;
    if (reopening || (!/^(codex|opencode):/.test(String(s.id)) && resumeApi.value === '__choose__')) return;
    reopening = true;
    reopen.disabled = true; showNote('正在那台电脑上打开…', false, 20000);
    const pick = resumeApi.value;
    const r = await net.act({ t: 'resume', machine: s.machine, id: s.id, api: pick === '' ? undefined : pick });
    reopening = false;
    reopen.disabled = resumeApi.value === '__choose__';
    showNote(r.msg || (r.ok ? '已打开' : '没能打开'), !r.ok, r.ok ? 9000 : 6000);
  });
  const resume = h('div', { class: 'resume', hidden: true }, h('span', { text: '继续：' }), rcmd, copyResumeButton, apiWrap, reopen);
  // 对话摘要 (dash-notes.js): the conversation's daily notes, above it while the 摘要 button is on
  const notes = createNotes();
  const agents = createAgents();                    // the session's subagents (dash-agents.js)
  let showNotes = prefs.get('dash.notes', false);
  const notesBtn = h('button', { class: 'btn snbtn', type: 'button', text: '摘要', title: '这个对话每天的摘要（来自工作日报）', hidden: true });
  notesBtn.addEventListener('click', () => { showNotes = !showNotes; prefs.set('dash.notes', showNotes); renderNotes(); });
  const renderNotes = () => { notesBtn.hidden = !sel; notesBtn.classList.toggle('on', showNotes); notes.show(showNotes, sel); };
  const convEl = h('div', { class: 'conv' }, h('div', { class: 'pick', text: '从左边选一个会话查看完整对话。' }));
  const permsEl = h('div', { class: 'perms' });
  const note = h('div', { class: 'note' });
  // 终端画面 (dash-term.js): the terminal's screen as a card -- Claude Code's own menus are only there
  const scrBtn = h('button', { class: 'btn kc', type: 'button', text: '画面', title: '显示 / 收起终端现在的画面（/model、/resume 这类菜单只画在终端里），排成卡片' });
  const term = createTerm({ press: (k) => pressKey(k), read: () => { const s = find(sel); return s ? net.act({ t: 'screen', machine: s.machine, id: s.id, hl: true }) : { ok: false, msg: '先选一个会话' }; },
    onToggle: (on) => scrBtn.classList.toggle('on', on) });
  scrBtn.addEventListener('click', () => term.show(!term.open));
  const keys = h('div', { class: 'keys', hidden: true },
    ...KEYS.map(([k, l]) => h('button', { class: 'btn', type: 'button', dataset: { key: k }, text: l })),
    h('span', { class: 'ksep' }),
    ...COMBOS.map(([k, l, tip]) => h('button', { class: 'btn kc', type: 'button', dataset: { key: k }, text: l, title: tip })),
    h('span', { class: 'ksep' }), scrBtn,
    h('span', { class: 'kh', text: '操作终端里的菜单（如 /model、/resume）；「画面」看终端现在显示什么' }));
  const say = h('textarea', { class: 'say', rows: 1, placeholder: '先选一个会话', disabled: true });
  const sendBtn = h('button', { class: 'btn go', type: 'submit', text: '发送', disabled: true });
  // the key buttons are for touch screens; with a keyboard the keys themselves are enough (⌨ shows the buttons anyway)
  const kbdBtn = h('button', { class: 'btn kbd', type: 'button', text: '⌨', title: '显示 / 隐藏按键（操作终端里的菜单）', hidden: true });
  let showKeys = prefs.get('dash.keys', coarse);
  kbdBtn.addEventListener('click', () => { showKeys = !showKeys; prefs.set('dash.keys', showKeys); renderControls(); });
  // the session's permission mode; a click cycles it like Shift+Tab in the terminal
  const modeBtn = h('button', { class: 'btn mode', type: 'button', hidden: true, text: '模式？' });
  // "/" in the reply box: suggestions of the session's machine's commands (dash-slash.js)
  const slash = createSlash({ say, machine: () => (sel ? sel.split('|')[0] : null), provider: () => (sel ? provOf(sel.split('|')[1]) : 'claude'), onFill: () => say.dispatchEvent(new Event('input')) });
  const compose = h('form', { class: 'compose', autocomplete: 'off' }, kbdBtn, modeBtn, say, sendBtn, slash.el);
  // /btw answers pop up over the conversation (dash-btw.js); a click on one in the conversation opens it again
  // (转成后台任务 there: "f" in the terminal's /btw overlay, which the pet presses only while it is open)
  const btw = createBtw({ md: (t) => md(t), fork: async () => {
    const s = find(sel); if (!s) return;
    const r = await net.act({ t: 'key', machine: s.machine, id: s.id, key: 'btwfork' });
    showNote(r.msg || (r.ok ? '已转成后台任务' : '没转成'), !r.ok);
  } });
  const btwText = new WeakMap();                     // answer element -> { text, t }
  convEl.addEventListener('click', (e) => { if (e.target.closest('a.fp')) return; const b = e.target.closest('.m.btw'); const a = b && btwText.get(b); if (a) btw.show(b.dataset.q || '', a.text, a.t); });
  const right = h('div', { class: 'right' }, h('div', { class: 'head' }, h('span', { style: 'min-width:0;display:flex;align-items:center' }, back, hname), h('span', { class: 'hr' }, hmeta, notesBtn)),
    resume, agents.el, notes.el, convEl, btw.el, permsEl, note, term.el, keys, compose);
  const side = h('div', { class: 'side' }, list);              // (the list's 活动 / 全部 and search bar go on top)
  const root = h('div', { class: 'dash' }, side, right);
  // file paths in what was said (dash-paths.js): a click opens the file on that session's computer; the menu also
  // shows it in its folder, or copies the path
  const pathCtx = (folder) => {
    const s = find(sel); if (!s) return null;
    const m = net.state.sessions.find((x) => x.machine === s.machine);
    return { machine: s.machine, session: s.id, cwd: s.cwd || '', files: !!(m && m.files), note: (msg, bad) => showNote(msg, bad), folder };
  };
  right.addEventListener('click', (e) => {
    const a = e.target.closest('a.fp'); if (!a) return;
    e.preventDefault();
    const c = pathCtx(false); if (c) follow(a, c);
  });
  ctxmenu.attach(right, (e) => {
    const a = e.target.closest && e.target.closest('a.fp'); if (!a) return null;
    return [{ label: '打开', onClick: () => { const c = pathCtx(false); if (c) follow(a, c); } },
      { label: '在文件夹中显示', onClick: () => { const c = pathCtx(true); if (c) follow(a, c); } },
      '-',
      { label: '复制路径', onClick: () => navigator.clipboard.writeText(a.dataset.p).then(() => showNote('已复制'), () => showNote('复制失败', true)) }];
  });

  let sel = null;                                   // "machine|id"
  const permCards = new Map();
  let sending = false, noteTimer = null;

  // what was typed but not sent stays with its conversation (kept in this browser: a reload keeps it too)
  const drafts = new Map(Object.entries(prefs.get('dash.drafts', {})));
  let draftT = null;
  function keepDraft() {
    if (!sel) return;
    drafts.delete(sel);                             // (re-inserted last: the newest 30 are kept)
    if (say.value.trim()) drafts.set(sel, say.value);
    clearTimeout(draftT);
    draftT = setTimeout(() => prefs.set('dash.drafts', Object.fromEntries([...drafts].slice(-30))), 400);
  }
  // conversations looked at lately: shown at once when you come back, then replaced by what the server sends
  const CONV_CACHE = 12;
  const convCache = new Map();                      // "machine|id" -> msgs, oldest first

  const allSessions = () => net.state.sessions.flatMap((m) => m.sessions.map((s) => ({ ...s, machine: m.machine, online: m.online })));
  const find = (key) => { if (!key) return null; const [machine, id] = key.split('|'); return allSessions().find((x) => x.machine === machine && x.id === id) || null; };
  // ---- list (js/apps/dash-list.js: groups, pinned / starred / hidden, right-click menus) ----
  const sessionList = createList({ el: list, current, selected: () => sel, onSelect: select, onNote: (m, bad) => showNote(m, bad) });
  side.prepend(sessionList.tool);
  const renderList = () => sessionList.render();
  // a phone's back gesture (js/backnav.js): a conversation open in the narrow layout is one level; back shows the list
  const navLevel = () => backnav.level('dash', root.isConnected && root.classList.contains('narrow') && root.classList.contains('viewing') ? 1 : 0);
  backnav.step(() => {
    if (!root.isConnected || !root.offsetParent || !root.classList.contains('narrow') || !root.classList.contains('viewing')) return false;
    root.classList.remove('viewing'); navLevel(); return true;
  }, 10);
  back.addEventListener('click', () => { root.classList.remove('viewing'); navLevel(); });

  function select(key) {
    if (key !== sel) keepDraft();                   // the one we leave keeps its unsent text
    slash.close();
    sel = key;
    renderList();
    root.classList.add('viewing'); navLevel();
    const s = find(key), [machine, id] = key.split('|');
    const cached = convCache.get(key);
    if (cached) renderConv(cached); else convEl.replaceChildren(h('div', { class: 'pick', text: '加载对话…' }));
    permsEl.replaceChildren(); permCards.clear(); showNote('');
    header(s);
    renderNotes();
    say.value = drafts.get(key) || '';
    renderControls();
    fitSay();
    net.send({ t: 'watch', machine, id });
  }
  function header(s) {
    const [machine] = (sel || '|').split('|');
    hname.textContent = s ? s.label : '选择一个会话';
    if (s) {
      const p = provOf(s.id), ai = p === 'opencode' ? aiMark(s) : null;
      const mark = p === 'opencode'
        ? h('span', { class: 'provs', title: 'OpenCode' + (ai ? ' · ' + ai.name : '') },
          h('span', { class: 'prov opn' }), ai ? h('span', { class: 'prov ai ai-' + ai.slug, title: ai.name }) : null)
        : h('span', { class: 'prov ' + (p === 'codex' ? 'cdx' : 'cla'), title: p === 'codex' ? 'Codex 的会话' : 'Claude Code 的会话' });
      hname.prepend(mark);
    }
    hmeta.textContent = s ? `${machine}${s.project ? ' · ' + s.project : ''}${s.online ? '' : ' · 离线'}` : '';
    // context left (from the last reply's token count); warned about when it runs low
    const left = s ? ctxLeft(s) : null;
    if (left != null) {
      hmeta.append(' · ', h('span', { class: 'cx' + (left <= 10 ? ' bad' : left <= CTX_LOW ? ' low' : ''), text: `上下文剩 ${left}%`,
        title: `已用约 ${Math.round(s.ctx.used / 1000)}k / ${Math.round(s.ctx.win / 1000)}k tokens（${provOf(s.id) === 'codex' ? 'Codex' : '到自动压缩前'}）` }));
    }
    resume.hidden = !(s && s.resume);
    reopen.hidden = !(s && s.online && s.via !== 'terminal');
    apiWrap.hidden = !(s && s.resume && provOf(s.id) === 'claude');
    if (s) { ensureApis(s.machine); renderResumeApi(s); } else resumeApi.replaceChildren();
    if (s && s.resume) { const cmd = commandFor(s, resumeApi.value); if (rcmd.textContent !== cmd) rcmd.textContent = cmd; }
    agents.render(s);
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
  let termOk = false;                              // the session runs in a terminal we can type / press keys into
  function renderControls() {
    const s = find(sel);
    const via = s ? (s.online ? s.via || 'off' : 'off') : null;
    say.disabled = !s || sending || !['terminal', 'resume'].includes(via);
    say.placeholder = !s ? '先选一个会话' : s.state === 'history' ? '历史会话：用上面的命令继续' : s.online ? PLACEHOLDER[provOf(s.id) === 'opencode' && via !== 'off' ? 'opencode' : via] || PLACEHOLDER.off : '机器离线';
    const asking = !!(s && s.online && (s.perms || []).length);
    if (asking) { say.disabled = true; say.placeholder = '先处理确认卡片'; }
    // a card open: the (disabled) reply box folds to one line so the card has the room; afterwards it grows back
    if (root.classList.contains('asking') !== asking) { root.classList.toggle('asking', asking); if (!asking) fitSay(); }
    sendBtn.disabled = say.disabled || !say.value.trim();
    termOk = !!(s && s.online && via === 'terminal' && provOf(s.id) !== 'opencode');
    keys.hidden = !(termOk && showKeys);
    for (const b of keys.querySelectorAll('button[data-key]')) if (COMBOS.some(([k]) => k === b.dataset.key)) b.hidden = provOf(s && s.id) !== 'claude';
    term.target(termOk ? sel : null);
    kbdBtn.hidden = !termOk;
    renderMode(s);
    renderPerms(s);
  }

  // ---- permission mode ----
  // What the transcript last recorded (s.mode, updated with every message); right after a Shift+Tab from here, the
  // mode the terminal switched to -- until the next record replaces it.
  const pressed = new Map();                        // "machine|id" -> { mode, base: s.mode when it was pressed }
  function renderMode(s) {
    const p = pressed.get(sel);
    if (p && s && s.mode !== p.base) pressed.delete(sel);
    const m = pressed.has(sel) ? p.mode : s && s.mode;
    const oc = !!(s && provOf(s.id) === 'opencode');
    modeBtn.hidden = oc || !(s && (m || termOk));
    modeBtn.disabled = oc || !termOk || sending;
    modeBtn.textContent = m ? MODE[m] || m : '模式？';
    modeBtn.dataset.mode = m || '';
    modeBtn.title = (m ? `权限模式：${MODE[m] || m}（发消息时记录）` : '权限模式：发一条消息后才知道') + (termOk ? '；点击或 Shift+Tab 轮转' : '');
    if (s && s.id.startsWith('codex:')) modeBtn.title = '点击打开 Codex 的 /permissions 权限菜单；Shift+Tab 切换计划模式';
  }
  modeBtn.addEventListener('click', async () => {
    const s = find(sel);
    if (!s || !s.id.startsWith('codex:')) return pressKey('btab', modeBtn);
    const at = sel;
    const r = await net.act({ t: 'send', machine: s.machine, id: s.id, text: '/permissions' });
    if (!r.ok) return showNote(r.msg || '打开权限菜单失败', true);
    if (sel === at) { term.show(true); term.load(900); }
  });
  const fitSay = () => { say.style.height = 'auto'; say.style.height = Math.min(140, say.scrollHeight + 2) + 'px'; };
  say.addEventListener('input', () => { fitSay(); sendBtn.disabled = say.disabled || !say.value.trim(); keepDraft(); });
  say.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    // an empty box: the key goes to the terminal (Shift+Enter stays a newline)
    if (termOk && !say.value && keyOf(e) && !(e.key === 'Enter' && e.shiftKey) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault(); pressKey(keyOf(e)); return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !coarse) { e.preventDefault(); compose.requestSubmit(); }
  });
  async function pressKey(key, b) {
    const s = find(sel); if (!s) return false;
    const at = sel;
    if (b) b.disabled = true;
    // (终端画面 open: the screen after the key comes back with the answer)
    const r = await net.act({ t: 'key', machine: s.machine, id: s.id, key, screen: term.open || undefined, hl: term.open || undefined });
    if (b) b.disabled = false;
    if (!r.ok) { showNote(r.msg || '按键失败', true); return false; }
    if (typeof r.screen === 'string' && at === sel && term.open) term.set(r.screen);
    if (key === 'btab' && r.mode) {
      pressed.set(at, { mode: r.mode, base: s.mode });
      if (at === sel) { renderMode(find(sel)); showNote('权限模式：' + (MODE[r.mode] || r.mode)); }
    }
    return true;
  }
  compose.addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = find(sel), text = say.value, key = sel;
    if (!s || say.disabled || !text.trim()) return;
    sending = true; renderControls(); showNote('发送中…', false, 30000);
    const r = await net.act({ t: 'send', machine: s.machine, id: s.id, text });
    sending = false;
    if (r.ok) {
      // sent: out of the box and out of that conversation's draft (also when you switched away meanwhile)
      if (sel === key && say.value === text) { say.value = ''; fitSay(); keepDraft(); }
      else if (drafts.get(key) === text) { drafts.delete(key); prefs.set('dash.drafts', Object.fromEntries(drafts)); }
      showNote(r.msg || '已发送');
      // a command that opens a menu in the terminal (/model, /resume...): the screen is shown so it can be answered
      if (opensMenu(text) && sel === key && termOk) { if (!showKeys) { showKeys = true; renderControls(); } if (term.open) term.load(900); else { term.show(true); term.load(900); } }
    } else showNote(r.msg || '发送失败', true);
    renderControls();
  });
  keys.addEventListener('click', (e) => { const b = e.target.closest('button[data-key]'); if (b) pressKey(b.dataset.key, b); });

  // ---- permission cards (stable across updates) ----
  function renderPerms(s) {
    const perms = s && s.online ? s.perms || [] : [];
    const ids = new Set(perms.map((p) => p.id));
    for (const [id, el] of permCards) if (!ids.has(id)) { el.remove(); permCards.delete(id); }
    for (const p of perms) {
      if (permCards.has(p.id)) continue;
      // Claude's own questions (dash-ask.js): answered here, not allowed
      const qs = p.ask ? questionsOf(p) : null;
      if (qs) { const card = askCard(p, qs); card.dataset.shown = Date.now(); permCards.set(p.id, card); permsEl.append(card); continue; }
      let i = {}; try { i = JSON.parse(p.input); } catch {}
      const choices = [['allow', '允许', 'btn go'], ['deny', '拒绝', 'btn no']];
      if (p.always) choices.splice(1, 0, ['always', '总是允许', 'btn']);   // Claude Code's "Yes, and don't ask again for ..."
      if (p.provider === 'codex') choices.push(['defer', '在 Codex 中处理', 'btn']);
      // the buttons right under the title: still in view when the card area is squeezed (it scrolls from the top)
      const card = h('div', { class: 'perm', dataset: { id: p.id } },
        h('div', { class: 'pt', text: `需要你确认 · ${p.tool}${p.subagent ? ' · ' + p.subagent : ''}` }),
        h('div', { class: 'pa' }, ...choices.map(([c, l, cls]) => h('button', { class: cls, type: 'button', dataset: { choice: c }, text: l })),
          h('span', { class: 'ps', text: '回车 = 允许 · 也可在那台机器上回答' })),
        // what 总是允许 adds, and where (this session / the project's settings)
        p.always ? h('div', { class: 'pal', text: '总是允许 = 允许，并且以后不再问：' + p.always }) : null,
        h('pre', { text: [p.cwd && `工作目录：${p.cwd}`, p.provider === 'opencode' && i.message && `说明：${i.message}`,
          p.provider === 'opencode' && Array.isArray(i.resources) && i.resources.length && `对象：${i.resources.join(' · ')}`,
          i.description, i.command && `${p.tool === 'apply_patch' ? '修改补丁' : '命令'}：${i.command}`,
          (i.file_path || i.notebook_path) && `文件：${i.file_path || i.notebook_path}`, p.input].filter(Boolean).join('\n') }));
      card.dataset.shown = Date.now();
      permCards.set(p.id, card); permsEl.append(card);
    }
  }
  permsEl.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled || !b.dataset.choice) return;   // (not a question's option)
    const card = b.closest('.perm'), s = find(sel); if (!s) return;
    const answers = b.dataset.choice === 'answer' ? card.answers() : undefined;
    if (b.dataset.choice === 'answer' && !answers) return;
    const was = [...card.querySelectorAll('button, input')].filter((x) => !x.disabled);
    for (const x of was) x.disabled = true;
    const st = $('.ps', card); st.textContent = '提交中…';
    const r = await net.act({ t: 'decide', machine: s.machine, id: s.id, perm: card.dataset.id, choice: b.dataset.choice, answers });
    st.textContent = r.ok ? '已提交' : (r.msg || '提交失败');
    if (!r.ok) for (const x of was) x.disabled = false;
  });
  // Enter allows the oldest open card -- when this window is the active one and no other control has the focus
  // (the reply box is disabled while a card is open, so the key arrives at the page). Not a held-down Enter, and not
  // a card that only just appeared (an Enter meant for something else).
  function onEnter(e) {
    if (e.key !== 'Enter' || e.repeat || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    const win = root.closest('.win');
    if (!win || win.classList.contains('inactive') || win.classList.contains('minimized')) return;
    const t = document.activeElement;
    if (t && t !== document.body && (!root.contains(t) || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
    const card = [...permsEl.querySelectorAll('.perm')].find((c) => c.querySelector('button[data-choice="allow"]:not(:disabled)'));
    if (!card || Date.now() - card.dataset.shown < ENTER_GRACE) return;
    e.preventDefault();
    card.querySelector('button[data-choice="allow"]').click();
  }
  // 终端画面 open: the keyboard works its menu without a box having to be clicked first (dash-term.js key). A card
  // waiting for 允许 keeps Enter (above).
  function onTermKey(e) {
    if (e.defaultPrevented || !term.open || !termOk) return;
    const win = root.closest('.win');
    if (!win || win.classList.contains('inactive') || win.classList.contains('minimized')) return;
    const t = document.activeElement;
    if (t && t !== document.body && (!root.contains(t) || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (t && t.tagName === 'BUTTON' && !term.el.contains(t)) return;               // (a button of the dashboard's own: its key)
    if (term.key(e)) e.preventDefault();
  }
  document.addEventListener('keydown', onEnter);
  document.addEventListener('keydown', onTermKey);

  // ---- conversation ----
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
    if (m.t) d.dataset.t = m.t;                     // (a path in it is looked for from where the session was then)
    const tm = `<span class="tm">${m.t ? hhmm(m.t) : ''}</span>`;
    if (m.role === 'assistant') d.innerHTML = md(m.text || '');
    else if (m.role === 'btw') { d.innerHTML = '<div class="btwh">顺带一问的回答 · 点开单独看</div>' + md(m.text || ''); d.title = '点开单独看'; }
    else if (m.role === 'tool') d.innerHTML = `<b>⚙</b> ${(m.items || []).slice(-5).map(esc).join(' · ')}${tm}`;
    else if (m.role === 'user') { d.textContent = m.text || ''; d.insertAdjacentHTML('beforeend', tm); }
    else if (m.role === 'cmd') cmdEl(d, m);
    else d.textContent = m.text || '';
    return d;
  }
  // what a slash command printed in the terminal (/context, /model ...): as it was laid out there; a long one folded
  // (the ones you unfolded stay so while the conversation is redrawn)
  const CMD_FOLD = 12, cmdOpen = new Set();
  function cmdEl(d, m) {
    const text = m.text || '', lines = text.split('\n'), key = m.t + ':' + text.length;
    const long = lines.length > CMD_FOLD + 2;
    const pre = h('pre', { text: long && !cmdOpen.has(key) ? lines.slice(0, CMD_FOLD).join('\n') : text });
    d.append(h('div', { class: 'ch', text: '命令输出' + (m.t ? ' · ' + hhmm(m.t) : '') }), pre);
    if (!long) return;
    const b = h('button', { class: 'cmore', type: 'button', text: cmdOpen.has(key) ? '收起' : `展开全部（共 ${lines.length} 行）` });
    b.addEventListener('click', () => {
      const open = !cmdOpen.has(key);
      if (open) cmdOpen.add(key); else cmdOpen.delete(key);
      pre.textContent = open ? text : lines.slice(0, CMD_FOLD).join('\n');
      b.textContent = open ? '收起' : `展开全部（共 ${lines.length} 行）`;
    });
    d.append(b);
  }
  function renderConv(msgs) {
    const atBottom = convEl.scrollHeight - convEl.scrollTop - convEl.clientHeight < 60;
    if (!msgs.length) { convEl.replaceChildren(h('div', { class: 'pick', text: '这个会话还没有内容。' })); return; }
    convEl.replaceChildren(...msgs.map(msgEl));
    // a /btw answer remembers its question (shown with it when clicked)
    let q = '';
    msgs.forEach((m, i) => { if (m.role === 'user' && /^\/btw(\s|$)/.test(m.text || '')) q = m.text; if (m.role === 'btw') { convEl.children[i].dataset.q = q; btwText.set(convEl.children[i], { text: m.text, t: m.t }); } });
    if (atBottom || convEl.dataset.for !== sel) convEl.scrollTop = convEl.scrollHeight;
    convEl.dataset.for = sel;
  }

  // ---- wiring ----
  const offs = [
    net.on('sessions', () => { renderList(); if (sel) header(find(sel)); renderControls(); }),
    net.on('conv', (d) => {
      const key = d.machine + '|' + d.id;
      convCache.delete(key); convCache.set(key, d.msgs || []);
      if (convCache.size > CONV_CACHE) convCache.delete(convCache.keys().next().value);
      // (a /btw answer popping up takes room under the conversation: keep its end in view)
      if (sel === key) { renderConv(d.msgs || []); if (btw.update(key, d.msgs || [])) convEl.scrollTop = convEl.scrollHeight; }
    }),
    net.on('open', () => { if (sel) { const [machine, id] = sel.split('|'); net.send({ t: 'watch', machine, id }); } }),
  ];
  const tickT = setInterval(renderList, 15000);               // "N分前" labels
  const ro = new ResizeObserver(() => { root.classList.toggle('narrow', root.clientWidth < 620); navLevel(); });
  ro.observe(root);
  renderList();

  return {
    root,
    setCurrent(c) { sessionList.setCurrent(c); },
    select,
    destroy() { sessionList.destroy(); for (const off of offs) off(); clearInterval(tickT); document.removeEventListener('keydown', onEnter); document.removeEventListener('keydown', onTermKey); ro.disconnect(); net.send({ t: 'unwatch' }); backnav.level('dash', 0); },
  };
}
