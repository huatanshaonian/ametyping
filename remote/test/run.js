// Runs the dashboard's end-to-end tests (each starts a throwaway server + agent in a temp folder; nothing real is
// touched). From remote/:  node test/run.js   (after pulling: npm install first -- a missing new dependency fails tests
// in ways that look unrelated)
//
// Other tests here, run one by one:
//   ui-*.js (ui-mail.js too)  headless Chrome screenshots + checks (needs Chrome; CHROME=<path> to override);
//                           pictures land in test/out/shots
//   win-keytest.js          Windows: navigation keys through the pet's console bridge
//   win-screentest.js       Windows: start a console window and read its screen back
//   win-manual-launch.js    Windows: REALLY starts Claude Code in D:\ame-launchtest through the running pet
//                           (create the folder first; uses your Claude usage)
//   linux-headless-e2e.js   copy to the Linux machine and run there: the headless service in an isolated tmux
//   e2e-walls.js <walls.js> <https image URL>   with a URL also downloads a real picture (run it on the server)
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const TESTS = ['e2e-records.js', 'e2e-sessions.js', 'e2e-files.js', 'e2e-launch.js', 'e2e-walls.js', 'e2e-agents.js', 'e2e-codex.js', 'e2e-summary.js', 'e2e-mode.js', 'e2e-archive.js', 'e2e-artifacts.js', 'e2e-morning.js', 'e2e-notes.js', 'e2e-google.js', 'e2e-google-tasks.js', 'e2e-google-more.js', 'e2e-backup.js', 'e2e-mail.js', 'e2e-mail-triage.js', 'e2e-mail-send.js', 'e2e-marks.js', 'e2e-ctx.js', 'e2e-btw.js', 'e2e-search-index.js', 'e2e-search-docs.js', 'e2e-always.js', 'e2e-deploy.js', 'e2e-ai.js', 'e2e-queued.js', 'e2e-session-terminal.js', 'e2e-static.js', 'e2e-push.js', 'e2e-literature.js', 'e2e-lit-library.js', 'e2e-term.js', 'e2e-ask.js'];
let failed = 0;
for (const t of TESTS) {
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10 * 60e3 });
  const out = (r.stdout || '') + (r.stderr || '');
  const summary = (out.trim().split('\n').pop() || '').trim();
  const ok = r.status === 0 && !/[1-9]\d* failed/.test(summary);
  if (!ok) { failed++; console.log(out); }
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${t.padEnd(18)} ${summary}`);
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nall passed');
process.exit(failed ? 1 : 0);
