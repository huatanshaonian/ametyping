// The harnesses' newest versions and what changed in them, for the daily harness check (fleet/index.js) and the daily
// report: looked up on the NAS through the same proxies as everything that leaves it (summary.proxies), once a day.
//   claude    downloads.claude.ai's "latest" (what its own installer takes); notes: CHANGELOG.md on GitHub
//   codex     npm @openai/codex; notes: GitHub releases of openai/codex (tags rust-vX.Y.Z)
//   opencode  npm @opencode/cli (the 2.x line; npm's opencode-ai and the 1.x tags are the old line); notes: GitHub
//             releases of anomalyco/opencode (tags vX.Y.Z)
//   agy       the installer's manifest (antigravity-cli-auto-updater .../manifests/linux_amd64.json); no notes to read
//             (the changelog page is a script-built site): only the version and the link
// What changed is condensed by the model (the daily report's job) into a few lines, the major ones marked: new
// abilities, changed behaviour, things that break. <dataDir>/fleet/releases.json keeps the newest seen and the history.
'use strict';
const path = require('path');
const { request: httpsRequest } = require('../google/http');
const { readJsonSafe, writeJsonAtomic } = require('../lib/json-store');

const VER = /(\d+)\.(\d+)\.(\d+)/;
const parts = (s) => { const m = VER.exec(String(s || '')); return m ? m.slice(1).map(Number) : null; };
const cmp = (a, b) => { const x = parts(a), y = parts(b); if (!x || !y) return 0; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const plain = (s) => { const m = VER.exec(String(s || '')); return m ? m[0] : ''; };
// versions in (from, to]: a note of `v` counts when from < v <= to (no from: only `to` itself)
const inRange = (v, from, to) => cmp(v, to) <= 0 && (from ? cmp(v, from) > 0 : cmp(v, to) === 0);
const NOTES_MAX = 14000;

const LABELS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', agy: 'Antigravity' };
const LINKS = { claude: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md', codex: 'https://github.com/openai/codex/releases',
  opencode: 'https://github.com/anomalyco/opencode/releases', agy: 'https://antigravity.google/docs/changelog' };

const SUMMARY_SCHEMA = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['id', 'major', 'highlights', 'other'],
  properties: { id: { type: 'string' }, major: { type: 'array', items: { type: 'string' } }, highlights: { type: 'array', items: { type: 'string' } },
    other: { type: 'string' } } } } } };

function summaryPrompt(list) {
  return `下面是几个 AI 编程工具（harness）新版本的更新日志。用户每天用它们写代码、跑仿真，想知道有没有值得注意的变化。
对每个工具输出一项（id 照抄）：
- major：重大更新，每条一句中文。只放真正影响使用的：新功能或新命令、默认行为改变、可能让现有用法出错的破坏性变更、重要的安全修复。没有就给空数组，不要凑数。
- highlights：其余值得一提的改进，最多 4 条，每条一句中文。
- other：其余小修小补用一句话概括（例如"另有 12 项 bug 修复"），没有就空字符串。
只依据日志内容，不要猜测；专有名词、命令、参数保留原文。

${list.map((x) => `### ${x.id}（${LABELS[x.id]}）${x.from ? x.from + ' → ' : ''}${x.to}\n${x.notes}`).join('\n\n')}`;
}

