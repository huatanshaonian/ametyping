// /btw in Claude Code 2.1.29x and later (app/btw-panel.js): the answer only in the terminal's overlay, read off a fake
// terminal drawn as Claude Code draws it (answering, the answer, scrolling 3 lines a key, Esc, f); the store keeping
// what was read (remote/server/store.js extra) once, and the question once when the transcript brings it again (fork)
const fs = require('fs'), path = require('path'), os = require('os');
const { panelOf, appendPage, readAnswer, createBtw, isBtw, questionOf } = require('../../app/btw-panel');
const { createStore } = require('../server/store');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a terminal with Claude Code in it: the conversation, then (when open) the /btw overlay, then the input box
function fakeTerm({ q = '要几层？', answer = [], height = 12, answeringFor = 0, history = [] } = {}) {
  const t = { open: true, top: 0, keys: [], looks: 0, forked: false };
  t.screen = async () => {
    t.looks++;
    const out = [' ▐▛███▛█   Claude Code v2.1.300', '', '❯ 主任务：把报告写完', '● 好的，先看目录。', '  说明里写着 Esc to close 也不算', '', '❯ /btw ' + q];
    if (t.open) {
      out.push(...history.map((h) => '  /btw ' + h), '  /btw ' + q, '');
      const answering = t.looks <= answeringFor;
      if (answering) out.push('    ✻ Answering…', '', '  Esc to close');
      else {
        const win = answer.slice(t.top, t.top + height);
        out.push(...win.map((l) => (l ? '    ' + l : '')), '');
        out.push(answer.length > height ? '  ↑/↓ to scroll · c to copy · f to fork · Esc to close' : '  c to copy · f to fork · Esc to close');
      }
    }
    out.push('─'.repeat(60), '❯ ', '─'.repeat(60), '  ⏵⏵ auto mode on (shift+tab to cycle)');
    return out.join('\n');
  };
  t.key = async (k) => {
    t.keys.push(k);
    if (!t.open) return { ok: true };
    if (k === 'down') t.top = Math.max(0, Math.min(t.top + 3, answer.length - height));
    if (k === 'up') t.top = Math.max(0, t.top - 3);
    if (k === 'esc') t.open = false;
    if (k === 'f') { t.forked = true; t.open = false; }
    return { ok: true };
  };
  return t;
}

