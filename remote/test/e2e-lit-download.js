// e2e: 文献 › 按 DOI 下载 and its MCP. A throwaway server with the literature module on a fake Zotero, fake paper
// records (OpenAlex / Crossref) and a fake browser for the library access; the MCP (server/literature/mcp.js) run as a
// real child process over the module's local socket:
//   the MCP says its limits (initialize, the tools); more than 20 DOIs refused; not a DOI refused; the same DOI twice in
//   one call is one; without write access to Zotero a job waits and says the user is needed; then: an open-access paper
//   -> a Zotero item in 文献下载 (tagged), its PDF attached, saved by save_pdf (no overwrite, relative paths refused);
//   a paper already in the library with its PDF -> done, nothing made; one only Crossref knows -> made from that record;
//   a DOI nobody knows -> failed, nothing made; without the library access -> failed, asked again within the hour ->
//   the same job, not tried; from the window: tried at once, through the library access now -> done; a site's robot
//   check -> blocked, needs the user; two agents asking for the same new DOI at the same moment -> one item;
//   the window's box takes DOIs out of pasted text; the bridge (what --ssh speaks) answers the same; no login = no.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process'), readline = require('readline');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createFakeZotero, toWebdav } = require('./fake-zotero');
const { createFakeBrowser } = require('./fake-browser');
const { makePdf } = require('./make-pdf');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-litdl-'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const WD = path.join(T, 'webdav'); fs.mkdirSync(WD);
const OUT = path.join(T, 'out'); fs.mkdirSync(OUT);
const PORT = 18879;
const SOCK = process.platform === 'win32' ? '\\\\.\\pipe\\ame-lit-test-' + process.pid : path.join(T, 'srv', 'agent.sock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 900)}`); };
const req = (method, p, body, cookie) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`,
    'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    const cs = []; res.on('data', (c) => cs.push(c));
    res.on('end', () => { const b = Buffer.concat(cs); let j = null; try { j = JSON.parse(b.toString('utf8')); } catch {} resolve({ status: res.statusCode, j, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.on('error', () => resolve({ status: 0, j: null, cookie: '' }));
  r.end(data);
});
async function until(fn, ms = 15000, step = 100) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; }

// the records: OpenAlex knows three, Crossref one more; the open one's PDF is served here
const OA_PDF = makePdf(['an open access paper', 'page two']), LIB_PDF = makePdf(['through the library access']);
let srcPort = 0;
const work = (doi, title, pdf) => ({ id: 'https://openalex.org/W' + doi.length, doi: 'https://doi.org/' + doi, title, publication_year: 2025, publication_date: '2025-03-01', type: 'article',
  authorships: [{ author: { display_name: 'Wei Sun', id: 'https://openalex.org/A1' } }], primary_location: { source: { display_name: 'Radio Science' } }, best_oa_location: pdf ? { pdf_url: pdf } : null });
const src = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://x'), p = decodeURIComponent(u.pathname);
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const W = { '10.5555/open': work('10.5555/open', 'An open access paper on plasma sheaths', `http://127.0.0.1:${srcPort}/pdf/open.pdf`),
    '10.1016/new': work('10.1016/new', 'A subscribed paper on radar cross sections', null), '10.1016/check': work('10.1016/check', 'A paper behind a robot check', null),
    '10.1016/race': work('10.1016/race', 'A paper two agents want', null) };
  if (p.startsWith('/oa/works/doi:')) { const w = W[p.slice('/oa/works/doi:'.length)]; if (w) return json(w); res.writeHead(404); return res.end('{}'); }
  if (p === '/cr/works/10.5555/crossonly') return json({ message: { DOI: '10.5555/CrossOnly', title: ['Only Crossref has this one'], author: [{ family: 'Ross', given: 'R.' }], 'container-title': ['AIAA Journal'], issued: { 'date-parts': [[2024, 5]] }, type: 'journal-article' } });
  if (p === '/pdf/open.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(OA_PDF); }
  res.writeHead(404); res.end('{}');
});

const zot = createFakeZotero({ webdavDir: WD, collections: [{ key: 'JDF645IP', name: '每日文献' }],
  items: [{ key: 'HAVEPDF1', itemType: 'journalArticle', title: 'Already in the library with its PDF', DOI: '10.1109/have', creators: [{ creatorType: 'author', lastName: 'Li', firstName: 'A.' }], date: '2020' },
    { key: 'ATTHAVE1', itemType: 'attachment', parentItem: 'HAVEPDF1', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'have.pdf' }] });
toWebdav(WD, 'ATTHAVE1', 'have.pdf', makePdf(['already here']));
const br = createFakeBrowser({ pdf: LIB_PDF });

