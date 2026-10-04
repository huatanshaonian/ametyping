// AI 模型 in the control panel: which model / effort each AI job uses (settings.js), and the Codex CLI kept up to date
// (codex.js). The web API:
//   GET  /api/ai                 the jobs, what each uses, the models the account has
//   POST /api/ai/set             { default?, tasks? }       (no code asked: it changes cost and speed, not access)
//   GET  /api/ai/codex[?check=1] version, newest release (as last looked up; check=1: look now), login state, last update
//   POST /api/ai/codex/update    run `codex update` (a code entered within the hour: it replaces software on the NAS)
'use strict';
const { createAiSettings } = require('./settings');
const { createCodexAdmin } = require('./codex');

function createAi({ dataDir, codex, egress, fallbackModel, codexHome, log = () => {}, audit = () => {} }) {
  const settings = createAiSettings({ dataDir, fallbackModel, codexHome });
  const admin = createCodexAdmin({ dataDir, codex, egress, codexHome, log });

  async function handle(req, res, url, ip, json, readBody, fresh) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/ai') { json(res, 200, settings.view()); return true; }
    if (req.method === 'GET' && p === '/api/ai/codex') { json(res, 200, await admin.status({ check: url.searchParams.get('check') === '1' })); return true; }
    if (req.method !== 'POST') return false;
    if (p === '/api/ai/set') {
      let d = {}; try { d = JSON.parse(await readBody(req, 16384)); } catch {}
      const r = settings.set(d);
      audit('ai-settings', ip);
      json(res, 200, { ...r, ...settings.view() });
      return true;
    }
    if (p === '/api/ai/codex/update') {
      if (!fresh()) { json(res, 200, { ok: false, need: 'totp', msg: '需要再输一次验证码' }); return true; }
      audit('codex-update', ip);
      json(res, 200, admin.update());
      return true;
    }
    return false;
  }
  return { handle, pick: settings.pick, settings, admin };
}

module.exports = { createAi };
