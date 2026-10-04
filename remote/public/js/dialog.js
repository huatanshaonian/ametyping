// Windose's own dialogs: a small modal asking for one line of text (a group's name...), resolving the trimmed text or
// null when cancelled, and message boxes (confirm / alert) below.
import { h } from './util.js';

export function askText({ title, label = '', value = '', max = 40 }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'field', maxlength: max, value });
    const done = (v) => { wrap.remove(); resolve(v); };
    const form = h('form', { class: 'dlgbox', autocomplete: 'off' },
      h('div', { class: 'dlgt', text: title }),
      h('div', { class: 'dlgb' },
        label ? h('p', { text: label }) : null,
        input,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => done(null) }),
          h('button', { class: 'btn go', type: 'submit', text: '确定' }))));
    form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value.trim(); if (v) done(v); else input.focus(); });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    const wrap = h('div', { class: 'dlg' }, form);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(null); });
    document.body.append(wrap);
    input.focus(); input.select();
  });
}

// A message box in Windose's own look, in place of the browser's alert / confirm (which stop the page and look like
// the browser, not like Windose): an icon, the text (line breaks kept), buttons. Resolves the chosen button's value;
// Esc, the title's × or a click outside: `esc`. Enter presses the focused button (the first .go one at the start).
//   buttons: [{ text, value, go (the main one), no (a destructive one), focus (focused at the start; else the main one) }]
export function msgBox({ title = 'Windose', text = '', icon = 'msg_information', buttons = [{ text: '确定', value: true, go: true }], esc = null }) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const done = (v) => { wrap.remove(); try { before && before.focus && before.focus(); } catch {} resolve(v); };
    const btns = buttons.map((b) => h('button', { class: 'btn' + (b.go ? ' go' : '') + (b.no ? ' no' : ''), type: 'button', text: b.text, onclick: () => done(b.value) }));
    const box = h('div', { class: 'dlgbox dlgmsg', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'dlgt' }, h('span', { text: title }), h('button', { class: 'dlgx', type: 'button', title: '关闭', text: '×', onclick: () => done(esc) })),
      h('div', { class: 'dlgb' },
        h('div', { class: 'dlgm' }, h('img', { src: `/icons/${icon}.png`, alt: '' }), h('div', { class: 'dlgtx', text })),
        h('div', { class: 'dlga' }, ...btns)));
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') return done(esc);
      // Tab and the arrows stay among the buttons
      const i = btns.indexOf(document.activeElement), step = e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey) ? 1 : e.key === 'ArrowLeft' || e.key === 'Tab' ? -1 : 0;
      if (step) { e.preventDefault(); btns[(i + step + btns.length) % btns.length].focus(); }
    });
    const wrap = h('div', { class: 'dlg' }, box);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(esc); });
    document.body.append(wrap);
    const first = buttons.findIndex((b) => b.focus), main = buttons.findIndex((b) => b.go);
    btns[first >= 0 ? first : main >= 0 ? main : 0].focus();
  });
}

// 「确定 / 取消」: true when confirmed. danger: the confirming button is a destructive one (删除…), 取消 gets the focus.
export function confirmBox(text, { title = '确认', ok = '确定', cancel = '取消', danger = false, icon = danger ? 'msg_warning' : 'msg_question' } = {}) {
  return msgBox({ title, text, icon, esc: false, buttons: danger ? [{ text: ok, value: true, no: true }, { text: cancel, value: false, focus: true }]
    : [{ text: ok, value: true, go: true }, { text: cancel, value: false }] });
}
// something to tell: resolves when closed. bad: it went wrong (the error icon)
export function alertBox(text, { title = '提示', bad = false, icon = bad ? 'msg_error' : 'msg_information' } = {}) {
  return msgBox({ title, text, icon, esc: true }).then(() => {});
}
