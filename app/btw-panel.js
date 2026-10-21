// /btw (a side question) in Claude Code 2.1.29x and later: the answer is shown in an overlay in the terminal and is never
// written to the transcript -- neither the question nor the answer. So for a /btw sent from the dashboard or the panel,
// the answer is read off the screen: once it is there, the overlay is scrolled down (↑/↓ move it 3 lines) and the
// pages are put together. The overlay stays open, as Claude Code leaves it; but it takes every Enter / Esc / space
// for itself (a message typed then would be lost), so before the next message is sent it is read if it has not been,
// and closed. "f" in the overlay turns the question into a background agent (fork); its answer then comes the old way,
// through the transcript (app/transcript.js).
// Both terminals use it: tmux on Linux (headless/), the console on Windows (app/remote-control.js), each giving
// io = { screen(): Promise<text|null>, key(name): Promise } with name one of down / up / esc / f.
// What was asked and read is kept on the session (s.btw) for the dashboard agent, which takes it to the server
// (/control/state: items).
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FOOT = /(^|\s)Esc to close\s*$/;
const QLINE = /^\s{0,6}\/btw (.*)$/;
const KEEP_MS = 15 * 60e3;                 // an item stays on the session this long (the agent takes it within seconds)
const WAIT_MS = 10 * 60e3;                 // how long an answer is waited for (after that it is still read before the next message)
const APPEAR_MS = 12e3;                    // the overlay not there by then: not this kind of /btw (an older Claude Code)

// The overlay on a screen, or null: { q, lines, answering, scroll, fork }
// (the last "Esc to close" line, the "/btw <question>" line above it that a blank line follows; the answer is what is
// between the two blank lines, its common indent taken off)
function panelOf(text) {
  if (text == null) return null;
  const ls = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let f = ls.length - 1;
  while (f >= 0 && !FOOT.test(ls[f])) f--;
  if (f < 2) return null;
  let qi = f - 1;
  while (qi >= 0 && f - qi < 200 && !(QLINE.test(ls[qi]) && ls[qi + 1] === '')) qi--;
  if (qi < 0 || f - qi >= 200) return null;
  let body = ls.slice(qi + 2, f);
  while (body.length && !body[body.length - 1]) body.pop();
  const ind = Math.min(...body.filter(Boolean).map((l) => l.match(/^ */)[0].length));
  if (Number.isFinite(ind)) body = body.map((l) => l.slice(ind));
  const answering = body.length <= 3 && body.some((l) => /Answering…|Retrying/.test(l));
  return { q: QLINE.exec(ls[qi])[1].trim(), lines: body, answering, scroll: /to scroll/.test(ls[f]), fork: /f to fork/.test(ls[f]) };
}

// add what a scrolled page shows past what was read: false when it shows nothing new (the end)
function appendPage(acc, page) {
  for (let k = Math.min(acc.length, page.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k && same; i++) same = acc[acc.length - k + i] === page[i];
    if (same) { if (k === page.length) return false; acc.push(...page.slice(k)); return true; }
  }
  acc.push(...page);
  return true;
}

// the whole answer on screen now (scrolling down through it), or null when there is none yet
async function readAnswer(io) {
  let p = panelOf(await io.screen());
  if (!p || p.answering) return null;
  const acc = p.lines.slice();
  if (p.scroll) {
    for (let i = 0; i < 300; i++) {
      await io.key('down');
      await sleep(90);
      const n = panelOf(await io.screen());
      if (!n || n.answering || !appendPage(acc, n.lines)) break;
    }
  }
  while (acc.length && !acc[acc.length - 1]) acc.pop();
  return { q: p.q, text: acc.join('\n').trim() };
}

// onChange(s, item): an item asked, or its answer read
function createBtw({ onChange = () => {} } = {}) {
  let seq = 0;
  // one thing at a time on a session's terminal (a watch, the check before a message, a fork)
  const lock = (s, fn) => { const run = (s.btwLock || Promise.resolve()).then(fn, fn); s.btwLock = run.catch(() => {}); return run; };
  const items = (s) => { const now = Date.now(); s.btw = (s.btw || []).filter((x) => now - x.t < KEEP_MS); return s.btw; };
  function answered(s, it, r) {
    it.a = r.text.slice(0, 100e3) || '（没有内容）'; it.ta = Date.now();
    onChange(s, it);
  }
  // the open overlay's answer, read into the item it belongs to (a /btw typed in the terminal itself: a new item)
  async function readOpen(s, io) {
    const r = await readAnswer(io);
    if (!r) return false;
    let it = items(s).find((x) => !x.a && r.q && x.q.replace(/\s+/g, ' ').startsWith(r.q.replace(/…$/, '').trim()));
    if (!it && items(s).some((x) => x.a && x.q.replace(/\s+/g, ' ').startsWith(r.q.replace(/…$/, '').trim()))) return true;
    if (!it) { it = { k: Date.now().toString(36) + '-' + (++seq), q: r.q, t: Date.now() }; s.btw.push(it); }
    answered(s, it, r);
    return true;
  }

  // a /btw was just typed into the session: wait for the overlay's answer (the screen looked at every 1.5 s for the first
  // minute, then every 5 s, for this one question only -- Claude Code says nothing else when it is there)
  function sent(s, io, question) {
    const it = { k: Date.now().toString(36) + '-' + (++seq), q: String(question).trim().slice(0, 2000), t: Date.now() };
    items(s).push(it);
    onChange(s, it);
    const t0 = Date.now();
    let seen = false;
    const step = () => lock(s, async () => {
      if (it.a) return true;
      const p = panelOf(await io.screen());
      if (p) seen = true;
      if (p && !p.answering) { await readOpen(s, io); return true; }
      if (!p && (seen || Date.now() - t0 > APPEAR_MS)) return true;         // closed (read before that), or never came
      return Date.now() - t0 > WAIT_MS;
    }).then((done) => { if (!done) setTimeout(step, Date.now() - t0 < 60e3 ? 1500 : 5000); }, () => {});
    setTimeout(step, 900);
    return it;
  }

  // before a message goes in: an open overlay read (if it was not yet) and closed, so the message is not lost in it
  function beforeSend(s, io) {
    return lock(s, async () => {
      const p = panelOf(await io.screen());
      if (!p) return;
      if (!p.answering) await readOpen(s, io);
      await io.key('esc');
      await sleep(200);
    });
  }

  // "f" in the overlay: the question to a background agent of its own
  function fork(s, io) {
    return lock(s, async () => {
      const p = panelOf(await io.screen());
      if (!p) return { ok: false, msg: '终端里的顺带一问已经关了，没法再转成后台任务（可以重新问一次）' };
      if (!p.fork) return { ok: false, msg: p.answering ? '还在回答，等它答完再转' : '这个回答不能转成后台任务' };
      await io.key('f');
      return { ok: true, msg: '已转成后台任务，做完后回答会出现在对话里' };
    });
  }

  // for /control/state
  const list = (s) => items(s).map((x) => ({ k: x.k, q: x.q, t: x.t, a: x.a, ta: x.ta }));
  return { sent, beforeSend, fork, list };
}

const isBtw = (text) => /^\/btw\s+\S/.test(String(text || '').trim());
const questionOf = (text) => String(text || '').trim().replace(/^\/btw\s+/, '');

module.exports = { createBtw, panelOf, appendPage, readAnswer, isBtw, questionOf };
