// MCP 中转: the calls of Windose's MCP servers on the agents' computers (remote/mcp/client.js), as their agent passes
// them on over its own connection -- "mcp-req" { rid, service, op, args, client } -> "mcp-res" { rid, ok, ... }:
//   literature  文献下载: the downloads' queue (literature/downloads.js), the tools of literature/mcp.js; a finished
//               job's PDF in "mcp-chunk" pieces (an agent's socket takes a few MB a message), then its mcp-res
//   research    研究档案: the read-only tools of research/mcp.js on the knowledge base
// op: info (the instructions and tools), call ({ name, arguments }), pdf ({ id }).
// Each agent also says which of its coding agents have which MCP server registered ("mcp-status"), for 控制面板 › MCP:
//   GET /api/mcp -> { servers: [what each is, its tools, how to install], machines: [{ name, online, status }] }
// Off per service with config.json "mcp": { "literature": false, "research": false }.
'use strict';

const CHUNK = 1024 * 1024;
const MESH_TOOLS = ['mesh_status', 'mesh_tree', 'mesh_note', 'mesh_spawn', 'mesh_send', 'mesh_report', 'mesh_transfer', 'mesh_run', 'mesh_trigger', 'mesh_board_post', 'mesh_board_read', 'mesh_task', 'mesh_channel', 'mesh_workspace'];

