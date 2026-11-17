#!/usr/bin/env node
// 文献下载的 MCP (stdio): lets an agent ask the literature module for papers by DOI and save their PDFs. It talks to the
// running server over the module's local socket (agent-socket.js), so every request goes into the same queue as the
// window's (one paper at a time through the library access, its pace and daily cap). Nothing listens on the network.
// No dependencies beyond Node itself: the file can be copied anywhere.
//
//   on the NAS (the agent runs there):
//     node mcp.js [--socket <path>]                          the socket from config.json; PDFs saved on the NAS
//   on another machine (the usual case):
//     node mcp.js --ssh <host> --remote "<node on the NAS> <this file on the NAS>"
//                                                            each request goes through `ssh <host> ... --bridge` (SSH's own
//                                                            key login is the authentication); PDFs saved on this machine
//   (inside) node mcp.js --bridge [--socket <path>]          one JSON line per request, for --ssh
// e.g. in an MCP client's config: { "command": "node", "args": ["D:/ametyping/remote/server/literature/mcp.js", "--ssh", "nas-ts",
//   "--remote", "/var/packages/Node.js_v22/target/usr/local/bin/node /volume2/docker/ame-remote/remote/server/literature/mcp.js"] }
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');
const cp = require('child_process');

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bridge') o.bridge = true;
    else if (a === '--socket' || a === '--ssh' || a === '--remote') o[a.slice(2)] = argv[++i];
  }
  return o;
}

// the socket of the server on this machine: --socket, else config.json's (the same rule as the server's)
function socketPath(o) {
  if (o.socket) return o.socket;
  const { defaultSocket } = require('./agent-socket');
  const CONFIG = process.env.AME_REMOTE_CONFIG || path.join(__dirname, '..', 'config.json');
  let cfg; try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { throw new Error('读不到 ' + CONFIG + '（这里不是看板服务器？用 --socket 指定，或在别的电脑上用 --ssh）'); }
  const dir = path.join(path.resolve(path.dirname(CONFIG), cfg.dataDir || 'data'), 'literature');
  return (cfg.literature && cfg.literature.agentSocket) || defaultSocket(dir);
}

// one request to the socket -> { s, j } | { s, buf, job }
function direct(socket, m, p, b) {
  return new Promise((resolve, reject) => {
    const body = b == null ? null : Buffer.from(JSON.stringify(b));
    const req = http.request({ socketPath: socket, path: p, method: m, timeout: 120e3, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        if (/application\/pdf/.test(res.headers['content-type'] || '')) {
          let job = null; try { job = JSON.parse(decodeURIComponent(res.headers['x-job'] || '')); } catch {}
          return resolve({ s: res.statusCode, buf, job });
        }
        let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ s: res.statusCode, j });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('文献服务没有回应')));
    req.on('error', (e) => reject(new Error(/ENOENT|ECONNREFUSED/.test(e.code || '') ? '连不上文献服务（看板服务器没在运行，或文献模块没开）' : e.message)));
    req.end(body);
  });
}

// --bridge: requests as JSON lines on stdin, answers on stdout (a PDF as base64)
function bridge(o) {
  const socket = socketPath(o);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', async (line) => {
    let q; try { q = JSON.parse(line); } catch { return; }
    let out;
    try { const r = await direct(socket, q.m, q.p, q.b); out = r.buf ? { i: q.i, s: r.s, b64: r.buf.toString('base64'), job: r.job } : { i: q.i, s: r.s, j: r.j }; }
    catch (e) { out = { i: q.i, err: e.message }; }
    process.stdout.write(JSON.stringify(out) + '\n');
  });
}

