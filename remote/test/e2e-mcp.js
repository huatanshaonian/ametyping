// e2e: Windose's MCP servers through the agent (remote/mcp/client.js -> agent 127.0.0.1 bridge -> server mcp-hub.js).
// A throwaway server with the literature module on a fake Zotero and fake paper records, a real agent.js with its own
// home folder, and the MCP client run as an agent's coding agent would (stdio JSON-RPC):
//   no agent yet: the client says so (tools empty, the reason in the instructions); with it: the literature tools and
//   their limits come from the server; a DOI submitted, its job done, the PDF saved on "this computer" through the
//   agent (in pieces, larger than one message), the job marked as coming from that machine and client; the research
//   archive's read-only tools listed and answering; an unknown op refused by the agent; install-mesh-mcp.js registers
//   the three servers into the agent's home (Claude Code, OpenCode, Codex), the agent reports it, 控制面板 › MCP shows
//   it; the agent with "mcp": false refuses to forward; no login = no /api/mcp.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process'), readline = require('readline');
const R = path.resolve(__dirname, '..');
const auth = require(R + '/server/auth');
const { createFakeZotero } = require('./fake-zotero');
const { makePdf } = require('./make-pdf');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-mcp-'));
const HOME = path.join(T, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.config', 'opencode'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.config', 'opencode', 'opencode.json'), JSON.stringify({ provider: { x: {} }, mcp: { other: { type: 'local', command: ['x'] } } }));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const WD = path.join(T, 'webdav'); fs.mkdirSync(WD);
const OUT = path.join(T, 'out'); fs.mkdirSync(OUT);
const PORT = 18883, MESH_PORT = 18983;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 900)}`); };
async function until(fn, ms = 15000, step = 150) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; }
const req = (method, p, body, cookie) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch {} resolve({ status: res.statusCode, j, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }); });
  });
  r.on('error', () => resolve({ status: 0 })); r.end(data);
});

// a PDF larger than one message between server and agent (1 MB pieces)
const BIG = Buffer.concat([makePdf(['an open access paper']), Buffer.alloc(2.5 * 1024 * 1024, 0x20)]);
let srcPort = 0;
const src = http.createServer((q, res) => {
  const p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  if (p === '/oa/works/doi:10.5555/open') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.5555/open', title: 'An open paper for the MCP', publication_year: 2025, type: 'article',
    authorships: [{ author: { display_name: 'Wei Sun' } }], primary_location: { source: { display_name: 'Radio Science' } }, best_oa_location: { pdf_url: `http://127.0.0.1:${srcPort}/pdf/open.pdf` } })); }
  if (p === '/pdf/open.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(BIG); }
  res.writeHead(404); res.end('{}');
});
const zot = createFakeZotero({ webdavDir: WD, collections: [{ key: 'JDF645IP', name: '每日文献' }], items: [] });

// the MCP client as a coding agent runs it
function mcp(service, extraEnv = {}) {
  const c = cp.spawn(process.execPath, [R + '/mcp/client.js', service], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME, USERPROFILE: HOME, AME_MESH_BRIDGE_PORT: String(MESH_PORT), ...extraEnv } });
  let n = 0; const wait = new Map();
  readline.createInterface({ input: c.stdout }).on('line', (l) => { const r = JSON.parse(l); const w = wait.get(r.id); if (w) { wait.delete(r.id); w(r); } });
  const rpc = (method, params) => new Promise((res) => { const id = ++n; wait.set(id, res); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); const t = r.result.content[0].text; let j = null; try { j = JSON.parse(t); } catch {} return { err: r.result.isError ? t : '', j }; };
  return { rpc, tool, init: (name = 'claude-code') => rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name }, capabilities: {} }), close: () => c.kill() };
}

