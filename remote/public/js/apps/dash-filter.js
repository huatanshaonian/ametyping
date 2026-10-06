// The top of 糖糖看板's session list: 活动 / 全部, and a search box.
//   活动: sessions still running (any state but history), active in the last 24 hours, or pinned -- not the terminal
//         a background session was moved from (its old history is under 全部)
//   全部: everything stored
//   search: over everything -- names, projects, machines and the last line at once, then the conversations' full text
//   on the server (/api/search?scope=sessions); a session found by its text shows the matching passage
import { h, prefs } from '../util.js';

const RECENT = 24 * 3600e3;
const DEBOUNCE = 300;

export function createFilter({ onChange }) {
  let view = prefs.get('dash.view', 'active') === 'all' ? 'all' : 'active';
  let q = '', hits = new Map(), pending = false, seq = 0, timer = null;

  const seg = (v, text) => h('button', { class: 'seg', type: 'button', dataset: { v }, text });
  const segs = h('span', { class: 'segs' }, seg('active', '活动'), seg('all', '全部'));
  const input = h('input', { class: 'lsearch', type: 'search', placeholder: '搜索对话', maxlength: 100, spellcheck: 'false' });
  const el = h('div', { class: 'ltool' }, segs, input);

  const mark = () => { for (const b of segs.children) b.classList.toggle('on', b.dataset.v === view && !q); };
  segs.addEventListener('click', (e) => {
    const b = e.target.closest('.seg'); if (!b) return;
    setView(b.dataset.v);
  });
  function setView(v) {
    view = v; prefs.set('dash.view', v);
    if (q) { input.value = ''; query(''); return; }                   // a view button also ends a search
    mark(); onChange();
  }
  function query(text) {
    q = text.trim().slice(0, 100);
    hits = new Map(); clearTimeout(timer);
    const my = ++seq;
    pending = !!q;
    mark(); onChange();
    if (!q) return;
    timer = setTimeout(async () => {
      let found = [];
      try { const r = await fetch('/api/search?scope=sessions&q=' + encodeURIComponent(q)); if (r.ok) found = (await r.json()).sessions || []; } catch {}
      if (my !== seq) return;                                          // typed on meanwhile
      for (const s of found) hits.set(s.machine + '|' + s.id, (s.hits[0] && s.hits[0].snippet) || '');
      pending = false;
      onChange();
    }, DEBOUNCE);
  }
  input.addEventListener('input', () => query(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; query(''); } });
  mark();

  const terms = () => q.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    el,
    // does this session belong in the list now? (text: what its card shows besides the name)
    keep({ s, m, key, mk }, text) {
      if (q) {
        const all = `${s.label} ${s.project || ''} ${m.machine} ${text}`.toLowerCase();
        return terms().every((t) => all.includes(t)) || hits.has(key);
      }
      // (parked: the window of a background session -- its history is under 全部, it is not something going on)
      return view === 'all' || !!mk.pinned || s.state !== 'history' || (!s.parked && Date.now() - (s.last || 0) < RECENT);
    },
    hit: (key) => (q ? hits.get(key) : undefined),     // the passage the server found, while searching
    searching: () => !!q,
    pending: () => pending,
    query: () => q,
    view: () => view,
    setView,
  };
}
