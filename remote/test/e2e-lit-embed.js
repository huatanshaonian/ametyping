// e2e: 文献 × 向量. The literature module wired to the embedding subsystem (embed/), on a fake Zotero and a fake
// embedding service (OpenAI-style /health + /v1/embeddings; a deterministic bilingual "topic" embedding: Chinese and
// English phrasings of one subject share an axis), no network, no real Zotero:
//   A. in process -- feed.prefilterSemantic: a candidate sharing no word with the profile but on its very subject is
//      brought into the top of the list the model scores (keyword order alone leaves it at the tail); the service
//      offline / no embed: exactly the old keyword prefilter, no error;
//   B. the real server.js -- the library's vectors synced after Zotero is mirrored (server.js's litProvider: items,
//      the user's notes and annotations, the cards' Windose卡片 notes left out); /api/lit/library: a Chinese query
//      finds the English papers (hybrid), also through an annotation; ?mode=keyword: words only; the service offline:
//      the words' result with semantic:'unavailable'; /api/lit/similar: the nearest papers, itself left out.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const embedMod = require(R + '/server/embed');
const { truncateAndNormalize } = require(R + '/server/embed/client');
const { hashText } = require(R + '/server/embed/clean');
const { createFeed } = require(R + '/server/literature/feed');
const { createFakeZotero } = require('./fake-zotero');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-lit-embed-'));
const PORT = 18873;
const DIMS = 64;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 900)}`); };
async function until(fn, ms = 20000, step = 200) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; }

// ---- the fake embedding: one axis per subject, both languages ----
// (the query prefix "Instruct: Given a search query, retrieve relevant passages from coding-agent conversations and
// notes" matches none of these)
const TOPICS = [
  { idx: 0, re: /鞘套|黑障|plasma sheath|blackout/i },
  { idx: 1, re: /电子密度|electron density/i },
  { idx: 2, re: /wound|medicine|医学/i },
  { idx: 3, re: /etching|silicon|刻蚀/i },
  { idx: 4, re: /tokamak|fusion|聚变/i },
  { idx: 5, re: /雷达|radar|散射|scattering/i },
  { idx: 6, re: /机翼|wing|drag|阻力/i },
  { idx: 7, re: /网格|mesh|finite element/i },
];
function vecOf(text) {
  const raw = new Array(DIMS).fill(0);
  let hit = false;
  for (const t of TOPICS) if (t.re.test(text)) { raw[t.idx] += 10; hit = true; }
  if (!hit) raw[16 + (parseInt(hashText(text).slice(0, 4), 16) % (DIMS - 17))] = 10;
  return Array.from(truncateAndNormalize(raw, DIMS));
}
function embeddingsReply(body) {
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  return { data: inputs.map((txt, index) => ({ index, embedding: vecOf(String(txt)) })), usage: { prompt_tokens: inputs.length } };
}
// in process: a fetch; for the server: the same over HTTP
function mockFetch(online) {
  return async (url, opts = {}) => {
    if (!online()) throw new Error('ECONNREFUSED');
    if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    if (url.endsWith('/v1/embeddings')) { const r = embeddingsReply(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => r }; }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
}
function fakeEmbedServer() {
  const st = { online: true, embedded: 0 };
  const server = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c));
    req.on('end', () => {
      if (!st.online) { req.socket.destroy(); return; }
      const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/health') return send(200, { status: 'ok' });
      if (req.url === '/v1/embeddings' && req.method === 'POST') { const body = JSON.parse(Buffer.concat(cs).toString('utf8')); st.embedded += [].concat(body.input).length; return send(200, embeddingsReply(body)); }
      send(404, { error: 'not found' });
    });
  });
  return { st, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))), close: () => server.close() };
}

// ---- A. the push's prefilter ----
async function partA() {
  const prof = { line: '研究再入飞行器等离子体鞘套对雷达散射的影响', follow: {} };
  const profile = { get: () => prof, words: () => ['plasma sheath', 'electron density'], openQuestions: () => [{ text: '电子密度剖面怎么取' }] };
  const c = (id, title, abstract) => ({ id, title, abstract, sources: ['openalex'] });
  const list = [
    c('K1', 'Cold plasma treatment for chronic wound healing', 'A plasma medicine clinical study.'),
    c('K2', 'Plasma etching of silicon wafers', 'Etching rates under varying power.'),
    c('K3', 'Electron density in a tokamak edge', 'Fusion plasma edge electron density measurements.'),
    c('U1', 'Radar target recognition by deep networks', 'Radar returns classified by networks.'),
    c('U2', 'Sea clutter statistics for coastal radar', 'Radar clutter distributions.'),
    c('X', '高超声速再入黑障区的雷达散射特性', '再入飞行器周围的等离子体鞘套使电磁波衰减，雷达回波随之改变。'),
    c('U3', 'Through-wall radar imaging', 'Radar images behind walls.'),
    c('U4', 'Automotive radar interference', 'Radar interference between cars.'),
  ];
  const mk = (embed) => createFeed({ dir: fs.mkdtempSync(path.join(T, 'feed-')), cfg: {}, mirror: {}, profile, sources: {}, ask: async () => ({}), cards: {}, embed });
  let online = true;
  const embed = embedMod.open({ cfg: { url: 'http://127.0.0.1:1', key: 'k', dims: DIMS }, dataDir: fs.mkdtempSync(path.join(T, 'vec-')), fetchImpl: mockFetch(() => online) });
  try {
    const feed = mk(embed);
    const ids = (l) => l.map((x) => x.id);
    const kw = feed.prefilter(list), sem = await feed.prefilterSemantic(list);
    ok('A1 keyword prefilter (sync, unchanged): the Chinese paper on the very subject sinks to the tail', typeof feed.prefilter(list).then === 'undefined' && ids(kw).indexOf('X') >= 5 && kw[0].id === 'K3', ids(kw));
    ok('A2 prefilterSemantic: the same paper is brought to the front (top 2), the off-topic "plasma" papers pushed down', ids(sem).indexOf('X') <= 1 && ids(sem).indexOf('X') < ids(kw).indexOf('X') && ids(sem).indexOf('K1') > ids(kw).indexOf('K1') && sem.length === list.length, ids(sem));
    const top3 = await feed.prefilterSemantic(list, 3);
    ok('A3 the cut for the model (n=3): in it with vectors, not with words alone', ids(top3).includes('X') && !ids(feed.prefilter(list, 3)).includes('X'), [ids(top3), ids(feed.prefilter(list, 3))]);
    online = false;
    const off = await feed.prefilterSemantic(list, 5);
    ok('A4 the service offline: exactly the keyword prefilter, no error', JSON.stringify(ids(off)) === JSON.stringify(ids(feed.prefilter(list, 5))), ids(off));
    const none = await mk(null).prefilterSemantic(list, 4);
    ok('A5 no embed at all: the keyword prefilter; an empty list stays empty', JSON.stringify(ids(none)) === JSON.stringify(ids(feed.prefilter(list, 4))) && (await feed.prefilterSemantic([])).length === 0, ids(none));
  } finally { embed && embed.close(); }
}

// ---- B. the server ----
const zot = createFakeZotero({ webdavDir: fs.mkdtempSync(path.join(T, 'webdav-')),
  collections: [{ key: 'QPUW2W6R', name: '气动隐身' }],
  items: [
    { key: 'AAAAAAA1', itemType: 'journalArticle', title: 'Plasma sheath effects on the radar cross section of reentry vehicles', creators: [{ creatorType: 'author', lastName: 'Sun', firstName: 'Wei' }],
      date: '2018', abstractNote: 'Backscattering of a vehicle wrapped in a plasma sheath.', collections: ['QPUW2W6R'] },
    { key: 'AAAAAAA2', itemType: 'journalArticle', title: 'Electron density profiles in hypersonic boundary layers', creators: [{ creatorType: 'author', lastName: 'Li', firstName: 'Q.' }], date: '2020', abstractNote: 'Measured profiles.' },
    { key: 'AAAAAAA3', itemType: 'journalArticle', title: 'Wing planform optimization for drag reduction', creators: [{ creatorType: 'author', lastName: 'Chen', firstName: 'Y.' }], date: '2021', abstractNote: 'Lower drag by planform.' },
    // (the card's AI note on a paper about wings, talking of the sheath: not the user's, not in the vectors)
    { key: 'NOTEAAA3', itemType: 'note', parentItem: 'AAAAAAA3', note: '<p>等离子体鞘套 雷达 黑障 综述卡片</p>', tags: [{ tag: 'Windose卡片' }] },
    { key: 'AAAAAAA4', itemType: 'journalArticle', title: 'Unstructured grid generation for finite element solvers', creators: [{ creatorType: 'author', lastName: 'Ma', firstName: 'L.' }], date: '2019', abstractNote: 'Mesh quality metrics.' },
    { key: 'ATTAAAA4', itemType: 'attachment', parentItem: 'AAAAAAA4', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'ma2019.pdf' },
    // (the user's own annotation: this mesh paper matters for the blackout)
    { key: 'ANNAAAA4', itemType: 'annotation', parentItem: 'ATTAAAA4', annotationType: 'highlight', annotationText: 'grid near the shock', annotationComment: '黑障计算要用', annotationPageLabel: '3', annotationSortIndex: '00003' },
    { key: 'AAAAAAA5', itemType: 'journalArticle', title: 'Radio blackout during reentry and its mitigation', creators: [{ creatorType: 'author', lastName: 'Kim', firstName: 'M.' }], date: '2022', abstractNote: 'Communication loss.' },
  ] });

async function partB() {
  const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
  const fe = fakeEmbedServer();
  const zp = await zot.listen(), ep = await fe.listen();
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, FAKE_CODEX_LOG: path.join(T, 'codex.log') };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-lit-embed-1' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex-lit.js')] };
  cfg.embed = { url: `http://127.0.0.1:${ep}`, key: 'k', dims: DIMS, queryTimeoutMs: 1500 };
  cfg.literature = { zotero: `http://127.0.0.1:${zp}`, webdavDir: fs.mkdtempSync(path.join(T, 'wd-')), kbDir: path.join(T, 'kb'), refreshMs: 400, at: '23:59', visionMaxPages: 0,
    endpoints: { openalex: 'http://127.0.0.1:1/oa', s2: 'http://127.0.0.1:1/s2', dtic: 'http://127.0.0.1:1/dtic', crossref: 'http://127.0.0.1:1/cr', arxiv: 'http://127.0.0.1:1/arxiv', aiaa: 'http://127.0.0.1:1/aiaa', ntrs: 'http://127.0.0.1:1/ntrs', cn: false } };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const req = (method, p, cookie, body) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch {} resolve({ status: res.statusCode, j, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
    });
    r.on('error', () => resolve({ status: 0, j: null, cookie: '' }));
    r.end(data);
  });
  try {
    await until(async () => (await req('GET', '/login')).status === 200, 15000, 150);
    const { cookie } = await req('POST', '/api/login', '', { user: 'u', password: 'pw-lit-embed-1', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const G = async (p) => (await req('GET', p, cookie)).j;
    ok('B0 not logged in: /api/lit/similar refused', (await req('GET', '/api/lit/similar?key=AAAAAAA1')).status === 401);

    // the vectors follow the library: 5 papers; notes = the annotation only (the card's AI note left out)
    const st = await until(async () => { const s = await G('/api/embed/status'); return s && s.store && s.store.litItems === 5 && s; }, 20000);
    ok('B1 Zotero mirrored -> the library embedded (5 papers, 1 note: the annotation; the Windose卡片 note left out)', st && st.store.litItems === 5 && st.store.litNotes === 1, st && st.store);

    const Q = encodeURIComponent('等离子体鞘套 雷达');
    const hy = await G('/api/lit/library?q=' + Q), kw = await G('/api/lit/library?q=' + Q + '&mode=keyword');
    const hk = (hy.items || []).map((x) => x.key);
    ok('B2 hybrid: a Chinese query finds the English paper on it first', hy.semantic === 'ok' && hk[0] === 'AAAAAAA1', hy);
    ok('B3 hybrid: the papers on the blackout next -- one by its abstract, one only by the user\'s annotation; the wing paper (sheath only in the AI card note) below them',
      hk.indexOf('AAAAAAA5') > 0 && hk.indexOf('AAAAAAA4') > 0 && hk.indexOf('AAAAAAA3') > Math.max(hk.indexOf('AAAAAAA5'), hk.indexOf('AAAAAAA4')), hk);
    ok('B4 ?mode=keyword: words only -- nothing in English matches the Chinese words', kw.semantic === 'off' && kw.items.length === 0, kw);
    const kw2 = await G('/api/lit/library?q=plasma');
    ok('B5 an English word: its keyword match stays first in the fused list; the items keep the usual shape', kw2.semantic === 'ok' && kw2.items[0].key === 'AAAAAAA1' && 'citekey' in kw2.items[0] && 'pdf' in kw2.items[0], kw2.items.map((x) => x.key));
    const colOnly = await G('/api/lit/library?col=QPUW2W6R&q=' + Q);
    ok('B6 a collection chosen: the semantic hits stay inside it', colOnly.semantic === 'ok' && colOnly.items.map((x) => x.key).join() === 'AAAAAAA1', colOnly.items.map((x) => x.key));
    const noQ = await G('/api/lit/library');
    ok('B7 no query: the library as before (all 5, newest first), semantic off', noQ.semantic === 'off' && noQ.items.length === 5, noQ);

    const sim = await G('/api/lit/similar?key=AAAAAAA1&k=3');
    const sk = (sim.items || []).map((x) => x.key);
    ok('B8 /api/lit/similar: the nearest paper first (the blackout one), itself left out, k respected, scores rounded', sim.ok && sim.semantic === 'ok' && sk[0] === 'AAAAAAA5' && !sk.includes('AAAAAAA1') && sk.length === 3 &&
      sim.items.every((x) => typeof x.score === 'number' && (String(x.score).split('.')[1] || '').length <= 4) && !!sim.items[0].title, sim);
    ok('B9 /api/lit/similar: an unknown or malformed key -> 404', (await req('GET', '/api/lit/similar?key=ZZZZZZZ9', cookie)).status === 404 && (await req('GET', '/api/lit/similar?key=../x', cookie)).status === 404);

    fe.st.online = false;
    const offHy = await G('/api/lit/library?q=plasma');
    ok('B10 the service offline: the keyword result, semantic "unavailable", no error', offHy.semantic === 'unavailable' && offHy.items.map((x) => x.key).join() === 'AAAAAAA1', offHy);
    const offCn = await G('/api/lit/library?q=' + Q);
    ok('B11 offline, the Chinese query: the words find nothing, said so (unavailable), not an error', offCn.semantic === 'unavailable' && offCn.items.length === 0, offCn);
    fe.st.online = true;
  } finally {
    srv.kill(); fe.close(); zot.close && zot.close();
    if (fail) console.log('--- server output (tail) ---\n' + out.slice(-3000));
  }
}

(async () => {
  try { await partA(); await partB(); }
  catch (e) { fail++; console.log('FAIL exception ' + (e.stack || e.message)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
