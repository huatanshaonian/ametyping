// Claude panel under Ame. Left: session cards (name, latest line, state, red dot when there is
// something new you have not looked at). Right: the selected session's log, newest line typed out.
'use strict';
const $ = (id) => document.getElementById(id);
const list = $('list'), log = $('log'), se = $('se');
se.volume = 0.45;
let data = [], selected = null, pinned = false, typeTimer = null, lastTypedKey = '', collapsed = false, sentUnread = -1;
const seen = {};                       // session id -> last activity time the user has looked at

const WORKING = new Set(['message', 'thinking', 'reading', 'error']);
const stateName = (st) => (WORKING.has(st) ? ['working', '进行中'] : st === 'waiting' ? ['waiting', '等你确认']
  : st === 'done' ? ['done', '完成'] : st === 'paused' ? ['idle', '已中断'] : st === 'ended' ? ['idle', '已关闭'] : ['idle', '空闲']);
const ago = (t0) => { const s = Math.round((Date.now() - t0) / 1000); return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分`; };
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const lastText = (s) => { for (let i = s.lines.length - 1; i >= 0; i--) if (!s.lines[i].sep) return s.lines[i].text; return '…'; };

// unread = new activity you have not looked at; while collapsed nothing is being looked at, so the selected one counts too
const isUnread = (s) => (seen[s.id] || 0) < s.last && (collapsed || s.id !== selected);

function header() {
  const running = data.filter((s) => WORKING.has(s.state)).length, waiting = data.filter((s) => s.state === 'waiting').length;
  $('who').textContent = `Claude / Codex ─ ${data.length} 个会话`;
  $('meta').textContent = [running && `${running} 个在跑`, waiting && `${waiting} 个等你`].filter(Boolean).join(' · ') || '都停下了';
  const nUnread = data.filter(isUnread).length;
  $('ub').classList.toggle('on', nUnread > 0); $('ubn').textContent = nUnread;
  if (nUnread !== sentUnread) { sentUnread = nUnread; window.bubble.unread(nUnread); }   // P-chan's badge (main forwards it to Ame)
  const s = data.find((x) => x.id === selected);
  if (s) {
    $('hname').textContent = s.project && s.project !== s.label ? `${s.label}  ─ ${s.project}` : s.label;
    $('hmeta').textContent = `${stateName(s.state)[1]}${s.steps ? ` · 第${s.steps}步` : ''} · ${ago(s.t0)}`;
  }
}

// cards are kept and updated in place (rebuilding them on every event swallowed clicks mid-press)
const cards = new Map();                 // session id -> element
function renderList() {
  const ids = new Set(data.map((s) => s.id));
  for (const [id, el] of cards) if (!ids.has(id)) { el.remove(); cards.delete(id); }
  data.forEach((s, i) => {
    let c = cards.get(s.id);
    if (!c) {
      c = document.createElement('div');
      c.innerHTML = '<div class="dot"></div><div class="nm"></div><div class="sm"></div><div class="st"></div>';
      c.dataset.id = s.id;
      cards.set(s.id, c);
    }
    if (list.children[i] !== c) list.insertBefore(c, list.children[i] || null);
    const [cls, name] = stateName(s.state);
    c.className = 'card' + (s.id === selected ? ' sel' : '') + (isUnread(s) ? ' unread' : '');
    c.querySelector('.nm').textContent = s.label;
    c.querySelector('.sm').textContent = lastText(s);
    const st = c.querySelector('.st'); st.className = 'st ' + cls;
    st.textContent = `${s.provider === 'codex' ? 'Codex' : 'Claude'} · ${name}`;
  });
}
// select on press (not click): nothing can swap the element between press and release
// The panel never takes focus (so typing elsewhere is not interrupted); such windows get no mouse-move
// messages, so e.target can be the element under the PREVIOUS cursor position. Hit-test the real point.
list.addEventListener('pointerdown', (e) => {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const c = hit && hit.closest('.card');
  if (!c) return;
  const s = data.find((x) => x.id === c.dataset.id);
  if (!s) return;
  selected = s.id; pinned = true; seen[s.id] = s.last; lastTypedKey = '';
  renderAll(false);
  if (chatOn) { selectChat(); composeState(); }
});

function renderLog(typeNewest) {
  clearInterval(typeTimer);
  const s = data.find((x) => x.id === selected);
  log.innerHTML = '';
  if (!s) return;
  const lines = s.lines.slice(-40);
  let lastEl = null, lastLine = null;
  lines.forEach((l, i) => {
    if (l.sep) { const d = document.createElement('div'); d.className = 'sep'; log.appendChild(d); return; }
    const d = document.createElement('div');
    const kind = ['done', 'waiting', 'error', 'message'].includes(l.type) ? ' ' + l.type : '';
    d.className = 'ln' + (i === lines.length - 1 ? ' last' : '') + kind;
    const tm = document.createElement('span'); tm.className = 'tm'; tm.textContent = hhmm(l.t);
    const tx = document.createElement('span'); tx.textContent = l.text;
    d.append(tm, tx); log.appendChild(d);
    lastEl = tx; lastLine = l;
  });
  const caret = document.createElement('span'); caret.className = 'caret';
  const key = selected + '|' + (lastLine ? lastLine.t + lastLine.text : '');
  if (lastEl && typeNewest && key !== lastTypedKey) {
    lastTypedKey = key;
    const text = lastLine.text; let n = 0;
    lastEl.textContent = ''; lastEl.appendChild(caret);
    typeTimer = setInterval(() => {
      n++; lastEl.textContent = text.slice(0, n); lastEl.appendChild(caret);
      if (n >= text.length) clearInterval(typeTimer);
      log.scrollTop = log.scrollHeight;
    }, 35);
  } else if (lastEl) lastEl.appendChild(caret);
  log.scrollTop = log.scrollHeight;
}

function renderAll(typeNewest) { renderList(); if (!chatOn) renderLog(typeNewest); renderPermissions(); header(); }

// Keep permission cards stable while progress and terminal updates arrive.
const permissionCards = new Map();
function renderPermissions() {
  const s = data.find((x) => x.id === selected);
  const requests = s && s.permissions || [];
  // still asking but the card is gone (its hook gave up after an hour): say where to answer instead of showing nothing
  const lastLine = s && [...s.lines].reverse().find((l) => !l.sep);
  const stale = !!s && s.state === 'waiting' && !requests.length && !!lastLine && /确认/.test(lastLine.text);
  let hint = $('permission-hint');
  if (stale && !hint) {
    hint = document.createElement('div'); hint.id = 'permission-hint'; hint.className = 'permission';
    hint.textContent = '这个确认已超时，卡片已撤下：请到终端里回答';
    $('permissions').prepend(hint);
  } else if (!stale && hint) hint.remove();
  const ids = new Set(requests.map((p) => p.id));
  for (const [id, el] of permissionCards) if (!ids.has(id)) { el.remove(); permissionCards.delete(id); }
  for (const p of requests) {
    if (permissionCards.has(p.id)) continue;
    const card = document.createElement('div'); card.className = 'permission'; card.dataset.id = p.id;
    const title = document.createElement('div'); title.className = 'permission-title';
    title.textContent = `需要你确认 · ${p.tool}${p.subagent ? ` · ${p.subagent}` : ''}`;
    const details = document.createElement('pre');
    const i = p.input || {};
    // Show complete parameters (including edits), never interpret tool input as HTML.
    details.textContent = [p.cwd && `工作目录：${p.cwd}`, i.description,
      i.command && `${p.tool === 'apply_patch' ? '修改补丁' : '命令'}：${i.command}`, (i.file_path || i.notebook_path) && `文件：${i.file_path || i.notebook_path}`,
      JSON.stringify(i, null, 2)].filter(Boolean).join('\n');
    const actions = document.createElement('div'); actions.className = 'permission-actions';
    const choices = [['allow', '允许'], ['deny', '拒绝']];
    if (p.provider === 'codex') choices.push(['defer', '在 Codex 中处理']);
    for (const [choice, label] of choices) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.choice = choice; b.textContent = label;
      actions.appendChild(b);
    }
    const status = document.createElement('span'); status.className = 'permission-status';
    status.textContent = p.provider === 'codex' ? '超时后交回 Codex' : '也可在终端回答';
    actions.appendChild(status); card.append(title, details, actions);
    permissionCards.set(p.id, card); $('permissions').appendChild(card);
  }
}
async function decidePermission(button) {
  if (button.disabled) return;
  const card = button.closest('.permission');
  for (const b of card.querySelectorAll('button')) b.disabled = true;
  const status = card.querySelector('.permission-status'); status.textContent = '提交中…';
  try {
    const r = await window.bubble.decidePermission(card.dataset.id, button.dataset.choice);
    status.textContent = r.ok ? '已提交' : '请求已结束';
  } catch {
    status.textContent = '提交失败，请重试或在终端回答';
    for (const b of card.querySelectorAll('button')) b.disabled = false;
  }
}
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const button = hit && hit.closest('.permission button');
  if (button) { e.preventDefault(); decidePermission(button); }
});
// Keyboard activation remains available without submitting twice after a pointer press.
$('permissions').addEventListener('click', (e) => {
  if (e.detail === 0 && e.target.matches('button')) decidePermission(e.target);
});

window.bubble.onState(({ sessions, changedId, mode, sound = true }) => {
  const prev = data.find((s) => s.id === changedId);
  const prevSel = data.find((s) => s.id === selected);
  const prevSelState = prevSel && prevSel.state;
  data = sessions;
  setMode(mode);
  if (!data.find((s) => s.id === selected)) { selected = null; pinned = false; }
  // stay on the current session while it is still working (others just get a red dot);
  // move on when it has finished (unless you picked it yourself); a session that needs you always takes over
  const changed = data.find((s) => s.id === changedId);
  const cur = data.find((s) => s.id === selected);
  if (changed && (!cur || changed.state === 'waiting' || (!pinned && !WORKING.has(cur.state) && cur.state !== 'waiting'))) selected = changedId;
  if (!selected && data.length) selected = data[0].id;
  const sel = data.find((s) => s.id === selected);
  if (sel && !collapsed) seen[sel.id] = sel.last;
  renderAll(changedId === selected);
  if (changed && (!prev || prev.state !== changed.state) && ['message', 'done', 'waiting'].includes(changed.state)) {
    if (sound) { try { se.currentTime = 0; se.play(); } catch {} }   // tray: 提示音
  }
  if (chatOn) { selectChat(); composeState(); }
});
window.bubble.onHide(() => {});
// the main process owns the collapsed flag (window height, settings); this just mirrors it
window.bubble.onCollapsed((v) => {
  collapsed = !!v;
  document.body.classList.toggle('collapsed', collapsed);
  $('fold').textContent = collapsed ? '□' : '−'; $('fold').title = collapsed ? '展开' : '折叠';
  const sel = data.find((x) => x.id === selected);
  if (!collapsed && sel) seen[sel.id] = sel.last;      // expanding = looking at the selected session
  renderAll(false);
});
let lastTitleDown = { t: 0, x: 0, y: 0 };
document.addEventListener('pointerdown', (e) => {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (hit && hit.id === 'close') window.bubble.close();
  else if (hit && hit.id === 'fold') window.bubble.collapse(!collapsed);
});
const grip = $('grip');
document.addEventListener('pointerdown', (e) => {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (hit === grip) { grip.setPointerCapture(e.pointerId); window.bubble.gesture('resize-start'); }
  else if (hit && hit.closest && hit.closest('#title') && hit.id !== 'close' && hit.id !== 'fold') {
    // double-click on the title bar folds / unfolds (checked by hand: the panel gets no reliable dblclick events)
    const d = lastTitleDown, now = Date.now();
    if (now - d.t < 450 && Math.abs(e.clientX - d.x) < 6 && Math.abs(e.clientY - d.y) < 6) {
      lastTitleDown = { t: 0, x: 0, y: 0 }; window.bubble.collapse(!collapsed);
    } else {
      lastTitleDown = { t: now, x: e.clientX, y: e.clientY };
      window.bubble.gesture('drag-start');   // drag by the title bar
    }
  }
});
const endResize = () => { window.bubble.gesture('resize-end'); window.bubble.gesture('drag-end'); };
document.addEventListener('pointerup', endResize);
grip.addEventListener('lostpointercapture', endResize);
setInterval(header, 5000);


// ---------- chat mode (常驻对话): the whole conversation from the transcript + a reply box ----------
const chatEl = $('chat'), input = $('input'), note = $('note');
let chatOn = false, chatFor = null, noteTimer = null;

function setMode(mode) {
  const on = mode === 'chat';
  if (on === chatOn) return;
  chatOn = on;
  document.body.classList.toggle('chat', on);
  if (!on) chatFor = null;
}
function selectChat() {
  if (selected === chatFor) return;
  chatFor = selected; chatEl.innerHTML = ''; chatEl.dataset.loaded = '';
  window.bubble.select(selected);
}
function showNote(msg, ms = 5000) {
  clearTimeout(noteTimer);
  note.textContent = msg; note.classList.toggle('show', !!msg);
  if (msg) noteTimer = setTimeout(() => note.classList.remove('show'), ms);
}
const PLACEHOLDER = {
  codex: '请在 Codex 中继续对话；这里查看进度和处理权限',
  terminal: '回复（Enter 发送，Shift+Enter 换行）',
  resume: '会话已关闭：发送会在后台用 claude -p --resume 续上',
  busy: '后台续聊进行中…',
  none: '这个会话不在终端里（IDE / 桌面 App），只能看不能回',
  unknown: '等它下一次有动静，就知道它在哪个终端了',
};
function composeState() {
  const s = data.find((x) => x.id === selected);
  const via = s ? s.via : 'unknown';
  input.disabled = !s || via === 'codex' || via === 'none' || via === 'busy' || via === 'unknown';
  input.placeholder = s ? PLACEHOLDER[via] : '还没有会话';
}

// --- tiny markdown: code fences, inline code, bold, headings; everything else is escaped text ---
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function inline(s) {
  return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
}
function md(text) {
  const out = [];
  String(text).split(/```[^\n]*\n?/).forEach((part, i) => {
    if (i % 2) out.push(`<pre>${esc(part.replace(/\n$/, ''))}</pre>`);
    else for (const para of part.split(/\n{2,}/)) if (para.trim()) out.push(`<p>${inline(para.trim())}</p>`);
  });
  return out.join('');
}
function msgEl(m) {
  const d = document.createElement('div');
  d.className = 'm ' + m.role;
  const tm = `<span class="tm">${hhmm(m.t)}</span>`;
  if (m.role === 'assistant') d.innerHTML = md(m.text);
  else if (m.role === 'tool') {
    const shown = m.items.slice(-4).map(esc).join(' · ');
    d.innerHTML = `<b>⚙</b> ${m.items.length > 4 ? `…等 ${m.items.length} 步 · ` : ''}${shown}${tm}`;
  } else if (m.role === 'user') { d.textContent = m.text; d.insertAdjacentHTML('beforeend', tm); }
  else d.textContent = m.text;
  return d;
}
window.bubble.onChat(({ id, msgs }) => {
  if (id !== selected) return;
  const atBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;
  chatEl.innerHTML = '';
  if (!msgs.length) chatEl.innerHTML = '<div class="m sys">（这个会话还没有内容）</div>';
  for (const m of msgs) chatEl.appendChild(msgEl(m));
  if (atBottom || !chatEl.dataset.loaded) chatEl.scrollTop = chatEl.scrollHeight;
  chatEl.dataset.loaded = '1';
});

async function send() {
  const text = input.value;
  if (!text.trim() || input.disabled || !selected) return;
  showNote('发送中…', 20000);
  const r = await window.bubble.send(selected, text);
  if (r.ok) { input.value = ''; showNote(r.msg || '', 6000); if (!r.msg) showNote(''); }
  else showNote(r.msg || '没发出去', 8000);                        // text stays in the box
}
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
// the send button reacts on press, hit-tested at the real point (see the note on the card list above)
document.addEventListener('pointerdown', (e) => {
  if (!chatOn) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (hit && hit.id === 'sendb') { e.preventDefault(); send(); }
});
