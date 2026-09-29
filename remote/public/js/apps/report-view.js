// One daily report as the 工作日报 window shows it: the headline and numbers, 科研 / 个人小项目 with what got done,
// decisions and loose ends, 杂活 folded away, the rolling 「计划了没做的」 list, new plans, keywords. Sessions are links
// into 糖糖看板.
import { h } from '../util.js';
import * as dashboard from './dashboard.js';

const CAT = [['research', '科研'], ['personal', '个人小项目'], ['chore', '杂活']];
const WEEK = '日一二三四五六';
const pad = (n) => String(n).padStart(2, '0');
const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const dayName = (date) => { const d = new Date(date + 'T12:00:00'); return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`; };
const IMG = /\.(png|jpe?g|gif|webp)$/i;
const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
export const minutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}` : `${m} 分钟`);

const list = (title, items, cls) => (items && items.length
  ? h('div', { class: 'rp-list ' + (cls || '') }, h('div', { class: 'rp-lt', text: title }), h('ul', {}, ...items.map((t) => h('li', { text: t }))))
  : null);

export function render(r) {
  const byKey = new Map((r.sessions || []).map((s) => [s.key, s]));
  const sessLink = (key) => {
    const s = byKey.get(key); if (!s) return null;
    return h('button', { class: 'rp-sess', type: 'button', title: `${s.machine} · ${s.cwd || ''}\n${s.resume || ''}`, text: `${s.title || s.id.slice(0, 8)} · ${s.machine}`,
      onclick: () => dashboard.openSession(s.machine, s.id) });
  };
  const project = (p) => h('div', { class: 'rp-proj' },
    h('div', { class: 'rp-ph' }, h('b', { text: p.name }), h('span', { class: 'rp-min', text: minutes(p.minutes || 0) })),
    p.summary ? h('p', { class: 'rp-sum', text: p.summary }) : null,
    list('做成了', p.done), list('决定', p.decisions), list('没做完', p.unfinished, 'todo'),
    p.files && p.files.length ? h('details', { class: 'rp-files' }, h('summary', { text: `改动的文件（${p.files.length}）` }),
      h('ul', {}, ...p.files.map((f) => h('li', { text: `${f.path}${f.op === 'write' ? '（新写）' : ''} · ${f.machine}` })))) : null,
    h('div', { class: 'rp-sl' }, ...(p.sessions || []).map(sessLink)));

  const sections = [];
  for (const [cat, name] of CAT) {
    const ps = (r.projects || []).filter((p) => p.category === cat);
    if (!ps.length) continue;
    const mins = ps.reduce((n, p) => n + (p.minutes || 0), 0);
    if (cat === 'chore') {
      sections.push(h('details', { class: 'rp-sec rp-chore' }, h('summary', { text: `${name}（${ps.length} 件 · ${minutes(mins)}）` }),
        h('ul', {}, ...ps.map((p) => h('li', {}, h('b', { text: p.name + '：' }), p.summary || '', ' ', ...(p.sessions || []).map(sessLink))))));
    } else sections.push(h('section', { class: 'rp-sec' }, h('h3', { text: `${name} · ${minutes(mins)}` }), ...ps.map(project)));
  }

  const open = (r.open || []);
  const openBox = open.length ? h('section', { class: 'rp-sec rp-open' }, h('h3', { text: '计划了没做的' }),
    h('ul', {}, ...open.map((o) => h('li', { class: 'st-' + o.status },
      h('span', { class: 'rp-mark', text: o.status === 'done' ? '✓' : o.status === 'dropped' ? '✗' : '□' }),
      h('span', { text: o.text }), h('small', { text: ` ${o.project ? o.project + ' · ' : ''}${o.since ? o.since.slice(5).replace('-', '/') + ' 记下' : ''}${o.status === 'done' ? ' · 已完成' : o.status === 'dropped' ? ' · 不做了' : ''}` }))))) : null;
  // things made outside a tracked repository (remote/server/artifacts.js): the copy on the NAS when there is one
  const arts = r.artifacts || [];
  const artBox = arts.length ? h('section', { class: 'rp-sec rp-arts' }, h('h3', { text: `产出物（${arts.length}）` }),
    h('ul', {}, ...arts.map((a) => {
      const name = a.path.split(/[\\/]/).pop();
      const url = a.backed && a.sha ? `/api/artifact?sha=${a.sha}&name=${encodeURIComponent(name)}` : null;
      const where = a.unchecked ? '电脑离线，未检查' : !a.repo ? '不在任何仓库里' : !a.repo.remote ? '本地仓库（没有远程）' : a.repo.tracked === false ? '在仓库里但没提交' : '';
      return h('li', {},
        h('div', {}, h('code', { class: 'rp-ap', text: a.path }), h('small', { text: ` · ${a.machine}${a.size ? ' · ' + size(a.size) : ''}${where ? ' · ' + where : ''}` })),
        a.note ? h('div', { class: 'rp-an', text: a.note }) : null,
        url && IMG.test(name) ? h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { class: 'rp-thumb', src: url, alt: name, loading: 'lazy' })) : null,
        h('div', { class: 'rp-sl' }, url ? h('a', { class: 'rp-sess', href: url, target: '_blank', rel: 'noopener', text: '打开群晖上的副本' }) : null,
          ...(a.sessions || []).map(sessLink)));
    }))) : null;
  const plans = (r.plans || []).length ? h('section', { class: 'rp-sec' }, h('h3', { text: '新写的计划' }),
    h('ul', {}, ...r.plans.map((p) => h('li', {}, `「${p.title}」${p.project ? ' · ' + p.project : ''} `, sessLink(p.session))))) : null;
  const kw = (r.keywords || []).length ? h('div', { class: 'rp-kw' }, ...r.keywords.map((k) => h('span', { text: k }))) : null;

  const st = r.stats || {};
  return h('article', { class: 'rp' },
    h('div', { class: 'rp-top' },
      h('div', { class: 'rp-day', text: r.draft ? '到现在为止（草稿）' : dayName(r.date) + (r.brief ? '（补录，简略）' : '') }),
      h('div', { class: 'rp-meta', text: `${when(r.from)} – ${when(r.to)} · ${minutes(st.minutes || 0)} · ${st.sessions || 0} 个会话 · ${st.machines || 0} 台电脑` })),
    h('p', { class: 'rp-head', text: r.headline || '' }),
    ...sections, openBox, plans, artBox, kw,
    !sections.length && !openBox ? h('p', { class: 'rp-empty', text: '这段时间没有记录。' }) : null);
}
