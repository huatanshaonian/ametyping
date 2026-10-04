// A stand-in for Claude Code (`claude -p`) in the tests: logs its arguments, prompt and proxy (FAKE_CLAUDE_LOG),
// prints the --output-format json result with the answer as structured_output (fake-answer.js, shaped by --json-schema),
// or fails as an account out of usage does (is_error, 429) -- FAKE_CLAUDE_FAIL, or while the file FAKE_CLAUDE_FAIL_FILE exists.
// The maintenance commands (控制面板 → AI 模型): the version lives in FAKE_CLAUDE_VERSION (a file; 2.1.288 when none),
// `update` moves it on to FAKE_CLAUDE_NEXT, `auth status` says logged in (claude.ai, max) unless FAKE_CLAUDE_LOGGED_OUT.
const fs = require('fs');
const { answerFor } = require('./fake-answer');
const args = process.argv.slice(2);
const log = (o) => { if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, proxy: process.env.HTTPS_PROXY || '', ...o }) + '\n'); };
if (args[0] === '--version' || args[0] === 'update' || args[0] === 'auth') {
  const vf = process.env.FAKE_CLAUDE_VERSION;
  const cur = () => { try { return fs.readFileSync(vf, 'utf8').trim(); } catch { return '2.1.288'; } };
  log({});
  if (args[0] === '--version') console.log(cur() + ' (Claude Code)');
  else if (args[0] === 'update') { if (vf && process.env.FAKE_CLAUDE_NEXT) fs.writeFileSync(vf, process.env.FAKE_CLAUDE_NEXT); console.log('Successfully updated to version ' + cur()); }
  else console.log(JSON.stringify(process.env.FAKE_CLAUDE_LOGGED_OUT ? { loggedIn: false } :
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.com', orgName: 'org', subscriptionType: 'max' }, null, 2));
  process.exit(0);
}
const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  log({ prompt });
  const base = { type: 'result', subtype: 'success', num_turns: 2, session_id: '00000000-0000-0000-0000-000000000000' };
  if (process.env.FAKE_CLAUDE_FAIL || (process.env.FAKE_CLAUDE_FAIL_FILE && fs.existsSync(process.env.FAKE_CLAUDE_FAIL_FILE))) {
    console.log(JSON.stringify({ ...base, is_error: true, api_error_status: 429, result: "You've hit your limit · resets 5am (Asia/Shanghai)" }));
    process.exit(1);
  }
  const answer = answerFor(schema, prompt);
  console.log(JSON.stringify({ ...base, is_error: false, api_error_status: null, result: JSON.stringify(answer), structured_output: answer }));
});
