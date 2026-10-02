// /btw (a side question) in 糖糖看板: Claude Code shows its answer in an overlay of its own; here the answer arrives as
// a "btw" message (app/transcript.js pairs it with the question) and pops up over the conversation the same way --
// when it is new while you watch that conversation (or came in during the last two minutes). It stays in the
// conversation as a marked reply too.
import { h } from '../util.js';

const FRESH = 120e3;

export function createBtw({ md }) {
  const q = h('div', { class: 'bq' });
  const body = h('div', { class: 'bb' });
  const el = h('div', { class: 'btwpop', hidden: true },
    h('div', { class: 'bt' }, h('b', { text: '顺带一问' }), h('button', { class: 'btn bx', type: 'button', text: '关闭', onclick: () => close() })),
    q, body);
  const known = new Map();                         // "machine|id" -> the last answer seen there
  const close = () => { el.hidden = true; };

  function show(question, answer) {
    q.textContent = question ? question.replace(/^\/btw\s*/, '') : '';
    q.hidden = !q.textContent;
    body.innerHTML = md(answer || '');
    el.hidden = false;
    body.scrollTop = 0;
  }
  // a conversation's messages came in (key: the one on screen)
  function update(key, msgs) {
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role !== 'btw') i--;
    const last = i >= 0 ? msgs[i] : null;
    const sig = last ? `${last.t}|${(last.text || '').length}` : '';
    const prev = known.get(key);
    known.set(key, sig);
    if (!last || sig === prev) return;
    if (prev === undefined && Date.now() - (last.t || 0) > FRESH) return;     // an old answer, first time this is opened
    let j = i - 1;
    while (j >= 0 && !(msgs[j].role === 'user' && /^\/btw\b/.test(msgs[j].text || ''))) j--;
    show(j >= 0 ? msgs[j].text : '', last.text);
  }
  return { el, update, show, close, open: () => !el.hidden };
}
