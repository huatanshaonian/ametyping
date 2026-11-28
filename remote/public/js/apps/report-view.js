// One daily report as the 工作日报 window shows it: the headline and numbers, 科研 / 个人小项目 with what got done,
// decisions and loose ends, 杂活 folded away, the rolling 「计划了没做的」 list, new plans, keywords. Sessions are links
// into 糖糖看板.
import { h } from '../util.js';
import * as dashboard from './dashboard.js';
import * as todos from '../todos.js';
import * as mesh from '../mesh.js';
import { openPath } from './explorer.js';
import { renderCiteNodes } from './cite-link.js';

const CAT = [['research', '科研'], ['personal', '个人小项目'], ['chore', '杂活']];
const WEEK = '日一二三四五六';
const pad = (n) => String(n).padStart(2, '0');
const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const dayName = (date) => { const d = new Date(date + 'T12:00:00'); return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`; };
const IMG = /\.(png|jpe?g|gif|webp)$/i;
const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
export const minutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}` : `${m} 分钟`);

const list = (title, items, cls) => (items && items.length
  ? h('div', { class: 'rp-list ' + (cls || '') }, h('div', { class: 'rp-lt', text: title }), h('ul', {}, ...items.map((t) => h('li', {}, ...renderCiteNodes(t)))))
  : null);

function findMeshProject(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  const all = mesh.list();
  return all.find((p) => String(p.name || '').trim().toLowerCase() === q)
    || all.find((p) => { const n = String(p.name || '').trim().toLowerCase(); return n && (q.includes(n) || n.includes(q)); })
    || null;
}

function projectHeading(name) {
  const mp = findMeshProject(name);
  if (!mp) return [h('b', { text: name })];
  return [
    h('b', { text: name }),
    h('button', {
      class: 'rs-link',
      type: 'button',
      style: 'margin-left:6px;font-size:11px',
      title: `在「项目管理」中打开 ${mp.name}`,
      text: '↗ 项目',
      onclick: () => {
        try { location.hash = '#proj=' + encodeURIComponent(mp.id) + '&tab=research'; } catch {}
        import('./projects.js').then((m) => m.open(mp.id, { tab: 'research' })).catch(() => {});
      },
    }),
  ];
}

