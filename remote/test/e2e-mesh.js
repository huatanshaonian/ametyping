// e2e: AmeMesh cross-machine session communication, NAS on-demand folder catalog, dual-track notes,
// Project Manager static assets, and tools/ame-mesh.js loopback bridge against real server.js + agent.js.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-e2e-mesh-'));
const HOME = path.join(T, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
const SHARE = path.join(T, 'share');
fs.mkdirSync(path.join(SHARE, 'CEM_Solver', 'src'), { recursive: true });
fs.mkdirSync(path.join(SHARE, 'CEM_Results'), { recursive: true });
fs.writeFileSync(path.join(SHARE, 'CEM_Solver', 'src', 'po.py'), 'print("PO")\n');
fs.writeFileSync(path.join(SHARE, 'CEM_Results', 'rcs.dat'), '0.0 12.3\n');

const CFG = path.join(T, 'srv', 'config.json');
fs.mkdirSync(path.dirname(CFG), { recursive: true });
const PORT = 18842;
const MESH_PORT = 18941;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  c ? pass++ : fail++;
  console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 400)}`);
};

const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000' };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
cfg.web.port = PORT;
cfg.summary = { enabled: false };
fs.writeFileSync(CFG, JSON.stringify(cfg));

const tok = node([R + '/server/setup.js', 'add-agent', 'dell97']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({
  server: `ws://127.0.0.1:${PORT}/agent`,
  token: tok,
  name: 'dell97',
  control: false,
  meshPort: MESH_PORT,
  files: { roots: [SHARE], upload: true },
}));

const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };

function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      user: 'u',
      password: 'pw-123456789012',
      code: auth.totpAt(JSON.parse(fs.readFileSync(CFG, 'utf8')).totpSecret, Math.floor(Date.now() / 30000)),
    });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0]); });
    req.end(body);
  });
}

function api(cookie, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      const bs = [];
      res.on('data', (c) => bs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(bs).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', (e) => resolve({ status: 0, raw: e.message }));
    req.end(data);
  });
}

