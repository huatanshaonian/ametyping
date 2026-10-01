// 对话摘要: one conversation's short daily notes from the daily reports (what it did, what was planned but not done,
// where it stands, key points / ideas), newest day first. Shown above the conversation when the 摘要 button is on.
import { h } from '../util.js';
import { dayName, minutes } from './report-view.js';

const STATUS = { done: ['done', '已完成'], ongoing: ['ongoing', '进行中'], paused: ['paused', '搁置'] };
const SHOW = 3;                                   // days shown before 「更早的」

export function createNotes() {
  const el = h('div', { class: 'snotes', hidden: true });
  let key = null, seq = 0, all = false;

  async function load(machine, id) {
    key = machine + '|' + id; all = false;
    const my = ++seq;
    el.replaceChildren(h('div', { class: 'sn-empty', text: '读取摘要…' }));
    let items = [];
    try { const r = await fetch(`/api/report/session?machine=${encodeURIComponent(machine)}&id=${encodeURIComponent(id)}`); if (r.ok) items = (await r.json()).items || []; } catch {}
    if (my !== seq) return;                       // another conversation was picked meanwhile
    render(items);
  }
  function render(items) {
    const withNote = items.filter((x) => x.note);
    if (!withNote.length) {
      el.replaceChildren(h('div', { class: 'sn-empty', text: items.length
        ? '这个对话出现在旧日报里，但那时还没有逐个对话的摘要。'
        : '还没有这个对话的摘要：每天早上写日报时生成，也可以在工作日报里点「总结到现在」。' }));
      return;
    }
    const shown = all ? withNote : withNote.slice(0, SHOW);
    el.replaceChildren(...shown.map(day));
    if (withNote.length > shown.length) {
      el.append(h('button', { class: 'sn-more', type: 'button', text: `更早的 ${withNote.length - shown.length} 天`, onclick: () => { all = true; render(items); } }));
    }
  }
  function day(x) {
    const n = x.note, [cls, label] = STATUS[n.status] || ['', ''];
    const list = (title, arr) => (arr && arr.length ? h('div', { class: 'sn-row' }, h('b', { text: title }), h('ul', {}, ...arr.map((t) => h('li', { text: t })))) : null);
    const when = x.draft ? '今天（到现在）' : dayName(x.date);
    return h('div', { class: 'sn-day' },
      h('div', { class: 'sn-head' },
        label ? h('span', { class: 'sn-st ' + cls, text: label }) : null,
        x.draft ? h('span', { text: when }) : h('a', { href: '#', text: when, title: '打开这天的日报', onclick: (e) => { e.preventDefault(); import('./reports.js').then((m) => m.open(x.date)); } }),
        x.minutes ? h('span', { class: 'sn-min', text: minutes(x.minutes) }) : null),
      n.did ? h('div', { class: 'sn-did', text: n.did }) : null,
      list('没做', n.open), list('要点', n.ideas));
  }

  return {
    el,
    // the panel on / off, for the conversation picked (null: none)
    // (read again whenever it is opened: a new report may have come in meanwhile)
    show(on, sel) {
      const was = el.hidden;
      el.hidden = !on || !sel;
      if (el.hidden) return;
      const [machine, id] = sel.split('|');
      if (sel !== key || was) load(machine, id);
    },
  };
}