function createReleases({ dataDir, egress = null, ask = null, log = () => {}, request = httpsRequest, now = () => Date.now() }) {
  const file = path.join(dataDir, 'fleet', 'releases.json');
  let state = { latest: {}, history: [], checkedAt: 0, error: '' };
  const loaded = readJsonSafe(file);
  if (loaded && typeof loaded === 'object') state = { ...state, ...loaded };
  function save() {
    writeJsonAtomic(file, state, { indent: 2, mode: 0o600 });
  }
  const UA = { 'User-Agent': 'Windose', Accept: 'application/json, text/plain, */*' };
  async function getText(url, headers = {}) {
    const r = await request(url, { headers: { ...UA, ...headers } }, egress);
    if (r.status !== 200) throw new Error(new URL(url).hostname + ' 回答 ' + r.status);
    return r.body.toString('utf8');
  }
  const getJSON = async (url, headers) => JSON.parse(await getText(url, headers));

  const NEWEST = {
    claude: async () => plain(await getText('https://downloads.claude.ai/claude-code-releases/latest')),
    codex: async () => plain((await getJSON('https://registry.npmjs.org/@openai/codex/latest')).version),
    opencode: async () => plain((await getJSON('https://registry.npmjs.org/@opencode/cli/latest')).version),
    agy: async () => plain((await getJSON('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json')).version),
  };
  // the notes of the versions in (from, to], newest first, as one text
  async function ghReleases(repo, tagOf, from, to) {
    const list = await getJSON(`https://api.github.com/repos/${repo}/releases?per_page=40`, { Accept: 'application/vnd.github+json' });
    return list.filter((r) => !r.draft && !r.prerelease && tagOf(r.tag_name) && inRange(tagOf(r.tag_name), from, to))
      .map((r) => `#### ${tagOf(r.tag_name)}\n${String(r.body || '').trim()}`).join('\n\n');
  }
  const NOTES = {
    async claude(from, to) {
      const md = await getText('https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md');
      return md.split(/^(?=## )/m).filter((s) => { const v = /^## (\S+)/.exec(s); return v && inRange(v[1], from, to); }).join('\n').trim();
    },
    codex: (from, to) => ghReleases('openai/codex', (t) => (/^rust-v(\d+\.\d+\.\d+)$/.exec(t) || [])[1], from, to),
    opencode: (from, to) => ghReleases('anomalyco/opencode', (t) => (/^v(\d+\.\d+\.\d+)$/.exec(t) || [])[1], from, to),
    agy: async () => '',
  };

  // the newest of each, and for each that moved on, what changed since `since[id]` (the oldest installed version on
  // the machines, so nothing between is skipped), condensed. -> { latest, fresh: [history entries added], errors }
  async function check({ since = {} } = {}) {
    const errors = {}, moved = [];
    await Promise.all(Object.keys(NEWEST).map(async (id) => {
      try {
        const v = await NEWEST[id]();
        if (!v) throw new Error('读不到版本号');
        const prev = state.latest[id] && state.latest[id].version;
        state.latest[id] = { version: v, at: now() };
        if (prev !== v) moved.push({ id, prev: prev || '', to: v });
      } catch (e) { errors[id] = e.message; }
    }));
    const fresh = [];
    if (moved.length) {
      const withNotes = [];
      for (const m of moved) {
        // from: the older of the newest seen before and the oldest still installed (a first check: just the newest)
        const from = [m.prev, plain(since[m.id])].filter(Boolean).sort(cmp)[0] || '';
        let notes = '';
        try { notes = (await NOTES[m.id](from, m.to)).slice(0, NOTES_MAX); } catch (e) { errors[m.id] = (errors[m.id] ? errors[m.id] + '；' : '') + '更新日志：' + e.message; }
        withNotes.push({ ...m, from, notes });
      }
      let sum = {};
      const toAsk = withNotes.filter((x) => x.notes);
      if (toAsk.length && ask) {
        try { for (const it of (await ask(summaryPrompt(toAsk), SUMMARY_SCHEMA, 'daily')).items || []) sum[it.id] = it; }
        catch (e) { errors.summary = '更新日志没能概括：' + e.message; log('harness 更新日志概括失败：' + e.message); }
      }
      for (const x of withNotes) {
        const s = sum[x.id];
        // without the model: the first lines of the notes as they are
        const raw = !s && x.notes ? x.notes.split('\n').map((l) => l.replace(/^[-*#\s]+/, '').trim()).filter((l) => l && !VER.test(l.slice(0, 12))).slice(0, 4) : [];
        fresh.push({ id: x.id, label: LABELS[x.id], from: x.from, to: x.to, at: now(), link: LINKS[x.id],
          major: s ? (s.major || []).slice(0, 6) : [], highlights: s ? (s.highlights || []).slice(0, 4) : raw, other: s ? String(s.other || '') : '',
          noNotes: !x.notes });
      }
      state.history = [...fresh, ...state.history].slice(0, 80);
    }
    state.checkedAt = now(); state.error = Object.values(errors).join('；');
    try { save(); } catch {}
    return { latest: state.latest, fresh, errors };
  }
  const latestOf = (id) => (state.latest[id] && state.latest[id].version) || '';
  const view = () => ({ latest: state.latest, checkedAt: state.checkedAt, error: state.error, history: state.history.slice(0, 12) });
  const historyBetween = (from, to) => state.history.filter((h) => h.at >= from && h.at < to);
  return { check, latestOf, view, historyBetween, LABELS };
}

module.exports = { createReleases, cmp, plain };