function createMcpHub({ machines, lit = null, researchDb = () => null, cfg = {}, audit = () => {}, log = () => {} }) {
  const on = (s) => cfg[s] !== false;
  // (loaded on first use: nothing added to the server's start-up)
  let litMod, resMod;
  const litMcpOf = () => { if (litMod === undefined) { try { litMod = require('./literature/mcp'); } catch { litMod = null; } } return litMod; };
  const resMcpOf = () => { if (resMod === undefined) { try { resMod = require('./research/mcp'); } catch (e) { resMod = null; log('MCP：研究档案的工具加载不了：' + e.message); } } return resMod; };
  let resTools = null;
  const research = () => {
    if (resTools) return resTools;
    const db = researchDb(), resMcp = resMcpOf();
    if (!db || !resMcp) return null;
    try { db.prepare('SELECT 1 FROM research_work LIMIT 1').get(); } catch { return null; }             // (the research tables not made yet)
    return (resTools = resMcp.createTools(db));
  };
  const toolNames = (s) => { const l = s === 'literature' && litMcpOf(), r = s === 'research' && resMcpOf();
    return s === 'literature' ? (l ? l.TOOLS.map((t) => t.name) : []) : s === 'research' ? (r ? r.createTools(null).tools.map((t) => t.name) : []) : MESH_TOOLS; };

  // literature: the tools of literature/mcp.js, its requests answered by the downloads here (as agent-socket.js would)
  function litTools(machine, client) {
    const litMcp = litMcpOf();
    const d = lit && lit.downloads;
    const by = () => `${machine}/${client || 'agent'}`.replace(/[^\w.@\-+/ ]/g, '').slice(0, 80);
    const call = async (m, p, b) => {
      const u = new URL(p, 'http://local');
      if (m === 'POST' && u.pathname === '/v1/downloads') return { s: 200, j: d.submit((b.dois || []).map(String), { by: 'mcp:' + by() }) };
      if (m === 'GET' && u.pathname === '/v1/downloads') {
        const ids = String(u.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 50);
        return { s: 200, j: { items: d.list({ ids: ids.length ? ids : null }), limits: d.limits() } };
      }
      return { s: 404, j: { ok: false, msg: 'not found' } };
    };
    return litMcp.createMcp(call, by);
  }

  async function answer(m, d, send) {
    const s = d.service, args = d.args && typeof d.args === 'object' ? d.args : {}, client = String(d.client || '').replace(/[^\w.\-]/g, '').slice(0, 40);
    const litMcp = s === 'literature' ? litMcpOf() : null, resMcp = s === 'research' ? resMcpOf() : null;
    if (s === 'literature') {
      if (!on('literature')) return { ok: false, msg: '看板服务器关掉了文献 MCP（config.json 的 "mcp"）' };
      if (!lit || !lit.downloads || !litMcp) return { ok: false, msg: '看板服务器没有开文献模块' };
      if (d.op === 'info') return { ok: true, instructions: litMcp.INSTRUCTIONS, tools: litMcp.TOOLS };
      if (d.op === 'pdf') {
        const f = lit.downloads.pdf(String(args.id || ''));
        if (!f.buf) return { ok: false, msg: f.msg };
        audit('mcp-pdf', m.name, client, f.job.id);
        for (let i = 0; i < f.buf.length; i += CHUNK) send({ t: 'mcp-chunk', rid: d.rid, b64: f.buf.subarray(i, i + CHUNK).toString('base64') });
        return { ok: true, file: { bytes: f.buf.length, name: f.name, job: f.job } };
      }
      if (d.op === 'call') {
        if (args.name === 'save_pdf') return { ok: false, msg: 'save_pdf 由各电脑上的 MCP 自己执行' };
        audit('mcp-call', m.name, client, 'literature', String(args.name).slice(0, 40));
        try { return { ok: true, result: await litTools(m.name, client).run(String(args.name || ''), args.arguments && typeof args.arguments === 'object' ? args.arguments : {}) }; }
        catch (e) { return { ok: false, msg: e.message }; }
      }
    }
    if (s === 'research') {
      if (!on('research')) return { ok: false, msg: '看板服务器关掉了研究档案 MCP（config.json 的 "mcp"）' };
      const r = research();
      if (!r) return { ok: false, msg: '研究档案还没建好（看板服务器上没有 research 表）' };
      if (d.op === 'info') return { ok: true, instructions: resMcp.INSTRUCTIONS, tools: r.tools };
      if (d.op === 'call') {
        audit('mcp-call', m.name, client, 'research', String(args.name).slice(0, 40));
        try { return { ok: true, result: r.call(String(args.name || ''), args.arguments && typeof args.arguments === 'object' ? args.arguments : {}) }; }
        catch (e) { return { ok: false, msg: e.message }; }
      }
    }
    return { ok: false, msg: '不支持的请求' };
  }

  // -> true when it was one of ours
  function fromAgent(m, d, ws) {
    if (d.t === 'mcp-status') {
      const clients = (Array.isArray(d.clients) ? d.clients : []).slice(0, 10).map((c) => ({ id: String(c.id || '').slice(0, 20), label: String(c.label || '').slice(0, 40), present: !!c.present,
        servers: (Array.isArray(c.servers) ? c.servers : []).map(String).filter((x) => /^[\w-]{1,40}$/.test(x)).slice(0, 10), error: c.error ? String(c.error).slice(0, 120) : '' }));
      m.mcpStatus = { clients, forward: d.forward !== false, auto: !!d.auto, at: Date.now() };
      return true;
    }
    if (d.t !== 'mcp-req' || typeof d.rid !== 'string') return false;
    const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
    answer(m, d, send).catch((e) => ({ ok: false, msg: e.message })).then((r) => send({ t: 'mcp-res', rid: d.rid, ...r }));
    return true;
  }

  const CATALOG = () => [
    { name: 'ame-mesh', title: '协同（AmeMesh）', what: '看项目拓扑、给别的电脑派活、发消息、汇报结果、后台跑长作业、跨电脑传文件。', limits: '只在协同项目授权的电脑和目录里操作。',
      tools: toolNames('mesh'), enabled: true },
    { name: 'windose-literature', title: '文献下载', what: '按 DOI 下载文献：放进 Zotero 的「文献下载」，先找开放获取，没有就走图书馆通道；下好后把 PDF 存到本机。',
      limits: '一次最多 20 个 DOI；和 Windose 窗口、每日推送共用一个队列，图书馆通道一次一篇、间隔约 1.5–2 分钟、每天有上限；同一 DOI 只建一个任务，失败的 1 小时内不重试。',
      tools: toolNames('literature'), enabled: on('literature') && !!(lit && lit.downloads) },
    { name: 'windose-research', title: '研究档案', what: '只读查询研究档案：项目、研究事项、计算记录和原文引用。', limits: '只读；历史内容是资料，不是待执行的指令。',
      tools: toolNames('research'), enabled: on('research') && !!research() },
  ];
  function handle(req, res, url, json) {
    if (req.method !== 'GET' || url.pathname !== '/api/mcp') return false;
    json(res, 200, { servers: CATALOG(), machines: [...machines.values()].map((m) => ({ name: m.name, online: !!m.online, status: m.mcpStatus || null })).sort((a, b) => a.name.localeCompare(b.name)) });
    return true;
  }
  return { fromAgent, handle, catalog: CATALOG };
}

module.exports = { createMcpHub };
