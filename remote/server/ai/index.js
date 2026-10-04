// AI 模型 in the control panel: which model / effort each AI job uses and the backup model (settings.js), asking the
// models -- Codex or Claude Code, the backup when the first fails (ask.js) -- and both tools kept up to date (codex.js,
// claude.js). The web API:
//   GET  /api/ai                   the jobs, what each uses, the models the accounts have, the backup, models resting after a failure
//   POST /api/ai/set               { default?, backup?, tasks? }   (no code asked: it changes cost and speed, not access)
//   GET  /api/ai/<tool>[?check=1]  codex | claude: version, newest release (as last looked up; check=1: look now), login state, last update
//   POST /api/ai/<tool>/update     run `codex update` / `claude update` (a code entered within the hour: it replaces software on the NAS)
'use strict';
const { createAiSettings } = require('./settings');
const { createAsk } = require('./ask');
const { createCodexAdmin } = require('./codex');
const { createClaudeAdmin } = require('./claude');

// codex / claude: { bin, pathPrefix, timeoutMs }
function createAi({ dataDir, codex, claude = { bin: 'claude' }, egress, fallbackModel, codexHome, claudeHome, log = () => {}, audit = () => {} }) {
  const settings = createAiSettings({ dataDir, fallbackModel, codexHome, claudeHome });
  const asker = createAsk({ codex, claude, egress, pick: settings.pick, log });
  const admins = { codex: createCodexAdmin({ dataDir, codex, egress, codexHome, log }), claude: createClaudeAdmin({ dataDir, claude, egress, log }) };
  const view = () => ({ ...settings.view(), down: asker.state() });

  async function handle(req, res, url, ip, json, readBody, fresh) {
    const p = url.pathname;
    const tool = /^\/api\/ai\/(codex|claude)(\/update)?$/.exec(p);
    if (req.method === 'GET' && p === '/api/ai') { json(res, 200, view()); return true; }
    if (req.method === 'GET' && tool && !tool[2]) { json(res, 200, await admins[tool[1]].status({ check: url.searchParams.get('check') === '1' })); return true; }
    if (req.method !== 'POST') return false;
    if (p === '/api/ai/set') {
      let d = {}; try { d = JSON.parse(await readBody(req, 16384)); } catch {}
      const r = settings.set(d);
      audit('ai-settings', ip);
      json(res, 200, { ...r, ...view() });
      return true;
    }
    if (tool && tool[2]) {
      if (!fresh()) { json(res, 200, { ok: false, need: 'totp', msg: '需要再输一次验证码' }); return true; }
      audit(tool[1] + '-update', ip);
      json(res, 200, admins[tool[1]].update());
      return true;
    }
    return false;
  }
  return { handle, pick: settings.pick, ask: asker.ask, settings, admin: admins.codex, admins,
    stop() { for (const a of Object.values(admins)) a.stop(); } };
}

module.exports = { createAi };
