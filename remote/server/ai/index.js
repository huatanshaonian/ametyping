// AI 模型 in the control panel: which model / effort each AI job uses and the backup model (settings.js), asking the
// models -- Codex, Claude Code or the Claude API, the backup when the first fails (ask.js) -- both tools kept up to
// date (codex.js, claude.js), and the Claude API's key (api-key.js). The web API:
//   GET  /api/ai                   the jobs, what each uses, the models the accounts have, the backup, models resting after a failure
//   POST /api/ai/set               { default?, backup?, tasks? }   (no code asked: it changes cost and speed, not access)
//   GET  /api/ai/<tool>[?check=1]  codex | claude: version, newest release (as last looked up; check=1: look now), login state, last update
//   POST /api/ai/<tool>/update     run `codex update` / `claude update` (a code entered within the hour: it replaces software on the NAS)
//   GET  /api/ai/api[?check=1]     the Claude API: is there a key (its last four characters, never the key), when it was last found good (check=1: ask now)
//   POST /api/ai/api/key           { key }   put a key in ('' takes it away); a code entered within the hour: it decides who pays
'use strict';
const { createAiSettings } = require('./settings');
const { createAsk } = require('./ask');
const { createCodexAdmin } = require('./codex');
const { createClaudeAdmin } = require('./claude');
const { createApiKey } = require('./api-key');
const { checkKey } = require('./anthropic-api');

// codex / claude: { bin, pathPrefix, timeoutMs }; apiBase: another address for the Claude API (tests)
function createAi({ dataDir, codex, claude = { bin: 'claude' }, egress, fallbackModel, codexHome, claudeHome, apiBase = '', log = () => {}, audit = () => {} }) {
  const apiKey = createApiKey({ dataDir });
  const settings = createAiSettings({ dataDir, fallbackModel, codexHome, claudeHome, hasApi: apiKey.has });
  const asker = createAsk({ codex, claude, api: { key: apiKey.get, base: apiBase, timeoutMs: codex.timeoutMs }, egress, pick: settings.pick, log });
  // the key as last tried against the API: { at, ok, error }
  let checked = null;
  async function apiStatus(check) {
    if (apiKey.has() && (check || !checked)) {
      try { await checkKey({ key: apiKey.get(), egress, base: apiBase }); checked = { at: Date.now(), ok: true, error: '' }; }
      catch (e) { checked = { at: Date.now(), ok: false, error: String(e.message).slice(0, 300) }; }
    }
    return { ...apiKey.view(), checked: apiKey.has() ? checked : null };
  }
  const admins = { codex: createCodexAdmin({ dataDir, codex, egress, codexHome, log }), claude: createClaudeAdmin({ dataDir, claude, egress, log }) };
  const view = () => ({ ...settings.view(), down: asker.state() });

  async function handle(req, res, url, ip, json, readBody, fresh) {
    const p = url.pathname;
    const tool = /^\/api\/ai\/(codex|claude)(\/update)?$/.exec(p);
    if (req.method === 'GET' && p === '/api/ai') { json(res, 200, view()); return true; }
    if (req.method === 'GET' && tool && !tool[2]) { json(res, 200, await admins[tool[1]].status({ check: url.searchParams.get('check') === '1' })); return true; }
    if (req.method === 'GET' && p === '/api/ai/api') { json(res, 200, await apiStatus(url.searchParams.get('check') === '1')); return true; }
    if (req.method !== 'POST') return false;
    if (p === '/api/ai/api/key') {
      if (!fresh()) { json(res, 200, { ok: false, need: 'totp', msg: '需要再输一次验证码' }); return true; }
      let d = {}; try { d = JSON.parse(await readBody(req, 4096)); } catch {}
      const r = apiKey.set(d.key);
      if (r.ok) { checked = null; audit(d.key ? 'ai-api-key-set' : 'ai-api-key-removed', ip); }
      json(res, 200, { ...r, api: r.ok ? await apiStatus(true) : undefined });
      return true;
    }
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
