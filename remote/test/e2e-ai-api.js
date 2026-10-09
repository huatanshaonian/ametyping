// e2e: the Claude API as a third way to ask a model (server/ai: api-key.js, anthropic-api.js), against a fake API here.
// The key: put in behind a code, kept in a file of its own, never sent back; with it Claude's models are offered a
// second time ("api:<model>"). A job on one of them is asked over the API -- the model's own name, its effort, the
// answer forced into the job's schema, read from the stream -- and when the credit is used up the backup finishes it.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { forApi } = require(R + '/server/ai/anthropic-api');
const { answerFor } = require('./fake-answer');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-aiapi-'));
const PORT = 18884, API = 18885, KEY = 'sk-ant-api03-' + 'k'.repeat(40) + 'WXYZ';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 700)}`); };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; };

// ---- the fake API: /v1/models (is the key good), /v1/messages (a stream; `mode` makes it fail the ways the real one does)
const calls = []; let mode = '';
const sse = (res, name, d) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...d })}\n\n`);
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    const good = req.headers['x-api-key'] === KEY && req.headers['anthropic-version'] === '2023-06-01';
    const err = (status, type, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type, message } })); };
    if (!good) return err(401, 'authentication_error', 'invalid x-api-key');
    if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ type: 'model', id: 'claude-opus-5-5' }], has_more: true })); }
    const body = JSON.parse(b); calls.push(body);
    if (mode === 'broke') return err(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
    if (body.model === 'claude-sonnet-5' && body.output_config.effort) return err(400, 'invalid_request_error', 'output_config.effort: this model does not support the effort parameter');
    const prompt = body.messages[0].content, text = JSON.stringify(answerFor(body.output_config.format.schema, typeof prompt === 'string' ? prompt : prompt.find((x) => x.type === 'text').text));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, 'message_start', { message: { id: 'msg_1', role: 'assistant', content: [] } });
    sse(res, 'content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
    sse(res, 'content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '{"answer":"想一想"}' } });
    res.write('event: ping\ndata: {"type": "ping"}\n\n');
    if (mode === 'overloaded') { sse(res, 'error', { error: { type: 'overloaded_error', message: 'Overloaded' } }); return res.end(); }
    // the answer in pieces that do not end where an event ends (as the network delivers them)
    const cut = Math.floor(text.length / 3);
    const ev = [text.slice(0, cut), text.slice(cut, 2 * cut), text.slice(2 * cut)].map((t) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } })}\n\n`).join('');
    res.write(ev.slice(0, 37)); await sleep(30); res.write(ev.slice(37, ev.length - 9)); await sleep(30); res.write(ev.slice(ev.length - 9));
    sse(res, 'message_delta', { delta: { stop_reason: mode === 'long' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 12 } });
    sse(res, 'message_stop', {}); res.end();
  });
}).listen(API, '127.0.0.1');

// ---- the server: Codex and Claude Code as fakes, Claude Code's catalog
const HOME = path.join(T, 'codexhome'); fs.mkdirSync(HOME);
fs.writeFileSync(path.join(HOME, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], default_reasoning_level: 'medium', visibility: 'list' }] }));
const CHOME = path.join(T, 'claudehome'); fs.mkdirSync(path.join(CHOME, 'cache', 'model-catalog'), { recursive: true });
const eff = (rec, ...ids) => ({ type: 'effort', effort_options: ids.map((id) => ({ id, name: id, ...(id === rec ? { badge: { message: 'Recommended' } } : {}) })) });
fs.writeFileSync(path.join(CHOME, 'cache', 'model-catalog', 'a.json'), JSON.stringify({ version: 2, fetchedAt: 2000, catalog: { config: { models: [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main', thinking: eff('medium', 'low', 'medium', 'high', 'xhigh', 'max') },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'main', thinking: { type: 'none' } },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', section: 'overflow', thinking: eff('high', 'low', 'high') }] } } }));
const LOG = path.join(T, 'codex.log'), CLOG = path.join(T, 'claude.log');
const logOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
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
  // what the API takes of a schema: no sizes or ranges, every object closed -- a property that is itself called "title" kept
  const s = forApi({ type: 'object', properties: { title: { type: 'string', maxLength: 80, title: 'x' }, n: { type: 'integer', minimum: 0, maximum: 5 },
    list: { type: 'array', minItems: 2, maxItems: 9, items: { type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] } }, required: ['a'] } }, one: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['title'] });
  ok('the schema as the API takes it', JSON.stringify(s) === JSON.stringify({ type: 'object', properties: { title: { type: 'string' }, n: { type: 'integer' },
    list: { type: 'array', items: { type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] } }, required: ['a'], additionalProperties: false } }, one: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['title'], additionalProperties: false }), s);

  const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, FAKE_CODEX_LOG: LOG, FAKE_CLAUDE_LOG: CLOG, AME_SUMMARY_TICK_MS: '600000' };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')], codexHome: HOME,
    claude: [process.execPath, path.join(__dirname, 'fake-claude.js')], claudeHome: CHOME, claudeApiBase: `http://127.0.0.1:${API}` };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  fs.mkdirSync(path.join(T, 'srv', 'data', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(T, 'srv', 'data', 'reports', '2026-09-28.json'), JSON.stringify({ date: '2026-09-28', headline: '加密了网格', keywords: ['网格', 'mesh'], projects: [], stats: {} }));
  const KEYFILE = path.join(T, 'srv', 'data', 'anthropic-api.json');
  let srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  const askOnce = async (cookie, q) => { await req('POST', '/api/ask', { q }, cookie); return until(async () => { const j = ((await req('GET', '/api/ask', null, cookie)).j || {}).job; return j && !j.running && j; }); };
  try {
    await until(async () => (await req('GET', '/login')).status === 200);
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    let v = (await req('GET', '/api/ai', null, cookie)).j || {}, a = (await req('GET', '/api/ai/api', null, cookie)).j || {};
    ok('no key: no API models offered, the page says there is none', !v.models.some((m) => m.provider === 'api') && a.has === false && a.tail === '' && a.checked === null, [v.models, a]);
    ok('not logged in: refused', (await req('GET', '/api/ai/api')).status === 401 && (await req('POST', '/api/ai/api/key', { key: KEY })).status === 401);
    let r = (await req('POST', '/api/ai/api/key', { key: 'hello world' }, cookie)).j || {};
    ok('something that is no key: refused, nothing kept', r.ok === false && !fs.existsSync(KEYFILE), r);

    // the key put in: tried at once, kept in its own file, only its last four characters come back
    r = await req('POST', '/api/ai/api/key', { key: '  ' + KEY + '\n' }, cookie);
    ok('a key put in: found good at once; the answer has its last four characters, not the key', r.j.ok && r.j.api.has && r.j.api.tail === 'WXYZ' && r.j.api.checked.ok === true && r.j.api.setAt > 0 && !r.b.includes(KEY.slice(0, 30)), r.b);
    ok('kept in a file of its own', JSON.parse(fs.readFileSync(KEYFILE, 'utf8')).key === KEY);
    v = (await req('GET', '/api/ai', null, cookie));
    const am = v.j.models.filter((m) => m.provider === 'api');
    ok('Claude\'s models offered a second time, over the API: same efforts, told apart by name; the key in none of it', am.map((m) => m.slug).join() === 'api:claude-opus-5-5,api:claude-haiku-4-5-20251001,api:claude-sonnet-5' &&
      am[0].name === 'Opus 5.5（API）' && am[0].efforts.join() === 'low,medium,high,xhigh,max' && am[1].efforts.length === 0 && v.j.models.filter((m) => m.provider === 'claude').length === 3 && !v.b.includes('sk-ant'), am);

    // 问一问 on Opus over the API, GPT as the backup
    v = (await req('POST', '/api/ai/set', { default: { model: 'gpt-6-luna', effort: '' }, backup: { model: 'gpt-6-luna', effort: 'low' }, tasks: { ask: { model: 'api:claude-opus-5-5', effort: 'xhigh' } } }, cookie)).j || {};
    const use = (id) => (v.tasks.find((t) => t.id === id) || {}).uses || {};
    ok('a job set to an API model', use('ask').model === 'api:claude-opus-5-5' && use('ask').provider === 'api' && use('ask').effort === 'xhigh' && use('ask').backup.provider === 'codex' && use('daily').provider === 'codex', use('ask'));
    let job = await askOnce(cookie, '网格是怎么加密的？');
    const c0 = calls[0] || {};
    ok('问一问 answered over the API (the answer read from the stream, the thinking left out)', job && /mesh_refine/.test(job.answer || '') && !job.error && calls.length === 2 && logOf(LOG).length === 0 && logOf(CLOG).length === 0, [job, calls.length]);
    ok('asked as the API wants it: the model\'s own name, its effort, thinking, a stream, the schema, our system prompt', c0.model === 'claude-opus-5-5' && c0.stream === true && c0.max_tokens > 8000 &&
      c0.output_config.effort === 'xhigh' && c0.thinking.type === 'adaptive' && c0.output_config.format.type === 'json_schema' && c0.output_config.format.schema.additionalProperties === false &&
      /Windose/.test(c0.system) && c0.messages.length === 1 && c0.messages[0].role === 'user' && !c0.tools, c0);

    // a model without efforts: none sent; one the catalog gave efforts but the API refuses them for: asked again without
    v = (await req('POST', '/api/ai/set', { tasks: { ask: { model: 'api:claude-haiku-4-5-20251001', effort: 'high' } } }, cookie)).j || {};
    let n = calls.length; job = await askOnce(cookie, '网格？');
    ok('Haiku over the API: no effort, no thinking asked for', job && job.answer && calls.length === n + 2 && calls[n].model === 'claude-haiku-4-5-20251001' && !calls[n].thinking && !('effort' in calls[n].output_config), calls[n]);
    v = (await req('POST', '/api/ai/set', { tasks: { ask: { model: 'api:claude-sonnet-5', effort: 'high' } } }, cookie)).j || {};
    n = calls.length; job = await askOnce(cookie, '网格呢？');
    ok('the API refusing the effort for a model: asked once more without it, still answered by that model', job && job.answer && !job.error && calls.length === n + 4 && calls[n].output_config.effort === 'high' && !calls[n + 1].thinking && !calls[n + 1].output_config.effort && logOf(LOG).length === 0, [job, calls.length - n]);

    // the credit used up: the backup finishes the job, the page says why
    v = (await req('POST', '/api/ai/set', { tasks: { ask: { model: 'api:claude-opus-5-5', effort: 'low' } } }, cookie)).j || {};
    mode = 'broke'; n = calls.length;
    job = await askOnce(cookie, '网格的加密方法？');
    v = (await req('GET', '/api/ai', null, cookie)).j || {};
    ok('the credit used up: the job still answered, by the backup (Codex); the API tried once, then left to rest', job && /mesh_refine/.test(job.answer || '') && !job.error && calls.length === n + 1 && logOf(LOG).filter((x) => x.args.includes('exec')).length === 2, [job, calls.length - n, logOf(LOG).length]);
    ok('the page says the credit is used up', v.down.length === 1 && v.down[0].model === 'api:claude-opus-5-5' && /额度用完了/.test(v.down[0].error) && /credit balance/.test(v.down[0].error), v.down);
    // the stream breaking off with an error, an answer cut short: both failures, not half an answer
    const { runApi } = require(R + '/server/ai/anthropic-api');
    const direct = (m) => { mode = m; return runApi({ key: KEY, model: 'claude-opus-5-5', effort: '', prompt: '问', schema: { type: 'object', properties: { answer: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } } }, base: `http://127.0.0.1:${API}` }).then((x) => 'ok:' + x.answer.slice(0, 4), (e) => e.message); };
    const e1 = await direct('overloaded'), e2 = await direct('long'), e3 = await direct(''), e4 = await runApi({ key: 'sk-ant-wrong', model: 'x', prompt: '问', schema: {}, base: `http://127.0.0.1:${API}` }).catch((e) => e.message);
    ok('an error in the middle of the stream, an answer cut off at the limit, a wrong key: each said as it is', /overloaded_error/.test(e1) && /没写完/.test(e2) && e3 === 'ok:加密网格' && /不认这个 key/.test(e4), [e1, e2, e3, e4]);
    mode = '';

    // kept across a restart; taken away: the models go, a job still set to one falls to the backup
    srv.kill(); await sleep(500);
    srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
    await until(async () => (await req('GET', '/login')).status === 200);
    const c2 = (await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + 1) })).cookie;
    a = (await req('GET', '/api/ai/api', null, c2)).j || {};
    ok('after a restart: the key still there, tried when the page is opened', a.has && a.tail === 'WXYZ' && a.checked && a.checked.ok === true, a);
    n = calls.length; job = await askOnce(c2, '网格是怎么加密的？');
    ok('and used', job && job.answer && calls.length === n + 2 && calls[n].output_config.effort === 'low', [job, calls.length - n]);
    r = (await req('POST', '/api/ai/api/key', { key: '' }, c2)).j || {};
    v = (await req('GET', '/api/ai', null, c2)).j || {};
    ok('the key taken away: its file gone, the API models no longer offered', r.ok && r.api.has === false && !fs.existsSync(KEYFILE) && !v.models.some((m) => m.provider === 'api'), [r, v.models.length]);
    n = calls.length; const nx = logOf(LOG).length; job = await askOnce(c2, '网格？');
    ok('a job still set to an API model: not sent anywhere without a key, the backup answers', job && job.answer && !job.error && calls.length === n && logOf(LOG).length === nx + 2, [job, calls.length - n]);
    const aud = fs.readFileSync(path.join(T, 'srv', 'audit.log'), 'utf8');
    ok('the audit log has the key put in and taken away -- not the key', /ai-api-key-set/.test(aud) && /ai-api-key-removed/.test(aud) && !aud.includes('sk-ant'));
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    try { srv.kill(); } catch {}
    await sleep(400); try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
