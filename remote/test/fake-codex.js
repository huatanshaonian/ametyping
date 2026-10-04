// A stand-in for `codex exec` in the summary tests: logs its arguments and prompt (FAKE_CODEX_LOG), answers with JSON
// shaped by the schema it was given (fake-answer.js: a day report, a session summary, ...), or fails (FAKE_CODEX_FAIL, or while the
// file FAKE_CODEX_FAIL_FILE exists).
const fs = require('fs');
const { answerFor } = require('./fake-answer');
const args = process.argv.slice(2);
// the maintenance commands (控制面板 → AI 模型): the version lives in FAKE_CODEX_VERSION (a file; 0.158.0 when none),
// `update` moves it on to FAKE_CODEX_NEXT, `login status` says logged in unless FAKE_CODEX_LOGGED_OUT
if (args[0] === '--version' || args[0] === 'update' || args[0] === 'login') {
  const vf = process.env.FAKE_CODEX_VERSION;
  const cur = () => { try { return fs.readFileSync(vf, 'utf8').trim(); } catch { return '0.158.0'; } };
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, proxy: process.env.HTTPS_PROXY || '' }) + '\n');
  if (args[0] === '--version') console.log('codex-cli ' + cur());
  else if (args[0] === 'update') { if (vf && process.env.FAKE_CODEX_NEXT) fs.writeFileSync(vf, process.env.FAKE_CODEX_NEXT); console.log('Updated Codex to ' + cur()); }
  else if (process.env.FAKE_CODEX_LOGGED_OUT) { console.log('Not logged in'); process.exit(1); }
  else console.log('Logged in using ChatGPT');
  process.exit(0);
}
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
const out = args[args.indexOf('-o') + 1];
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt, proxy: process.env.HTTPS_PROXY || '' }) + '\n');
  if (process.env.FAKE_CODEX_FAIL || (process.env.FAKE_CODEX_FAIL_FILE && fs.existsSync(process.env.FAKE_CODEX_FAIL_FILE))) { process.stderr.write('ERROR: stream disconnected\n'); process.exit(1); }
  const answer = answerFor(schema, prompt);
  fs.writeFileSync(out, JSON.stringify(answer));
});
