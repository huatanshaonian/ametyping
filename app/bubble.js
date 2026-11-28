// Claude panel under Ame. Left: session cards (name, latest line, state, red dot when there is
// something new you have not looked at). Right: the selected session's log, newest line typed out.
'use strict';
const $ = (id) => document.getElementById(id);
const list = $('list'), log = $('log'), se = $('se'), seTada = $('se-tada'), seRingin = $('se-ringin');
se.volume = 0.45;
if (seTada) seTada.volume = 0.55;
if (seRingin) seRingin.volume = 0.5;
let data = [], selected = null, pinned = false, typeTimer = null, lastTypedKey = '', collapsed = false, sentUnread = -1;
let localMachine = '';
const seen = {};                       // session id -> last activity time the user has looked at

function applyShade(shade) {
  if (['dusk', 'night', 'plum', 'desert', 'green'].includes(shade)) document.documentElement.dataset.shade = shade;
  else delete document.documentElement.dataset.shade;
}
if (window.bubble && window.bubble.onShade) window.bubble.onShade(applyShade);

// Ensure #hopen and #htopo exist (uses #hopen/#htopo from bubble.html if present; creates fallback buttons otherwise)
function ensureHeadBtn(id, text, title) {
  let b = $(id);
  if (!b && $('head')) {
    b = document.createElement('button');
    b.id = id;
    b.className = 'hbtn';
    b.type = 'button';
    b.hidden = true;
    b.textContent = text;
    b.title = title;
    $('head').appendChild(b);
  }
  return b;
}
const hopenBtn = ensureHeadBtn('hopen', '↗ 看板', '在网页看板中打开此会话');
const htopoBtn = ensureHeadBtn('htopo', '🕸 拓扑', '在项目拓扑中打开此节点');

function openSessionInWeb() {
  const s = data.find((x) => x.id === selected);
  if (!s || !window.bubble || !window.bubble.openExternal) return;
  const hash = localMachine ? '#s=' + encodeURIComponent(localMachine + '|' + s.id) : '#dashboard';
  window.bubble.openExternal(hash);
}

function openTopoInWeb() {
  const s = data.find((x) => x.id === selected);
  if (!s || !s.mesh || !s.mesh.projectId || !window.bubble || !window.bubble.openExternal) return;
  const hash = '#proj=' + encodeURIComponent(s.mesh.projectId) + '&tab=topo' + (s.mesh.nodeId ? '&node=' + encodeURIComponent(s.mesh.nodeId) : '');
  window.bubble.openExternal(hash);
}

const WORKING = new Set(['message', 'thinking', 'reading', 'error']);
const confirming = (s) => !!(s.permissions || []).length || /确认/.test(([...(s.lines || [])].reverse().find((l) => !l.sep) || {}).text || '');
const stateName = (st, s) => (WORKING.has(st) ? ['working', '进行中'] : st === 'waiting' ? ['waiting', s && !confirming(s) ? '等你回复' : '等你确认']
  : st === 'done' ? ['done', '完成'] : st === 'paused' ? ['idle', '已中断'] : st === 'ended' ? ['idle', '已关闭'] : ['idle', '空闲']);