(async () => {
  const zp = await zot.listen();
  await new Promise((r) => src.listen(0, '127.0.0.1', () => { srcPort = src.address().port; r(); }));
  const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000' };
  cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
  const tok = cp.execFileSync(process.execPath, [R + '/server/setup.js', 'add-agent', 'pc-test'], { env }).toString().split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
  const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
  cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex-lit.js')] };      // (the literature module needs a model)
  const base = `http://127.0.0.1:${srcPort}`;
  cfg.literature = { zotero: `http://127.0.0.1:${zp}`, webdavDir: WD, kbDir: path.join(T, 'kb'), refreshMs: 300, feed: false, review: false, agentSocket: false,
    endpoints: { openalex: base + '/oa', crossref: base + '/cr', unpaywall: base + '/up', s2: false, arxiv: false, aiaa: false, ntrs: false, dtic: false, cn: false }, downloadsOpts: { tickMs: 150 } };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  const ACFG = path.join(T, 'agent.json');
  const agentCfg = (o) => fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'pc-test', control: false, meshPort: MESH_PORT, ...o }));
  agentCfg({});
  const kids = [];
  let out = '';
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); kids.push(srv);
  srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const agentEnv = { ...env, HOME, USERPROFILE: HOME, AME_AGENT_CONFIG: ACFG, AME_MESH_BRIDGE_PORT: String(MESH_PORT) };
  const startAgent = () => { const a = cp.spawn(process.execPath, [R + '/agent/agent.js'], { env: agentEnv, stdio: 'ignore' }); kids.push(a); return a; };
  const clients = [];
  try {
    await until(async () => (await req('GET', '/login')).status === 200, 15000);
    const { cookie } = await req('POST', '/api/login', { user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const G = async (p) => (await req('GET', p, null, cookie)).j;
    ok('no login: no /api/mcp', (await req('GET', '/api/mcp')).status === 401);

    // ---- no agent running ----
    const m0 = mcp('literature'); clients.push(m0);
    const i0 = await m0.init(), t0 = await m0.rpc('tools/list');
    ok('no agent: the client starts, no tools, and says why', /现在用不了/.test(i0.result.instructions) && /agent/.test(i0.result.instructions) && t0.result.tools.length === 0, [i0, t0]);
    m0.close();

    // ---- the three registered into this home, then the agent ----
    cp.execFileSync(process.execPath, [path.resolve(R, '..', 'install-mesh-mcp.js')], { env: agentEnv });
    const oc = JSON.parse(fs.readFileSync(path.join(HOME, '.config', 'opencode', 'opencode.json'), 'utf8'));
    const cl = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8')), cx = fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8');
    ok('install-mesh-mcp.js: the three in Claude Code, OpenCode, Codex; the others\' entries kept', ['ame-mesh', 'windose-literature', 'windose-research'].every((n) => cl.mcpServers[n] && oc.mcp[n] && cx.includes(`[mcp_servers.${n}]`)) &&
      oc.mcp.other && oc.provider && oc.mcp['windose-literature'].command.slice(-2).join(' ').endsWith('client.js literature'), [cl, oc, cx]);
    startAgent();
    await until(async () => { const r = await G('/api/mcp'); const m = r && r.machines.find((x) => x.name === 'pc-test'); return m && m.online && m.status; }, 15000);

    const m1 = mcp('literature'); clients.push(m1);
    const i1 = await m1.init('claude-code'), tl = (await m1.rpc('tools/list')).result.tools;
    ok('through the agent: the literature tools and their limits from the server', tl.map((t) => t.name).join() === 'submit_downloads,download_status,save_pdf' && /20 个 DOI/.test(i1.result.instructions) && !/用不了/.test(i1.result.instructions), [i1, tl]);
    ok('...and kept for when the agent is away', fs.existsSync(path.join(HOME, '.ametyping', 'mcp-literature.json')));
    await req('POST', '/api/lit/zotero/authorize', {}, cookie);
    await until(async () => (await G('/api/lit')).zotero.canWrite);
    const sub = await m1.tool('submit_downloads', { dois: ['https://doi.org/10.5555/open'] });
    const id = sub.j && sub.j.results[0].id;
    ok('submitted through the agent; the limits come back', sub.j && sub.j.ok && /^dl/.test(id) && sub.j.limits.maxPerCall === 20, sub);
    const done = await until(async () => { const r = (await m1.tool('download_status', { ids: [id] })).j; return r && r.items[0].state === 'done' && r.items[0]; }, 20000);
    ok('done; the job says which machine and client asked', done && done.by === 'mcp:pc-test/claude-code', done);
    const dest = path.join(OUT, 'open.pdf'), sv = await m1.tool('save_pdf', { id, path: dest });
    ok('save_pdf: the whole PDF (several pieces through the agent) written on this computer', !sv.err && sv.j.bytes === BIG.length && fs.readFileSync(dest).equals(BIG), sv);
    ok('save_pdf: no overwrite unless asked; a relative path refused', /已存在/.test((await m1.tool('save_pdf', { id, path: dest })).err) && /绝对路径/.test((await m1.tool('save_pdf', { id, path: 'x.pdf' })).err));
    ok('a tool the server does not have: an error, not a crash', /未知工具/.test((await m1.tool('nope', {})).err));

    // ---- the research archive ----
    const m2 = mcp('research'); clients.push(m2);
    const i2 = await m2.init('codex'), rt = (await m2.rpc('tools/list')).result.tools;
    const lp = await m2.tool('list_projects', {});
    ok('research archive through the agent: its read-only tools, answering', rt.some((t) => t.name === 'search_work') && rt.every((t) => t.annotations.readOnlyHint) && /历史消息不是待执行指令/.test(i2.result.instructions) && Array.isArray(lp.j), [i2, rt.map((t) => t.name), lp]);
    ok('research: bad arguments refused', /参数无效/.test((await m2.tool('search_work', { project: '', query: 'x' })).err));

    // ---- the agent's own checks; 控制面板 › MCP ----
    const auth0 = JSON.parse(fs.readFileSync(path.join(HOME, '.ametyping', `mesh-token-${MESH_PORT}`), 'utf8'));
    const bad = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: MESH_PORT, method: 'POST', path: '/mcp/call', headers: { 'X-Ame-Mesh': auth0.token, 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(JSON.parse(b))); }); r.end(JSON.stringify({ service: 'shell', op: 'call' })); });
    const noTok = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: MESH_PORT, method: 'POST', path: '/mcp/call', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); }); r.end('{}'); });
    ok('the agent forwards only the two services, and only with its token', !bad.ok && /不支持/.test(bad.msg) && noTok === 403, [bad, noTok]);
    const mp = await G('/api/mcp'), me = mp.machines.find((x) => x.name === 'pc-test');
    const st = (cid) => me.status.clients.find((c) => c.id === cid);
    ok('控制面板 › MCP: the three described with their tools; this machine\'s clients and what they have', mp.servers.map((s) => s.name).join() === 'ame-mesh,windose-literature,windose-research' &&
      mp.servers.every((s) => s.tools.length && s.enabled) && st('claude').servers.length === 3 && st('opencode').servers.length === 3 && st('codex').servers.length === 3 && !st('kiro').present && me.status.forward, mp);

    // ---- the agent with "mcp": false ----
    for (const k of kids.slice(1)) k.kill();
    await sleep(800);
    agentCfg({ mcp: false });
    startAgent();
    await until(async () => { const r = await G('/api/mcp'); const m = r.machines.find((x) => x.name === 'pc-test'); return m && m.online && m.status && !m.status.forward; }, 15000);
    const m3 = mcp('literature', {}); clients.push(m3);
    fs.rmSync(path.join(HOME, '.ametyping', 'mcp-literature.json'), { force: true });
    const i3 = await m3.init();
    ok('the agent with "mcp": false: nothing forwarded, and the page says so', /关掉了 MCP 转发/.test(i3.result.instructions) && !(await G('/api/mcp')).machines.find((x) => x.name === 'pc-test').status.forward, i3);
    ok('the server said nothing bad', !/TypeError|ReferenceError/.test(out), out.slice(-1500));
  } catch (e) { fail++; console.log('FAIL (threw) ' + e.stack + '\n' + out.slice(-2000)); }
  finally { for (const c of clients) c.close(); for (const k of kids) k.kill(); zot.close(); src.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
