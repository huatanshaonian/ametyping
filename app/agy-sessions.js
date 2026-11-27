// Antigravity (agy) session-to-PID registry (~/.ametyping/agy-sessions/<id>.json).
'use strict';
const { createSessionRegistry } = require('./session-registry');

const reg = createSessionRegistry({
  dirName: 'agy-sessions',
  prefix: 'agy',
  caseInsensitiveUuid: true,
  requireProvider: '',
  requireIdentity: false,
  requireCwdString: false,
});

module.exports = {
  save: reg.save,
  remove: reg.remove,
  load: reg.load,
  remember: reg.remember,
  forget: reg.forget,
  list: reg.list,
};
