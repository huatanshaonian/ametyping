// The numbered steps under a plan (1. 2. 3. ...): each its own text and tick, in the user's order. Kept on the plan
// itself (todos.json, "steps"); a plan without steps has no such field, as before.
'use strict';
const crypto = require('crypto');

const MAX = 60;
const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : '');

// steps given when a plan is made: [text] or [{ text, done }]
function initial(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX).map((s) => (typeof s === 'string' ? { text: s } : s || {}))
    .map((s) => ({ id: crypto.randomBytes(4).toString('hex'), text: text(s.text), done: s.done === true })).filter((s) => s.text);
}

// { op: add | update | delete | move, sid, text, done, to, at } on plan t; true when it changed
function change(t, d) {
  const steps = t.steps || [];
  if (d.op === 'add') {
    const s = text(d.text);
    if (!s) return { ok: false, msg: '内容是空的' };
    if (steps.length >= MAX) return { ok: false, msg: `每个计划最多 ${MAX} 条` };
    const st = { id: crypto.randomBytes(4).toString('hex'), text: s, done: false };
    const at = Number.isFinite(+d.at) && d.at !== null && d.at !== '' ? Math.max(0, Math.min(steps.length, Math.round(+d.at))) : steps.length;
    steps.splice(at, 0, st);
    t.steps = steps;
    return { ok: true, step: st };
  }
  const st = steps.find((x) => x.id === d.sid);
  if (!st) return { ok: false, msg: '找不到这一条' };
  if (d.op === 'update') {
    if (typeof d.text === 'string') { const s = text(d.text); if (!s) return { ok: false, msg: '内容是空的' }; st.text = s; }
    if (typeof d.done === 'boolean') st.done = d.done;
    return { ok: true, step: st };
  }
  if (d.op === 'delete') {
    t.steps = steps.filter((x) => x !== st);
    if (!t.steps.length) delete t.steps;
    return { ok: true };
  }
  if (d.op === 'move') {
    const to = Math.round(+d.to);
    if (!Number.isFinite(to)) return { ok: false, msg: '不能移动' };
    const rest = steps.filter((x) => x !== st);
    rest.splice(Math.max(0, Math.min(rest.length, to)), 0, st);
    t.steps = rest;
    return { ok: true };
  }
  return { ok: false, msg: '不认识的操作' };
}

module.exports = { initial, change, MAX };
