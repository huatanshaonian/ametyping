// 糖糖看板's session list: your groups first (sessions from any machine), then each computer's other sessions
// (the current computer on top). Pinned sessions lead their section, starred ones carry a ★, hidden ones are left out
// until you ask to see them. Right click (long press on a phone) a session, a group or the list for the menu.
// Marks and groups live on the server (js/marks.js) so every device shows the same list. Above it: 活动 / 全部 and
// the search box (dash-filter.js); the list element itself is `el`, the bar is returned as `tool`.
import { $, h, esc, ago, stateName, prefs, ctxLeft, CTX_LOW, plain, aiMark } from '../util.js';
import * as net from '../net.js';
import * as marks from '../marks.js';
import * as mesh from '../mesh.js';
import * as projects from './projects.js';
import * as ctx from '../ctxmenu.js';
import { askText } from '../dialog.js';
import { createFilter } from './dash-filter.js';
import { agentTag } from './dash-agents.js';

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
        const mn = mesh.nodeOfKey(key);
    const shortModel = (raw) => String(raw || '').replace(/^magpie\/(?:devin\/)?/, '').replace(/-(?:medium|high|low)$/, (m) => (m === '-high' ? '(H)' : ''));
    const modelStr = (mn && mn.node && mn.node.model) || s.model || '';
    const modelBadge = modelStr ? `<span class="mrole mdl" title="模型：${esc(modelStr)}">${esc(shortModel(modelStr))}</span>` : '';
    const wdBadge = mn && mn.node.watchdogAlert ? `<span class="mrole wd-alert" title="看门狗告警：${esc(mn.node.watchdogAlert.label)}">告警:${esc(mn.node.watchdogAlert.label)}</span>` : '';
    const roleLbl = mn ? (mn.node.role === 'master' ? 'Master' : mn.node.role === 'verifier' ? 'Verifier' : mn.node.role === 'peer' || mn.node.role === 'cowork' ? 'Peer' : 'Worker') : '';
    const meshBadge = mn
      ? `<span class="mrole ${esc(mn.node.role)}" title="所属项目：${esc(mn.project.name)}">${roleLbl}</span>` +
        modelBadge +
        (mn.node.archived ? '<span class="mrole arch" title="已归档退役，保留拓扑痕迹">已归档</span>' : '') +
        (!mn.node.archived && mn.node.reviewStatus === 'waiting_review' ? '<span class="mrole rev" title="已达成阶段目标，等待检视">待检视</span>' : '') +
        wdBadge
      : modelBadge;
    const nmHtml = (mk.starred ? '<span class="star">★</span>' : '') + badge + esc(s.label) + meshBadge + (s.bg ? '<span class="bgb" title="Claude Code 的后台会话：不依赖终端窗口，关掉窗口也继续运行">后台</span>' : '') + (mk.pinned ? '<span class="pin">置顶</span>' : '') + agentHtml(s) +
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
    const pm = e.target.closest('.pm-jump');
    if (pm) { e.stopPropagation(); projects.open(pm.dataset.proj); return; }
    const cm = e.target.closest('.cm');
    if (cm) {                                                         // ⋯: the session's menu, under the button
      const r = cm.getBoundingClientRect();
      ctx.show(r.right, r.bottom, sessionMenu(cm.closest('.card').dataset.key), { touch: true });
      return;
    }
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
    const mn = mesh.nodeOfKey(key);
    const wdBadge = mn && mn.node.watchdogAlert ? `<span class="mrole wd-alert" title="看门狗告警：${esc(mn.node.watchdogAlert.label)}">⚠️ ${esc(mn.node.watchdogAlert.label)}</span>` : '';
    return [
      { label: '打开', onClick: () => onSelect(key) },
      ...(mn ? [{ label: `打开所属项目拓扑（${mn.project.name}）`, onClick: () => projects.open(mn.project.id) }] : []),
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
    const proj = mesh.byGroup(id);
    return [
      { label: collapsed.has(sk) ? '展开' : '折叠', onClick: () => fold(sk) },
      ...(proj ? [{ label: `在「项目管理」中打开拓扑（${proj.name}）`, onClick: () => projects.open(proj.id) }] : []),
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

  const offMarks = marks.subscribe(render);
  const offMesh = mesh.subscribe(render);
  return {
    tool: filter.el,
    render,
    setCurrent(c) { current = c; render(); el.scrollTop = 0; },
    destroy() { offMarks(); offMesh(); },
  };
}
