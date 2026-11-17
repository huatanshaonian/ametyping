#!/usr/bin/env node
// Windose 的 MCP（stdio）：把一个 agent 的工具调用经本机 agent 转给看板服务器。
//   node remote/mcp/client.js literature   文献：按 DOI 下载（server/literature/downloads.js 的队列）
//   node remote/mcp/client.js research     研究档案：只读查询（server/research/mcp.js 的工具）
// It talks only to this computer's agent -- 127.0.0.1:3941, the token it wrote to ~/.ametyping/mesh-token-3941 (the
// same way tools/ame-mesh.js does) -- and the agent passes the call on over its own connection to the server. No SSH,
// no key of its own. The tools and their limits come from the server (kept in ~/.ametyping/mcp-<name>.json for when the
// agent is offline). One tool runs here: literature's save_pdf, which writes the PDF on this computer.
// No dependencies beyond Node itself. Installed into the agents by install-mesh-mcp.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');

const SERVICES = { literature: 'windose-literature', research: 'windose-research' };
const PORT = +process.env.AME_MESH_PORT || +process.env.AME_MESH_BRIDGE_PORT || 3941;

function loadAuth(home = os.homedir()) {
  const raw = JSON.parse(fs.readFileSync(path.join(home, '.ametyping', `mesh-token-${PORT}`), 'utf8'));
  return { port: +raw.port || PORT, token: String(raw.token || '') };
}

// one call to the local agent -> { ok, ... } | { ok, buf, job } (a PDF)
function callAgent(body, { timeoutMs = 60e3, home } = {}) {
  let auth;
  try { auth = loadAuth(home); } catch { return Promise.resolve({ ok: false, msg: '找不到本机 agent 的令牌（~/.ametyping/mesh-token-' + PORT + '）：这台电脑的 Windose agent 没在运行' }); }
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: auth.port, method: 'POST', path: '/mcp/call', timeout: timeoutMs,
      headers: { 'X-Ame-Mesh': auth.token, 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        if (/application\/pdf/.test(res.headers['content-type'] || '')) {
          let job = null; try { job = JSON.parse(decodeURIComponent(res.headers['x-job'] || '')); } catch {}
          return resolve({ ok: true, buf, job });
        }
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch { resolve({ ok: false, msg: '本机 agent 返回的不是 JSON（' + res.statusCode + '）' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, msg: e.message === 'timeout' ? '本机 agent 没有回应' : '连不上本机 agent（' + e.message + '）：这台电脑的 Windose agent 没在运行' }));
    req.end(data);
  });
}

// literature's save_pdf: the PDF of a finished job, written here
async function savePdf(a, call) {
  if (typeof a.id !== 'string' || !/^[\w-]{1,40}$/.test(a.id)) throw new Error('id 无效');
  if (typeof a.path !== 'string' || !path.isAbsolute(a.path) || !/\.pdf$/i.test(a.path)) throw new Error('path 要是以 .pdf 结尾的绝对路径');
  for (const k of Object.keys(a)) if (!['id', 'path', 'overwrite'].includes(k)) throw new Error('未知参数 ' + k);
  const dest = path.resolve(a.path);
  if (!fs.existsSync(path.dirname(dest)) || !fs.statSync(path.dirname(dest)).isDirectory()) throw new Error('目录不存在：' + path.dirname(dest));
  if (fs.existsSync(dest) && a.overwrite !== true) throw new Error('文件已存在（要覆盖就加 overwrite: true）：' + dest);
  const r = await call({ op: 'pdf', args: { id: a.id } }, { timeoutMs: 600e3 });
  if (!r.buf) throw new Error(r.msg || '取不到 PDF');
  const tmp = dest + '.part-' + process.pid;
  fs.writeFileSync(tmp, r.buf);
  fs.renameSync(tmp, dest);
  return { ok: true, path: dest, bytes: r.buf.length, job: r.job };
}

function serve(service, { input = process.stdin, output = process.stdout, home = os.homedir(), call: callFn = callAgent } = {}) {
  if (!SERVICES[service]) throw new Error('用法：node client.js literature|research');
  const cacheFile = path.join(home, '.ametyping', `mcp-${service}.json`);
  let client = 'agent';
  const call = (body, o) => callFn({ service, client, ...body }, { home, ...o });
  // the tools and instructions from the server; the last ones seen when the agent is not there
  let info = null;
  async function getInfo() {
    if (info) return info;
    const r = await call({ op: 'info' }, { timeoutMs: 15e3 });
    if (r.ok && Array.isArray(r.tools)) {
      info = { instructions: String(r.instructions || ''), tools: r.tools };
      try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(info)); } catch {}
      return info;
    }
    try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); return { ...c, offline: r.msg }; } catch {}
    return { instructions: '', tools: [], offline: r.msg || '本机 agent 不可用' };
  }
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (o) => output.write(JSON.stringify(o) + '\n');
  lines.on('line', async (line) => {
    let q; try { q = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无效 JSON' } }); }
    if (q.id === undefined) return;
    const res = { jsonrpc: '2.0', id: q.id };
    try {
      if (q.method === 'initialize') {
        const p = q.params || {};
        client = String((p.clientInfo && p.clientInfo.name) || 'agent').replace(/[^\w.\-]/g, '').slice(0, 40) || 'agent';
        const i = await getInfo();
        res.result = { protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(p.protocolVersion) ? p.protocolVersion : '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: SERVICES[service], version: '0.2.0' }, instructions: (i.offline ? `（现在用不了：${i.offline}）` : '') + i.instructions };
      } else if (q.method === 'ping') res.result = {};
      else if (q.method === 'tools/list') res.result = { tools: (await getInfo()).tools };
      else if (q.method === 'tools/call') {
        const name = q.params && q.params.name, args = (q.params && q.params.arguments) || {};
        try {
          let out;
          if (service === 'literature' && name === 'save_pdf') out = await savePdf(args, call);
          else {
            const r = await call({ op: 'call', args: { name, arguments: args } }, { timeoutMs: 120e3 });
            if (!r.ok) throw new Error(r.msg || '调用失败');
            out = r.result;
          }
          res.result = { content: [{ type: 'text', text: JSON.stringify(out) }] };
        } catch (e) { res.result = { isError: true, content: [{ type: 'text', text: e.message }] }; }
      } else res.error = { code: -32601, message: '不支持的方法 ' + q.method };
    } catch (e) { res.error = { code: -32603, message: e.message }; }
    write(res);
  });
  return lines;
}

if (require.main === module) {
  try { serve(process.argv[2]); } catch (e) { process.stderr.write(e.message + '\n'); process.exit(1); }
}

module.exports = { serve, callAgent, SERVICES };
