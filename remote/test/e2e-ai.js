// e2e: 控制面板 → AI 模型 (server/ai): the models offered (Codex's cache, hidden ones left out), a default for every job
// and one job set on its own, an effort a model does not have falling back to its default, the choice reaching Codex
// (-m / -c model_reasoning_effort when 问一问 asks); Codex's version and login (no tokens out), the newest release as
// last looked up (kept across a restart), `codex update` behind a code and the version after it; Claude Code the same
// way (its models from its own catalog, `claude -p`, `claude update`), and the backup model (后备模型) finishing a job
// when the chosen one fails.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-ai-'));
const PORT = 18880;
const LOG = path.join(T, 'codex.log'), VER = path.join(T, 'codex-version');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 700)}`); };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; };

// Codex's own folder: the models the account has, and its sign-in (the tokens must never come out)
const HOME = path.join(T, 'codexhome'); fs.mkdirSync(HOME);
const lv = (...e) => e.map((x) => ({ effort: x, description: x }));
fs.writeFileSync(path.join(HOME, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), default_reasoning_level: 'low', visibility: 'list' },
  { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', description: 'Workhorse', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), default_reasoning_level: 'medium', visibility: 'list' },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Fast', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max'), default_reasoning_level: 'medium', visibility: 'list' },
  { slug: 'codex-auto-review', display_name: 'Review', supported_reasoning_levels: lv('low'), visibility: 'hide' },
] }));
fs.writeFileSync(path.join(HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH' }, last_refresh: '2026-09-28T20:01:56Z' }));
fs.writeFileSync(VER, '0.158.0');
// Claude Code's folder: its model catalog (two catalog files, the newer one counts; main models first, Haiku without efforts)
const CHOME = path.join(T, 'claudehome'); fs.mkdirSync(path.join(CHOME, 'cache', 'model-catalog'), { recursive: true });
const eff = (rec, ...ids) => ({ type: 'effort', effort_options: ids.map((id) => ({ id, name: id, ...(id === rec ? { badge: { message: 'Recommended' } } : {}) })) });
const cat = (at, models) => JSON.stringify({ version: 2, fetchedAt: at, catalog: { surface: 'cc', config: { id: 'cc', models } } });
fs.writeFileSync(path.join(CHOME, 'cache', 'model-catalog', 'old.json'), cat(1000, [{ id: 'claude-opus-4-1', name: 'Opus 4.1', section: 'main' }]));
fs.writeFileSync(path.join(CHOME, 'cache', 'model-catalog', 'new.json'), cat(2000, [
  { id: 'claude-sonnet-5', name: 'Sonnet 5', section: 'overflow', thinking: eff('high', 'low', 'medium', 'high', 'xhigh', 'max') },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main', description: 'For complex work', thinking: eff('medium', 'low', 'medium', 'high', 'xhigh', 'max') },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'main', thinking: { type: 'none' } }]));
const CLOG = path.join(T, 'claude.log'), CVER = path.join(T, 'claude-version'), CODEX_DOWN = path.join(T, 'codex-down'), CLAUDE_DOWN = path.join(T, 'claude-down');
fs.writeFileSync(CVER, '2.1.288');
const logOf = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const req = (method, p, body, cookie) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, j, b, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.on('error', () => resolve({ status: 0 }));
  r.end(data);
});

(async () => {
  const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, FAKE_CODEX_LOG: LOG, FAKE_CODEX_VERSION: VER, FAKE_CODEX_NEXT: '0.160.0', AME_SUMMARY_TICK_MS: '600000',
    FAKE_CLAUDE_LOG: CLOG, FAKE_CLAUDE_VERSION: CVER, FAKE_CLAUDE_NEXT: '2.1.290', FAKE_CODEX_FAIL_FILE: CODEX_DOWN, FAKE_CLAUDE_FAIL_FILE: CLAUDE_DOWN };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')], codexHome: HOME,
    claude: [process.execPath, path.join(__dirname, 'fake-claude.js')], claudeHome: CHOME };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  // something to find for 问一问 (so it asks the model), and a release looked up two days ago
  fs.mkdirSync(path.join(T, 'srv', 'data', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(T, 'srv', 'data', 'reports', '2026-09-28.json'), JSON.stringify({ date: '2026-09-28', headline: '加密了网格', keywords: ['网格', 'mesh'], projects: [], stats: {} }));
  fs.writeFileSync(path.join(T, 'srv', 'data', 'codex-check.json'), JSON.stringify({ version: '0.160.0', at: Date.now() - 2 * 86400e3, error: '' }));
  let srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  try {
    await until(async () => (await req('GET', '/login')).status === 200);
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    let v = (await req('GET', '/api/ai', null, cookie)).j || {};
    ok('the jobs and the models the account has (hidden ones left out); all on the configured model at first', v.tasks.length === 10 && ['litFeed', 'litRead', 'litReview', 'litVision'].every((id) => v.tasks.some((t) => t.id === id)) && v.models.filter((m) => m.provider === 'codex').map((m) => m.slug).join() === 'gpt-6-astra,gpt-6-sol,gpt-6-luna' &&
      v.tasks.every((t) => t.uses.model === 'gpt-6-luna' && t.uses.effort === '' && t.uses.provider === 'codex' && !t.uses.backup) && v.models[0].efforts.includes('ultra') && v.models[0].defaultEffort === 'low', v);
    const cl = v.models.filter((m) => m.provider === 'claude');
    ok('Claude Code\'s models from its newest catalog: main ones first, efforts and the recommended one, Haiku without efforts', cl.map((m) => m.slug).join() === 'claude-opus-5-5,claude-haiku-4-5-20251001,claude-sonnet-5' &&
      cl[0].efforts.join() === 'low,medium,high,xhigh,max' && cl[0].defaultEffort === 'medium' && cl[0].name === 'Opus 5.5' && cl[1].efforts.length === 0 && cl[2].defaultEffort === 'high', cl);
    ok('not logged in: refused', (await req('GET', '/api/ai')).status === 401);

    // a default for all, 问一问 on its own, the weekly report asking luna for an effort luna does not have
    v = (await req('POST', '/api/ai/set', { default: { model: 'gpt-6-sol', effort: 'high' }, tasks: { ask: { model: 'gpt-6-astra', effort: 'xhigh' }, weekly: { model: 'gpt-6-luna', effort: 'ultra' }, daily: { model: 'bad model!', effort: '' } } }, cookie)).j || {};
    const use = (id) => (v.tasks.find((t) => t.id === id) || {}).uses || {};
    ok('a default for all, one job on its own; an effort the model lacks -> its default; a bad name ignored', v.ok && use('daily').model === 'gpt-6-sol' && use('daily').effort === 'high' &&
      use('ask').model === 'gpt-6-astra' && use('ask').effort === 'xhigh' && use('weekly').model === 'gpt-6-luna' && use('weekly').effort === '' && use('mailTriage').model === 'gpt-6-sol', v.tasks && v.tasks.map((t) => [t.id, t.uses]));

    // the choice reaches Codex
    await req('POST', '/api/ask', { q: '网格是怎么加密的？' }, cookie);
    await until(async () => { const s = ((await req('GET', '/api/ask', null, cookie)).j || {}).job; return s && !s.running && s; });
    const asked = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.args.includes('exec')) : [];
    ok('问一问 runs Codex with its own model and effort (-m gpt-6-astra -c model_reasoning_effort="xhigh")', asked.length >= 1 && asked.every((x) => x.args[x.args.indexOf('-m') + 1] === 'gpt-6-astra' &&
      x.args.includes('model_reasoning_effort="xhigh"')), asked.map((x) => x.args.slice(0, 8)));

    // a Claude model for one job: Claude Code runs it (no tools, its own short system prompt, nothing kept); Haiku
    // has no efforts, so none is passed
    v = (await req('POST', '/api/ai/set', { tasks: { mailDraft: { model: 'claude-haiku-4-5-20251001', effort: 'high' }, weekly: { model: '', effort: '' } } }, cookie)).j || {};
    ok('a job on Haiku: Claude Code runs it, no effort (Haiku has none)', use('mailDraft').model === 'claude-haiku-4-5-20251001' && use('mailDraft').provider === 'claude' && use('mailDraft').effort === '', use('mailDraft'));
    // the backup: Opus 5.5 at max; Codex out of order -> 问一问 still answered, by Claude; Codex then rests, the
    // second question of the same 问一问 (the answer after the search terms) goes to Claude straight away
    v = (await req('POST', '/api/ai/set', { backup: { model: 'claude-opus-5-5', effort: 'max' } }, cookie)).j || {};
    ok('the backup shown for every job', v.backup.model === 'claude-opus-5-5' && v.tasks.every((t) => t.uses.backup && t.uses.backup.model === 'claude-opus-5-5' && t.uses.backup.provider === 'claude' && t.uses.backup.effort === 'max'), v.tasks && v.tasks.map((t) => [t.id, t.uses]));
    fs.writeFileSync(CODEX_DOWN, '');
    const nCodex = logOf(LOG).length;
    await req('POST', '/api/ask', { q: '网格的加密方法？' }, cookie);
    const job = await until(async () => { const s = ((await req('GET', '/api/ask', null, cookie)).j || {}).job; return s && !s.running && s; });
    const byClaude = logOf(CLOG).filter((x) => x.args.includes('-p'));
    const a0 = byClaude[0] ? byClaude[0].args : [];
    ok('Codex failing: 问一问 still answered, by the backup', job && job.answer && /mesh_refine/.test(job.answer) && !job.error, job);
    ok('the backup runs as Claude Code: -p, its model and effort, no tools, own system prompt, nothing saved, JSON schema', byClaude.length >= 1 &&
      a0[a0.indexOf('--model') + 1] === 'claude-opus-5-5' && a0[a0.indexOf('--effort') + 1] === 'max' && a0[a0.indexOf('--tools') + 1] === '' &&
      a0.includes('--no-session-persistence') && a0.includes('--system-prompt') && a0[a0.indexOf('--setting-sources') + 1] === '' && !!JSON.parse(a0[a0.indexOf('--json-schema') + 1]).properties, a0);
    ok('Codex tried once, then rests: the next question of the same job went to Claude straight away', logOf(LOG).length - nCodex === 1 && byClaude.length === 2, [logOf(LOG).length - nCodex, byClaude.length]);
    v = (await req('GET', '/api/ai', null, cookie)).j || {};
    ok('the page tells which model failed and until when the other goes first', v.down.length === 1 && v.down[0].model === 'gpt-6-astra' && /stream disconnected/.test(v.down[0].error) && v.down[0].until > Date.now(), v.down);
    // both failing: the job fails, saying why for each
    fs.writeFileSync(CLAUDE_DOWN, '');
    await req('POST', '/api/ask', { q: '网格？' }, cookie);
    const bad = await until(async () => { const s = ((await req('GET', '/api/ask', null, cookie)).j || {}).job; return s && !s.running && s; });
    ok('both failing: the job fails, with both reasons', bad && /claude-opus-5-5/.test(bad.error) && /hit your limit/.test(bad.error) && /gpt-6-astra/.test(bad.error), bad);
    fs.rmSync(CODEX_DOWN); fs.rmSync(CLAUDE_DOWN);

    // Codex itself
    let c = (await req('GET', '/api/ai/codex', null, cookie)).j || {};
    ok('Codex: version, logged in (ChatGPT, when refreshed), the release looked up 2 days ago -- no tokens in the answer', c.version === '0.158.0' && c.login.ok && c.login.mode === 'chatgpt' &&
      /2026-09-28/.test(c.login.refreshed) && c.latest === '0.160.0' && c.checkedAt > 0 && !/SECRET/.test(JSON.stringify(c)), c);
    ok('opening the page does not ask GitHub (the last answer shown)', c.latest === '0.160.0' && Date.now() - c.checkedAt > 86400e3);
    // update: needs a code entered within the hour (the login just gave one), runs in the background
    const u = (await req('POST', '/api/ai/codex/update', {}, cookie)).j || {};
    c = await until(async () => { const x = (await req('GET', '/api/ai/codex', null, cookie)).j || {}; return !x.updating && x.lastUpdate ? x : null; }) || {};
    ok('更新 Codex: runs `codex update`, the version after it, how it went', u.ok && c.version === '0.160.0' && c.lastUpdate.ok && c.lastUpdate.from === '0.158.0' && c.lastUpdate.to === '0.160.0', [u, c]);
    // Claude Code itself: version, login (the way and the plan -- not the address), `claude update`
    let k = (await req('GET', '/api/ai/claude', null, cookie)).j || {};
    ok('Claude Code: version, logged in (claude.ai, max) -- the account\'s address not in the answer', k.version === '2.1.288' && k.login.ok && k.login.mode === 'claude.ai' && k.login.plan === 'max' &&
      !/example\.com/.test(JSON.stringify(k)), k);
    const ku = (await req('POST', '/api/ai/claude/update', {}, cookie)).j || {};
    k = await until(async () => { const x = (await req('GET', '/api/ai/claude', null, cookie)).j || {}; return !x.updating && x.lastUpdate ? x : null; }) || {};
    ok('更新 Claude Code: runs `claude update`, the version after it', ku.ok && k.version === '2.1.290' && k.lastUpdate.ok && k.lastUpdate.from === '2.1.288' && k.lastUpdate.to === '2.1.290', [ku, k]);
    const aud = fs.readFileSync(path.join(T, 'srv', 'audit.log'), 'utf8');
    ok('the audit log has the settings change and the updates', /ai-settings/.test(aud) && /codex-update/.test(aud) && /claude-update/.test(aud));

    // kept across a restart: the settings, the release looked up
    srv.kill(); await sleep(500);
    srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
    await until(async () => (await req('GET', '/login')).status === 200);
    const { cookie: c2 } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + 1) });
    v = (await req('GET', '/api/ai', null, c2)).j || {};
    c = (await req('GET', '/api/ai/codex', null, c2)).j || {};
    ok('after a restart: the settings kept (the backup too), the last look-up kept (not asked again)', (v.tasks.find((t) => t.id === 'ask') || {}).uses.model === 'gpt-6-astra' && v.backup.model === 'claude-opus-5-5' && c.latest === '0.160.0', [v.tasks, v.backup, c.latest]);

    // without a code within the hour: asked for one (server/ai on its own)
    const { createAi } = require(R + '/server/ai');
    const ai = createAi({ dataDir: T, codex: { bin: [process.execPath, path.join(__dirname, 'fake-codex.js')] }, egress: null, fallbackModel: 'gpt-6-luna', codexHome: HOME });
    let ans = null;
    await ai.handle({ method: 'POST' }, null, new URL('http://x/api/ai/codex/update'), '1', (res, code, o) => { ans = o; }, async () => '{}', () => false);
    ok('更新 Codex needs a code entered within the hour', ans && ans.need === 'totp' && !ans.ok, ans);
    ai.stop();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally { srv.kill(); }
  await sleep(500);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