// an MCP client: the server's mcp.js as a child, JSON-RPC lines
function mcpClient(extra) {
  const c = cp.spawn(process.execPath, [R + '/server/literature/mcp.js', ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
  let n = 0; const wait = new Map(); let err = '';
  readline.createInterface({ input: c.stdout }).on('line', (l) => { const r = JSON.parse(l); const w = wait.get(r.id); if (w) { wait.delete(r.id); w(r); } });
  c.stderr.on('data', (d) => { err += d; });
  const rpc = (method, params) => new Promise((res) => { const id = ++n; wait.set(id, res); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); const t = r.result.content[0].text; let j = null; try { j = JSON.parse(t); } catch {} return { err: r.result.isError ? t : '', j }; };
  return { rpc, tool, close: () => c.kill(), err: () => err };
}

(async () => {
  const zp = await zot.listen(), bp = await br.listen();
  await new Promise((r) => src.listen(0, '127.0.0.1', () => { srcPort = src.address().port; r(); }));
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex-lit.js')] };
  const base = `http://127.0.0.1:${srcPort}`;
  cfg.literature = { zotero: `http://127.0.0.1:${zp}`, webdavDir: WD, kbDir: path.join(T, 'kb'), refreshMs: 300, feed: false, review: false, pdfGapSec: 0.15, agentSocket: SOCK,
    endpoints: { openalex: base + '/oa', crossref: base + '/cr', unpaywall: base + '/up', s2: false, arxiv: false, aiaa: false, ntrs: false, dtic: false, cn: false },
    browser: { loadMs: 3000, settleMs: 10, stepMs: 20, quietMs: 300, checkMs: 20, verifyMs: 50, pdfMs: 5000 }, pdfQueue: { tickMs: 40 }, downloadsOpts: { tickMs: 150 } };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const clients = [];
  try {
    await until(async () => (await req('GET', '/login')).status === 200, 15000, 150);
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const G = async (p) => (await req('GET', p, null, cookie)).j;
    const P = async (p, b) => (await req('POST', p, b || {}, cookie)).j;
    await until(async () => ((await G('/api/lit/library')).items || []).length === 1);
    await until(() => /下载接口/.test(out), 5000);
    ok('no login: the window\'s download API refused', (await req('GET', '/api/lit/downloads')).status === 401 && (await req('POST', '/api/lit/download', { text: '10.5555/open' })).status === 401);
    ok('the socket is the server user\'s only', process.platform === 'win32' || (fs.statSync(SOCK).mode & 0o777) === 0o600);

    const m = mcpClient(['--socket', SOCK]); clients.push(m);
    const init = await m.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' }, capabilities: {} });
    const tl = (await m.rpc('tools/list')).result.tools;
    ok('the MCP says what it allows: 20 DOIs a call, one queue, one at a time, a daily cap, no retry within the hour, the user for checks',
      /20 个 DOI/.test(init.result.instructions) && /一次只下一篇/.test(init.result.instructions) && /needsUser/.test(init.result.instructions) &&
      tl.map((t) => t.name).join() === 'submit_downloads,download_status,save_pdf' && tl[0].inputSchema.properties.dois.maxItems === 20 && /每天/.test(tl[0].description), [init, tl]);
    const big = await m.tool('submit_downloads', { dois: Array.from({ length: 21 }, (_, i) => '10.5555/x' + i) });
    ok('more than 20 at once: refused before anything is asked', !!big.err && /1～20/.test(big.err), big);
    const unk = await m.tool('download_status', { foo: 1 });
    ok('an unknown argument: refused', /未知参数/.test(unk.err), unk);

    // ---- no write access yet ----
    const s1 = await m.tool('submit_downloads', { dois: ['https://doi.org/10.5555/OPEN', '10.5555/open', 'not a doi', '10.1109/have'] });
    const r1 = s1.j.results;
    ok('submitted: the DOI from a link, the same one twice in a call is one, not a DOI refused; the limits come back', s1.j.ok && r1.length === 3 && r1[0].doi === '10.5555/open' &&
      !r1[1].ok && /不是 DOI/.test(r1[1].msg) && r1[2].doi === '10.1109/have' && s1.j.limits.maxPerCall === 20 && s1.j.limits.serial === true && s1.j.limits.perDay === 30, s1.j);
    const idOpen = r1[0].id, idHave = r1[2].id;
    const w0 = await until(async () => { const r = (await m.tool('download_status', { ids: [idOpen] })).j.items[0]; return r.needsUser && r; }, 5000);
    ok('without write access to Zotero: the job waits and says the user is needed', w0 && w0.state === 'queued' && /授权/.test(w0.msg), w0);

    await P('/api/lit/zotero/authorize');
    await until(async () => (await G('/api/lit')).zotero.canWrite);
    const done = await until(async () => { const r = (await m.tool('download_status', { ids: [idOpen, idHave] })).j.items; return r.every((x) => x.state === 'done') && r; }, 15000);
    ok('granted: both done -- the open one from its open copy, the library\'s own as it was', done && done[0].source === 'open' && done[0].key && /库里本来就有/.test(done[1].msg) && done[1].key === 'HAVEPDF1', done);
    const made = zot.objs.get(done[0].key), col = [...zot.cols.values()].find((c) => c.name === '文献下载');
    ok('the open one: a Zotero item in 文献下载, tagged, with the record\'s title and DOI, its PDF attached', made && col && made.collections.join() === col.key && made.tags.some((t) => t.tag === 'Windose下载') &&
      made.DOI === '10.5555/open' && /open access paper/.test(made.title) && zot.writes.some((w) => w.kind === 'file'), [made, col]);
    ok('nothing made for the paper already there', zot.writes.filter((w) => w.kind === 'items' && w.data.DOI === '10.1109/have').length === 0);
    const dest = path.join(OUT, 'open.pdf');
    const sv = await m.tool('save_pdf', { id: idOpen, path: dest });
    ok('save_pdf: the PDF written where asked, the same bytes', !sv.err && sv.j.bytes === OA_PDF.length && fs.readFileSync(dest).equals(OA_PDF), sv);
    const sv2 = await m.tool('save_pdf', { id: idOpen, path: dest }), sv3 = await m.tool('save_pdf', { id: idOpen, path: 'rel.pdf' }), sv4 = await m.tool('save_pdf', { id: idOpen, path: path.join(OUT, 'nope', 'x.pdf') });
    ok('save_pdf: no overwrite unless asked, no relative path, no missing folder', /已存在/.test(sv2.err) && /绝对路径/.test(sv3.err) && /目录不存在/.test(sv4.err), [sv2, sv3, sv4]);
    ok('save_pdf with overwrite', !(await m.tool('save_pdf', { id: idOpen, path: dest, overwrite: true })).err);

    // ---- no open copy, no library access ----
    const s2 = await m.tool('submit_downloads', { dois: ['10.5555/crossonly', '10.5555/nowhere', '10.1016/new'] });
    const [idCross, idNone, idNew] = s2.j.results.map((x) => x.id);
    const st2 = await until(async () => { const r = (await m.tool('download_status', { ids: [idCross, idNone, idNew] })).j.items; return r.every((x) => x.state === 'failed') && r; }, 15000);
    ok('only Crossref knows it: made from that record; nobody knows it: refused, nothing made', st2 && st2[0].key && zot.objs.get(st2[0].key).title === 'Only Crossref has this one' &&
      /查不到/.test(st2[1].msg) && !st2[1].key && !zot.writes.some((w) => w.kind === 'items' && /nowhere/.test(w.data.DOI || '')), st2);
    ok('no open copy and the library access off: failed, said why', /图书馆通道也没有开启/.test(st2[2].msg), st2[2]);
    const again = await m.tool('submit_downloads', { dois: ['10.1016/new'] });
    ok('asked again within the hour by an agent: the same job, not tried', again.j.results[0].id === idNew && again.j.results[0].duplicate && /不再重试/.test(again.j.results[0].note) && again.j.results[0].state === 'failed', again.j);

    // ---- the library access on: from the window, at once ----
    await P('/api/lit/settings', { browserPort: bp });
    const wr = await P('/api/lit/download', { text: '想要这篇：https://doi.org/10.1016/new.  还有 10.1016/check，谢谢' });
    ok('the window\'s box: the DOIs out of pasted text; a failed one tried again at once', wr.ok && wr.results.length === 2 && wr.results[0].id === idNew && wr.results[0].again && wr.results[1].doi === '10.1016/check', wr);
    const idCheck = wr.results[1].id;
    const st3 = await until(async () => { const r = (await m.tool('download_status', { ids: [idNew, idCheck] })).j.items; return r[0].state === 'done' && r[1].state === 'blocked' && r; }, 20000);
    ok('through the library access: done; the robot check: blocked, the user needed, said where', st3 && st3[0].source === 'library' && st3[1].needsUser && /人机验证/.test(st3[1].msg), st3);
    const sv5 = await m.tool('save_pdf', { id: idNew, path: path.join(OUT, 'new.pdf') });
    ok('...and its PDF saved', !sv5.err && fs.readFileSync(path.join(OUT, 'new.pdf')).equals(LIB_PDF), sv5);
    const sv6 = await m.tool('save_pdf', { id: idCheck, path: path.join(OUT, 'check.pdf') });
    ok('a job not done: no PDF, said why', /还没下好/.test(sv6.err), sv6);

    // ---- two agents at the same moment ----
    const m2 = mcpClient(['--socket', SOCK]); clients.push(m2);
    await m2.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex' }, capabilities: {} });
    const [a, b] = await Promise.all([m.tool('submit_downloads', { dois: ['10.1016/race'] }), m2.tool('submit_downloads', { dois: ['10.1016/RACE'] })]);
    await until(async () => (await m.tool('download_status', { ids: [a.j.results[0].id] })).j.items[0].state === 'done', 20000);
    ok('two agents, the same new DOI at once: one job, one Zotero item', a.j.results[0].id === b.j.results[0].id && [a, b].filter((x) => x.j.results[0].duplicate).length === 1 &&
      [...zot.objs.values()].filter((o) => o.DOI === '10.1016/race').length === 1, [a.j, b.j]);
    const lst = await G('/api/lit/downloads');
    ok('the window lists the jobs, the agents\' marked as theirs, and the limits', lst.items.some((x) => /^mcp:claude-code@/.test(x.by)) && lst.items.some((x) => x.by === 'windose') && lst.limits.libraryEnabled, lst);

    // ---- the bridge (what --ssh speaks on the far side) ----
    const bc = cp.spawn(process.execPath, [R + '/server/literature/mcp.js', '--bridge', '--socket', SOCK], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    readline.createInterface({ input: bc.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
    bc.stdin.write(JSON.stringify({ i: 1, m: 'GET', p: '/v1/limits' }) + '\n' + JSON.stringify({ i: 2, m: 'GET', p: '/v1/pdf?id=' + idOpen }) + '\n');
    await until(() => lines.length === 2, 5000);
    const l1 = lines.find((x) => x.i === 1), l2 = lines.find((x) => x.i === 2);
    ok('the bridge: answers as JSON lines, a PDF as base64 with its job', l1 && l1.j.maxPerCall === 20 && l2 && Buffer.from(l2.b64, 'base64').equals(OA_PDF) && l2.job.id === idOpen, lines.map((x) => ({ ...x, b64: x.b64 && x.b64.length })));
    bc.kill();

    // ---- --ssh: the MCP on another machine, each request through "ssh <host> <remote> --bridge" (a stand-in for ssh) ----
    const fakeSsh = path.join(T, 'fake-ssh.js');
    // (like ssh: the remote command run by a shell on the far side)
    fs.writeFileSync(fakeSsh, `const a = process.argv.slice(2); const host = a[a.length - 2], cmd = a[a.length - 1];
if (host !== 'nas-test') { process.stderr.write('ssh: Could not resolve hostname ' + host); process.exit(255); }
const c = require('child_process').spawn(cmd, { stdio: 'inherit', shell: true }); c.on('exit', (x) => process.exit(x));`);
    const sshEnv = { AME_MCP_SSH: JSON.stringify([process.execPath, fakeSsh]) };
    const remote = `"${process.execPath}" "${R}/server/literature/mcp.js" --socket "${SOCK}"`;
    const viaSsh = (host) => { const c = cp.spawn(process.execPath, [R + '/server/literature/mcp.js', '--ssh', host, '--remote', remote], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...sshEnv } });
      let n = 0; const wait = new Map();
      readline.createInterface({ input: c.stdout }).on('line', (l) => { const r = JSON.parse(l); const w = wait.get(r.id); if (w) { wait.delete(r.id); w(r); } });
      const rpc = (method, params) => new Promise((res) => { const id = ++n; wait.set(id, res); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
      return { rpc, tool: async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); const t = r.result.content[0].text; let j = null; try { j = JSON.parse(t); } catch {} return { err: r.result.isError ? t : '', j }; }, close: () => c.kill() }; };
    const ms = viaSsh('nas-test'); clients.push(ms);
    await ms.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'opencode' }, capabilities: {} });
    const sst = await ms.tool('download_status', { ids: [idOpen] });
    const far = path.join(OUT, 'via-ssh.pdf'), ssv = await ms.tool('save_pdf', { id: idOpen, path: far });
    ok('--ssh: status through the far side, and the PDF saved on this side', sst.j && sst.j.items[0].state === 'done' && !ssv.err && fs.readFileSync(far).equals(OA_PDF), [sst, ssv]);
    const bad = viaSsh('nowhere'); clients.push(bad);
    await bad.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'x' }, capabilities: {} });
    const bst = await bad.tool('download_status', {});
    ok('--ssh to a host that is not there: the tool fails and says what ssh said', /Could not resolve hostname/.test(bst.err), bst);
    ok('the server said nothing bad', !/TypeError|ReferenceError|下载任务出错/.test(out), out.slice(-1500));
  } catch (e) { fail++; console.log('FAIL (threw) ' + e.stack + '\n' + out.slice(-2000)); }
  finally { for (const c of clients) c.close(); srv.kill(); zot.close(); br.close && br.close(); src.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
