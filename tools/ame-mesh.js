#!/usr/bin/env node
// AmeMesh Cross-Machine & Cross-Agent Bridge:
// Works as both:
//   1) A command-line tool (`node tools/ame-mesh.js <command> [options]`) for any coding agent with shell access
//   2) A standard JSON-RPC 2.0 stdio MCP server (`node tools/ame-mesh.js mcp`) for Claude Code / Codex / OpenCode / Antigravity
//
// Connects locally to `remote/agent/agent.js` on 127.0.0.1:3941 using the per-user token in ~/.ametyping/mesh-token-3941.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DEFAULT_PORT = +process.env.AME_MESH_PORT || 3941;

function loadAuth(port = DEFAULT_PORT, home = os.homedir()) {
  const file = path.join(home, '.ametyping', `mesh-token-${port}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { port: +raw.port || port, token: String(raw.token || ''), machine: String(raw.machine || os.hostname()) };
}

function callLocal(method, urlPath, body, opts = {}) {
  let auth;
  try {
    auth = opts.auth || loadAuth(opts.port, opts.home);
  } catch {
    return Promise.resolve({ ok: false, msg: '找不到本机 AmeMesh 令牌文件（请确认 remote/agent 正在运行）' });
  }
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1',
      port: auth.port,
      method,
      path: urlPath,
      timeout: 22000,
      headers: {
        'X-Ame-Mesh': auth.token,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch { resolve({ ok: false, msg: '解析响应失败' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, msg: '请求本机 agent 超时' }); });
    req.on('error', (e) => resolve({ ok: false, msg: '无法连接本机 agent：' + e.message }));
    req.end(data);
  });
}

function rpc(op, params = {}, opts = {}) {
  const sessionId = params.sessionId || process.env.AME_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  return callLocal('POST', '/mesh/rpc', { op, sessionId, ...params }, opts);
}

// ---- MCP Server (JSON-RPC 2.0 over stdio) ----
const MCP_TOOLS = [
  {
    name: 'mesh_status',
    description: '查看当前会话所属协同项目的局部拓扑状态表（上下游 Master/Worker/Peer 节点、目标 Goal、停机条件 Stop Gate）以及该项目授权访问的跨机器文件夹列表（含用户备注、AI 备注与浅层目录结构树）。不会返回无关会话。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，项目 ID（不填则自动按当前会话匹配）' },
        sessionId: { type: 'string', description: '可选，当前会话 ID' },
      },
    },
  },
  {
    name: 'mesh_tree',
    description: '按需查看某台电脑上指定文件夹的浅层目录结构树、Git 分支与磁盘可用空间（从群晖缓存秒读或触发轻量扫描，无需拉取实际文件）。',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: '目标电脑名称（不填则为本机）' },
        path: { type: 'string', description: '目标文件夹绝对路径' },
        depth: { type: 'number', description: '展开层级（1~5，默认 3）' },
        refresh: { type: 'boolean', description: '是否强制向目标机器重新扫描刷新' },
      },
      required: ['path'],
    },
  },
  {
    name: 'mesh_note',
    description: '为某台电脑上的文件夹更新「AI 备注」（记录该目录的代码入口、运行环境、产物输出规律等经验，不会覆盖用户的「我的备注」）。',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: '目标电脑名称（不填则为本机）' },
        path: { type: 'string', description: '文件夹绝对路径' },
        aiNote: { type: 'string', description: 'AI 备注内容' },
        tag: { type: 'string', description: '可选语义标签（仅在该文件夹尚无用户标签时生效：solver/results/code/data/docs）' },
      },
      required: ['path', 'aiNote'],
    },
  },
  {
    name: 'mesh_spawn',
    description: '在目标电脑的指定文件夹启动一个新的 Worker 协同会话（支持 claude / codex / opencode / agy），自动加入当前项目拓扑与糖糖看板分组，并下发包含「执行目标 Goal」与「停机检视条件 Stop Gate」的任务契约。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，所属项目 ID' },
        projectName: { type: 'string', description: '若尚未创建项目，自动新建的项目名' },
        machine: { type: 'string', description: '目标电脑名称' },
        cwd: { type: 'string', description: '目标电脑上的工作目录绝对路径（需在项目允许访问范围内）' },
        tool: { type: 'string', enum: ['claude', 'codex', 'opencode', 'agy'], description: '启动的 Coding Agent 类型' },
        alias: { type: 'string', description: '给该节点起一个易读别名（如：FEKO求解节点）' },
        goal: { type: 'string', description: '本阶段明确的执行目标（Goal）' },
        stopCondition: { type: 'string', description: '停机与检视边界（Stop & Review Gate）：达成何种状态必须停下等待 Review' },
        prompt: { type: 'string', description: '首轮详细执行指令' },
      },
      required: ['machine', 'cwd', 'goal', 'prompt'],
    },
  },
  {
    name: 'mesh_send',
    description: '向当前项目拓扑内的另一个节点（Worker 或平级 Cowork 节点）发送指令或协作消息。若对方空闲则直接注入终端唤醒；若对方正忙则自动进入收件箱，待其本轮结束后自动投递。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，项目 ID' },
        toNodeId: { type: 'string', description: '目标节点 ID 或别名' },
        text: { type: 'string', description: '发送的具体指令或协作消息内容' },
        goal: { type: 'string', description: '可选，更新目标节点的阶段 Goal' },
        stopCondition: { type: 'string', description: '可选，更新目标节点的停机检视条件 Stop Gate' },
      },
      required: ['toNodeId', 'text'],
    },
  },
  {
    name: 'mesh_report',
    description: 'Worker 节点达成停机条件（Stop Gate）或遇到阻塞时，向主控会话（Master）汇报结果摘要与产出文件路径，并进入等待 Review 状态（自动唤醒空闲的主控会话）。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，项目 ID' },
        fromNodeId: { type: 'string', description: '可选，当前节点 ID' },
        summary: { type: 'string', description: '执行结果摘要、关键数值指标或阻塞原因' },
        reviewStatus: { type: 'string', enum: ['waiting_review', 'done', 'blocked'], description: '节点状态（默认 waiting_review）' },
        artifacts: { type: 'array', items: { type: 'string' }, description: '产出的图表或数据文件路径列表' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'mesh_transfer',
    description: '请求跨机器传输文件，或针对超大文件（>50MB / 跨慢速网络）向用户发起「移动硬盘人工拷贝（Sneakernet）」请求卡片。用户拷贝完成后系统会自动唤醒目标会话。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，项目 ID' },
        fromMachine: { type: 'string', description: '源电脑名称' },
        fromPath: { type: 'string', description: '源文件路径' },
        toMachine: { type: 'string', description: '目标电脑名称' },
        toPath: { type: 'string', description: '目标存放路径' },
        size: { type: 'number', description: '文件字节大小（>= 50MB 自动转为人工硬盘摆渡请求）' },
        mode: { type: 'string', enum: ['auto', 'manual_disk'], description: '传输模式（auto 或 manual_disk）' },
        note: { type: 'string', description: '给用户的拷贝说明备注' },
      },
      required: ['fromMachine', 'fromPath', 'toMachine', 'toPath'],
    },
  },
];

async function handleMcpCall(name, args = {}, opts = {}) {
  switch (name) {
    case 'mesh_status': return rpc('status', args, opts);
    case 'mesh_tree': return rpc('tree', args, opts);
    case 'mesh_note': return rpc('note', args, opts);
    case 'mesh_spawn': return rpc('spawn', args, opts);
    case 'mesh_send': return rpc('send', args, opts);
    case 'mesh_report': return rpc('report', args, opts);
    case 'mesh_transfer': return rpc('transfer', args, opts);
    default: return { ok: false, msg: '未知的工具：' + name };
  }
}

function startMcpStdio(opts = {}) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'ame-mesh', version: '1.0.0' },
          },
        }) + '\n');
      } else if (msg.method === 'tools/list') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: MCP_TOOLS },
        }) + '\n');
      } else if (msg.method === 'tools/call') {
        const p = msg.params || {};
        const r = await handleMcpCall(p.name, p.arguments || {}, opts);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
            isError: r.ok === false,
          },
        }) + '\n');
      } else if (msg.id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
      }
    }
  });
}

// ---- CLI parser for direct command execution ----
function parseCliFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function runCli(argv = process.argv.slice(2)) {
  const flags = parseCliFlags(argv);
  const cmd = flags._[0] || 'status';
  if (cmd === 'mcp') return startMcpStdio();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log([
      'AmeMesh 跨机器/跨 Agent 协同工具 (CLI & MCP)',
      '用法:',
      '  node tools/ame-mesh.js status [--projectId <id>] [--sessionId <id>]',
      '  node tools/ame-mesh.js tree --path <dir> [--machine <pc>] [--refresh]',
      '  node tools/ame-mesh.js note --path <dir> --aiNote <text> [--machine <pc>] [--tag <tag>]',
      '  node tools/ame-mesh.js spawn --machine <pc> --cwd <dir> --goal <goal> --prompt <text> [--stopCondition <gate>] [--tool claude|codex|opencode|agy] [--alias <name>]',
      '  node tools/ame-mesh.js send --toNodeId <node> --text <msg> [--goal <goal>] [--stopCondition <gate>]',
      '  node tools/ame-mesh.js report --summary <text> [--reviewStatus waiting_review|done|blocked] [--artifacts a.png,b.csv]',
      '  node tools/ame-mesh.js transfer --fromMachine <pc1> --fromPath <p1> --toMachine <pc2> --toPath <p2> [--size <bytes>] [--mode auto|manual_disk] [--note <text>]',
      '  node tools/ame-mesh.js mcp   (启动标准 stdio MCP Server)',
    ].join('\n'));
    return;
  }
  if (typeof flags.artifacts === 'string') {
    flags.artifacts = flags.artifacts.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (flags.size != null) flags.size = +flags.size || 0;
  if (flags.depth != null) flags.depth = +flags.depth || 3;
  delete flags._;
  const res = await rpc(cmd, flags);
  console.log(JSON.stringify(res, null, 2));
  if (res.ok === false) process.exitCode = 1;
}

if (require.main === module) {
  runCli();
}

module.exports = { rpc, handleMcpCall, MCP_TOOLS, loadAuth, callLocal };
