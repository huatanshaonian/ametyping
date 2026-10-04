// Keeping the Codex CLI on the NAS up to date (cli-admin.js does the work): the newest release from GitHub (tags look
// like rust-v0.158.0), `codex update`, and whether it is logged in (`codex login status` and when the sign-in was last
// refreshed -- no tokens are read out). The standalone install switches its `current` link to the new release, so a
// report being written at that moment carries on with the old one.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { request } = require('../google/http');
const { createCliAdmin } = require('./cli-admin');

// codex: { bin (path or [cmd, ...args]), pathPrefix }; egress: the proxies (null: direct)
function createCodexAdmin({ dataDir, codex, egress = null, codexHome = path.join(os.homedir(), '.codex'), log = () => {} }) {
  return createCliAdmin({ dataDir, egress, log, tool: {
    name: 'codex', label: 'Codex', bin: codex.bin, pathPrefix: codex.pathPrefix, versionHost: 'chatgpt.com', updateHost: 'github.com',
    async newest(eg) {
      const r = await request('https://api.github.com/repos/openai/codex/releases/latest', { headers: { 'User-Agent': 'Windose', Accept: 'application/vnd.github+json' } }, eg);
      if (r.status !== 200 || !r.json) throw new Error('GitHub 回答 ' + r.status);
      return String(r.json.tag_name || '');
    },
    async login(run) {
      const r = await run(['login', 'status'], { timeoutMs: 20e3 });
      let mode = '', refreshed = '';
      try { const a = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')); mode = String(a.auth_mode || ''); refreshed = String(a.last_refresh || ''); } catch {}
      const text = r.out.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
      return { ok: r.code === 0 && !/not logged in/i.test(text), text: text.slice(0, 200), mode, refreshed };
    },
  } });
}

module.exports = { createCodexAdmin };
