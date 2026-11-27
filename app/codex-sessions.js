// Codex session-to-PID registry (~/.ametyping/codex-sessions/<id>.json).
'use strict';
const { createSessionRegistry } = require('./session-registry');

const reg = createSessionRegistry({
  dirName: 'codex-sessions',
  prefix: '',
  caseInsensitiveUuid: false,
  requireProvider: 'codex',
  requireIdentity: true,
  requireCwdString: true,
});

module.exports = { remember: reg.remember, list: reg.list, forget: reg.forget };
