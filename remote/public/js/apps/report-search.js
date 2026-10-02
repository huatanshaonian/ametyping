// 工作日报 window: search results (reports, artifacts, notes, mail, conversations) and 问一问 answers with their sources.
// Reports open in the window, conversations in 糖糖看板, notes in 记事本, mail in 邮件, artifacts' NAS copies in a new tab.
import { h } from '../util.js';
import * as dashboard from './dashboard.js';
import * as notepad from './notepad.js';
import * as mailApp from './mail.js';
import { dayName } from './report-view.js';

const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const copyUrl = (a) => (a.sha ? `/api/artifact?sha=${a.sha}&name=${encodeURIComponent(a.path.split(/[\\/]/).pop())}` : null);

function artifactItem(a, extra) {
  const url = copyUrl(a);
  return h('li', {}, h('code', { class: 'rp-ap', text: a.path }), h('small', { text: ` · ${a.machine}${a.last ? ' · ' + a.last.slice(5).replace('-', '/') : ''}` }),
    a.note ? h('div', { class: 'rp-an', text: a.note }) : null, extra || null,
    url ? h('div', { class: 'rp-sl' }, h('a', { class: 'rp-sess', href: url, target: '_blank', rel: 'noopener', text: '打开群晖上的副本' })) : null);
}

export function renderResults(q, r, { openReport }) {
  const notes = r.notes || [], mail = r.mail || [];
  const n = r.reports.length + r.artifacts.length + r.sessions.length + notes.length + mail.length;
  const box = h('article', { class: 'rp' }, h('div', { class: 'rp-top' }, h('div', { class: 'rp-day', text: `搜索「${q}」` }), h('div', { class: 'rp-meta', text: n ? `${n} 项` : '' })));
  if (!n) { box.append(h('p', { class: 'rp-empty', text: '没有找到。中文词之间用空格分开，每个词都要出现；也可以试试「问一问」。' })); return box; }
  if (r.reports.length) box.append(h('section', { class: 'rp-sec' }, h('h3', { text: `日报（${r.reports.length}）` }),
    h('ul', { class: 'rs-list' }, ...r.reports.map((x) => h('li', {},
      h('button', { class: 'rs-link', type: 'button', text: dayName(x.date) + (x.brief ? '（补录）' : ''), onclick: () => openReport(x.date) }),
      h('div', { class: 'rs-snip', text: x.snippet }))))));
  if (r.artifacts.length) box.append(h('section', { class: 'rp-sec rp-arts' }, h('h3', { text: `产出物（${r.artifacts.length}）` }),
    h('ul', {}, ...r.artifacts.map((a) => artifactItem(a)))));
  if (notes.length) box.append(h('section', { class: 'rp-sec' }, h('h3', { text: `笔记（${notes.length}）` }),
    h('ul', { class: 'rs-list' }, ...notes.map((x) => h('li', {},
      h('button', { class: 'rs-link', type: 'button', text: x.title, onclick: () => notepad.open(x.id) }), h('small', { text: ' ' + when(x.updated) }),
      h('div', { class: 'rs-snip', text: x.snippet }))))));
  if (mail.length) box.append(h('section', { class: 'rp-sec' }, h('h3', { text: `邮件（${mail.length}）` }),
    h('ul', { class: 'rs-list' }, ...mail.map((x) => h('li', {},
      h('button', { class: 'rs-link', type: 'button', text: x.subject, onclick: () => mailApp.open(x.key) }),
      h('small', { text: ` ${(x.from && (x.from.name || x.from.address)) || ''} · ${when(x.date)}` }),
      h('div', { class: 'rs-snip', text: x.snippet }))))));
  if (r.sessions.length) box.append(h('section', { class: 'rp-sec' }, h('h3', { text: `对话（${r.sessions.length} 个会话）` }),
    h('ul', { class: 'rs-list' }, ...r.sessions.map((s) => h('li', {},
      h('button', { class: 'rs-link', type: 'button', text: `${s.title} · ${s.machine}`, onclick: () => dashboard.openSession(s.machine, s.id) }),
      h('small', { text: ' ' + when(s.last) }),
      ...s.hits.map((x) => h('div', { class: 'rs-snip', text: `${when(x.t)} ${x.role === 'user' ? '我' : x.role === 'assistant' ? '助手' : '工具'}：${x.snippet}` })))))));
  return box;
}

export function renderAnswer(job, { openReport }) {
  const box = h('article', { class: 'rp' }, h('div', { class: 'rp-top' }, h('div', { class: 'rp-day', text: '问一问' })), h('p', { class: 'rp-head', text: job.q }));
  if (job.running) {
    box.append(h('p', { class: 'rp-empty', text: job.terms && job.terms.length ? `在找：${job.terms.join('、')}…（再等一会儿）` : '正在想该搜什么…（大约半分钟）' }));
    return box;
  }
  if (job.error) { box.append(h('p', { class: 'rp-empty bad', text: '没能回答：' + job.error })); return box; }
  box.append(h('div', { class: 'qa-answer', text: job.answer }));
  if (job.sources.length) box.append(h('section', { class: 'rp-sec' }, h('h3', { text: '出处' }),
    h('ul', { class: 'rs-list' }, ...job.sources.map((s) => s.kind === 'report'
      ? h('li', {}, h('b', { text: `[${s.ref}] ` }), h('button', { class: 'rs-link', type: 'button', text: dayName(s.date) + ' 的日报', onclick: () => openReport(s.date) }), h('small', { text: ' ' + (s.headline || '') }))
      : s.kind === 'mail'
        ? h('li', {}, h('b', { text: `[${s.ref}] ` }), h('button', { class: 'rs-link', type: 'button', text: `邮件「${s.subject}」`, onclick: () => mailApp.open(s.key) }), h('small', { text: ' ' + (s.from || '') }))
      : s.kind === 'note'
        ? h('li', {}, h('b', { text: `[${s.ref}] ` }), h('button', { class: 'rs-link', type: 'button', text: `笔记「${s.title}」`, onclick: () => notepad.open(s.id) }))
      : s.kind === 'session'
        ? h('li', {}, h('b', { text: `[${s.ref}] ` }), h('button', { class: 'rs-link', type: 'button', text: `会话「${s.title}」 · ${s.machine}`, onclick: () => dashboard.openSession(s.machine, s.id) }))
        : artifactItem({ ...s, last: '' }, h('b', { text: ` [${s.ref}]` }))))));
  if (job.terms && job.terms.length) box.append(h('p', { class: 'rp-meta', text: `搜过：${job.terms.join('、')}` }));
  return box;
}
