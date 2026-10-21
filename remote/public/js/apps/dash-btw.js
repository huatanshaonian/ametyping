// /btw (a side question) in 糖糖看板: Claude Code shows its answer in an overlay of its own; here the answer arrives as
// a "btw" message (app/transcript.js pairs it with the question) and pops up under the conversation (which makes room) --
// when it is new while you watch that conversation (or came in during the last two minutes). It stays in the
// conversation as a marked reply too.
// Claude Code 2.1.29x and later show the answer only on their screen: the pet reads it from there (app/btw-panel.js),
// and while its overlay is still open, 转成后台任务 presses "f" there (the question goes to a background agent).
import { h } from '../util.js';

const FRESH = 120e3;
const FORKABLE = 15 * 60e3;                        // an answer this young may still be open in the terminal

export function createBtw({ md, fork }) {
  const q = h('div', { class: 'bq' });
  const body = h('div', { class: 'bb' });
  const forkBtn = h('button', { class: 'btn bx', type: 'button', text: '转成后台任务', hidden: true,
    title: '像终端里按 f：这个问题交给一个后台代理去做，做完的回答会出现在对话里',
    onclick: async () => { forkBtn.disabled = true; try { await fork(); } finally { forkBtn.disabled = false; } } });
  const el = h('div', { class: 'btwpop', hidden: true },
    h('div', { class: 'bt' }, h('b', { text: '顺带一问' }),
      h('span', {}, forkBtn, h('button', { class: 'btn bx', type: 'button', text: '关闭', onclick: () => close() }))),
    q, body);
  const known = new Map();                         // "machine|id" -> the last answer seen there
  const close = () => { el.hidden = true; };

  // t: when the answer came (an answer young enough may still be open in the terminal: it can be forked)
  function show(question, answer, t) {
    forkBtn.hidden = !fork || !(Date.now() - (t || 0) < FORKABLE);
    q.textContent = question ? question.replace(/^\/btw\s*/, '') : '';
    q.hidden = !q.textContent;
    body.innerHTML = md(answer || '');
    el.hidden = false;
    body.scrollTop = 0;
  }
  // a conversation's messages came in (key: the one on screen); true when an answer popped up
  function update(key, msgs) {
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role !== 'btw') i--;
    const last = i >= 0 ? msgs[i] : null;
    const sig = last ? `${last.t}|${(last.text || '').length}` : '';
    const prev = known.get(key);
    known.set(key, sig);
    if (!last || sig === prev) return false;
    if (prev === undefined && Date.now() - (last.t || 0) > FRESH) return false;   // an old answer, first time this is opened
    let j = i - 1;
    while (j >= 0 && !(msgs[j].role === 'user' && /^\/btw\b/.test(msgs[j].text || ''))) j--;
    show(j >= 0 ? msgs[j].text : '', last.text, last.t);
    return true;
  }
  return { el, update, show, close, open: () => !el.hidden };
}
