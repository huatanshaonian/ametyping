// Claude asking you something (its AskUserQuestion tool) answered on a card: the questions come with the permission
// request (app/permissions.js keeps them), the answer goes back through the hook as the tool's own input with the
// answers filled in (permission-hook.js) -- which Claude Code 2.1.289 takes like an answer given in its terminal;
// "先聊聊" is a refusal that says so; a plain "allow" would be ignored by Claude Code, so there is none.
// The real pet's store and the real hook, with a stand-in for the socket between them.
const http = require('http'), path = require('path'), cp = require('child_process');
const R = path.resolve(__dirname, '..', '..');
const { createPermissions } = require(R + '/app/permissions');
const { recordsOf } = require(R + '/app/transcript');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));

const QS = { questions: [
  { question: '要哪些配菜', header: '配菜', multiSelect: true, options: [{ label: '青菜', description: '绿' }, { label: '鸡蛋', description: '黄' }, { label: '豆腐', description: '白' }] },
  { question: '喝什么', header: '饮料', multiSelect: false, options: [{ label: '茶', description: '热' }, { label: '水', description: '凉' }] }] };
const fakeRes = () => { const r = new (require('events'))(); r.destroyed = false; r.writableEnded = false; r.out = null; r.writeHead = () => {}; r.end = (s) => { r.out = s; r.writableEnded = true; }; return r; };
const ends = [];
const perms = createPermissions((s, e) => { if (e) ends.push(e.why + ':' + (e.choice || '')); });

// ---- the pending question ----
const r1 = fakeRes(), id1 = perms.add({ session: 's', tool: 'AskUserQuestion', input: QS, suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }, r1);
const r2 = fakeRes(), id2 = perms.add({ session: 's', tool: 'Bash', input: { command: 'ls' }, suggestions: [] }, r2);
const r3 = fakeRes(), id3 = perms.add({ session: 's', provider: 'codex', tool: 'AskUserQuestion', input: QS }, r3);
const r4 = fakeRes(), id4 = perms.add({ session: 's', tool: 'AskUserQuestion', input: { questions: 'broken' } }, r4);
const by = Object.fromEntries(perms.list('s').map((p) => [p.id, p]));
chk('listed as a question (with what was asked), not as something to allow', by[id1].ask === true && by[id1].always === '' && by[id1].input.questions.length === 2 && !by[id2].ask && !by[id3].ask && !by[id4].ask, by);
chk('no 允许 / 总是允许 for a question (Claude Code would ignore an allow without answers)', perms.decide(id1, 'allow') === false && perms.decide(id1, 'always') === false && r1.out === null, r1.out);
chk('an answer must answer every question, in words', perms.decide(id1, 'answer', { answers: { 要哪些配菜: '青菜' } }) === false && perms.decide(id1, 'answer', { answers: { 要哪些配菜: '青菜', 喝什么: '  ' } }) === false &&
  perms.decide(id1, 'answer', { answers: { 要哪些配菜: ['青菜'], 喝什么: '茶' } }) === false && perms.decide(id1, 'answer', {}) === false && perms.decide(id1, 'answer') === false && r1.out === null, r1.out);
chk('answering is for questions only', perms.decide(id2, 'answer', { answers: { x: 'y' } }) === false && perms.decide(id2, 'chat') === false && perms.decide(id3, 'answer', { answers: { 要哪些配菜: '青菜', 喝什么: '茶' } }) === false, 0);
const ok = perms.decide(id1, 'answer', { answers: { 要哪些配菜: '青菜, 鸡蛋, 再加点辣椒', 喝什么: ' 茶 ', 多余的: 'x' } });
const o1 = JSON.parse(r1.out || '{}');
chk('answered: the hook is told to allow, with the tool\'s input as it was plus the answers (only to what was asked)', ok === true && o1.choice === 'allow' && JSON.stringify(o1.updatedInput.questions) === JSON.stringify(QS.questions) &&
  JSON.stringify(o1.updatedInput.answers) === JSON.stringify({ 要哪些配菜: '青菜, 鸡蛋, 再加点辣椒', 喝什么: '茶' }) && ends.join() === 'decided:answer', [o1, ends]);
