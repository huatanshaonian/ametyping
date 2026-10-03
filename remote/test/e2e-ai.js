// e2e: 控制面板 → AI 模型 (server/ai): the models offered (Codex's cache, hidden ones left out), a default for every job
// and one job set on its own, an effort a model does not have falling back to its default, the choice reaching Codex
// (-m / -c model_reasoning_effort when 问一问 asks); Codex's version and login (no tokens out), the newest release as
// last looked up (kept across a restart), `codex update` behind a code and the version after it.
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
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, FAKE_CODEX_LOG: LOG, FAKE_CODEX_VERSION: VER, FAKE_CODEX_NEXT: '0.160.0', AME_SUMMARY_TICK_MS: '600000' };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')], codexHome: HOME };
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
    ok('the jobs and the models the account has (hidden ones left out); all on the configured model at first', v.tasks.length === 6 && v.models.map((m) => m.slug).join() === 'gpt-6-astra,gpt-6-sol,gpt-6-luna' &&
      v.tasks.every((t) => t.uses.model === 'gpt-6-luna' && t.uses.effort === '') && v.models[0].efforts.includes('ultra') && v.models[0].defaultEffort === 'low', v);
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

    // Codex itself
    let c = (await req('GET', '/api/ai/codex', null, cookie)).j || {};
    ok('Codex: version, logged in (ChatGPT, when refreshed), the release looked up 2 days ago -- no tokens in the answer', c.version === '0.158.0' && c.login.ok && c.login.mode === 'chatgpt' &&
      /2026-09-28/.test(c.login.refreshed) && c.latest === '0.160.0' && c.checkedAt > 0 && !/SECRET/.test(JSON.stringify(c)), c);
    ok('opening the page does not ask GitHub (the last answer shown)', c.latest === '0.160.0' && Date.now() - c.checkedAt > 86400e3);
    // update: needs a code entered within the hour (the login just gave one), runs in the background
    const u = (await req('POST', '/api/ai/codex/update', {}, cookie)).j || {};
    c = await until(async () => { const x = (await req('GET', '/api/ai/codex', null, cookie)).j || {}; return !x.updating && x.lastUpdate ? x : null; }) || {};
    ok('更新 Codex: runs `codex update`, the version after it, how it went', u.ok && c.version === '0.160.0' && c.lastUpdate.ok && c.lastUpdate.from === '0.158.0' && c.lastUpdate.to === '0.160.0', [u, c]);
    const aud = fs.readFileSync(path.join(T, 'srv', 'audit.log'), 'utf8');
    ok('the audit log has the settings change and the update', /ai-settings/.test(aud) && /codex-update/.test(aud));

    // kept across a restart: the settings, the release looked up
    srv.kill(); await sleep(500);
    srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
    await until(async () => (await req('GET', '/login')).status === 200);
    const { cookie: c2 } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + 1) });
    v = (await req('GET', '/api/ai', null, c2)).j || {};
    c = (await req('GET', '/api/ai/codex', null, c2)).j || {};
    ok('after a restart: the settings kept, the last look-up kept (not asked again)', (v.tasks.find((t) => t.id === 'ask') || {}).uses.model === 'gpt-6-astra' && c.latest === '0.160.0', [v.tasks, c.latest]);

    // without a code within the hour: asked for one (server/ai on its own)
    const { createAi } = require(R + '/server/ai');
    const ai = createAi({ dataDir: T, codex: { bin: [process.execPath, path.join(__dirname, 'fake-codex.js')] }, egress: null, fallbackModel: 'gpt-6-luna', codexHome: HOME });
    let ans = null;
    await ai.handle({ method: 'POST' }, null, new URL('http://x/api/ai/codex/update'), '1', (res, code, o) => { ans = o; }, async () => '{}', () => false);
    ok('更新 Codex needs a code entered within the hour', ans && ans.need === 'totp' && !ans.ok, ans);
    ai.admin.stop();
  } catch (e) { fail++; console.log('ERROR', e); }
  finally { srv.kill(); }
  await sleep(500);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
