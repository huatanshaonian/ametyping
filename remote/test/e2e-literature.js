// e2e: 文献. A throwaway server with the literature module on a fake Zotero (fake-zotero.js: library, WebDAV folder,
// write key, upload flow), fake paper sources (fake-lit-sources.js) and a fake model (fake-codex-lit.js):
//   the library mirrored (citation keys, annotations), a PDF read out of the WebDAV zip; the profile drafted (journals ->
//   ISSNs from the library, authors and key papers -> OpenAlex ids) and confirmed; the daily push (dedupe against the
//   library, the same paper from two sources merged, scored against the questions, the rest filled with a review);
//   收下 without write access refused, then granted; 收下 with an open PDF (into 每日文献/<month>, the PDF through the
//   upload flow, a quick card from the full text, a note back in Zotero); 收下 without a PDF (a card from the abstract,
//   "worth getting the full text", then the PDF dropped in later -> the card again from the text); a review's answers
//   into the card; 深读 (understanding + feedback, a chat with page references, 沉淀 -> proposals, accepted); a deep
//   card keeping the user's sections, an edited card not overwritten (a proposal instead), a stale save refused;
//   an action into 重要计划; a topic drafted from cards and a related-work paragraph; the output stats; no login = no.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createFakeZotero, toWebdav } = require('./fake-zotero');
const { createFakeSources } = require('./fake-lit-sources');
const { makePdf } = require('./make-pdf');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-lit-'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const WD = path.join(T, 'webdav'); fs.mkdirSync(WD);
const KB = path.join(T, 'kb');
const PORT = 18871;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 700)}`); };
const req = (method, p, body, cookie, raw) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    const cs = []; res.on('data', (c) => cs.push(c));
    res.on('end', () => { const b = Buffer.concat(cs); let j = null; try { j = JSON.parse(b.toString('utf8')); } catch {} resolve({ status: res.statusCode, j, body: b, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.on('error', () => resolve({ status: 0, j: null, body: Buffer.alloc(0), cookie: '' }));
  r.end(data);
});
async function until(fn, ms = 20000, step = 200) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; }

// the fake library
const PDF1 = makePdf(['plasma sheath electron density profile page one', 'collision frequency model page two']);
const zot = createFakeZotero({ webdavDir: WD,
  collections: [{ key: 'QPUW2W6R', name: '气动隐身' }, { key: '4WQG3HZQ', name: '等离子体RCS', parent: 'QPUW2W6R' }, { key: 'JDF645IP', name: '每日文献' }],
  items: [
    { key: 'AAAAAAA1', itemType: 'journalArticle', title: 'Backward scattering of a reentry vehicle in plasma sheath', creators: [{ creatorType: 'author', lastName: 'Sun', firstName: 'Wei' }],
      publicationTitle: 'IEEE Transactions on Antennas and Propagation', ISSN: '0018-926X', DOI: '10.1109/tap.2018.1', date: '2018', abstractNote: 'plasma sheath electron density and backscattering', collections: ['QPUW2W6R'], citationKey: 'sun2018backward' },
    { key: 'ATTAAAA1', itemType: 'attachment', parentItem: 'AAAAAAA1', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'sun2018.pdf' },
    { key: 'ANNAAAA1', itemType: 'annotation', parentItem: 'ATTAAAA1', annotationType: 'highlight', annotationText: 'electron density', annotationComment: '关键', annotationPageLabel: '1', annotationSortIndex: '00001' },
    { key: 'AAAAAAA2', itemType: 'journalArticle', title: 'Radar cross section of cones', creators: [{ creatorType: 'author', lastName: 'Ross', firstName: 'R.' }], date: '1990', collections: ['4WQG3HZQ'] },
    { key: 'AAAAAAA4', itemType: 'report', title: 'Attenuation of radio signals by a reentry plasma (RAM C)', creators: [{ creatorType: 'author', lastName: 'Grantham', firstName: 'W.' }], date: '1970', extra: 'NTRS: 19700001', institution: 'NASA Langley' },
    { key: 'ATTAAAA4', itemType: 'attachment', parentItem: 'AAAAAAA4', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'scan.pdf' },
    { key: 'AAAAAAA3', itemType: 'journalArticle', title: 'Plasma sheath blackout mitigation by magnetic window', creators: [{ creatorType: 'author', name: 'Kim' }], DOI: '10.2514/1.exist', date: '2020' },
  ] });
toWebdav(WD, 'ATTAAAA1', 'sun2018.pdf', PDF1);
toWebdav(WD, 'ATTAAAA4', 'scan.pdf', makePdf(['x']));          // (a scan: almost no text layer)
const src = createFakeSources();

(async () => {
  const zp = await zot.listen(), sp = await src.listen();
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, FAKE_CODEX_LOG: path.join(T, 'codex.log') };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex-lit.js')] };
  const base = `http://127.0.0.1:${sp}`;
  cfg.literature = { zotero: `http://127.0.0.1:${zp}`, webdavDir: WD, kbDir: KB, refreshMs: 400, pdfWaitMs: 2500, pollMs: 250, at: '23:59', daily: 3,
    endpoints: { openalex: base + '/oa', crossref: base + '/cr', arxiv: base + '/arxiv', aiaa: base + '/aiaa', ntrs: base + '/ntrs' } };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  try {
    await until(async () => (await req('GET', '/login')).status === 200, 15000, 150);
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const G = async (p) => (await req('GET', p, null, cookie)).j;
    const P = async (p, b) => (await req('POST', p, b || {}, cookie)).j;
    ok('not logged in: refused', (await req('GET', '/api/lit')).status === 401 && (await req('POST', '/api/lit/feed/run', {})).status === 401);

    // ---- the library ----
    const st = await until(async () => { const s = await G('/api/lit'); return s && s.zotero.items === 4 && s; });
    ok('the library is mirrored (4 papers, an annotation; no write access yet)', st && st.zotero.annotations === 1 && !st.zotero.canWrite, st);
    const lib = (await G('/api/lit/library')).items;
    const a1 = lib.find((x) => x.key === 'AAAAAAA1'), a2 = lib.find((x) => x.key === 'AAAAAAA2');
    ok('own citation keys kept, missing ones made (lastname+year+word); the PDF found in WebDAV', a1.citekey === 'sun2018backward' && a2.citekey === 'ross1990radar' && a1.pdf && !a2.pdf && a1.notes === 1, [a1, a2]);
    ok('a scanned NASA report: the card is made from NTRS own OCR text', (await P('/api/lit/card', { key: 'AAAAAAA4', kind: 'quick' })).ok &&
      !!(await until(async () => { const d = await G('/api/lit/item?key=AAAAAAA4'); return d.job && !d.job.running && d.card; }, 20000)) &&
      /NTRS OCR PAGE ONE plasma attenuation/.test(fs.readFileSync(path.join(T, 'codex.log'), 'utf8')), '');
    ok('a collection lists its sub-collections too', (await G('/api/lit/library?col=QPUW2W6R')).items.length === 2);
    ok('search by words', (await G('/api/lit/library?q=cones')).items.map((x) => x.key).join() === 'AAAAAAA2');
    const pdf = await req('GET', '/api/lit/pdf?key=AAAAAAA1', null, cookie);
    ok('the PDF comes out of the WebDAV zip', pdf.status === 200 && pdf.body.slice(0, 5).toString() === '%PDF-' && pdf.body.length === PDF1.length);
    ok('no PDF: 404', (await req('GET', '/api/lit/pdf?key=AAAAAAA2', null, cookie)).status === 404);

    // ---- the profile ----
    ok('the push refuses without a profile', (await P('/api/lit/feed/run')).ok && (await until(async () => { const f = await G('/api/lit/feed'); const r = (f.status.runs || []).slice(-1)[0]; return r && r.error; })), '');
    ok('filling refused before there is a main line', !(await P('/api/lit/profile/fill')).ok);
    ok('organizing refused without an account of the work', !(await P('/api/lit/profile/organize')).ok);
    const STORY = '我在做再入飞行器的气动隐身，主要算等离子体鞘套对 RCS 的影响，现在卡在电子密度剖面怎么取，也没有实测数据来验证。';
    ok('the user writes the account of the work, as it comes', (await P('/api/lit/profile/save', { story: STORY })).ok);
    ok('organizing started', (await P('/api/lit/profile/organize')).ok);
    let org = await until(async () => { const r = await G('/api/lit/profile'); return r.profile && r.profile.organizedAt && !r.state.running && r.profile; }, 30000);
    ok('organized: a main line, the questions in dimensions, each with why, where the field stands and its papers; what was unclear', org && org.line.startsWith('总目标：我在做再入飞行器') &&
      org.questions.map((q) => q.dim).join() === '贴合工作,领域前沿,方法与验证' && org.questions[0].why && org.unclear.length === 1 && org.story === STORY, org);
    const q1 = org.questions[0], qv = org.questions.find((q) => q.dim === '方法与验证');
    ok('a question\'s papers: the library\'s (with its key, to open) and the new ones (with a link); an unknown number dropped', q1.refs.length === 2 && q1.refs[0].key === 'AAAAAAA1' &&
      /blackout measurements/.test(q1.refs[1].title) && /^https?:/.test(q1.refs[1].url) && qv.refs.length === 1, org.questions);
    ok('the papers\' list numbers in the text become their titles', !/\b[LN]\d\b/.test(q1.state) && /《Plasma sheath communication/.test(q1.state) && /《Backward scattering/.test(q1.state), q1.state);
    const orgLog = fs.readFileSync(path.join(T, 'codex.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const plan = orgLog.find((x) => /queries/.test(x.kind)), qp = orgLog.find((x) => /line,questions,unclear/.test(x.kind));
    ok('organizing read the account, then the library\'s papers on it and the last years\' literature (the library\'s own left out of the new)', plan && /## 研究自述\n我在做再入飞行器/.test(plan.prompt) &&
      qp && /\[L1\]\* Backward scattering/.test(qp.prompt) && /\[N1\] Plasma sheath communication blackout/.test(qp.prompt) && !/\[N\d\] Plasma sheath blackout mitigation/.test(qp.prompt) &&
      src.hits.some((h) => /sort=relevance_score/.test(h) && /search=plasma\+sheath\+electron\+density/.test(h)), qp && qp.prompt.slice(-1500));
    const LINE = '博士课题：再入飞行器气动隐身。三条线：等离子体鞘套的电磁散射；RCS 高频方法与验证；气动外形与隐身的协同优化。';
    ok('the user corrects the main line and the questions', (await P('/api/lit/profile/save', { line: LINE, questions: org.questions })).ok);
    ok('filling started', (await P('/api/lit/profile/fill')).ok);
    let prof = await until(async () => { const r = await G('/api/lit/profile'); return r.profile && r.profile.filledAt && !r.state.running && r.profile; }, 30000);
    const venue = prof && prof.follow.venues.find((v) => /Antennas/.test(v.name)), aiaaJ = prof && prof.follow.venues.find((v) => v.name === 'AIAA Journal'), extra = prof && prof.follow.venues.find((v) => v.extra);
    ok('filled: journal -> ISSN from the library, AIAA -> its feed code, a journal the library lacks -> ISSN from OpenAlex, author -> OpenAlex id, key paper -> OpenAlex id',
      prof && venue.issns[0] === '0018-926X' && aiaaJ.aiaa === 'aiaaj' && extra && extra.name === 'Radio Science' && extra.issns.includes('0048-6604') &&
      prof.follow.authors[0].openalex === 'A123' && prof.follow.seeds[0].key === 'AAAAAAA1' && prof.follow.seeds[0].openalex === 'W9' && !prof.confirmed, prof);
    const br = prof.topics.find((t) => t.name === '等离子体鞘套电磁散射'), thin = prof.topics.find((t) => t.name === '气动隐身协同优化');
    ok('the branches: what each covers, how well the library covers it, its papers shown by title', br && br.coverage === '充足' && br.paperList[0].title.startsWith('Backward scattering') &&
      thin && thin.coverage === '较少' && !thin.papers.length, prof.topics);
    ok('no item key left in the prose: the paper\'s title instead', !/[A-Z0-9]{8}/.test(br.desc) && /《Backward scattering/.test(br.desc), br.desc);
    ok('the line and the user\'s questions untouched (the account too); the model\'s questions are suggestions only', prof.line === LINE && prof.story === STORY && prof.questions.map((q) => q.text).join('|') === org.questions.map((q) => q.text).join('|') && prof.questions[0].refs.length === 2 &&
      prof.suggestions.length === 1 && /试验/.test(prof.suggestions[0].text), [prof.questions, prof.suggestions]);
    const log1 = fs.readFileSync(path.join(T, 'codex.log'), 'utf8');
    ok('the filling was made from the line, the questions in order, and the whole library', log1.includes('再入飞行器气动隐身') && /Q1\. 鞘套电子密度剖面/.test(log1) &&
      /\[AAAAAAA1\]\*/.test(log1) && /\[AAAAAAA2\]/.test(log1) && /\[AAAAAAA4\]/.test(log1) && /IEEE Transactions on Antennas and Propagation（1）/.test(log1));
    const sv = await P('/api/lit/profile/save', { questions: [...prof.questions, { text: prof.suggestions[0].text, status: 'open' }], suggestions: [], confirm: true });
    ok('a suggestion taken in, confirmed', sv.ok && sv.profile.confirmed && sv.profile.questions.length === 4 && !sv.profile.suggestions.length && sv.profile.questions[0].dim === '贴合工作' && sv.profile.questions[0].refs.length === 2, sv);

    // ---- the daily push ----
    const hits0 = src.hits.length;
    await P('/api/lit/feed/run');
    const feed = await until(async () => { const f = await G('/api/lit/feed'); return !f.status.running && (f.status.runs || []).filter((r) => !r.error).length && f; }, 30000);
    const open = feed.items.filter((e) => e.status === 'new');
    const fresh = open.filter((e) => e.kind === 'new'), rev = open.filter((e) => e.kind === 'review');
    ok('two new papers (the two about plasma sheaths, best first), one review to fill the third place', fresh.length === 2 && rev.length === 1 && fresh.some((e) => /blackout measurements/.test(e.paper.title)) && fresh.some((e) => /RAM C-II/.test(e.paper.title)), open.map((e) => [e.kind, e.paper.title, e.score]));
    ok('the paper already in Zotero is not pushed; unrelated ones are not', !feed.items.some((e) => /magnetic window|stock|traffic/i.test(e.paper.title)), feed.items.map((e) => e.paper.title));
    const ramc = fresh.find((e) => /RAM C-II/.test(e.paper.title)), closed = fresh.find((e) => /blackout/.test(e.paper.title));
    ok('the same paper from OpenAlex and AIAA is one, with the open PDF link; the why and the question number', ramc.paper.sources.sort().join() === 'aiaa,openalex' && /\/pdf\/new1\.pdf$/.test(ramc.paper.pdf) && ramc.question === 1 && /剖面/.test(ramc.why), ramc);
    ok('the review: recall questions, from the annotated paper', rev[0].key === 'AAAAAAA1' && rev[0].mode === 'recall' && rev[0].recall.length === 2, rev[0]);
    const searches = src.hits.slice(hits0).filter((h) => h.startsWith('/oa/works?') && /[?&]search=/.test(h));
    ok('search phrases: 4 of the 5 today, without their quotes', searches.length === 4 && !searches.some((h) => /%22|"/.test(h)), searches);
    const ax = src.hits.find((h) => h.startsWith('/arxiv/api/query')) || '';
    ok('arXiv: the categories AND one of the profile\'s phrases', /cat%3Aphysics\.plasm-ph/.test(ax) && /abs%3A%22plasma\+sheath%22/.test(ax), ax);
    const run1 = feed.status.runs.filter((r) => !r.error).pop();
    ok('the run log counts each way of finding, and the good ones it brought', run1.sources['期刊'] === 3 && run1.sources['引用核心文献'] === 1 && run1.sources['AIAA 目录'] === 1 &&
      run1.good['期刊'] === 1 && run1.good['引用核心文献'] === 1 && run1.good['AIAA 目录'] === 1, run1);
    ok('the sources were asked: journals by ISSN, papers citing the key one, AIAA\'s feed, arXiv', ['/oa/works?filter=primary_location.source.issn%3A0018-926X', 'cites%3AW9', '/aiaa/action/showFeed', '/arxiv/api/query'].every((s) => src.hits.some((h) => h.includes(s))), src.hits);

    // ---- 收下 ----
    const k0 = await P('/api/lit/feed/keep', { id: ramc.id });
    ok('收下 without write access: refused, asks for the authorization', !k0.ok && k0.need === 'authorize', k0);
    ok('authorization started', (await P('/api/lit/zotero/authorize')).ok);
    ok('granted (the key kept, private)', await until(async () => (await G('/api/lit')).zotero.canWrite) && fs.existsSync(path.join(T, 'srv', 'data', 'literature', 'zotero-key.json')));
    const k1 = await P('/api/lit/feed/keep', { id: ramc.id });
    ok('收下: a Zotero item', k1.ok && /^[A-Z0-9]{8}$/.test(k1.key), k1);
    const e1 = await until(async () => { const f = await G('/api/lit/feed'); const e = f.items.find((x) => x.id === ramc.id); return e && e.intake && /ready|error/.test(e.intake.stage) && e; }, 30000);
    ok('the open PDF went to Zotero (upload flow) and the quick card was made from the text', e1 && e1.intake.stage === 'ready' && zot.writes.some((w) => w.kind === 'file'), e1 && e1.intake);
    const col = [...zot.cols.values()].find((c) => c.parent === 'JDF645IP');
    const made = zot.objs.get(k1.key);
    ok('filed in 每日文献/<this month>, tagged, with its DOI and abstract', col && /^\d{4}-\d{2}$/.test(col.name) && made.collections.includes(col.key) && made.tags.some((t) => t.tag === 'Windose推送') && made.DOI === '10.2514/1.new1' && /electron density/.test(made.abstractNote), [col, made]);
    const d1 = await G('/api/lit/item?key=' + k1.key);
    ok('the card: from the full text (page references), in the knowledge base as Markdown with front matter', d1.card && d1.card.meta.status === 'quick' && /\[p\.1\]/.test(d1.card.text) && /^---\ntitle: /.test(d1.card.text) &&
      fs.existsSync(path.join(KB, 'papers', d1.citekey + '.md')), d1.card);
    ok('a copy of the card went to Zotero as a note', [...zot.objs.values()].some((o) => o.itemType === 'note' && o.parentItem === k1.key && (o.tags || []).some((t) => t.tag === 'Windose卡片') && /<h2>/.test(o.note)));
    ok('the catalogue lists the card', /\[\[/.test(fs.readFileSync(path.join(KB, 'index.md'), 'utf8')));

    const k2 = await P('/api/lit/feed/keep', { id: closed.id });
    const e2 = await until(async () => { const f = await G('/api/lit/feed'); const e = f.items.find((x) => x.id === closed.id); return e && e.intake && /needs-pdf|ready|error/.test(e.intake.stage) && e; }, 30000);
    ok('no PDF: a card from the abstract, and the advice to get the full text', k2.ok && e2.intake.stage === 'needs-pdf' && /建议手动获取全文/.test(e2.intake.msg), e2 && e2.intake);
    const d2 = await G('/api/lit/item?key=' + k2.key);
    ok('that card says so too', d2.card && d2.card.meta.getpdf && !/\[p\.1\]/.test(d2.card.text), d2.card && d2.card.meta);
    zot.addPdf(k2.key, 'blackout.pdf', makePdf(['blackout telemetry measurements', 'attenuation versus altitude']));
    const e3 = await until(async () => { const f = await G('/api/lit/feed'); const e = f.items.find((x) => x.id === closed.id); return e && e.intake.stage === 'ready' && e; }, 20000);
    ok('the PDF dropped in later is noticed: the card is made again from the text', !!e3 && /\[p\.1\]/.test((await G('/api/lit/item?key=' + k2.key)).card.text));

    // ---- the review ----
    ok('review answered', (await P('/api/lit/feed/review', { id: rev[0].id, answers: ['指数分布', '约 10 dB'] })).ok);
    let a1d = await G('/api/lit/item?key=AAAAAAA1');
    ok('the answers are in the card\'s 我的笔记, dated', a1d.card && /## 我的笔记[\s\S]*复习 \d{4}-\d{2}-\d{2}[\s\S]*约 10 dB/.test(a1d.card.text), a1d.card && a1d.card.text);

    // ---- 深读 ----
    ok('understanding written', (await P('/api/lit/understand', { key: 'AAAAAAA1', text: '它测了鞘套的电子密度，用来算后向散射。' })).ok);
    const fb = await until(async () => { const r = await G('/api/lit/read?key=AAAAAAA1'); return r.feedback && !(r.job && r.job.running) && r; });
    ok('the feedback on it (with a page) and a question back; the understanding is in the card', fb.feedback && /\[p\.1\]/.test(fb.feedback.feedback) && fb.feedback.askBack && /## 我的理解\n\n它测了鞘套/.test((await G('/api/lit/item?key=AAAAAAA1')).card.text), fb);
    ok('a question asked', (await P('/api/lit/chat', { key: 'AAAAAAA1', q: 'collision frequency 怎么取？', sel: 'collision frequency model', page: 2 })).ok);
    const ch = await until(async () => { const r = await G('/api/lit/read?key=AAAAAAA1'); return r.turns && r.turns.length && !(r.job && r.job.running) && r; });
    const lg = fs.readFileSync(path.join(T, 'codex.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => /answer,askBack/.test(x.kind)).pop();
    ok('answered with a page reference; the question was sent with the selected text and the pages that matter', ch.turns[0].a.includes('[p.1]') && /collision frequency model page two/.test(lg.prompt) && /选中的文字/.test(lg.prompt), ch.turns);
    ok('沉淀 started', (await P('/api/lit/distill', { key: 'AAAAAAA1' })).ok);
    const props = await until(async () => { const r = await G('/api/lit/proposals'); return r.items.filter((x) => x.source === 'distill').length === 2 && r.items; });
    ok('two proposals (a section that does not exist goes to 我的笔记); nothing written yet', props && props.some((x) => x.op.section === '疑点') && props.some((x) => x.op.section === '我的笔记') &&
      !/对话发现/.test((await G('/api/lit/item?key=AAAAAAA1')).card.text), props);
    const pv = await G('/api/lit/proposal?id=' + props.find((x) => x.op.section === '疑点').id);
    ok('a proposal shows before / after', pv && !/对话发现/.test(pv.before) && /## 疑点\n\n- 对话发现/.test(pv.after), pv);
    ok('accepted -> written', (await P('/api/lit/proposal/accept', { id: pv.id })).ok && /对话发现/.test((await G('/api/lit/item?key=AAAAAAA1')).card.text));
    ok('rejected -> gone', (await P('/api/lit/proposal/reject', { id: props.find((x) => x.op.section === '我的笔记').id })).ok && !(await G('/api/lit/proposals')).items.some((x) => x.source === 'distill'));

    // ---- the deep card ----
    ok('deep card started', (await P('/api/lit/card', { key: 'AAAAAAA1', kind: 'deep' })).ok);
    a1d = await until(async () => { const d = await G('/api/lit/item?key=AAAAAAA1'); return d.job && !d.job.running && d; }, 30000);
    const t1 = a1d.card.text;
    ok('deep card: actions, page references, the user\'s sections kept, another card linked', a1d.card.meta.status === 'deep' && /## 可以采取的行动\n\n- \[ \] 用第 2 页/.test(t1) &&
      /## 我的理解\n\n它测了鞘套/.test(t1) && /## 我的笔记[\s\S]*约 10 dB/.test(t1) && /## 关系\n\n- 对比 \[\[/.test(t1) && /## 我的批注\n\n- “electron density” — 关键（p\.1）/.test(t1), t1);
    ok('its actions are listed', a1d.actions.length === 1 && /重算 X 波段/.test(a1d.actions[0].text));
    const edited = t1.replace(/## 问题\n\n问题/, '## 问题\n\n我改写过的问题');
    ok('the user edits the card (from the version opened)', (await P('/api/lit/kb/save', { path: a1d.card.path, text: edited, base: a1d.card.hash })).ok);
    ok('a save from an older version is refused, the file untouched', (await P('/api/lit/kb/save', { path: a1d.card.path, text: 'x', base: a1d.card.hash })).conflict &&
      /我改写过的问题/.test(fs.readFileSync(path.join(KB, a1d.card.path), 'utf8')));
    await P('/api/lit/card', { key: 'AAAAAAA1', kind: 'deep' });
    const a1e = await until(async () => { const d = await G('/api/lit/item?key=AAAAAAA1'); return d.job && !d.job.running && d.job.result && d; }, 30000);
    ok('a new deep card over an edited one becomes a proposal, the edit stays', a1e.job.result.proposed && /我改写过的问题/.test(a1e.card.text) && (await G('/api/lit/proposals')).items.some((x) => x.source === 'card'), a1e.job);
    ok('star / checked', (await P('/api/lit/card/meta', { key: 'AAAAAAA1', starred: true, verified: true })).ok && (await G('/api/lit/item?key=AAAAAAA1')).card.meta.status === 'reviewed' &&
      (await G('/api/lit/library?starred=1')).items.length === 1);
    ok('an action into 重要计划', (await P('/api/lit/action/todo', { key: 'AAAAAAA1', text: '用第 2 页的剖面重算 X 波段 RCS' })).ok &&
      ((await G('/api/todos')).items || []).some((t) => t.project === '文献' && /sun2018backward/.test(t.text)));

    // ---- topics ----
    const tp = await P('/api/lit/topic/create', { name: '等离子体鞘套', keywords: ['plasma sheath'] });
    ok('a topic page', tp.ok && fs.existsSync(path.join(KB, tp.path)));
    ok('the same name twice: refused', !(await P('/api/lit/topic/create', { name: '等离子体鞘套' })).ok);
    ok('topic update started', (await P('/api/lit/topic/update', { path: tp.path })).ok);
    const tprop = await until(async () => (await G('/api/lit/proposals')).items.find((x) => x.source === 'topic'));
    ok('the update waits as a proposal; accepted, the page cites cards', tprop && (await P('/api/lit/proposal/accept', { id: tprop.id })).ok && /## 空白与机会\n\n- 低空碰撞频率/.test(fs.readFileSync(path.join(KB, tp.path), 'utf8')) &&
      /\[\[/.test(fs.readFileSync(path.join(KB, tp.path), 'utf8')), tprop);
    const rw = await P('/api/lit/topic/related', { path: tp.path });
    ok('a related-work paragraph with \\cite', rw.ok && /\\cite\{/.test(rw.paragraph), rw);
    ok('the knowledge base is searchable', (await G('/api/lit/kb/search?q=' + encodeURIComponent('低空碰撞频率'))).items.some((x) => x.path === tp.path));

    // ---- what reading turned into ----
    const s7 = await G('/api/lit/stats?days=7');
    ok('the output stats', s7.understanding >= 1 && s7.kept >= 2 && s7.cards.verified === 1 && s7.actions.added === 1 && s7.feed.kept === 2 && s7.feed.reviewed === 1 && /产出/.test(s7.verdict), s7);
    ok('the morning note counts what is still open', (await G('/api/lit')).morning.new === 0);
  } catch (e) { fail++; console.log('ERROR', e); }
  finally {
    srv.kill(); zot.close(); src.close(); await sleep(400);
    if (fail) console.log('--- server output ---\n' + out.slice(-3000));
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