(async () => {
  // ---- reading the screen ----
  const long = Array.from({ length: 40 }, (_, i) => (i % 7 === 3 ? '' : i % 5 === 0 ? '同一行' : `第 ${i + 1} 行：  缩进 ${'·'.repeat(i % 4)}x`));
  long[10] = '  - 列表项（比别的行多缩进两格）';
  const t1 = fakeTerm({ answer: long, answeringFor: 1 });
  const p0 = panelOf(await t1.screen());
  chk('answering: the overlay, still answering', p0 && p0.answering && p0.q === '要几层？', p0);
  const p1 = panelOf(await t1.screen());
  chk('answered: question, the lines without the overlay\'s indent, scrolling and fork offered', p1 && !p1.answering && p1.q === '要几层？' && p1.lines[0] === long[0] && p1.scroll && p1.fork && p1.lines.length === 12, p1);
  chk('no overlay: nothing (a conversation that merely says "Esc to close" is not one)', panelOf('❯ hello\n● 按 Esc to close\n❯ ') === null && panelOf(null) === null && panelOf('') === null, 0);
  const th = fakeTerm({ answer: ['新的回答'], history: ['旧问题一', '旧问题二'] });
  const ph = panelOf(await th.screen());
  chk('earlier questions listed above (browsing): the current one is the last', ph && ph.q === '要几层？' && ph.lines.join('|') === '新的回答', ph);
  const acc = ['a', 'b', 'x', 'x'];
  chk('pages put together: repeated lines at the seam', appendPage(acc, ['x', 'x', 'x', 'c']) && acc.join('') === 'abxxxc' && !appendPage(acc, ['x', 'x', 'c']), acc);
  const r1 = await readAnswer(t1);
  chk('a long answer: scrolled through and read whole, blank and repeated lines included', r1 && r1.text === long.join('\n').trim() && r1.q === '要几层？', r1 && r1.text.split('\n').length);
  chk('... with down keys only (3 lines each, then one that moves nothing)', t1.keys.every((k) => k === 'down') && t1.keys.length === Math.ceil((40 - 12) / 3) + 1, t1.keys);
  const t2 = fakeTerm({ answer: ['五层。', '', '理由：地基只够五层。'] });
  const r2 = await readAnswer(t2);
  chk('a short answer: read without a key', r2 && r2.text === '五层。\n\n理由：地基只够五层。' && t2.keys.length === 0, [r2, t2.keys]);
  chk('/btw recognised; the question taken off it', isBtw('/btw 几点了') && !isBtw('/btw') && !isBtw('/btwx 1') && !isBtw('看 /btw 怎么用') && questionOf(' /btw  几点了 ') === '几点了', 0);

  // ---- a /btw sent: the answer waited for, read, kept on the session ----
  const changes = [];
  const btw = createBtw({ onChange: (s) => changes.push(s.id) });
  const s = { id: 'S1' };
  const t3 = fakeTerm({ q: '要几层？', answer: long, answeringFor: 2 });
  const it = btw.sent(s, t3, '要几层？');
  chk('sent: the question listed at once', btw.list(s).length === 1 && btw.list(s)[0].q === '要几层？' && !btw.list(s)[0].a && changes.length === 1, btw.list(s));
  for (let i = 0; i < 40 && !it.a; i++) await sleep(200);
  chk('sent: the answer read once it was there (whole), the session told', it.a === long.join('\n').trim() && btw.list(s)[0].a === it.a && changes.length === 2, [it, changes]);
  chk('sent: the overlay left open, as Claude Code leaves it', t3.open && !t3.keys.includes('esc'), t3.keys);
  // the next message: the open overlay closed first (it takes Enter / Esc / space for itself: the message would be lost)
  await btw.beforeSend(s, t3);
  chk('before the next message: the overlay closed with Esc, not read again', !t3.open && t3.keys.filter((k) => k === 'esc').length === 1 && btw.list(s).length === 1, [t3.keys, btw.list(s)]);
  const n0 = t3.keys.length;
  await btw.beforeSend(s, t3);
  chk('no overlay: no key at all', t3.keys.length === n0, t3.keys);
  // a /btw typed in the terminal itself, still open when a message comes from the dashboard: read too, then closed
  const s2 = { id: 'S2' };
  const t4 = fakeTerm({ q: '终端里自己问的', answer: ['在终端里问的回答'] });
  await btw.beforeSend(s2, t4);
  chk('a /btw asked in the terminal and still open: its answer kept, then closed', btw.list(s2).length === 1 && btw.list(s2)[0].q === '终端里自己问的' && btw.list(s2)[0].a === '在终端里问的回答' && !t4.open, [btw.list(s2), t4.keys]);
  // the message sent while it was still answering: closed (Claude Code keeps answering it in the background) -- the
  // watch goes on and reads it if it comes back
  const s3 = { id: 'S3' };
  const t5 = fakeTerm({ q: '慢问题', answer: ['慢回答'], answeringFor: 100 });
  btw.sent(s3, t5, '慢问题');
  await sleep(1000);
  await btw.beforeSend(s3, t5);
  chk('still answering when a message comes: closed, nothing made up', !t5.open && !btw.list(s3)[0].a, [t5.keys, btw.list(s3)]);
  // a /btw that brings no overlay (an older Claude Code: it forks at once): the watch gives up by itself
  const t6 = fakeTerm({ answer: ['x'] }); t6.open = false;
  const s4 = { id: 'S4' };
  btw.sent(s4, t6, '老版本');
  // ---- f: to a background agent, only while the overlay is open ----
  const t7 = fakeTerm({ answer: ['可以转'] });
  const f1 = await btw.fork({ id: 'S5' }, t7);
  chk('fork: "f" pressed in the open overlay', f1.ok && t7.forked && t7.keys.join() === 'f', [f1, t7.keys]);
  const f2 = await btw.fork({ id: 'S5' }, t7);
  chk(`fork: the overlay gone -- nothing typed (${f2.msg})`, !f2.ok && t7.keys.join() === 'f', [f2, t7.keys]);
  const t8 = fakeTerm({ answer: ['x'], answeringFor: 100 });
  const f3 = await btw.fork({ id: 'S6' }, t8);
  chk(`fork: still answering -- nothing typed (${f3.msg})`, !f3.ok && t8.keys.length === 0, [f3, t8.keys]);

  // ---- the panel's own conversation (app/main.js btwToChat): the question shown from the screen is not shown again
  // when the fork line brings it, and the fork's answer still finds its question ----
  const { recordsOf } = require('../../app/transcript');
  const pst = []; pst.btwAsked = new Set(['/btw 要几层？']);
  const fl = recordsOf({ type: 'system', subtype: 'local_command', timestamp: '2026-10-19T10:00:05Z', content: '<local-command-stdout>⑂ forked yao-ji-ceng (b4ce)</local-command-stdout>', commandRun: { command: 'btw', args: '要几层？' } }, pst);
  const fa = recordsOf({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-19T10:00:30Z', content: '<task-notification>\n<task-id>ayao-ji-ceng-f948cd93525db4ce</task-id>\n<status>completed</status>\n<result>后台：五层。</result>\n</task-notification>' }, pst);
  const fl2 = recordsOf({ type: 'system', subtype: 'local_command', timestamp: '2026-10-19T10:01:05Z', content: '<local-command-stdout>⑂ forked yao-ji-ceng-2 (c0de)</local-command-stdout>', commandRun: { command: 'btw', args: '要几层？' } }, pst);
  chk('panel: the fork line\'s question not twice; its answer paired; asked again later: shown', fl.length === 0 && fa.length === 1 && fa[0].role === 'btw' && fa[0].text === '后台：五层。' && fl2.length === 1, [fl, fa, fl2]);

  // ---- the store: what was read, once; the question not twice when the transcript brings it (fork) ----
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-btws-'));
  const st = createStore(path.join(T, 'data'));
  const t0 = Date.parse('2026-10-19T10:00:00Z');
  st.accept('pc', { id: 'S', from: 0, to: 10, recs: [{ u: 'u1', i: 0, role: 'user', text: '主任务', t: t0 }] });
  const q = { u: 'btwq-k1', role: 'user', text: '/btw 要几层？', t: t0 + 1000 }, a = { u: 'btwa-k1', role: 'btw', text: '五层。', t: t0 + 9000 };
  chk('extra: the question', st.extra('pc', 'S', [q]) === true, 0);
  chk('extra: question again with its answer -- only the answer is new', st.extra('pc', 'S', [q, a]) === true && st.extra('pc', 'S', [q, a]) === false, 0);
  // "f": Claude Code writes the fork line (the question as a user record) and later the agent's answer
  st.accept('pc', { id: 'S', from: 10, to: 20, recs: [{ u: 'u2', i: 0, role: 'user', text: '/btw 要几层？', t: t0 + 20000 }, { u: 'u3', i: 0, role: 'btw', text: '后台代理查过了：五层。', t: t0 + 60000 }] });
  st.accept('pc', { id: 'S', from: 20, to: 30, recs: [{ u: 'u4', i: 0, role: 'user', text: '/btw 要几层？', t: t0 + 90000 }] });
  const kept = st.records('pc', 'S', 0, Date.parse('2027-01-01')).map((r) => [r.role, r.text]);
  chk('store: question once (the fork line skipped), both answers; the same question asked again later is kept', JSON.stringify(kept) === JSON.stringify([['user', '主任务'], ['user', '/btw 要几层？'], ['btw', '五层。'], ['btw', '后台代理查过了：五层。'], ['user', '/btw 要几层？']]), kept);
  const tail = st.tail('pc', 'S').map((m) => m.role);
  chk('store: the conversation shown has them', tail.filter((r) => r === 'btw').length === 2, tail);
  const st2 = createStore(path.join(T, 'data'));
  chk('store: kept once after a restart too', st2.extra('pc', 'S', [q, a]) === false, 0);
  fs.rmSync(T, { recursive: true, force: true });
  await sleep(13500);                                       // (the watch on S4 gives up after 12 s: let it, the test ends clean)
  chk('no overlay ever: the watch gave up without a key', !btw.list(s4)[0].a && t6.keys.length === 0, [btw.list(s4), t6.keys]);
  console.log(res.join('\n'));
})();
