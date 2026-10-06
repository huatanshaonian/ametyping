// Claude asking you something (its AskUserQuestion tool), as a card in the dashboard: the questions with their
// options -- one answer or several, or your own words -- instead of 允许 / 拒绝. The questions come with the
// permission request (the tool's input, as its hook sees it), so nothing is read off the terminal's screen; the answer
// goes back the same way, and Claude Code takes it like one given in the terminal. 先聊聊 is the terminal's "Chat about
// this": the questions are put aside and Claude asks what you want to clarify.
import { h } from '../util.js';

// the questions of a card (p.input: the tool's input as JSON text), or null when they cannot be read
export function questionsOf(p) {
  let i = null; try { i = JSON.parse(p.input); } catch {}
  const qs = i && Array.isArray(i.questions) ? i.questions : null;
  if (!qs || !qs.length || !qs.every((q) => q && typeof q.question === 'string' && q.question && Array.isArray(q.options))) return null;
  return qs;
}

// one answer per question: the option's label, the labels of a question that takes several joined with ", " (as
// Claude Code does), your own words -- alone, or after the labels
export function answerOf(q, picked, own) {
  own = String(own || '').trim();
  if (q.multiSelect) return [...q.options.map((o) => o.label).filter((l) => picked.has(l)), ...(own ? [own] : [])].join(', ');
  return own || [...picked][0] || '';
}

// the card: el.answers() -> { question: answer } once every question has one, else null
export function askCard(p, qs) {
  const state = qs.map(() => ({ picked: new Set(), own: '' }));
  const go = h('button', { class: 'btn go', type: 'button', dataset: { choice: 'answer' }, text: '提交回答', disabled: true });
  const answers = () => {
    const out = {};
    for (let n = 0; n < qs.length; n++) { const a = answerOf(qs[n], state[n].picked, state[n].own); if (!a) return null; out[qs[n].question] = a; }
    return out;
  };
  const fresh = () => { go.disabled = !answers(); };
  const blocks = qs.map((q, n) => {
    const st = state[n];
    const own = h('input', { class: 'field aown', placeholder: q.multiSelect ? '还有别的：自己填写' : '都不是：自己填写', autocomplete: 'off', spellcheck: 'false' });
    const opts = q.options.map((o) => {
      const b = h('button', { class: 'aopt', type: 'button', title: o.description || '' }, h('b', { text: o.label }), o.description ? h('span', { text: o.description }) : null);
      b.addEventListener('click', () => {
        if (q.multiSelect) { if (st.picked.has(o.label)) st.picked.delete(o.label); else st.picked.add(o.label); }
        else { st.picked.clear(); st.picked.add(o.label); st.own = ''; own.value = ''; }      // one answer: an option, or your own words
        opts.forEach((x, k) => x.classList.toggle('on', st.picked.has(q.options[k].label)));
        fresh();
      });
      return b;
    });
    own.addEventListener('input', () => {
      st.own = own.value;
      if (!q.multiSelect && own.value.trim()) { st.picked.clear(); opts.forEach((x) => x.classList.remove('on')); }
      fresh();
    });
    own.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.isComposing && !go.disabled) { e.preventDefault(); go.click(); } });
    return h('div', { class: 'aq' },
      h('div', { class: 'aqh' }, q.header ? h('span', { class: 'aqt', text: q.header }) : null, h('span', { text: q.question }), q.multiSelect ? h('i', { text: '可多选' }) : null),
      h('div', { class: 'aqo' }, ...opts), own);
  });
  const card = h('div', { class: 'perm ask', dataset: { id: p.id } },
    h('div', { class: 'pt', text: `Claude 在问你${qs.length > 1 ? ` · ${qs.length} 个问题` : ''}${p.subagent ? ' · ' + p.subagent : ''}` }),
    ...blocks,
    h('div', { class: 'pa' }, go,
      h('button', { class: 'btn', type: 'button', dataset: { choice: 'chat' }, text: '先聊聊', title: '先不回答：让 Claude 问你想澄清什么（终端里的 Chat about this）' }),
      h('button', { class: 'btn no', type: 'button', dataset: { choice: 'deny' }, text: '不回答' }),
      h('span', { class: 'ps', text: '也可在那台机器上回答' })));
  card.answers = answers;
  return card;
}