// ISO week number of a date (weeks start on Monday)
export function weekNo(date) {
  const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / 86400e3 - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
const md = (d) => d.slice(5).replace('-', '/');

// the coding agents (harnesses): their new versions with the major changes first, what each computer updated, what is
// still behind (remote/server/fleet: the daily harness check before the report)
const HN = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', agy: 'Antigravity' };
const vs = (v) => (String(v || '').match(/\d+\.\d+\.\d+/) || [v || '?'])[0];
function harnessBox(x) {
  if (!x) return null;
  const rels = x.releases || [], ups = x.updates || [], ins = x.installs || [], behind = x.behind || [];
  const rel = rels.map((r) => h('li', { class: 'rp-hx' + ((r.major || []).length ? ' rp-hx-major' : '') },
    h('div', {}, h('b', { text: `${r.label || HN[r.id] || r.id} ${r.to}` }), h('small', { text: r.from ? `（上次 ${r.from}）` : '' }), ' ',
      r.link ? h('a', { href: r.link, target: '_blank', rel: 'noopener', text: '更新日志' }) : null),
    (r.major || []).length ? h('ul', { class: 'rp-hx-m' }, ...r.major.map((t) => h('li', {}, h('span', { class: 'rp-mark', text: '★' }), h('span', { text: t })))) : null,
    (r.highlights || []).length ? h('ul', {}, ...r.highlights.map((t) => h('li', { text: t }))) : null,
    r.other ? h('div', { class: 'rp-hx-o', text: r.other }) : null,
    r.noNotes ? h('div', { class: 'rp-hx-o', text: '没有可读的更新日志，详情看链接' }) : null));
  const byMachine = new Map();
  for (const u of [...ups.map((u) => ({ ...u, kind: 'update' })), ...ins.map((u) => ({ ...u, kind: 'install' }))]) {
    if (!byMachine.has(u.machine)) byMachine.set(u.machine, []);
    byMachine.get(u.machine).push(u);
  }
  const done = [...byMachine].map(([m, list]) => h('li', {}, h('b', { text: m + '：' }), h('span', { text: list.map((u) =>
    u.skipped ? `${HN[u.id] || u.id} 有会话开着，没更新`
      : !u.ok ? `${HN[u.id] || u.id} ${u.kind === 'install' ? '安装' : '更新'}失败（${u.msg || ''}）`
      : u.kind === 'install' ? `装了 ${HN[u.id] || u.id} ${vs(u.after)}` : `${HN[u.id] || u.id} ${vs(u.before)} → ${vs(u.after)}`).join('；') })));
  const left = behind.length ? h('div', { class: 'rp-hx-o', text: '还落后：' + behind.map((b) => `${b.machine} 的 ${HN[b.id] || b.id} ${vs(b.version)}（最新 ${b.latest}）`).join('；') }) : null;
  if (!rel.length && !done.length) return null;
  const major = rels.some((r) => (r.major || []).length);
  return h('section', { class: 'rp-sec rp-harness' + (major ? ' rp-hx-has-major' : '') },
    h('h3', { text: major ? '编程工具更新（有重大变化）' : '编程工具更新' }),
    rel.length ? h('ul', { class: 'rp-hx-l' }, ...rel) : null,
    done.length ? h('div', { class: 'rp-lt', text: '各电脑' }) : null, done.length ? h('ul', {}, ...done) : null, left);
}

// the weekly report (remote/server/summary/weekly.js); openReport(date) opens one of its days
export function renderWeek(w, { openReport }) {
  const s = w.stats || {}, c = s.byCat || {};
  const sec = (title, ...kids) => h('section', { class: 'rp-sec' }, h('h3', { text: title }), ...kids);
  const cats = CAT.filter(([k]) => k !== 'chore').map(([k, name]) => {
    const ps = (w.projects || []).filter((p) => p.category === k);
    return ps.length ? sec(`${name} · ${minutes(c[k] || 0)}`, ...ps.map((p) => h('div', { class: 'rp-proj' },
      h('div', { class: 'rp-ph' }, ...projectHeading(p.name)), p.summary ? h('p', { class: 'rp-sum' }, ...renderCiteNodes(p.summary)) : null, list('进展', p.progress)))) : null;
  });
  return h('article', { class: 'rp' },
    h('div', { class: 'rp-top' },
      h('div', { class: 'rp-day', text: `第 ${weekNo(w.start)} 周周报 · ${md(w.start)} – ${md(w.end)}` }),
      h('div', { class: 'rp-meta', text: `${minutes(s.minutes || 0)} · 工作 ${s.days || 0} 天 · ${s.sessions || 0} 个会话 · 杂活 ${s.chores || 0} 件${s.artifacts ? ' · 产出物 ' + s.artifacts + ' 个' : ''}` })),
    h('p', { class: 'rp-head' }, ...renderCiteNodes(w.headline || '')),
    (w.highlights || []).length ? sec('这周最值得记住的', h('ul', {}, ...w.highlights.map((x) => h('li', {}, ...renderCiteNodes(x))))) : null,
    ...cats,
    (w.todosDone || []).length ? sec('这周完成的重要计划', h('ul', {}, ...w.todosDone.map((t) => h('li', { text: `✓ ${t.text}（${md(t.date)}${t.evidence ? '，' + t.evidence : ''}）` })))) : null,
    (w.open || []).length ? sec('还没完成的重要计划', h('ul', {}, ...w.open.map((o) => h('li', { text: `${o.text}${o.project ? '（' + o.project + '）' : ''}${o.due ? ' · ' + md(o.due) + ' 截止' : ''}` })))) : null,
    (w.artifacts || []).length ? sec(`这周的产出物（${w.artifacts.length}）`, h('ul', {}, ...w.artifacts.map((a) => h('li', {},
      h('button', { class: 'rs-link rp-ap', type: 'button', title: `在 ${a.machine} 上打开`, text: a.path, onclick: () => openPath(a.machine, a.path) }), h('small', { text: ` · ${a.machine} · ${md(a.date)}` }), a.note ? h('div', { class: 'rp-an', text: a.note }) : null)))) : null,
    sec('每天', h('ul', { class: 'rs-list' }, ...(w.days || []).map((d) => h('li', {},
      h('button', { class: 'rs-link', type: 'button', text: dayName(d.date) + (d.brief ? '（补录）' : ''), onclick: () => openReport(d.date) }),
      h('small', { text: ` ${minutes(d.minutes || 0)} · ${d.headline}` }))))));
}

export function render(r) {
  const byKey = new Map((r.sessions || []).map((s) => [s.key, s]));
  const sessLink = (key) => {
    const s = byKey.get(key); if (!s) return null;
    // hover: where it ran, how to resume it, and its own note of the day (对话摘要)
    const n = s.note, st = n && { done: '已完成', ongoing: '进行中', paused: '搁置' }[n.status];
    const note = n && n.did ? `\n\n${st ? '【' + st + '】' : ''}${n.did}${n.open.length ? '\n没做：' + n.open.join('；') : ''}${n.ideas.length ? '\n要点：' + n.ideas.join('；') : ''}` : '';
    return h('button', { class: 'rp-sess', type: 'button', title: `${s.machine} · ${s.cwd || ''}\n${s.resume || ''}${note}`, text: `${s.title || s.id.slice(0, 8)} · ${s.machine}`,
      onclick: () => dashboard.openSession(s.machine, s.id) });
  };
  const project = (p) => h('div', { class: 'rp-proj' },
    h('div', { class: 'rp-ph' }, ...projectHeading(p.name), h('span', { class: 'rp-min', text: minutes(p.minutes || 0) })),
    p.summary ? h('p', { class: 'rp-sum' }, ...renderCiteNodes(p.summary)) : null,
    list('做成了', p.done), list('决定', p.decisions), list('没做完', p.unfinished, 'todo'),
    p.files && p.files.length ? h('details', { class: 'rp-files' }, h('summary', { text: `改动的文件（${p.files.length}）` }),
      h('ul', {}, ...p.files.map((f) => h('li', {},
        h('button', { class: 'rs-link', type: 'button', title: `在 ${f.machine} 上打开`, text: f.path, onclick: () => openPath(f.machine, f.path) }),
        h('small', { text: `${f.op === 'write' ? '（新写）' : ''} · ${f.machine}` }))))) : null,
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

  // the day's loose ends: ☆ makes one an important item (js/todos.js), checked by every report after
  // (reports written before 重要计划 existed also carry done / dropped items from their rolling list)
  const open = (r.open || []);
  const star = (o) => {
    const b = h('button', { class: 'rp-star', type: 'button', title: '设为重要：加进「重要计划」，之后每天的日报会检查它做完没有', text: todos.starred(r.date, o.text) ? '★' : '☆' });
    b.addEventListener('click', async () => {
      if (b.textContent === '★') return;
      b.disabled = true;
      const res = await todos.add(o.text, { project: o.project, from: { date: r.date } });
      b.disabled = false; if (res.ok) b.textContent = '★';
    });
    return b;
  };
  const openBox = open.length ? h('section', { class: 'rp-sec rp-open' }, h('h3', { text: '没做完的' }),
    h('ul', {}, ...open.map((o) => h('li', { class: 'st-' + (o.status || 'open') },
      o.status && o.status !== 'open' ? h('span', { class: 'rp-mark', text: o.status === 'done' ? '✓' : '✗' }) : star(o),
      h('span', { text: o.text }), h('small', { text: ` ${o.project || ''}${o.status === 'done' ? ' · 已完成' : o.status === 'dropped' ? ' · 不做了' : ''}` }))))) : null;
  const doneBox = (r.todosDone || []).length ? h('section', { class: 'rp-sec rp-open' }, h('h3', { text: '重要计划：这天做完了' }),
    h('ul', {}, ...r.todosDone.map((t) => h('li', { class: 'st-done-ok' }, h('span', { class: 'rp-mark', text: '✓' }), h('span', { text: t.text }),
      h('small', { text: `${t.project ? ' ' + t.project : ''}${t.evidence ? ' · ' + t.evidence : ''}` }))))) : null;
  // things made outside a tracked repository (remote/server/artifacts.js): the copy on the NAS when there is one
  const arts = r.artifacts || [];
  const artBox = arts.length ? h('section', { class: 'rp-sec rp-arts' }, h('h3', { text: `产出物（${arts.length}）` }),
    h('ul', {}, ...arts.map((a) => {
      const name = a.path.split(/[\\/]/).pop();
      const url = a.backed && a.sha ? `/api/artifact?sha=${a.sha}&name=${encodeURIComponent(name)}` : null;
      const where = a.unchecked ? '电脑离线，未检查' : !a.repo ? '不在任何仓库里' : !a.repo.remote ? '本地仓库（没有远程）' : a.repo.tracked === false ? '在仓库里但没提交' : '';
      return h('li', {},
        h('div', {}, h('button', { class: 'rs-link rp-ap', type: 'button', title: `在 ${a.machine} 上打开`, text: a.path, onclick: () => openPath(a.machine, a.path) }), h('small', { text: ` · ${a.machine}${a.size ? ' · ' + size(a.size) : ''}${where ? ' · ' + where : ''}` })),
        a.note ? h('div', { class: 'rp-an', text: a.note }) : null,
        url && IMG.test(name) ? h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { class: 'rp-thumb', src: url, alt: name, loading: 'lazy' })) : null,
        h('div', { class: 'rp-sl' }, url ? h('a', { class: 'rp-sess', href: url, target: '_blank', rel: 'noopener', text: '打开群晖上的副本' }) : null,
          ...(a.sessions || []).map(sessLink)));
    }))) : null;
  const plans = (r.plans || []).length ? h('section', { class: 'rp-sec' }, h('h3', { text: '新写的计划' }),
    h('ul', {}, ...r.plans.map((p) => h('li', {}, `「${p.title}」${p.project ? ' · ' + p.project : ''} `, sessLink(p.session))))) : null;
  const kw = (r.keywords || []).length ? h('div', { class: 'rp-kw' }, ...r.keywords.map((k) => h('span', { text: k }))) : null;

  const st = r.stats || {};
  const hxBox = harnessBox(r.harness), hxMajor = !!(r.harness && (r.harness.releases || []).some((x) => (x.major || []).length));
  return h('article', { class: 'rp' },
    h('div', { class: 'rp-top' },
      h('div', { class: 'rp-day', text: r.draft ? '到现在为止（草稿）' : dayName(r.date) + (r.brief ? '（补录，简略）' : '') }),
      h('div', { class: 'rp-meta', text: `${when(r.from)} – ${when(r.to)} · ${minutes(st.minutes || 0)} · ${st.sessions || 0} 个会话 · ${st.machines || 0} 台电脑` })),
    h('p', { class: 'rp-head' }, ...renderCiteNodes(r.headline || '')),
    // a harness with major changes is shown right under the headline, otherwise after the day's work
    hxMajor ? hxBox : null,
    ...sections, doneBox, openBox, plans, artBox, hxMajor ? null : hxBox, kw,
    !sections.length && !openBox ? h('p', { class: 'rp-empty', text: '这段时间没有记录。' }) : null);
}
