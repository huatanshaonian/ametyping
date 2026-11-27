// What differs on Linux when the session is Codex CLI and not Claude Code.
'use strict';
const { findUnixBin, makeThreadOf } = require('./cli-bin');

const codexBin = (env) => findUnixBin('codex', env);
const threadOf = makeThreadOf('codex', false);
const execResumeArgs = (thread) => ['exec', 'resume', '--skip-git-repo-check', thread, '-'];

module.exports = { codexBin, threadOf, execResumeArgs };
