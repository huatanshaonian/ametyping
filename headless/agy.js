// What differs on Linux when the session is Antigravity CLI (agy) and not Claude Code.
'use strict';
const { findUnixBin, makeThreadOf } = require('./cli-bin');

const agyBin = (env) => findUnixBin('agy', env);
const threadOf = makeThreadOf('agy', true);
const execResumeArgs = (thread) => ['--conversation', thread, '-p', '--dangerously-skip-permissions'];

module.exports = { agyBin, bin: agyBin, threadOf, execResumeArgs };
