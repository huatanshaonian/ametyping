// Windose selects a local cc-environments entry; credentials never come from a NAS mirror.
'use strict';
const path = require('path');
const fs = require('fs');
const source = path.join(__dirname, '..', 'remote', 'agent', 'claude-profiles.js');
const { createProfiles } = require(fs.existsSync(source) ? source : path.join(process.resourcesPath, 'claude-profiles.js'));
function localApi(value) {
  if (!value || value.local !== true || typeof value.id !== 'string') return null;
  try { return createProfiles().resolve(value.id); } catch { return null; }
}
function resumePlan(id, env = process.env, options = {}) {
  if (!id) return { ok: true, env: { ...env, AME_CLAUDE_API: '' }, command: null, cleanup() {} };
  try {
    const command = createProfiles().command(id, { ...options, env });
    return { ok: true, env: command.env, command, cleanup: command.cleanup };
  } catch (e) { return { ok: false, msg: e.message + '；为避免切换 API，先不续聊。' }; }
}
function settingsFile(api) {
  try { const r = createProfiles().runtime(api.id); return { file: r.file, args: r.args, cleanup: r.cleanup }; } catch { return null; }
}
module.exports = { createProfiles, localApi, valid: localApi, resumePlan, settingsFile, PROXY: /^(direct|inherit|https?:\/\/\S{1,480})$/ };
