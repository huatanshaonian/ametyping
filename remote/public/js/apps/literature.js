// 文献: the literature window (server/literature). Tabs:
//   今日    the day's picks (new papers to 收下 / 跳过, reviews of the user's own papers as recall questions)
//   文献库  the Zotero library by collection, a paper's card, annotations, and the way into 深读
//   知识库  the model's suggested changes waiting for 接受, topic pages, search over cards and topics
//   画像    research summary, the questions being worked on, what to follow
//   产出    what reading turned into lately
// The bar shows Zotero's state and asks for write access when it is missing (granted once in Zotero's own window).
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import { get, post, onLit } from './lit-api.js';
import * as feedTab from './lit-feed.js';
import * as libTab from './lit-library.js';
import * as kbTab from './lit-kb.js';
import * as profTab from './lit-profile.js';
import * as reviewTab from './lit-review.js';
import { openReader } from './lit-reader.js';
import { open as openControl } from './control.js';

const ICON = icon('help_book_big', true);
let app = null;

export function open(tab) {
  if (app) { wm.open({ id: 'literature' }); if (tab) app.show(tab); return; }
  app = mount(tab || 'feed');
  wm.open({ id: 'literature', title: '文献', icon: ICON, content: app.root, width: 980, height: 640, onClose: () => { app.destroy(); app = null; } });
}

function mount(first) {
  const TABS = [['feed', '今日', feedTab], ['library', '文献库', libTab], ['kb', '知识库', kbTab], ['profile', '画像', profTab], ['review', '回顾', reviewTab], ['stats', '产出', profTab]];
  const status = h('span', { class: 'lit-st' });
  const authBtn = h('button', { class: 'btn go', type: 'button', text: '授权写入 Zotero', hidden: true, title: '收下文献、写回卡片需要 Zotero 的写入授权：点了之后到 Zotero 的网页桌面里点「始终允许」' });
  const authNote = h('span', { class: 'lit-auth', hidden: true });
  const setBtn = h('button', { class: 'lit-tab', type: 'button', text: '设置', title: '控制面板 › 文献：文献来源的 key、联系邮箱、每日推送', onclick: () => openControl('literature') });
  const tabBtns = TABS.map(([id, label]) => h('button', { class: 'lit-tab', type: 'button', text: label, dataset: { tab: id }, onclick: () => show(id) }));
  const body = h('div', { class: 'lit-body' });
  const root = h('div', { class: 'lit' }, h('div', { class: 'lit-bar' }, ...tabBtns, h('span', { class: 'lit-sp' }), status, authNote, authBtn, setBtn), body);
  const mounted = new Map();
  let cur = null;
  const ctx = {
    openReader, show,
    // a card by its citation key ([[citekey]] links): the library, that paper
    openCitekey: (k) => { show('library'); mounted.get('library').select({ citekey: k }); },
    openItem: (key) => { show('library'); mounted.get('library').select({ key }); },
    refreshStatus,
  };

  function show(id) {
    if (!TABS.some((t) => t[0] === id)) id = 'feed';
    cur = id;
    for (const b of tabBtns) b.classList.toggle('on', b.dataset.tab === id);
    if (!mounted.has(id)) {
      const [, , mod] = TABS.find((t) => t[0] === id);
      const el = h('div', { class: 'lit-pane' });
      mounted.set(id, { el, ...(id === 'stats' ? mod.mountStats(el, ctx) : mod.mount(el, ctx)) });
    }
    for (const [k, v] of mounted) v.el.hidden = k !== id;
    if (!body.contains(mounted.get(id).el)) body.append(mounted.get(id).el);
    const m = mounted.get(id); if (m.refresh) m.refresh();
  }

  async function refreshStatus() {
    const s = await get('/api/lit');
    if (!s) { status.textContent = '文献模块没有开启（config.json 里加 "literature"）'; status.classList.add('bad'); return; }
    const z = s.zotero;
    status.classList.toggle('bad', !!z.error);
    status.textContent = z.error ? `Zotero：${z.error}` : `Zotero ${z.items} 篇 · ${z.annotations} 条批注${s.proposals ? ` · ${s.proposals} 条待确认的修改` : ''}`;
    // the authorization: waiting for the click in Zotero's window, or why it did not work
    authNote.hidden = !z.authorizing && !z.authError;
    authNote.classList.toggle('bad', !z.authorizing && !!z.authError);
    authNote.textContent = z.authorizing ? '等你在 Zotero 的网页桌面（群晖的 3921 端口）里点「始终允许」…' : z.authError ? '授权没成：' + z.authError : '';
    authBtn.hidden = !!z.canWrite || !!z.authorizing;
    if (z.authorizing) { clearTimeout(authT); authT = setTimeout(refreshStatus, 3000); }
    for (const b of tabBtns) if (b.dataset.tab === 'kb') b.textContent = s.proposals ? `知识库（${s.proposals}）` : '知识库';
    for (const b of tabBtns) if (b.dataset.tab === 'review') b.textContent = s.reviews ? `回顾（${s.reviews}）` : '回顾';
  }
  let authT = null;
  authBtn.addEventListener('click', async () => {
    await post('/api/lit/zotero/authorize', {});
    setTimeout(refreshStatus, 1200);
  });

  const off = onLit((what) => {
    if (/^(zotero|library|proposals|kb|review)$/.test(what)) refreshStatus();
    for (const v of mounted.values()) if (v.onLit) v.onLit(what);
  });
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 700));
  ro.observe(root);
  refreshStatus();
  show(first);
  return { root, show, destroy() { off(); ro.disconnect(); clearTimeout(authT); for (const v of mounted.values()) if (v.destroy) v.destroy(); } };
}