const ago = (t0) => { const s = Math.round((Date.now() - t0) / 1000); return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分`; };
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const lastText = (s) => { for (let i = s.lines.length - 1; i >= 0; i--) if (!s.lines[i].sep) return s.lines[i].text; return '…'; };

const isUnread = (s) => (seen[s.id] || 0) < s.last && (collapsed || s.id !== selected);

function header() {
  const running = data.filter((s) => WORKING.has(s.state)).length, waiting = data.filter((s) => s.state === 'waiting').length;
  $('who').textContent = `Claude / Codex / OpenCode / Agy ─ ${data.length} 个会话`;
  $('meta').textContent = [running && `${running} 个在跑`, waiting && `${waiting} 个等你`].filter(Boolean).join(' · ') || '都停下了';
  const nUnread = data.filter(isUnread).length;
  $('ub').classList.toggle('on', nUnread > 0); $('ubn').textContent = nUnread;
  if (nUnread !== sentUnread) { sentUnread = nUnread; window.bubble.unread(nUnread); }
  const s = data.find((x) => x.id === selected);
  if (s) {
    $('hname').textContent = s.project && s.project !== s.label ? `${s.label}  ─ ${s.project}` : s.label;
    $('hmeta').textContent = `${stateName(s.state, s)[1]}${s.steps ? ` · 第${s.steps}步` : ''} · ${ago(s.t0)}`;
    if (hopenBtn) hopenBtn.hidden = false;
    if (htopoBtn) htopoBtn.hidden = !(s.mesh && s.mesh.projectId);
  } else {
    if (hopenBtn) hopenBtn.hidden = true;
    if (htopoBtn) htopoBtn.hidden = true;
  }
}

const cards = new Map();
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
    const [cls, name] = stateName(s.state, s);
    c.className = 'card' + (s.id === selected ? ' sel' : '') + (isUnread(s) ? ' unread' : '');
    const nm = c.querySelector('.nm');
    nm.textContent = s.label + (s.bg ? '（后台）' : '');
    let mark;
    if (s.provider === 'opencode' || s.provider === 'agy' || s.provider === 'kiro') {
      const pname = s.provider === 'agy' ? 'Antigravity' : s.provider === 'kiro' ? 'Kiro' : 'OpenCode';
      mark = document.createElement('span'); mark.className = 'provs'; mark.title = pname;
      const oc = document.createElement('span'); oc.className = 'prov ' + (s.provider === 'agy' ? 'agy' : s.provider === 'kiro' ? 'kiro' : 'opn'); mark.append(oc);
      if (s.ai && /^[a-z0-9-]{1,32}$/.test(String(s.ai.slug || ''))) {
        const ai = document.createElement('span'); ai.className = 'prov ai ai-' + s.ai.slug; ai.title = String(s.ai.name || '');
        const model = String((s.model && typeof s.model === 'object' ? s.model.id : s.model) || '').trim().slice(0, 80);
        if (model && model.toLowerCase() !== ai.title.toLowerCase()) ai.title = (ai.title ? ai.title + ' · ' : '') + model;
        mark.append(ai); mark.title = pname + (ai.title ? ' · ' + ai.title : '');
      }
    } else {
      mark = document.createElement('span'); mark.className = 'prov ' + (s.provider === 'codex' ? 'cdx' : 'cla');
    }
    nm.prepend(mark);
    c.querySelector('.sm').textContent = lastText(s);
    const st = c.querySelector('.st'); st.className = 'st ' + cls;
    st.textContent = `${s.provider === 'codex' ? 'Codex' : s.provider === 'opencode' ? 'OpenCode' : s.provider === 'agy' ? 'Antigravity' : s.provider === 'kiro' ? 'Kiro' : 'Claude'} · ${name}`;
  });
}

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

const permissionCards = new Map();
function renderPermissions() {
  const s = data.find((x) => x.id === selected);
  const requests = s && s.permissions || [];
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
    if (p.ask && askQuestions(p)) { const c = askCard(p, askQuestions(p)); permissionCards.set(p.id, c); $('permissions').appendChild(c); continue; }
    const card = document.createElement('div'); card.className = 'permission'; card.dataset.id = p.id;
    const title = document.createElement('div'); title.className = 'permission-title';
    title.textContent = `需要你确认 · ${p.tool}${p.subagent ? ` · ${p.subagent}` : ''}`;
    const details = document.createElement('pre');
    const i = p.input || {};
    details.textContent = [p.cwd && `工作目录：${p.cwd}`,
      p.provider === 'opencode' && i.message && `说明：${i.message}`,
      p.provider === 'opencode' && Array.isArray(i.resources) && i.resources.length && `对象：${i.resources.join(' · ')}`,
      (i.description || i.toolSummary),
      (i.command || i.CommandLine) && `${p.tool === 'apply_patch' ? '修改补丁' : '命令'}：${i.command || i.CommandLine}`,
      (i.file_path || i.notebook_path || i.Path || i.TargetFile) && `文件：${i.file_path || i.notebook_path || i.Path || i.TargetFile}`,
      JSON.stringify(i, null, 2)].filter(Boolean).join('\n');
    const actions = document.createElement('div'); actions.className = 'permission-actions';
    const choices = [['allow', '允许'], ['deny', '拒绝']];
    if (p.always) choices.splice(1, 0, ['always', '总是允许']);
    if (p.provider === 'codex') choices.push(['defer', '在 Codex 中处理']);
    if (p.provider === 'agy') choices.push(['defer', '在 Antigravity 中处理']);
    for (const [choice, label] of choices) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.choice = choice; b.textContent = label;
      if (choice === 'always') b.title = '允许，并且以后不再问：' + p.always;
      actions.appendChild(b);
    }
    const status = document.createElement('span'); status.className = 'permission-status';
    status.textContent = p.provider === 'codex' ? '超时后交回 Codex' : p.provider === 'agy' ? '超时后交回 Antigravity' : '也可在终端回答';
    actions.appendChild(status); card.append(title, details, actions);
    permissionCards.set(p.id, card); $('permissions').appendChild(card);
  }
}

function askQuestions(p) {
  const qs = p.input && p.input.questions;
  return Array.isArray(qs) && qs.length && qs.every((q) => q && typeof q.question === 'string' && q.question && Array.isArray(q.options)) ? qs : null;
}
function askCard(p, qs) {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const card = el('div', 'permission ask'); card.dataset.id = p.id;
  const askWho = p.provider === 'agy' ? 'Antigravity' : 'Claude';
  card.append(el('div', 'permission-title', `${askWho} 在问你${qs.length > 1 ? ` · ${qs.length} 个问题` : ''}${p.subagent ? ` · ${p.subagent}` : ''}`));
  const state = qs.map(() => ({ picked: new Set(), own: '' }));
  const go = el('button', '', '提交回答'); go.type = 'button'; go.dataset.choice = 'answer'; go.disabled = true;
  card.answers = () => {
    const out = {};
    for (let n = 0; n < qs.length; n++) {
      const q = qs[n], st = state[n], own = st.own.trim();
      const a = q.multiSelect ? [...q.options.map((o) => o.label).filter((l) => st.picked.has(l)), ...(own ? [own] : [])].join(', ') : own || [...st.picked][0] || '';
      if (!a) return null;
      out[q.question] = a;
    }
    return out;
  };
  const fresh = () => { go.disabled = !card.answers(); };
  qs.forEach((q, n) => {
    const st = state[n], box = el('div', 'ask-q'), head = el('div', 'ask-h');
    if (q.header) head.append(el('span', 'ask-t', q.header));
    head.append(el('span', '', q.question));
    if (q.multiSelect) head.append(el('i', '', '可多选'));
    const row = el('div', 'ask-o');
    const own = el('input', 'ask-own'); own.placeholder = q.multiSelect ? '还有别的：自己填写' : '都不是：自己填写'; own.spellcheck = false;
    const opts = q.options.map((o) => {
      const b = el('button', 'ask-opt'); b.type = 'button'; b.title = o.description || '';
      b.append(el('b', '', o.label)); if (o.description) b.append(el('span', '', o.description));
      b.pick = () => {
        if (q.multiSelect) { if (st.picked.has(o.label)) st.picked.delete(o.label); else st.picked.add(o.label); }
        else { st.picked.clear(); st.picked.add(o.label); st.own = ''; own.value = ''; }
        opts.forEach((x, k) => x.classList.toggle('on', st.picked.has(q.options[k].label)));
        fresh();
      };
      row.append(b);
      return b;
    });
    own.addEventListener('input', () => {
      st.own = own.value;
      if (!q.multiSelect && own.value.trim()) { st.picked.clear(); opts.forEach((x) => x.classList.remove('on')); }
      fresh();
    });
    own.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.isComposing && !go.disabled) { e.preventDefault(); decidePermission(go); } });
    box.append(head, row, own); card.append(box);
  });
  const actions = el('div', 'permission-actions');
  const chat = el('button', '', '先聊聊'); chat.type = 'button'; chat.dataset.choice = 'chat'; chat.title = '先不回答：让 Claude 问你想澄清什么（终端里的 Chat about this）';
  const no = el('button', '', '不回答'); no.type = 'button'; no.dataset.choice = 'deny';
  actions.append(go, chat, no, el('span', 'permission-status', '也可在终端回答'));
  card.append(actions);
  return card;
}
async function decidePermission(button) {
  if (button.disabled) return;
  if (button.pick) return button.pick();
  const card = button.closest('.permission');
  const extra = button.dataset.choice === 'answer' ? { answers: card.answers() } : undefined;
  if (extra && !extra.answers) return;
  const was = [...card.querySelectorAll('button, input')].filter((x) => !x.disabled);
  for (const b of was) b.disabled = true;
  const status = card.querySelector('.permission-status'); status.textContent = '提交中…';
  try {
    const r = await window.bubble.decidePermission(card.dataset.id, button.dataset.choice, extra);
    status.textContent = r.ok ? '已提交' : '请求已结束';
  } catch {
    status.textContent = '提交失败，请重试或在终端回答';
    for (const b of was) b.disabled = false;
  }
}
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const headAction = hit && hit.closest && hit.closest('#hopen, #htopo');
  if (headAction) {
    e.preventDefault();
    if (headAction.id === 'hopen') openSessionInWeb();
    else if (headAction.id === 'htopo') openTopoInWeb();
    return;
  }
  const button = hit && hit.closest('.permission button');
  if (button) { e.preventDefault(); decidePermission(button); }
});
$('permissions').addEventListener('click', (e) => {
  if (e.detail === 0 && e.target.matches('button')) decidePermission(e.target);
});
if (hopenBtn) hopenBtn.addEventListener('click', (e) => { if (e.detail === 0) openSessionInWeb(); });
if (htopoBtn) htopoBtn.addEventListener('click', (e) => { if (e.detail === 0) openTopoInWeb(); });

const WAIT_SOUND_GRACE_MS = 1500;
const LONG_ACTIVE_MS = 180_000;
const LONG_MIN_DELTA_STEPS = 8;
const MAX_TICK_GAP_MS = 30_000;
const waitSoundTimers = new Map();
const bubbleWork = new Map();
function cancelWaitSound(id) {
  const t = waitSoundTimers.get(id);
  if (t) { clearTimeout(t); waitSoundTimers.delete(id); }
}
function playClip(aud) {
  const el = aud || se;
  if (!el) return;
  try { el.currentTime = 0; el.play(); } catch {}
}

window.bubble.onState(({ sessions, changedId, mode, sound = true, machine = '', shade = '' }) => {
  if (machine) localMachine = machine;
  applyShade(shade);
  const nowTs = Date.now();
  const prev = data.find((x) => x.id === changedId);
  data = sessions;
  const activeIds = new Set();
  for (const x of data) {
    const steps = Number(x.steps) || 0;
    if (WORKING.has(x.state)) {
      activeIds.add(x.id);
      const rec = bubbleWork.get(x.id);
      if (!rec) bubbleWork.set(x.id, { activeMs: 0, lastTickAt: nowTs, startSteps: steps, maxSteps: steps });
      else {
        rec.activeMs += Math.max(0, Math.min(nowTs - rec.lastTickAt, MAX_TICK_GAP_MS));
        rec.lastTickAt = nowTs;
        if (steps > rec.maxSteps) rec.maxSteps = steps;
      }
    } else if (x.state === 'waiting' && bubbleWork.has(x.id)) {
      activeIds.add(x.id);
      const rec = bubbleWork.get(x.id);
      rec.lastTickAt = nowTs;
      if (steps > rec.maxSteps) rec.maxSteps = steps;
    }
  }
  for (const id of [...waitSoundTimers.keys()]) {
    const x = data.find((it) => it.id === id);
    if (!x || x.state !== 'waiting') cancelWaitSound(id);
  }
  setMode(mode);
  if (!data.find((x) => x.id === selected)) { selected = null; pinned = false; }
  const changed = data.find((x) => x.id === changedId);
  const cur = data.find((x) => x.id === selected);
  if (changed && (!cur || changed.state === 'waiting' || (!pinned && !WORKING.has(cur.state) && cur.state !== 'waiting'))) selected = changedId;
  if (!selected && data.length) selected = data[0].id;
  const sel = data.find((x) => x.id === selected);
  if (sel && !collapsed) seen[sel.id] = sel.last;
  renderAll(changedId === selected);
  if (changed && (!prev || prev.state !== changed.state)) {
    if (changed.state === 'waiting') {
      if (sound && !waitSoundTimers.has(changed.id)) {
        const sid = changed.id;
        const hasAsk = (changed.permissions || []).some((p) => Boolean(askQuestions(p)));
        waitSoundTimers.set(sid, setTimeout(() => {
          waitSoundTimers.delete(sid);
          const now = data.find((it) => it.id === sid);
          if (now && now.state === 'waiting') playClip(hasAsk ? seRingin : se);
        }, hasAsk ? 300 : WAIT_SOUND_GRACE_MS));
      }
    } else if (changed.state === 'done') {
      const rec = bubbleWork.get(changed.id);
      let isLong = false;
      if (rec) {
        rec.activeMs += Math.max(0, Math.min(nowTs - rec.lastTickAt, MAX_TICK_GAP_MS));
        const maxSteps = Math.max(Number(changed.steps) || 0, rec.maxSteps);
        isLong = rec.activeMs >= LONG_ACTIVE_MS && (maxSteps - rec.startSteps) >= LONG_MIN_DELTA_STEPS;
      }
      if (sound) playClip(isLong ? seTada : se);
    } else if (changed.state === 'message') {
      if (sound) playClip(se);
    }
  }
  for (const id of [...bubbleWork.keys()]) if (!activeIds.has(id)) bubbleWork.delete(id);
  if (chatOn) { selectChat(); composeState(); }
});
window.bubble.onHide(() => {});
window.bubble.onCollapsed((v) => {
  collapsed = !!v;
  document.body.classList.toggle('collapsed', collapsed);
  $('fold').textContent = collapsed ? '□' : '−'; $('fold').title = collapsed ? '展开' : '收成 P 酱';
  const sel = data.find((x) => x.id === selected);
  if (!collapsed && sel) seen[sel.id] = sel.last;
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
  else if (hit && hit.closest && hit.closest('#title') && hit.id !== 'close' && hit.id !== 'fold' && !hit.closest('#hopen') && !hit.closest('#htopo')) {
    const d = lastTitleDown, now = Date.now();
    if (now - d.t < 450 && Math.abs(e.clientX - d.x) < 6 && Math.abs(e.clientY - d.y) < 6) {
      lastTitleDown = { t: 0, x: 0, y: 0 }; window.bubble.collapse(!collapsed);
    } else {
      lastTitleDown = { t: now, x: e.clientX, y: e.clientY };
      window.bubble.gesture('drag-start');
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
  terminal: '回复（Enter 发送，Shift+Enter 换行）',
  resume: '会话已关闭：发送会在后台续上',
  busy: '后台续聊进行中…',
  none: '这个会话不在终端里（IDE / 桌面 App），只能看不能回',
  unknown: '等它下一次有动静，就知道它在哪个终端了',
};
function composeState() {
  const s = data.find((x) => x.id === selected);
  const via = s ? s.via : 'unknown';
  input.disabled = !s || via === 'none' || via === 'busy' || via === 'unknown';
  input.placeholder = s ? PLACEHOLDER[via] : '还没有会话';
}

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
  if (m.role === 'assistant' || m.role === 'btw') d.innerHTML = (m.role === 'btw' ? '<b class="btwh">顺带一问的回答</b>' : '') + md(m.text);
  else if (m.role === 'tool') {
    const shown = m.items.slice(-4).map(esc).join(' · ');
    d.innerHTML = `<b>⚙</b> ${m.items.length > 4 ? `…等 ${m.items.length} 步 · ` : ''}${shown}${tm}`;
  } else if (m.role === 'user') { d.textContent = m.text; d.insertAdjacentHTML('beforeend', tm); }
  else if (m.role === 'cmd') cmdEl(d, m);
  else d.textContent = m.text;
  return d;
}
const CMD_FOLD = 8, cmdOpen = new Set();
function cmdEl(d, m) {
  const text = m.text || '', lines = text.split('\n'), key = m.t + ':' + text.length;
  const long = lines.length > CMD_FOLD + 2, open = cmdOpen.has(key);
  d.innerHTML = `<div class="ch">命令输出 · ${hhmm(m.t)}</div><pre>${esc(long && !open ? lines.slice(0, CMD_FOLD).join('\n') : text)}</pre>`
    + (long ? `<span class="cmore">${open ? '收起' : `展开全部（共 ${lines.length} 行）`}</span>` : '');
  if (long) d.querySelector('.cmore').addEventListener('click', () => { if (open) cmdOpen.delete(key); else cmdOpen.add(key); d.replaceWith(msgEl(m)); });
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
  else showNote(r.msg || '没发出去', 8000);
}
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
document.addEventListener('pointerdown', (e) => {
  if (!chatOn) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (hit && hit.id === 'sendb') { e.preventDefault(); send(); }
});
