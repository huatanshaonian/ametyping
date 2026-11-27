// Kiro CLI session-to-PID registry (~/.ametyping/kiro-sessions/<id>.json).
'use strict';
const { createSessionRegistry } = require('./session-registry');

const reg = createSessionRegistry({
  dirName: 'kiro-sessions',
  prefix: 'kiro',
  caseInsensitiveUuid: true,
  requireProvider: 'kiro',
  requireIdentity: true,
  requireCwdString: true,
});

module.exports = reg;
