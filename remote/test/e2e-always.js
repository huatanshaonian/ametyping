// 总是允许: Claude Code's "don't ask again" suggestions described for the cards (app/permission-rules.js), kept with the
// pending prompt (app/permissions.js), and handed back unchanged by the hook (permission-hook.js) when chosen.
const http = require('http'), path = require('path'), cp = require('child_process');
const R = path.resolve(__dirname, '..', '..');
const { alwaysLabel } = require(R + '/app/permission-rules');
const { createPermissions } = require(R + '/app/permissions');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));

const SUG_SESSION = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }];
const SUG_LOCAL = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git log:*' }, { toolName: 'Read' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addDirectories', directories: ['D:/data'], destination: 'session' }];

// the label
chk('label: one rule, this session', alwaysLabel(SUG_SESSION) === 'Bash(npm test:*) · 本会话', alwaysLabel(SUG_SESSION));
chk('label: rules kept in the project, a directory', alwaysLabel(SUG_LOCAL) === 'Bash(git log:*)、Read · 这个项目（仅这台电脑）；访问 D:/data · 本会话', alwaysLabel(SUG_LOCAL));
chk('label: a mode', alwaysLabel([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]) === '切到自动接受编辑 · 本会话', 0);
chk('label: nothing usable -> no option', alwaysLabel([]) === '' && alwaysLabel(null) === '' && alwaysLabel([{ type: 'removeRules', rules: [] }]) === '' &&
  alwaysLabel([{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }]) === '', 0);

// the pending prompt
const fakeRes = () => { const r = new (require('events'))(); r.destroyed = false; r.writableEnded = false; r.out = null; r.writeHead = () => {}; r.end = (s) => { r.out = s; r.writableEnded = true; }; return r; };
const perms = createPermissions(() => {});
const r1 = fakeRes(), id1 = perms.add({ session: 's', tool: 'Bash', input: { command: 'npm test' }, suggestions: SUG_SESSION }, r1);
const r2 = fakeRes(), id2 = perms.add({ session: 's', tool: 'Edit', input: {}, suggestions: [] }, r2);
const r3 = fakeRes(), id3 = perms.add({ session: 's', provider: 'codex', tool: 'shell', input: {}, suggestions: SUG_SESSION }, r3);
const listed = Object.fromEntries(perms.list('s').map((p) => [p.id, p.always]));
chk('listed with what 总是允许 adds (none without suggestions, none for Codex)', listed[id1] === 'Bash(npm test:*) · 本会话' && listed[id2] === '' && listed[id3] === '', listed);
chk('总是允许 refused where nothing could be added', perms.decide(id2, 'always') === false && perms.decide(id3, 'always') === false && r2.out === null, r2.out);
chk('总是允许 answers the hook with choice always', perms.decide(id1, 'always') === true && JSON.parse(r1.out).choice === 'always', r1.out);
perms.clear();

// the hook end to end: a stand-in pet answers 'always' / 'allow'
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
  const input = { session_id: 'S1', tool_name: 'Bash', tool_input: { command: 'git log -3' }, cwd: '/w', permission_suggestions: SUG_LOCAL };
  const a = await runHook({ choice: 'always' }, input);
  const d = a.out && a.out.hookSpecificOutput.decision;
  chk('hook: the pet gets the suggestions', a.got && JSON.stringify(a.got.suggestions) === JSON.stringify(SUG_LOCAL), a.got);
  chk('hook: 总是允许 -> allow with Claude Code\'s suggestions unchanged (project rules too, as the terminal offers)',
    d && d.behavior === 'allow' && JSON.stringify(d.updatedPermissions) === JSON.stringify(SUG_LOCAL), d);
  const b = await runHook({ choice: 'allow' }, input);
  chk('hook: 允许 -> allow, nothing added', b.out && b.out.hookSpecificOutput.decision.behavior === 'allow' && !('updatedPermissions' in b.out.hookSpecificOutput.decision), b.out);
  const c = await runHook({ choice: 'deny' }, input);
  chk('hook: 拒绝 -> deny', c.out && c.out.hookSpecificOutput.decision.behavior === 'deny', c.out);
  console.log(res.join('\n'));
})();
