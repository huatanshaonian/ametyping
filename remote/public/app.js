'use strict';
// Dashboard. Opens a WebSocket, shows the session list per machine, and (on click) subscribes to one
// session's conversation. Where the machine allows it, the reply box types into that session and the
// permission cards answer its pending prompts -- both carried out by the pet on that machine, like its own panel.
const $ = (id) => document.getElementById(id);
const listEl = $('list'), convEl = $('conv'), conn = $('conn');
let data = [], sel = null, ws = null, cards = new Map(), heads = new Map();
const say = $('say'), sendBtn = $('sendbtn'), permsEl = $('perms'), note = $('note');

const STATE = { message: ['working', '进行中'], thinking: ['working', '进行中'], reading: ['working', '进行中'],
  error: ['working', '出错'], waiting: ['waiting', '等你确认'], done: ['done', '完成'], idle: ['idle', '空闲'], ended: ['idle', '已关闭'] };
const stateOf = (s) => STATE[s] || ['idle', s || '空闲'];
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}秒` : s < 3600 ? `${Math.floor(s / 60)}分` : `${Math.floor(s / 3600)}时`; };
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function allSessions() {
  const out = [];
  for (const m of data) for (const s of m.sessions) out.push({ ...s, machine: m.machine, online: m.online });
  return out;
}
const lastLine = (s) => { for (let i = (s.lines || []).length - 1; i >= 0; i--) if (s.lines[i].text) return s.lines[i].text; return '…'; };

function renderList() {
  const empty = !data.some((m) => m.sessions.length);
  if (empty) { listEl.innerHTML = '<div id="empty">还没有会话。开着糖糖 agent 的机器一有 Claude 活动就会出现在这里。</div>'; cards.clear(); heads.clear(); return; }
  if ($('empty')) $('empty').remove();
  const wanted = new Set();
  const order = [];                  // elements in display order; nodes are reused so a click is never lost to a rebuild
  for (const m of data) {
    if (!m.sessions.length) continue;
    let mc = heads.get(m.machine);
    if (!mc) { mc = document.createElement('div'); heads.set(m.machine, mc); }
    mc.className = 'mc' + (m.online ? ' on' : '');
    const mtext = `<span class="dot"></span>${esc(m.machine)} · ${m.sessions.length} 个会话${m.online ? '' : '（离线）'}${m.online && !m.control ? ' · 只读' : ''}`;
    if (mc.innerHTML !== mtext) mc.innerHTML = mtext;
    order.push(mc);
    for (const s of m.sessions) {
      const key = m.machine + '|' + s.id;
      wanted.add(key);
      let c = cards.get(key);
      if (!c) {
        c = document.createElement('div');
        c.innerHTML = '<div class="nm"></div><div class="sm"></div><div class="st"></div>';
        c.dataset.key = key;
        cards.set(key, c);
      }
      const [cls, name] = stateOf(s.state);
      c.className = 'card' + (sel === key ? ' sel' : '');
      const nm = c.querySelector('.nm'), n = (s.perms || []).length;
      const nmHtml = esc(s.label) + (n ? `<span class="pb">待确认 ${n}</span>` : '');
      if (nm.innerHTML !== nmHtml) nm.innerHTML = nmHtml;
      const sm = c.querySelector('.sm'); if (sm.textContent !== lastLine(s)) sm.textContent = lastLine(s);
      const st = c.querySelector('.st'); st.className = 'st ' + cls;
      st.textContent = `${name}${s.project ? ' · ' + s.project : ''} · ${ago(s.last)}`;
      order.push(c);
    }
  }
  for (const [k, el] of cards) if (!wanted.has(k)) { el.remove(); cards.delete(k); }
  for (const [k, el] of heads) if (!order.includes(el)) { el.remove(); heads.delete(k); }
  // move only what is out of place
  order.forEach((el, i) => { if (listEl.children[i] !== el) listEl.insertBefore(el, listEl.children[i] || null); });
  while (listEl.children.length > order.length) listEl.lastElementChild.remove();
}

listEl.addEventListener('click', (e) => {
  const c = e.target.closest('.card'); if (!c) return;
  select(c.dataset.key);
});
$('back').addEventListener('click', () => { document.body.classList.remove('viewing'); });

function select(key) {
  sel = key;
  renderList();
  document.body.classList.add('viewing');
  const [machine, id] = key.split('|');
  const s = allSessions().find((x) => x.machine === machine && x.id === id);
  $('hname').textContent = s ? s.label : '';
  $('hmeta').textContent = s ? `${machine}${s.project ? ' · ' + s.project : ''}` : '';
  convEl.innerHTML = '<div id="pick">加载对话…</div>';
  permsEl.innerHTML = ''; permCards.clear(); showNote('');
  renderControls();
  wsSend({ t: 'watch', machine, id });
}
const current = () => { if (!sel) return null; const [machine, id] = sel.split('|'); return allSessions().find((x) => x.machine === machine && x.id === id) || null; };

// --- actions: every request gets an id; the server answers with {t:'result', rid, ok, msg} ---
const waiting = new Map();          // rid -> callback
let ridN = 0;
function act(o, cb) {
  if (!ws || ws.readyState !== 1) return cb({ ok: false, msg: '还没连上服务器' });
  const rid = 'r' + (++ridN) + '-' + Date.now().toString(36);
  // acting needs a code entered in the last few minutes: ask for it, then retry once
  waiting.set(rid, (r) => {
    if (r.need !== 'totp') return cb(r);
    askCode().then((ok) => (ok ? act(o, cb) : cb({ ok: false, msg: '已取消' })));
  });
  wsSend({ ...o, rid });
  setTimeout(() => { const f = waiting.get(rid); if (f) { waiting.delete(rid); f({ ok: false, msg: '没有回应，结果不确定，请看对话确认' }); } }, 25000);
}
// --- re-enter the code (step-up) ---
const gate = $('gate'), gateCode = $('gate-code'), gateMsg = $('gate-msg');
let gateWait = null;
function askCode() {
  if (gateWait) return gateWait.p;
  let resolve; const p = new Promise((r) => { resolve = r; });
  gateWait = { p, resolve };
  gateMsg.textContent = ''; gateCode.value = ''; gate.hidden = false; gateCode.focus();
  return p;
}
function closeGate(ok) { gate.hidden = true; const g = gateWait; gateWait = null; if (g) g.resolve(ok); }
$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('gate-ok'); btn.disabled = true; gateMsg.textContent = '';
  let status = 0, d = {};
  try {
    const r = await fetch('/api/stepup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: gateCode.value.replace(/\s/g, '') }) });
    status = r.status; try { d = await r.json(); } catch {}
  } catch {}
  btn.disabled = false;
  if (status === 200) return closeGate(true);
  if (status === 401 && d.error === 'unauthorized') { location.href = '/login'; return; }
  gateMsg.textContent = status === 429 ? `尝试次数过多，请 ${Math.ceil((d.retryMs || 0) / 60000)} 分钟后再试` : '验证码不对';
  gateCode.value = ''; gateCode.focus();
});
$('gate-cancel').addEventListener('click', () => closeGate(false));
gate.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGate(false); });

let noteTimer = null;
function showNote(msg, bad, ms = 6000) {
  clearTimeout(noteTimer);
  note.textContent = msg || ''; note.classList.toggle('show', !!msg); note.classList.toggle('bad', !!bad);
  if (msg) noteTimer = setTimeout(() => note.classList.remove('show'), ms);
}

// --- reply box ---
const PLACEHOLDER = {
  terminal: '回复（Enter 发送，Shift+Enter 换行）— 会打进那台机器的终端',
  resume: '会话已关闭：发送会在那台机器后台用 claude -p --resume 续上',
  busy: '后台续聊进行中…',
  none: '这个会话不在终端里（IDE / 桌面 App），只能看',
  unknown: '还不知道它在哪个终端（等它下一次有动静）',
  codex: 'Codex 会话请在 Codex 里继续；这里可以处理权限',
  off: '这台机器没开远程控制（或糖糖没在运行），只能看',
};
let sending = false;
function renderControls() {
  const s = current();
  const via = s ? (s.online ? s.via || 'off' : 'off') : null;
  say.disabled = !s || sending || !['terminal', 'resume'].includes(via);
  say.placeholder = !s ? '先选一个会话' : s.online ? PLACEHOLDER[via] || PLACEHOLDER.off : '这台机器离线了';
  if (s && (s.perms || []).length && via === 'terminal') say.placeholder = '它在等你确认，先处理上面的确认卡片';
  if (s && (s.perms || []).length) say.disabled = true;
  sendBtn.disabled = say.disabled || !say.value.trim();
  renderPerms(s);
}
function fitSay() { say.style.height = 'auto'; say.style.height = Math.min(140, say.scrollHeight + 2) + 'px'; }
say.addEventListener('input', () => { fitSay(); sendBtn.disabled = say.disabled || !say.value.trim(); });
const coarse = matchMedia('(pointer: coarse)').matches;     // phones: Enter is a newline, the button sends
say.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); $('compose').requestSubmit(); }
});
$('compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = current(), text = say.value;
  if (!s || say.disabled || !text.trim()) return;
  sending = true; renderControls(); showNote('发送中…', false, 30000);
  act({ t: 'send', machine: s.machine, id: s.id, text }, (r) => {
    sending = false;
    if (r.ok) { if (say.value === text) { say.value = ''; fitSay(); } showNote(r.msg || '已发送'); }
    else showNote(r.msg || '发送失败', true);
    renderControls();
  });
});

// --- permission cards (kept stable across updates so a click is never lost to a re-render) ---
const permCards = new Map();
function renderPerms(s) {
  const list = s && s.online ? s.perms || [] : [];
  const ids = new Set(list.map((p) => p.id));
  for (const [id, el] of permCards) if (!ids.has(id)) { el.remove(); permCards.delete(id); }
  for (const p of list) {
    if (permCards.has(p.id)) continue;
    const card = document.createElement('div'); card.className = 'perm'; card.dataset.id = p.id;
    const t = document.createElement('div'); t.className = 'pt';
    t.textContent = `需要你确认 · ${p.tool}${p.subagent ? ' · ' + p.subagent : ''}`;
    const pre = document.createElement('pre');
    let i = {}; try { i = JSON.parse(p.input); } catch {}
    pre.textContent = [p.cwd && `工作目录：${p.cwd}`, i.description,
      i.command && `${p.tool === 'apply_patch' ? '修改补丁' : '命令'}：${i.command}`,
      (i.file_path || i.notebook_path) && `文件：${i.file_path || i.notebook_path}`, p.input].filter(Boolean).join('\n');
    const a = document.createElement('div'); a.className = 'pa';
    const choices = [['allow', '允许', 'btn go'], ['deny', '拒绝', 'btn no']];
    if (p.provider === 'codex') choices.push(['defer', '在 Codex 中处理', 'btn']);
    for (const [choice, label, cls] of choices) {
      const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.dataset.choice = choice; b.textContent = label;
      a.appendChild(b);
    }
    const st = document.createElement('span'); st.className = 'ps'; st.textContent = '也可在那台机器上回答';
    a.appendChild(st); card.append(t, pre, a);
    permCards.set(p.id, card); permsEl.appendChild(card);
  }
}
permsEl.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  const card = b.closest('.perm'), s = current(); if (!s) return;
  for (const x of card.querySelectorAll('button')) x.disabled = true;
  const st = card.querySelector('.ps'); st.textContent = '提交中…';
  act({ t: 'decide', machine: s.machine, id: s.id, perm: card.dataset.id, choice: b.dataset.choice }, (r) => {
    st.textContent = r.ok ? '已提交' : (r.msg || '提交失败');
    if (!r.ok) for (const x of card.querySelectorAll('button')) x.disabled = false;
  });
});

// --- render one conversation ---
function inline(s) {
  return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
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
  const tm = `<span class="tm">${m.t ? hhmm(m.t) : ''}</span>`;
  if (m.role === 'assistant') d.innerHTML = md(m.text || '');
  else if (m.role === 'tool') {
    const items = (m.items || []).slice(-5).map(esc).join(' · ');
    d.innerHTML = `<b>⚙</b> ${items}${tm}`;
  } else if (m.role === 'user') { d.textContent = m.text || ''; d.insertAdjacentHTML('beforeend', tm); }
  else d.textContent = m.text || '';
  return d;
}
function renderConv(msgs) {
  const atBottom = convEl.scrollHeight - convEl.scrollTop - convEl.clientHeight < 60;
  convEl.innerHTML = '';
  if (!msgs.length) { convEl.innerHTML = '<div id="pick">这个会话还没有内容。</div>'; return; }
  for (const m of msgs) convEl.appendChild(msgEl(m));
  if (atBottom) convEl.scrollTop = convEl.scrollHeight;
}

// --- websocket ---
function wsSend(o) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch {} }
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { conn.textContent = '已连接'; if (sel) { const [machine, id] = sel.split('|'); wsSend({ t: 'watch', machine, id }); } };
  ws.onclose = (e) => {
    if (e.code === 4401) { location.href = '/login'; return; }
    conn.textContent = '已断开，重连中…'; setTimeout(connect, 2000);
    for (const [rid, f] of waiting) { waiting.delete(rid); f({ ok: false, msg: '连接断了，结果不确定，请看对话确认' }); }
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (e) => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (d.t === 'sessions') {
      data = d.data || [];
      renderList();
      if (sel) {
        const [machine, id] = sel.split('|');
        const s = allSessions().find((x) => x.machine === machine && x.id === id);
        if (s) { $('hname').textContent = s.label; $('hmeta').textContent = `${machine}${s.project ? ' · ' + s.project : ''}${s.online ? '' : ' · 离线'}`; }
      }
      renderControls();
    } else if (d.t === 'result') {
      const f = waiting.get(d.rid); if (f) { waiting.delete(d.rid); f(d); }
    } else if (d.t === 'conv') {
      if (sel === d.machine + '|' + d.id) renderConv(d.msgs || []);
    }
  };
}

$('logout').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  location.href = '/login';
});

connect();
setInterval(renderList, 15000);   // refresh the "N秒前" labels
