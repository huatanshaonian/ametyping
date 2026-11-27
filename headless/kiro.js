// What differs on Linux when the session is Kiro CLI (kiro-cli) and not Claude Code.
'use strict';
const { findUnixBin, makeThreadOf } = require('./cli-bin');

const kiroBin = (env) => findUnixBin('kiro-cli', env);
const threadOf = makeThreadOf('kiro', true);
const execResumeArgs = (session, text) => ['chat', '--resume-id', session, '--no-interactive', '--trust-all-tools', String(text == null ? '' : text)];

module.exports = { kiroBin, bin: kiroBin, threadOf, execResumeArgs };
