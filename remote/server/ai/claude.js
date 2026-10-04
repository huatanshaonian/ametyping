// Keeping Claude Code on the NAS up to date (cli-admin.js does the work): the newest release as its own installer
// sees it (downloads.claude.ai's "latest"), `claude update`, and whether it is logged in (`claude auth status`: the
// way it signed in and the plan -- not the account's address, no tokens).
'use strict';
const { request } = require('../google/http');
const { createCliAdmin } = require('./cli-admin');

// claude: { bin (path or [cmd, ...args]), pathPrefix }; egress: the proxies (null: direct)
function createClaudeAdmin({ dataDir, claude, egress = null, log = () => {} }) {
  return createCliAdmin({ dataDir, egress, log, tool: {
    name: 'claude', label: 'Claude Code', bin: claude.bin, pathPrefix: claude.pathPrefix, versionHost: 'api.anthropic.com', updateHost: 'downloads.claude.ai',
    async newest(eg) {
      const r = await request('https://downloads.claude.ai/claude-code-releases/latest', { headers: { 'User-Agent': 'Windose' } }, eg);
      if (r.status !== 200) throw new Error('downloads.claude.ai 回答 ' + r.status);
      return r.body.toString('utf8').trim().slice(0, 40);
    },
    async login(run) {
      const r = await run(['auth', 'status', '--json'], { timeoutMs: 20e3 });
      let j = null; try { j = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch {}
      if (!j) return { ok: false, text: r.out.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '读不到登录状态', mode: '', plan: '' };
      return { ok: !!j.loggedIn, text: '', mode: String(j.authMethod || ''), plan: String(j.subscriptionType || '') };
    },
  } });
}

module.exports = { createClaudeAdmin };