// --ssh: one ssh process kept open, started again when it ends
function overSsh(host, remote) {
  let child = null, n = 0, errTail = '';
  const wait = new Map();
  function up() {
    if (child) return child;
    // (AME_MCP_SSH: tests only -- a JSON array standing in for the ssh program)
    const [bin, ...pre] = process.env.AME_MCP_SSH ? JSON.parse(process.env.AME_MCP_SSH) : ['ssh'];
    child = cp.spawn(bin, [...pre, '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', host, remote + ' --bridge'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const c = child;
    readline.createInterface({ input: c.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let r; try { r = JSON.parse(line); } catch { return; }
      const w = wait.get(r.i); if (!w) return;
      wait.delete(r.i); clearTimeout(w.t);
      if (r.err) w.rej(new Error(r.err));
      else w.res(r.b64 != null ? { s: r.s, buf: Buffer.from(r.b64, 'base64'), job: r.job } : { s: r.s, j: r.j });
    });
    c.stderr.on('data', (d) => { errTail = (errTail + d).slice(-400); });
    const gone = (why) => { if (child === c) child = null; for (const [, w] of wait) { clearTimeout(w.t); w.rej(new Error(why)); } wait.clear(); };
    c.on('exit', (code) => gone(`ssh ${host} 断开了（${code}）${errTail.trim() ? '：' + errTail.trim().split('\n').pop() : ''}`));
    c.on('error', (e) => gone('启动 ssh 失败：' + e.message));
    return c;
  }
  return (m, p, b) => new Promise((res, rej) => {
    const i = ++n, c = up();
    const t = setTimeout(() => { wait.delete(i); rej(new Error('文献服务没有回应（经 ssh ' + host + '）')); }, 300e3);
    wait.set(i, { res, rej, t });
    c.stdin.write(JSON.stringify({ i, m, p, b }) + '\n');
  });
}

// ---- the MCP ----
const LIMITS = '限制：一次最多提交 20 个 DOI；所有请求（包括 Windose 窗口和每日推送）共用一个下载队列，图书馆通道一次只下一篇，每篇之间间隔约 1.5–2 分钟，每天有总次数上限；排队中的任务最多 100 个。' +
  '同一个 DOI 重复提交会返回原来的任务，失败的 DOI 1 小时内不会重试。';
const INSTRUCTIONS = '这是用户自己的文献下载服务（经机构订阅下载，PDF 存进用户的 Zotero）。' + LIMITS +
  '提交是异步的：submit_downloads 立即返回任务号，下载要几分钟到几小时。之后用 download_status 查询，间隔不要短于 1 分钟；完成（state=done）后用 save_pdf 存到本地。' +
  'needsUser=true（人机验证、机构登录、Zotero 授权）时不要重试或重复提交，请告诉用户到 Windose 的「文献 › 文献库」处理。只提交用户确实需要的文献，不要批量爬取。';
const TOOLS = [
  { name: 'submit_downloads', description: '按 DOI 提交文献下载（异步，立即返回任务号与当前状态）。' + LIMITS + '返回的 limits 是队列当前的实际限额。',
    inputSchema: { type: 'object', properties: { dois: { type: 'array', items: { type: 'string', maxLength: 300 }, minItems: 1, maxItems: 20, description: 'DOI，例如 10.1109/TAP.2020.1234567（也可带 https://doi.org/ 前缀）' } }, required: ['dois'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'download_status', description: '查询下载任务。给 ids 查这些任务；不给则列出最近 30 个。state：queued 排队 / working 处理中 / waiting 等图书馆通道 / downloading 下载中 / blocked 或 paused 需要用户处理 / done 已下好 / failed 没拿到。查询间隔请不短于 1 分钟。',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 50 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'save_pdf', description: '把已完成（state=done）任务的 PDF 存到运行这个 MCP 的电脑上。path 是绝对路径，以 .pdf 结尾，所在目录必须已存在；已有同名文件时默认不覆盖。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 40 }, path: { type: 'string', maxLength: 1000 }, overwrite: { type: 'boolean' } }, required: ['id', 'path'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];

function createMcp(call, by = () => 'agent') {
  const check = (tool, a) => {
    for (const k of Object.keys(a)) if (!Object.hasOwn(tool.inputSchema.properties, k)) throw new Error('未知参数 ' + k);
    for (const k of tool.inputSchema.required || []) if (a[k] == null) throw new Error('缺少参数 ' + k);
  };
  const need = (r) => { if (r.s >= 400 || !r.j) throw new Error((r.j && r.j.msg) || '文献服务返回 ' + r.s); return r.j; };
  async function run(name, a = {}) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error('未知工具 ' + name);
    check(tool, a);
    if (name === 'submit_downloads') {
      if (!Array.isArray(a.dois) || !a.dois.length || a.dois.length > 20 || a.dois.some((d) => typeof d !== 'string' || d.length > 300)) throw new Error('dois 要是 1～20 个 DOI 字符串');
      return need(await call('POST', '/v1/downloads', { dois: a.dois, by: by() }));
    }
    if (name === 'download_status') {
      const ids = a.ids == null ? [] : a.ids;
      if (!Array.isArray(ids) || ids.length > 50 || ids.some((x) => typeof x !== 'string' || !/^[\w-]{1,40}$/.test(x))) throw new Error('ids 无效');
      return need(await call('GET', '/v1/downloads' + (ids.length ? '?ids=' + ids.join(',') : '')));
    }
    // save_pdf
    if (typeof a.id !== 'string' || !/^[\w-]{1,40}$/.test(a.id)) throw new Error('id 无效');
    if (typeof a.path !== 'string' || !path.isAbsolute(a.path) || !/\.pdf$/i.test(a.path)) throw new Error('path 要是以 .pdf 结尾的绝对路径');
    const dest = path.resolve(a.path);
    if (!fs.existsSync(path.dirname(dest)) || !fs.statSync(path.dirname(dest)).isDirectory()) throw new Error('目录不存在：' + path.dirname(dest));
    if (fs.existsSync(dest) && a.overwrite !== true) throw new Error('文件已存在（要覆盖就加 overwrite: true）：' + dest);
    const r = await call('GET', '/v1/pdf?id=' + a.id);
    if (!r.buf) throw new Error((r.j && r.j.msg) || '取不到 PDF');
    const tmp = dest + '.part-' + process.pid;
    fs.writeFileSync(tmp, r.buf);
    fs.renameSync(tmp, dest);
    return { ok: true, path: dest, bytes: r.buf.length, job: r.job };
  }
  return { run };
}

function serve(call, input = process.stdin, output = process.stdout) {
  let client = 'agent';
  const mcp = createMcp(call, () => `${client}@${os.hostname()}`);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (o) => output.write(JSON.stringify(o) + '\n');
  lines.on('line', async (line) => {
    let q; try { q = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无效 JSON' } }); }
    if (q.id === undefined) return;                                          // (notifications)
    const res = { jsonrpc: '2.0', id: q.id };
    try {
      if (q.method === 'initialize') {
        const want = q.params && q.params.protocolVersion;
        client = String((q.params && q.params.clientInfo && q.params.clientInfo.name) || 'agent').replace(/[^\w.\-]/g, '').slice(0, 40) || 'agent';
        res.result = { protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(want) ? want : '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'windose-literature', version: '0.1.0' }, instructions: INSTRUCTIONS };
      } else if (q.method === 'ping') res.result = {};
      else if (q.method === 'tools/list') res.result = { tools: TOOLS };
      else if (q.method === 'tools/call') {
        try { res.result = { content: [{ type: 'text', text: JSON.stringify(await mcp.run(q.params && q.params.name, (q.params && q.params.arguments) || {})) }] }; }
        catch (e) { res.result = { isError: true, content: [{ type: 'text', text: e.message }] }; }
      } else res.error = { code: -32601, message: '不支持的方法 ' + q.method };
    } catch (e) { res.error = { code: -32603, message: e.message }; }
    write(res);
  });
  return lines;
}

if (require.main === module) {
  const o = args(process.argv.slice(2));
  try {
    if (o.bridge) bridge(o);
    else if (o.ssh) {
      if (!o.remote) throw new Error('--ssh 还要 --remote "<NAS 上的 node> <NAS 上的 mcp.js>"');
      serve(overSsh(o.ssh, o.remote));
    } else { const s = socketPath(o); serve((m, p, b) => direct(s, m, p, b)); }
  } catch (e) { process.stderr.write(e.message + '\n'); process.exit(1); }
}

module.exports = { createMcp, serve, direct, TOOLS };
