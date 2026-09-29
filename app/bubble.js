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
  : st === 'done' ? ['done', '完成'] : ['idle', '空闲']);
const ago = (t0) => { const s = Math.round((Date.now() - t0) / 1000); return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分`; };
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const lastText = (s) => { for (let i = s.lines.length - 1; i >= 0; i--) if (!s.lines[i].sep) return s.lines[i].text; return '…'; };

// unread = new activity you have not looked at; while collapsed nothing is being looked at, so the selected one counts too
const isUnread = (s) => (seen[s.id] || 0) < s.last && (collapsed || s.id !== selected);

function header() {
  const running = data.filter((s) => WORKING.has(s.state)).length, waiting = data.filter((s) => s.state === 'waiting').length;
  $('who').textContent = `Claude ─ ${data.length} 个会话`;
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
    st.textContent = s.project && s.project !== s.label ? `${name} · ${s.project}` : name;
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

function renderAll(typeNewest) { renderList(); renderLog(typeNewest); header(); }

window.bubble.onState(({ sessions, changedId }) => {
  const prev = data.find((s) => s.id === changedId);
  data = sessions;
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
    try { se.currentTime = 0; se.play(); } catch {}
  }
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