(async () => {
  try {
    spawn([R + '/server/server.js']);
    for (let i = 0; i < 60 && (await api('', 'GET', '/login')).status !== 200; i++) await sleep(250);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG, AME_MESH_BRIDGE_PORT: String(MESH_PORT) });
    await sleep(2500);

    const cookie = await login();
    ok('logged in with session cookie', /^sid=/.test(cookie), cookie);

    // 1. Verify static assets for Project Manager & FS Catalog
    for (const asset of ['/js/fs-catalog.js', '/js/mesh.js', '/js/apps/projects.js', '/css/projects.css', '/icons/projects.png', '/icons/tree.png', '/icons/folder_tag.png', '/icons/handoff.png']) {
      const r = await api(cookie, 'GET', asset);
      ok(`static asset served: ${asset}`, r.status === 200 && r.raw.length > 50, r.status);
    }

    // 2. Connect browser WebSocket to observe mesh & fs-catalog broadcasts
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, Cookie: cookie } });
    let meshBroadcasts = 0, catalogBroadcasts = 0;
    ws.on('message', (m) => {
      const d = JSON.parse(m);
      if (d.t === 'mesh') meshBroadcasts++;
      if (d.t === 'fs-catalog') catalogBroadcasts++;
    });
    await new Promise((r) => ws.on('open', r));
    await sleep(300);

    // 3. Test NAS on-demand folder tree sync & dual-track notes via HTTP API
    const syncRes = await api(cookie, 'POST', '/api/fs-catalog/sync', { machine: 'dell97', path: SHARE, depth: 2 });
    ok('NAS /api/fs-catalog/sync scans remote agent folder tree without pulling file content',
      syncRes.status === 200 && syncRes.json && syncRes.json.ok && syncRes.json.item.snapshot.tree.some((c) => c.name === 'CEM_Solver'),
      syncRes.json);

    const noteRes = await api(cookie, 'POST', '/api/fs-catalog/note', {
      machine: 'dell97',
      path: path.join(SHARE, 'CEM_Solver'),
      tag: 'solver',
      userNote: '主求解器代码，禁止删除',
      aiNote: '入口 src/po.py',
    });
    ok('NAS /api/fs-catalog/note saves dual-track folder notes',
      noteRes.status === 200 && noteRes.json && noteRes.json.ok && noteRes.json.item.tag === 'solver' && catalogBroadcasts > 0,
      noteRes.json);

    // 4. Test creating an AmeMesh project, adding nodes, and auto-binding session-marks group
    const projRes = await api(cookie, 'POST', '/api/mesh/project', {
      name: 'CEM跨机协同测试',
      mode: 'master-worker',
      goal: '在 dell97 拉取代码完成 RCS 求解并回传',
      stopCondition: '误差 < 0.5dB 时停下等待检视',
      autoResumeClosed: true,
      workspaces: [
        { machine: 'dell97', path: path.join(SHARE, 'CEM_Solver'), mode: 'ro', tag: 'solver' },
        { machine: 'dell97', path: path.join(SHARE, 'CEM_Results'), mode: 'rw', tag: 'results' },
      ],
    });
    ok('POST /api/mesh/project creates project and binds groupId',
      projRes.status === 200 && projRes.json && projRes.json.ok && !!projRes.json.project.groupId && meshBroadcasts > 0,
      projRes.json);
    const projId = projRes.json.project.id;

    const n1 = await api(cookie, 'POST', '/api/mesh/node', {
      projectId: projId, machine: 'pc-master', sessionId: 's-master', role: 'master', label: '主控会话',
      goal: '统筹求解', stopCondition: '审核结果',
    });
    const n2 = await api(cookie, 'POST', '/api/mesh/node', {
      projectId: projId, machine: 'dell97', sessionId: 's-worker', role: 'worker', label: 'dell97求解会话',
      cwd: path.join(SHARE, 'CEM_Solver'), goal: '计算算例1', stopCondition: '输出 rcs.dat 后停机等待检视',
    });
    ok('POST /api/mesh/node registers Master and Worker nodes in topology',
      n1.json && n1.json.ok && n2.json && n2.json.ok, [n1.json, n2.json]);

    // 5. Test CLI / MCP tool bridge (tools/ame-mesh.js) through live agent loopback -> NAS server
    const cliEnv = { ...env, USERPROFILE: HOME, HOME, AME_MESH_BRIDGE_PORT: String(MESH_PORT) };
    const cliStatus = JSON.parse(cp.execFileSync(process.execPath, [
      path.resolve(R, '..', 'tools', 'ame-mesh.js'),
      'status', '--projectId', projId, '--sessionId', 's-worker',
    ], { env: cliEnv, encoding: 'utf8' }));
    ok('tools/ame-mesh.js status returns scoped topology via local agent loopback',
      cliStatus.ok && cliStatus.project && cliStatus.project.id === projId && cliStatus.project.nodes.length === 2,
      cliStatus);

    const cliNote = JSON.parse(cp.execFileSync(process.execPath, [
      path.resolve(R, '..', 'tools', 'ame-mesh.js'),
      'note', '--machine', 'dell97', '--path', path.join(SHARE, 'CEM_Solver'),
      '--aiNote', 'AI 已校验算例网格', '--userNote', '试图覆盖用户备注',
    ], { env: cliEnv, encoding: 'utf8' }));
    ok('tools/ame-mesh.js note updates aiNote while preserving userNote',
      cliNote.ok && cliNote.item.aiNote === 'AI 已校验算例网格' && cliNote.item.userNote === '主求解器代码，禁止删除',
      cliNote);

    // 6. Test Sneakernet (manual disk handoff) & transfer-confirm via HTTP API
    const txRes = await api(cookie, 'POST', '/api/mesh/transfer', {
      projectId: projId,
      fromMachine: 'dell97',
      fromPath: path.join(SHARE, 'CEM_Results', 'huge_field.bin'),
      toMachine: 'dell97',
      toPath: path.join(SHARE, 'CEM_Results', 'copied_field.bin'),
      size: 80 * 1024 * 1024,
      mode: 'auto',
      note: '80MB 近场矩阵请用移动硬盘拷贝',
      notifyNodeId: n2.json.node.id,
    });
    ok('POST /api/mesh/transfer creates manual_disk sneakernet handoff for >= 50MB file',
      txRes.json && txRes.json.ok && txRes.json.transfer.mode === 'manual_disk' && txRes.json.transfer.status === 'pending',
      txRes.json);

    const cfmRes = await api(cookie, 'POST', '/api/mesh/transfer-confirm', { projectId: projId, transferId: txRes.json.transfer.id });
    ok('POST /api/mesh/transfer-confirm completes sneakernet handoff',
      cfmRes.json && cfmRes.json.ok && cfmRes.json.transfer.status === 'completed',
      cfmRes.json);

    ws.close();
  } catch (e) {
    fail++;
    console.log('ERROR', e);
  } finally {
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
