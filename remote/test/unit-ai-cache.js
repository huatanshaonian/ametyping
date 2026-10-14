// The Claude API's prompt cache (server/ai/anthropic-api.js), against a fake API here:
//   a prompt cut by CACHE_BREAK goes as text blocks, the first and the one before the last marked to be cached for an
//   hour (images before them); a prompt without the marks goes as it is; the tokens the call took (the cache read and
//   written) are told; the marks refused (a 400 about the cache): asked once more without them; plain() takes the marks
//   out for Codex / Claude Code. And the deep reading's chat prompt is laid out that way: what stays the same first,
//   the talk a turn a block, the question last.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { runApi, contentOf, CACHE_BREAK, plain } = require('../server/ai/anthropic-api');
const { chatPrompt } = require('../server/literature/prompts/reader');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 700)); } };
const KEY = 'sk-ant-api03-' + 'k'.repeat(40);
const B = CACHE_BREAK;

const bodies = []; let refuseCache = false;
const sse = (res, name, d) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...d })}\n\n`);
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const body = JSON.parse(b); bodies.push(body);
    const marked = Array.isArray(body.messages[0].content) && body.messages[0].content.some((x) => x.cache_control);
    if (refuseCache && marked) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'cache_control.ttl: 1h is not supported' } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, 'message_start', { message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 20, cache_read_input_tokens: marked ? 5000 : 0, cache_creation_input_tokens: marked ? 300 : 0 } } });
    sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: '{"answer":"好"}' } });
    sse(res, 'message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
    sse(res, 'message_stop', {}); res.end();
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

  const c = contentOf(`paper${B}turn 1${B}turn 2${B}question`, [], true);
  ok('marked: a block each, the first and the one before the last cached for an hour, the question not', Array.isArray(c) && c.length === 4 && c.map((x) => x.text).join('|') === 'paper|turn 1|turn 2|question' &&
    c[0].cache_control.ttl === '1h' && !c[1].cache_control && c[2].cache_control.type === 'ephemeral' && !c[3].cache_control, c);
  const c0 = contentOf(`paper${B}question`, [], true);
  ok('no talk yet: the paper cached, the question not', c0.length === 2 && !!c0[0].cache_control && !c0[1].cache_control, c0);
  ok('without marks: the prompt as it is; without the cache: the blocks joined', contentOf('just this', [], true) === 'just this' && contentOf(`a${B}b`, [], false) === 'ab');
  const img = path.join(os.tmpdir(), `ai-cache-${process.pid}.png`); fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const ci = contentOf(`a${B}b`, [img], true); fs.unlinkSync(img);
  ok('images go before the blocks', ci[0].type === 'image' && ci[1].text === 'a' && !!ci[1].cache_control);
  ok('plain() takes the marks out', plain(`a${B}b${B}c`) === 'abc' && plain('x') === 'x');

  let used = null;
  const v = await runApi({ key: KEY, model: 'claude-opus-5-5', effort: 'high', prompt: `paper${B}question`, schema, base, onUsage: (u) => { used = u; } });
  ok('asked with the blocks; the tokens told (read from the cache, written to it, the answer)', v.answer === '好' && Array.isArray(bodies[0].messages[0].content) && bodies[0].messages[0].content[0].cache_control &&
    used && used.cacheRead === 5000 && used.cacheWrite === 300 && used.input === 20 && used.output === 7, used);

  refuseCache = true; bodies.length = 0;
  const v2 = await runApi({ key: KEY, model: 'claude-opus-5-5', effort: 'high', prompt: `paper${B}question`, schema, base });
  ok('the marks refused: asked once more without them, answered', v2.answer === '好' && bodies.length === 2 && bodies[1].messages[0].content === 'paperquestion', bodies.map((b) => typeof b.messages[0].content));

  // the deep reading's chat prompt
  const it = { title: 'A paper', venue: 'TAP', year: 2018 };
  const p = chatPrompt({}, it, 'the card', { whole: [{ page: 1, text: 'page one' }, { page: 2, text: 'page two' }] }, [{ q: 'q1', a: 'a1 [p.1]', sel: 'sel one', page: 2 }, { q: 'q2', a: 'a2', sel: '', page: 0 }], 'q3', 'sel now', 1);
  const parts = p.split(B);
  ok('chat: the text first, a turn a block, the question last', parts.length === 4 && /全文（标了页码）：\n\[p\.1\]\npage one\n\n\[p\.2\]\npage two/.test(parts[0]) && /卡片：\nthe card/.test(parts[0]) &&
    /^之前的对话（按时间顺序）：\n\n### 第 1 轮\n用户（当时在看第 2 页）：\[选中了原文：“sel one”\] q1\n\n你：a1 \[p\.1\]/.test(parts[1]) && /^### 第 2 轮\n用户：q2\n\n你：a2/.test(parts[2]) &&
    /用户现在在看第 1 页。/.test(parts[3]) && /选中的文字：\nsel now/.test(parts[3]) && /用户的问题：q3$/.test(parts[3]) && !/q3/.test(parts.slice(0, 3).join('')), parts);
  const p3 = chatPrompt({}, it, 'the card', { whole: [{ page: 1, text: 'page one' }, { page: 2, text: 'page two' }] }, [{ q: 'q1', a: 'a1 [p.1]', sel: 'sel one', page: 2 }, { q: 'q2', a: 'a2', sel: '', page: 0 }, { q: 'q3', a: 'a3' }], 'q4', '', 0);
  ok('the next turn starts exactly the same (what the cache holds is read again): the same text block, the same blocks for the turns already there, the same blocks for the turns already there', p3.split(B)[0] === parts[0] && p3.split(B)[1] === parts[1] && p3.split(B)[2] === parts[2]);
  const pl = chatPrompt({}, it, '', { picked: [{ page: 7, text: 'page seven' }], n: 300 }, [], 'q', '', 7);
  ok('a long paper: no whole text; the pages for this question come with the question', !/全文/.test(pl.split(B)[0]) && /这篇共 300 页，太长/.test(pl.split(B)[1]) && /\[p\.7\]\npage seven/.test(pl.split(B)[1]));

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