chk('answered once', perms.decide(id1, 'answer', { answers: { 要哪些配菜: '青菜', 喝什么: '茶' } }) === false, 0);
const r5 = fakeRes(), id5 = perms.add({ session: 's', tool: 'AskUserQuestion', input: QS }, r5);
const o5 = (perms.decide(id5, 'chat'), JSON.parse(r5.out || '{}'));
chk('先聊聊: a refusal that tells Claude to ask what you want to clarify', o5.choice === 'deny' && /talk about these questions/.test(o5.message) && /clarify/.test(o5.message) && ends[1] === 'decided:chat', o5);
const r6 = fakeRes(), id6 = perms.add({ session: 's', tool: 'AskUserQuestion', input: QS }, r6);
chk('不回答: a plain refusal', perms.decide(id6, 'deny') === true && JSON.parse(r6.out).choice === 'deny', r6.out);
chk('the other cards as before', perms.decide(id2, 'allow') === true && JSON.parse(r2.out).choice === 'allow' && perms.decide(id4, 'allow') === true, r2.out);
perms.clear();

// ---- in the conversation ----
const rec = (o) => recordsOf({ timestamp: '2026-10-05T17:12:36.633Z', ...o }, {}).map((r) => r.role + ':' + (r.text || (r.items || []).join())).join(' || ');
chk('the question in the conversation, and what you answered', rec({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: QS }] } }) === 'tool:提问 要哪些配菜 / 喝什么' &&
  rec({ type: 'user', toolUseResult: { answers: { 要哪些配菜: '青菜, 豆腐', 喝什么: '水' } }, message: { role: 'user', content: [{ type: 'tool_result', content: 'Your questions have been answered' }] } }) === 'sys:回答：要哪些配菜 → 青菜, 豆腐；喝什么 → 水' &&
  rec({ type: 'user', toolUseResult: { stdout: 'x' }, message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }) === '', 0);

// ---- the hook end to end ----
function runHook(answer, input) {
  return new Promise((resolve) => {
    let got = null;
    const srv = http.createServer((req, rq) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { got = JSON.parse(b); rq.end(JSON.stringify(answer)); }); })
      .listen(0, '127.0.0.1', () => {
        const p = cp.spawn(process.execPath, [R + '/permission-hook.js'], { env: { ...process.env, AME_PORT: String(srv.address().port) } });
        let out = ''; p.stdout.on('data', (c) => out += c);
        p.on('close', () => { srv.close(); resolve({ got, out: out ? JSON.parse(out) : null }); });
        p.stdin.end(JSON.stringify(input));
      });
  });
}
(async () => {
  const input = { session_id: 'S1', tool_name: 'AskUserQuestion', tool_input: QS, cwd: '/w', permission_suggestions: [] };
  const a = await runHook(o1, input);
  const d = a.out && a.out.hookSpecificOutput.decision;
  chk('hook: the pet gets the questions', a.got && a.got.tool === 'AskUserQuestion' && a.got.input.questions[1].options[1].label === '水', a.got);
  chk('hook: the answer -> allow with the input and its answers (what Claude Code takes as the answer)', d && d.behavior === 'allow' && d.updatedInput.answers['喝什么'] === '茶' && d.updatedInput.questions.length === 2 && !('updatedPermissions' in d), d);
  const b = await runHook(o5, input);
  chk('hook: 先聊聊 -> deny with its message', b.out && b.out.hookSpecificOutput.decision.behavior === 'deny' && /clarify/.test(b.out.hookSpecificOutput.decision.message), b.out);
  const c = await runHook({ choice: 'allow', updatedInput: ['not', 'an', 'object'] }, input);
  chk('hook: nonsense in place of an input is not passed on', c.out && c.out.hookSpecificOutput.decision.behavior === 'allow' && !('updatedInput' in c.out.hookSpecificOutput.decision), c.out);
  console.log(res.join('\n'));
  const failed = res.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${res.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
