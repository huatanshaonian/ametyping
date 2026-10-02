// 糖糖看板's session list: your groups first (sessions from any machine), then each computer's other sessions
// (the current computer on top). Pinned sessions lead their section, starred ones carry a ★, hidden ones are left out
// until you ask to see them. Right click (long press on a phone) a session, a group or the list for the menu.
// Marks and groups live on the server (js/marks.js) so every device shows the same list. Above it: 活动 / 全部 and
// the search box (dash-filter.js); the list element itself is `el`, the bar is returned as `tool`.
import { $, h, esc, ago, stateOf, prefs, ctxLeft, CTX_LOW, plain } from '../util.js';
import * as net from '../net.js';
import * as marks from '../marks.js';
import * as ctx from '../ctxmenu.js';
import { askText } from '../dialog.js';
import { createFilter } from './dash-filter.js';

const PAGE = 50;

export function createList({ el, current, selected, onSelect, onNote }) {
  const cards = new Map(), heads = new Map(), shown = new Map();
  const collapsed = new Set(prefs.get('dash.collapsed', []));
  let showHidden = false, onlyStarred = prefs.get('dash.onlyStarred', false);

  const lastLine = (s) => { for (let i = (s.lines || []).length - 1; i >= 0; i--) if (s.lines[i].text) return plain(s.lines[i].text); return s.state === 'history' ? '（历史会话）' : '…'; };
  const head = (k) => { let x = heads.get(k); if (!x) { x = h('div'); heads.set(k, x); } return x; };
  const filter = createFilter({ onChange: () => { render(); el.scrollTop = 0; } });

  function render() {
    const machines = [...net.state.sessions].sort((a, b) => (b.machine === current) - (a.machine === current));
    const groups = marks.groups(), gids = new Set(groups.map((g) => g.id));
    if (!groups.length && !machines.some((m) => m.sessions.length)) {
      el.replaceChildren(h('div', { class: 'empty', text: '还没有会话。开着 agent 的电脑一有 Claude 活动就会出现在这里。' })); cards.clear(); heads.clear(); return;
    }
    // every session once: in its group when it has one, else under its machine
    const inGroup = new Map(groups.map((g) => [g.id, []])), byMachine = new Map();
    let hiddenN = 0;
    for (const m of machines) {
      byMachine.set(m.machine, []);
      for (const s of m.sessions) {
        const key = m.machine + '|' + s.id, mk = marks.of(key);
        const item = { s, m, key, mk };
        if (!filter.keep(item, lastLine(s))) continue;
        // hidden ones stay out unless asked for -- a search finds them anyway
        if (mk.hidden && !filter.searching()) { hiddenN++; if (!showHidden) continue; }
        if (onlyStarred && !mk.starred) continue;
        (mk.group && gids.has(mk.group) ? inGroup.get(mk.group) : byMachine.get(m.machine)).push(item);
      }
    }
    const order = [], wanted = new Set();
    const unit = filter.searching() ? '个结果' : filter.view() === 'active' ? '个活动' : '个会话';
    const allView = !filter.searching() && filter.view() === 'all';
    // pinned first; otherwise the server's order (newest first) -- a group across machines is merged by last activity
    const pinnedFirst = (a, b) => !!b.mk.pinned - !!a.mk.pinned;
    const byLast = (a, b) => (b.s.last || 0) - (a.s.last || 0);
    const section = (sk, hd, items, showMachine) => {
      order.push(hd);
      if (collapsed.has(sk)) return;
      const limit = shown.get(sk) || PAGE;
      for (const it of items.slice(0, limit)) { wanted.add(it.key); order.push(card(it, showMachine)); }
      if (items.length > limit) {
        const mo = head('more|' + sk);
        mo.className = 'more'; mo.dataset.sec = sk;
        mo.textContent = `显示更多（还有 ${items.length - limit} 个）`;
        order.push(mo);
      }
    };
    for (const g of groups) {
      const sk = 'g:' + g.id, items = inGroup.get(g.id).sort(byLast).sort(pinnedFirst), hd = head(sk);
      if (!items.length && !allView) continue;                         // an empty group only under 全部
      hd.className = 'mc grp' + (collapsed.has(sk) ? ' fold' : ''); hd.dataset.sec = sk; hd.dataset.group = g.id;
      setText(hd, `${g.name} · ${items.length} ${unit}`, 'gi');
      section(sk, hd, items, true);
    }
    for (const m of machines) {
      const items = byMachine.get(m.machine);
      if (!items.length) continue;
      const sk = 'm:' + m.machine, hd = head(sk);
      hd.className = 'mc' + (m.online ? ' on' : '') + (m.machine === current ? ' cur' : '') + (collapsed.has(sk) ? ' fold' : ''); hd.dataset.sec = sk;
      setText(hd, `${m.machine} · ${items.length} ${unit}${m.online ? '' : '（离线）'}${m.online && !m.control ? ' · 只读' : ''}`, 'dot');
      section(sk, hd, items.sort(pinnedFirst), false);
    }
    if (hiddenN) {
      const t = head('hidden');
      t.className = 'more hid'; t.textContent = showHidden ? '收起已隐藏的会话' : `显示已隐藏的 ${hiddenN} 个会话`;
      order.push(t);
    }
    if (!wanted.size) {
      const e = head('none'); e.className = 'pick';
      e.textContent = filter.searching() ? (filter.pending() ? '搜索中…' : `没有找到「${filter.query()}」。`)
        : onlyStarred ? '没有星标的会话（右键会话可以加星标）。'
        : filter.view() === 'active' ? '没有活动中的会话。点上面的「全部」看历史会话。' : '';
      if (e.textContent) order.push(e);
    }
    for (const [k, c] of cards) if (!wanted.has(k)) { c.remove(); cards.delete(k); }
    for (const [k, x] of heads) if (!order.includes(x)) { x.remove(); heads.delete(k); }
    const empty = $('.empty', el); if (empty) empty.remove();
    order.forEach((x, i) => { if (el.children[i] !== x) el.insertBefore(x, el.children[i] || null); });
    while (el.children.length > order.length) el.lastElementChild.remove();
  }
  function setText(hd, text, mark) {
    if (hd.dataset.t === text) return;
    hd.dataset.t = text;
    hd.replaceChildren(h('span', { class: 'fd', text: '' }), h('span', { class: mark }), text);
  }
  function card({ s, m, key, mk }, showMachine) {
    let c = cards.get(key);
    if (!c) { c = h('div', { class: 'card', dataset: { key } }, h('div', { class: 'nm' }), h('div', { class: 'sm' }), h('div', { class: 'st' })); cards.set(key, c); }
    const [cls, name] = stateOf(s.state), n = (s.perms || []).length;
    c.className = 'card' + (selected() === key ? ' sel' : '') + (mk.hidden ? ' hid' : '');
    const left = s.state !== 'history' ? ctxLeft(s) : null;            // context running low: a tag on the card
    const nmHtml = (mk.starred ? '<span class="star">★</span>' : '') + esc(s.label) + (mk.pinned ? '<span class="pin">置顶</span>' : '') +
      (left != null && left <= CTX_LOW ? `<span class="cxb">上下文 ${left}%</span>` : '') + (n ? `<span class="pb">待确认 ${n}</span>` : '');
    if ($('.nm', c).innerHTML !== nmHtml) $('.nm', c).innerHTML = nmHtml;
    // while searching, the passage found in its conversation
    const hit = filter.hit(key), sm = $('.sm', c), line = hit || lastLine(s);
    if (sm.textContent !== line) sm.textContent = line;
    sm.classList.toggle('hit', !!hit);
    const st = $('.st', c); st.className = 'st ' + cls;
    st.textContent = `${name}${showMachine ? ' · ' + m.machine + (m.online ? '' : '（离线）') : ''}${s.project ? ' · ' + s.project : ''} · ${ago(s.last)}`;
    return c;
  }

  // ---- clicks: a session, "more", a section head (fold), the hidden ones ----
  el.addEventListener('click', (e) => {
    const t = e.target.closest('.more, .mc, .card');
    if (!t) return;
    if (t.classList.contains('hid') && t.classList.contains('more')) { showHidden = !showHidden; render(); return; }
    if (t.classList.contains('more')) { const sk = t.dataset.sec; shown.set(sk, (shown.get(sk) || PAGE) + PAGE); render(); return; }
    if (t.classList.contains('mc')) { fold(t.dataset.sec); return; }
    onSelect(t.dataset.key);
  });
  function fold(sk) {
    if (collapsed.has(sk)) collapsed.delete(sk); else collapsed.add(sk);
    prefs.set('dash.collapsed', [...collapsed]);
    render();
  }

  // ---- right-click menus ----
  const done = (r) => { if (r && !r.ok) onNote(r.msg || '操作失败', true); };
  async function newGroup(thenKey) {
    const name = await askText({ title: '新建群组', label: '群组名（可以放进不同电脑上的会话）' });
    if (!name) return;
    const r = await marks.addGroup(name);
    if (!r.ok) return done(r);
    if (thenKey) done(await marks.set(thenKey, { group: r.group.id }));
  }
  function sessionMenu(key) {
    const mk = marks.of(key), groups = marks.groups();
    const sub = groups.map((g) => ({ label: g.name, check: mk.group === g.id, onClick: () => marks.set(key, { group: mk.group === g.id ? '' : g.id }).then(done) }));
    if (sub.length) sub.push('-');
    sub.push({ label: '新建群组…', onClick: () => newGroup(key) });
    if (mk.group) sub.push({ label: '移出群组', onClick: () => marks.set(key, { group: '' }).then(done) });
    return [
      { label: '打开', onClick: () => onSelect(key) },
      '-',
      { label: mk.pinned ? '取消置顶' : '置顶', onClick: () => marks.set(key, { pinned: !mk.pinned }).then(done) },
      { label: mk.starred ? '取消星标' : '星标', onClick: () => marks.set(key, { starred: !mk.starred }).then(done) },
      { label: mk.hidden ? '取消隐藏' : '隐藏', onClick: () => marks.set(key, { hidden: !mk.hidden }).then(done) },
      '-',
      { label: '移到群组', sub },
      { label: '导出', sub: [{ label: 'Markdown（.md）', onClick: () => download(key, 'md') }, { label: '纯文本（.txt）', onClick: () => download(key, 'txt') }] },
    ];
  }
  // the whole conversation as a file (server/session-export.js), downloaded by the browser
  function download(key, fmt) {
    const [machine, id] = key.split('|');
    const a = h('a', { href: `/api/session/export?machine=${encodeURIComponent(machine)}&id=${encodeURIComponent(id)}&fmt=${fmt}`, download: '' });
    document.body.append(a); a.click(); a.remove();
  }
  function groupMenu(id, sk) {
    const g = marks.groups().find((x) => x.id === id);
    if (!g) return null;
    return [
      { label: collapsed.has(sk) ? '展开' : '折叠', onClick: () => fold(sk) },
      '-',
      { label: '重命名…', onClick: async () => { const n = await askText({ title: '重命名群组', value: g.name }); if (n && n !== g.name) done(await marks.renameGroup(id, n)); } },
      { label: '删除群组（会话回到各自电脑下）', onClick: () => marks.removeGroup(id).then(done) },
    ];
  }
  const listMenu = () => [
    { label: '新建群组…', onClick: () => newGroup() },
    '-',
    { label: '只看星标', check: onlyStarred, onClick: () => { onlyStarred = !onlyStarred; prefs.set('dash.onlyStarred', onlyStarred); render(); } },
    { label: '显示已隐藏的会话', check: showHidden, onClick: () => { showHidden = !showHidden; render(); } },
  ];
  ctx.attach(el, (e) => {
    const c = e.target.closest && e.target.closest('.card');
    if (c) return sessionMenu(c.dataset.key);
    const hd = e.target.closest && e.target.closest('.mc');
    if (hd && hd.dataset.group) return groupMenu(hd.dataset.group, hd.dataset.sec);
    if (hd) return [{ label: collapsed.has(hd.dataset.sec) ? '展开' : '折叠', onClick: () => fold(hd.dataset.sec) }, '-', ...listMenu()];
    return listMenu();
  });

  const off = marks.subscribe(render);
  return {
    tool: filter.el,
    render,
    setCurrent(c) { current = c; render(); el.scrollTop = 0; },
    destroy() { off(); },
  };
}
