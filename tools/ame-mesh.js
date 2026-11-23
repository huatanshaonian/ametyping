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
const child_process = require('child_process');

const DEFAULT_PORT = +process.env.AME_MESH_PORT || +process.env.AME_MESH_BRIDGE_PORT || 3941;

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

function savePendingMeshEvent(evt, home = os.homedir()) {
  try {
    const dir = path.join(home, '.ametyping');
    fs.mkdirSync(dir, { recursive: true });
    const pendingFile = path.join(dir, 'pending-mesh-events.json');
    let list = [];
    try {
      const raw = fs.readFileSync(pendingFile, 'utf8');
      list = JSON.parse(raw);
      if (!Array.isArray(list)) list = [];
    } catch {}
    list.push(evt);
    const tmpFile = pendingFile + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpFile, pendingFile);
  } catch {}
}

function executeCommandWorker({ commandArgs, label, logFile, cwd, projectId, nodeId, sessionId, opts = {} }) {
  const startMs = Date.now();
  const logDir = path.dirname(logFile);
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const outStream = fs.createWriteStream(logFile, { flags: 'a' });
  const rollingLines = [];

  const isBatch = /\.(cmd|bat)$/i.test(commandArgs[0]);
  const useShell = commandArgs.length === 1 || isBatch;
  const child = child_process.spawn(commandArgs[0], commandArgs.slice(1), {
    cwd: cwd || process.cwd(),
    shell: useShell,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  function handleChunk(chunk) {
    outStream.write(chunk);
    const str = chunk.toString('utf8');
    const lines = str.split(/\r?\n/);
    for (const l of lines) {
      if (l.trim()) {
        rollingLines.push(l);
        if (rollingLines.length > 40) rollingLines.shift();
      }
    }
  }

  if (child.stdout) child.stdout.on('data', handleChunk);
  if (child.stderr) child.stderr.on('data', handleChunk);

  return new Promise((resolve) => {
    child.on('close', async (exitCode) => {
      outStream.end();
      const durationMs = Date.now() - startMs;
      const code = exitCode !== null ? exitCode : 1;
      const tail = rollingLines.join('\n');
      const evt = {
        source: 'run',
        kind: code === 0 ? 'exit_ok' : 'exit_err',
        label: label || commandArgs[0],
        exitCode: code,
        durationMs,
        tail,
        cwd: cwd || process.cwd(),
        logFile,
        projectId: projectId || '',
        nodeId: nodeId || '',
        sessionId: sessionId || '',
      };
      const rpcOpts = { ...opts, cwd: cwd || opts.cwd };
      try {
        const r = await rpc('event', evt, rpcOpts);
        if (!r || !r.ok) {
          savePendingMeshEvent(evt);
        }
      } catch {
        savePendingMeshEvent(evt);
      }
      resolve({ ok: code === 0, exitCode: code, durationMs, logFile });
    });
    child.on('error', async (err) => {
      outStream.end();
      const durationMs = Date.now() - startMs;
      const tail = '启动进程失败: ' + err.message;
      const evt = {
        source: 'run',
        kind: 'exit_err',
        label: label || commandArgs[0],
        exitCode: 1,
        durationMs,
        tail,
        cwd: cwd || process.cwd(),
        logFile,
        projectId: projectId || '',
        nodeId: nodeId || '',
        sessionId: sessionId || '',
      };
      const rpcOpts = { ...opts, cwd: cwd || opts.cwd };
      try {
        const r = await rpc('event', evt, rpcOpts);
        if (!r || !r.ok) savePendingMeshEvent(evt);
      } catch {
        savePendingMeshEvent(evt);
      }
      resolve({ ok: false, exitCode: 1, durationMs, error: err.message, logFile });
    });
  });
}

function watchPidWorker({ pid, label, cwd, projectId, nodeId, sessionId, intervalMs = 2000, opts = {} }) {
  const startMs = Date.now();
  const targetPid = +pid;
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      let alive = false;
      try {
        process.kill(targetPid, 0);
        alive = true;
      } catch (e) {
        alive = e.code === 'EPERM';
      }
      if (!alive) {
        clearInterval(timer);
        const durationMs = Date.now() - startMs;
        const evt = {
          source: 'run',
          kind: 'pid_exit',
          label: label || ('进程 PID ' + targetPid),
          exitCode: 0,
          durationMs,
          cwd: cwd || process.cwd(),
          projectId: projectId || '',
          nodeId: nodeId || '',
          sessionId: sessionId || '',
        };
        try {
          const r = await rpc('event', evt, { ...opts, cwd: cwd || opts.cwd });
          if (!r || !r.ok) savePendingMeshEvent(evt);
        } catch {
          savePendingMeshEvent(evt);
        }
        resolve({ ok: true, exited: true, pid: targetPid, durationMs });
      }
    }, intervalMs);
  });
}

async function runBgMcp(args = {}, opts = {}) {
  const cmdStr = args.command;
  if (!cmdStr || typeof cmdStr !== 'string') return { ok: false, msg: '缺少 command 参数' };
  const cwd = args.cwd || opts.cwd || process.cwd();
  const logFile = args.logFile || path.join(cwd, '.ame-run-' + Date.now() + '.log');
  const label = args.label || cmdStr.slice(0, 60);
  const sessionId = args.sessionId || process.env.AME_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  const projectId = args.projectId || process.env.AME_PROJECT_ID || '';

  const workerPayload = {
    commandArgs: [cmdStr],
    label,
    logFile,
    cwd,
    projectId,
    nodeId: args.targetNodeId || args.nodeId || process.env.AME_NODE_ID || '',
    sessionId,
  };
  const child = child_process.spawn(
    process.execPath,
    [__filename, '__run_worker', JSON.stringify(workerPayload)],
    { detached: true, stdio: 'ignore', cwd }
  );
  child.unref();
  return {
    ok: true,
    pid: child.pid,
    label,
    logFile,
    msg: '计算作业「' + label + '」已在后台脱离运行 (PID ' + child.pid + ')。日志写入 ' + logFile + '。计算结束后看门狗将自动向会话发送就绪事件唤醒。可随时调用 mesh_report(reviewStatus="blocked") 等待计算完成。',
  };
}

function rpc(op, params = {}, opts = {}) {
  const sessionId = params.sessionId || process.env.AME_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  const projectId = params.projectId || process.env.AME_PROJECT_ID || process.env.AME_MESH_PROJECT_ID || '';
  const envNodeId = process.env.AME_NODE_ID || process.env.AME_MESH_NODE_ID || '';
  const fromNodeId = params.fromNodeId || envNodeId;
  const nodeId = params.nodeId || envNodeId;
  const callerCwd = params.callerCwd || opts.cwd || process.cwd();
  const payload = {
    op,
    ...params,
    sessionId,
    callerCwd,
  };
  if (projectId) payload.projectId = projectId;
  if (fromNodeId) payload.fromNodeId = fromNodeId;
  if (nodeId) payload.nodeId = nodeId;
  return callLocal('POST', '/mesh/rpc', payload, opts);
}

// ---- MCP Server (JSON-RPC 2.0 over stdio) ----
const MCP_TOOLS = [
  {
    name: 'mesh_status',
    description: '查看当前会话所属协同项目的局部拓扑状态表（上下游 Master/Worker/Peer 节点、目标 Goal、停机条件 Stop Gate）、授权目录摘要、roleCatalog（外置角色名片目录）、pools（可用模型分组池健康概览）及各机器已安装的 Harness（harnesses）；未绑定项目时会返回已有项目精简列表（projects）与跨机目录摘要（含近期会话与 worktree 目录，默认不含完整文件树防截断）。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，项目 ID（不填则自动按当前会话匹配）' },
        sessionId: { type: 'string', description: '可选，当前会话 ID' },
        includeTree: { type: 'boolean', description: '可选，是否附带目录完整文件树（默认 false，只返回轻量摘要防输出过大；需查文件树请按需调 mesh_tree）' },
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
    description: '在目标电脑的指定文件夹启动一个新的 Worker 协同会话（支持 claude / codex / opencode / agy / kiro），自动加入当前项目拓扑与糖糖看板分组，并下发包含「执行目标 Goal」与「停机检视条件 Stop Gate」的任务契约。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，所属项目 ID' },
        projectName: { type: 'string', description: '若尚未创建项目，自动新建的项目名' },
        machine: { type: 'string', description: '目标电脑名称' },
        cwd: { type: 'string', description: '目标电脑上的工作目录绝对路径（需在项目允许访问范围内）' },
        tool: { type: 'string', enum: ['claude', 'codex', 'opencode', 'agy', 'kiro'], description: '启动的 Coding Agent 类型' },
        role: { type: 'string', description: '可选，节点角色名（内置 master/worker/verifier/peer 或自定义角色，自动加载对应规范）' },
        pool: { type: 'string', description: '可选，模型能力组名（如 fast-coder/flagship/heavy-reasoner，由确定性路由按额度健康度自动选模型并故障回落；可与 tool 配合或替代 tool）' },
        model: { type: 'string', description: '可选，显式指定具体模型名' },
        alias: { type: 'string', description: '给该节点起一个易读别名（如：FEKO求解节点）' },
        goal: { type: 'string', description: '本阶段明确的执行目标（Goal）' },
        stopCondition: { type: 'string', description: '停机与检视边界（Stop & Review Gate）：达成何种状态必须停下等待 Review' },
        prompt: { type: 'string', description: '首轮详细执行指令' },
        boundaries: { type: 'array', items: { type: 'string' }, description: '允许该节点修改的文件或目录白名单（由主控拆分配置，交卷时自动核对防越界）' },
        doneWhen: { type: 'array', items: { type: 'string' }, description: '编号的可核对验收条件列表' },
        checks: { type: 'array', items: { type: 'string' }, description: '交卷前必跑的验证命令列表' },
        workspaceMode: { type: 'string', enum: ['inherit', 'worktree'], description: '工作区模式：inherit 共用目录（默认），worktree 自动切出独立 git worktree 分支并发隔离' },
        branch: { type: 'string', description: '可选，workspaceMode=worktree 时指定新分支名' },
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
        doneWhenStatus: { type: 'array', items: { type: 'string' }, description: '逐条回填 doneWhen 核对结果' },
        checksOutput: { type: 'string', description: '验证命令实际输出摘要' },
        boundaries: { type: 'array', items: { type: 'string' }, description: '可选，显式覆盖本次核对的文件边界白名单' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'mesh_review',
    description: 'Master 专用结单与节点生命周期管理：approve（静默批准结单）、reject（打回返工并可附反馈唤醒）、archive（归档退役：停止唤醒与看门狗监控，但永久保留拓扑与黑板痕迹）。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，项目 ID' },
        nodeId: { type: 'string', description: '目标节点 ID 或别名' },
        action: { type: 'string', enum: ['approve', 'reject', 'archive'], description: 'approve=静默批准结单, reject=打回返工, archive=退役归档保留痕迹' },
        note: { type: 'string', description: '可选，结单备注或打回返工意见' },
        closeTerminal: { type: 'boolean', default: false, description: '仅 action=archive 时生效；显式传 true 才向该 Worker/Verifier 发送优雅退出指令（默认 false；严禁关闭 master）' },
      },
      required: ['nodeId', 'action'],
    },
  },
  {
    name: 'mesh_transfer',
    description: '请求跨机器传输文件：小于 50MB 的文件在目标机器在线且开启文件浏览与上传（files & upload）时会自动流式直传并做 CRC-32 校验；大于等于 50MB 或目标离线/不可写时，自动降级向用户发起「移动硬盘人工拷贝（Sneakernet）」请求卡片，用户拷贝完成后自动唤醒目标会话。',
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
  {
    name: 'mesh_run',
    description: '在后台脱离当前会话启动长时间计算或跑批命令（如 FEKO / CEM 求解器），进程退出时自动捕获退出码与日志末尾并向目标会话发送完成事件唤醒，无需占着会话轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令字符串' },
        label: { type: 'string', description: '作业易读名称（如：FEKO球体扫频）' },
        cwd: { type: 'string', description: '执行工作目录（默认当前目录）' },
        logFile: { type: 'string', description: '可选，输出日志文件路径' },
        projectId: { type: 'string', description: '可选，所属项目 ID' },
        targetNodeId: { type: 'string', description: '可选，完成后唤醒的目标节点 ID' },
      },
      required: ['command'],
    },
  },
  {
    name: 'mesh_trigger',
    description: '管理项目的文件夹外部事件触发器（监听指定文件夹内新生成的仿真结果文件，文件写入稳定后自动唤醒节点处理；进程退出监听请使用 mesh_run 或 CLI watch-pid）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove', 'pause', 'resume'], description: '触发器操作' },
        projectId: { type: 'string', description: '项目 ID' },
        triggerId: { type: 'string', description: '触发器 ID（remove/pause/resume 时必填）' },
        type: { type: 'string', enum: ['folder'], description: '触发器类型（仅支持 folder；进程退出监听由 mesh_run / CLI watch-pid 处理）' },
        machine: { type: 'string', description: '监听的目标电脑名称' },
        path: { type: 'string', description: '监听的文件夹绝对路径（需在项目授权工作区内）' },
        glob: { type: 'string', description: '文件名匹配通配符（如 *.ffe, *.out, *.csv，默认 *）' },
        maxDepth: { type: 'number', description: '目录递归扫描深度（1~6，默认 4）' },
        targetNodeId: { type: 'string', description: '触发后通知的目标节点 ID（不填则通知主控节点）' },
        label: { type: 'string', description: '触发器说明标签' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mesh_board_post',
    description: '向当前项目的统一共享黑板发帖，支持 @节点别名、@all 或 @#频道名 定向唤醒（<500字全文直注，>=500字极简门铃），支持用 #楼层号 引用历史帖子；done=true 时自动触发本机 git 改动边界对账。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，项目 ID' },
        nodeId: { type: 'string', description: '强烈建议传入，当前发言节点 ID（防止同目录多节点并行时身份串台）' },
        text: { type: 'string', description: '帖子内容（支持 @节点别名 / @all / @#频道名 点名，以及 #楼层号 引用）' },
        channel: { type: 'string', default: 'main', description: "频道名称（默认 'main'）" },
        artifacts: { type: 'array', items: { type: 'string' }, description: '可选，关联产物文件路径列表' },
        done: { type: 'boolean', description: '可选，是否为交卷帖；done=true 时自动触发本机 git 改动边界对账' },
        doneWhenStatus: { type: 'array', items: { type: 'string' }, description: '可选，逐条回填 doneWhen 核对结果' },
        checksOutput: { type: 'string', description: '可选，验证命令实际输出摘要' },
        boundaries: { type: 'array', items: { type: 'string' }, description: '可选，显式覆盖本次核对的文件边界白名单' },
      },
      required: ['text'],
    },
  },
  {
    name: 'mesh_board_read',
    description: '按楼层拉取当前项目黑板的增量帖子（或按 seqList 精准读取指定 #楼层）并推进本节点的已读游标 lastReadSeq。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，项目 ID' },
        since: { type: 'number', description: '可选，从该楼层号之后开始增量拉取' },
        limit: { type: 'number', description: '可选，最多拉取条数' },
        channel: { type: 'string', description: '可选，按频道过滤' },
        seqList: { type: 'array', items: { type: 'number' }, description: '可选，精准读取指定的 #楼层号列表' },
      },
    },
  },
  {
    name: 'mesh_task',
    description: '管理当前项目的共享任务板（Shared Task List），支持任务依赖 blockedBy 自动解锁与文件边界 boundaries 声明。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'claim', 'update', 'remove'], description: '任务板操作' },
        projectId: { type: 'string', description: '可选，项目 ID' },
        nodeId: { type: 'string', description: '可选，当前调用节点 ID' },
        taskId: { type: 'string', description: '任务 ID（claim/update/remove 时使用）' },
        title: { type: 'string', description: '任务标题' },
        desc: { type: 'string', description: '任务详细描述' },
        ownerNodeId: { type: 'string', description: '负责节点 ID 或别名' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'review', 'done', 'blocked'], description: '任务状态' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: '前置依赖任务 ID 列表' },
        boundaries: { type: 'array', items: { type: 'string' }, description: '允许修改的文件或目录白名单' },
        doneWhen: { type: 'array', items: { type: 'string' }, description: '编号的可核对验收条件列表' },
        checks: { type: 'array', items: { type: 'string' }, description: '交卷前必跑的验证命令列表' },
        boardRefs: { type: 'array', items: { type: 'number' }, description: '关联的黑板 #楼层号列表' },
        artifacts: { type: 'array', items: { type: 'string' }, description: '关联产出文件路径列表' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mesh_channel',
    description: '管理当前项目黑板的多频道事件溯源（创建频道、订阅/退订频道、归档频道，支持 @#频道名 定向唤醒订阅成员）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'subscribe', 'unsubscribe', 'archive'], description: '频道操作' },
        projectId: { type: 'string', description: '可选，项目 ID' },
        channel: { type: 'string', description: '频道名称（create/subscribe/unsubscribe/archive 时必填）' },
        desc: { type: 'string', description: '可选，频道描述' },
        nodeId: { type: 'string', description: '可选，目标节点 ID 或别名' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mesh_workspace',
    description: '仅限 Master 主控使用：为项目一次性配置跨机器工作区安全围栏（rw 读写 / ro 只读），配置后默认自动上锁（workspacesLocked=true）。锁定后禁止擅自改动或扩权；仅当用户明确授意时方可传 userApproved=true 与 reason 解锁更新，并在黑板留审计记录。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选，项目 ID（不填且提供 projectName 时自动建项目）' },
        projectName: { type: 'string', description: '可选，新建项目的名称' },
        workspaces: {
          type: 'array',
          description: '允许访问的跨机器文件夹列表',
          items: {
            type: 'object',
            properties: {
              machine: { type: 'string', description: '电脑名称' },
              path: { type: 'string', description: '目录绝对路径' },
              mode: { type: 'string', enum: ['rw', 'ro'], description: '读写权限（rw 或 ro）' },
              tag: { type: 'string', description: '可选语义标签（solver/results/code/data/docs）' },
            },
            required: ['machine', 'path'],
          },
        },
        lock: { type: 'boolean', description: '配置后是否立即上锁（默认 true）' },
        userApproved: { type: 'boolean', description: '仅在已锁定且获得用户明确授意时设为 true' },
        reason: { type: 'string', description: '解锁更新围栏时的原因说明（记录在黑板）' },
      },
      required: ['workspaces'],
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
    case 'mesh_review': return rpc('review', args, opts);
    case 'mesh_transfer': return rpc('transfer', args, opts);
    case 'mesh_run': return runBgMcp(args, opts);
    case 'mesh_trigger': return rpc('trigger', args, opts);
    case 'mesh_board_post': return rpc('board_post', args, opts);
    case 'mesh_board_read': return rpc('board_read', args, opts);
    case 'mesh_task': return rpc('task', args, opts);
    case 'mesh_channel': return rpc('channel', args, opts);
    case 'mesh_workspace': return rpc('workspace', args, opts);
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

async function runCli(argv = process.argv.slice(2), opts = {}) {
  const flags = parseCliFlags(argv);
  const cmd = flags._[0] || 'status';
  if (cmd === '__run_worker') {
    const payload = JSON.parse(argv[1]);
    await executeCommandWorker(payload);
    return;
  }
  if (cmd === '__watch_worker') {
    const payload = JSON.parse(argv[1]);
    await watchPidWorker(payload);
    return;
  }
  if (cmd === 'run') {
    const dashDashIdx = argv.indexOf('--');
    const subArgv = dashDashIdx >= 0 ? argv.slice(0, dashDashIdx) : argv;
    const runFlags = parseCliFlags(subArgv);
    const commandArgs = dashDashIdx >= 0 ? argv.slice(dashDashIdx + 1) : runFlags._.slice(1);
    if (!commandArgs.length) {
      console.error('缺少要执行的命令。用法: node tools/ame-mesh.js run [options] -- <cmd> [args...]');
      process.exitCode = 1;
      return;
    }
    const cwd = runFlags.cwd || process.cwd();
    const label = runFlags.label || path.basename(commandArgs[0]);
    const logFile = runFlags.log || path.join(cwd, '.ame-run-' + Date.now() + '.log');
    const projectId = runFlags.projectId || process.env.AME_PROJECT_ID || '';
    const nodeId = runFlags.nodeId || runFlags.targetNodeId || process.env.AME_NODE_ID || '';
    const sessionId = runFlags.sessionId || process.env.AME_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
    const isFg = Boolean(runFlags.fg);
    if (isFg) {
      const r = await executeCommandWorker({ commandArgs, label, logFile, cwd, projectId, nodeId, sessionId });
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exitCode = r.exitCode || 1;
      return;
    }
    const child = child_process.spawn(
      process.execPath,
      [__filename, '__run_worker', JSON.stringify({ commandArgs, label, logFile, cwd, projectId, nodeId, sessionId })],
      { detached: true, stdio: 'ignore', cwd }
    );
    child.unref();
    console.log(JSON.stringify({ ok: true, bg: true, pid: child.pid, label, logFile }, null, 2));
    return;
  }
  if (cmd === 'watch-pid') {
    const pid = +flags.pid;
    if (!pid) {
      console.error('缺少 --pid 参数。用法: node tools/ame-mesh.js watch-pid --pid <pid> [--label <name>]');
      process.exitCode = 1;
      return;
    }
    const cwd = flags.cwd || process.cwd();
    const label = flags.label || ('PID ' + pid);
    const projectId = flags.projectId || process.env.AME_PROJECT_ID || '';
    const nodeId = flags.nodeId || flags.targetNodeId || process.env.AME_NODE_ID || '';
    const sessionId = flags.sessionId || process.env.AME_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
    const intervalMs = +flags.intervalMs || 2000;
    const isFg = Boolean(flags.fg);
    if (isFg) {
      const r = await watchPidWorker({ pid, label, cwd, projectId, nodeId, sessionId, intervalMs });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    const child = child_process.spawn(
      process.execPath,
      [__filename, '__watch_worker', JSON.stringify({ pid, label, cwd, projectId, nodeId, sessionId, intervalMs })],
      { detached: true, stdio: 'ignore', cwd }
    );
    child.unref();
    console.log(JSON.stringify({ ok: true, bg: true, pid: child.pid, watchingPid: pid }, null, 2));
    return;
  }
  if (cmd === 'mcp') return startMcpStdio();
  if (flags.help || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log([
      'AmeMesh 跨机器/跨 Agent 协同工具 (CLI & MCP)',
      '用法:',
      '  node tools/ame-mesh.js status [--projectId <id>] [--sessionId <id>]',
      '  node tools/ame-mesh.js tree --path <dir> [--machine <pc>] [--refresh]',
      '  node tools/ame-mesh.js note --path <dir> --aiNote <text> [--machine <pc>] [--tag <tag>]',
      '  node tools/ame-mesh.js spawn --machine <pc> --cwd <dir> --goal <goal> --prompt <text> [--stopCondition <gate>] [--tool claude|codex|opencode|agy|kiro] [--role <role>] [--pool <pool>] [--model <model>] [--alias <name>] [--workspaceMode inherit|worktree] [--branch <name>]',
      '  node tools/ame-mesh.js send --toNodeId <node> --text <msg> [--goal <goal>] [--stopCondition <gate>]',
      '  node tools/ame-mesh.js report --summary <text> [--reviewStatus waiting_review|done|blocked] [--artifacts a.png,b.csv]',
      '  node tools/ame-mesh.js transfer --fromMachine <pc1> --fromPath <p1> --toMachine <pc2> --toPath <p2> [--size <bytes>] [--mode auto|manual_disk] [--note <text>]',
      '  node tools/ame-mesh.js run [--cwd <dir>] [--label <name>] [--log <file>] [--projectId <id>] [--nodeId <id>] [--fg] -- <cmd> [args...]',
      '  node tools/ame-mesh.js watch-pid --pid <pid> [--label <name>] [--cwd <dir>] [--projectId <id>] [--nodeId <id>] [--intervalMs <ms>] [--fg]',
      '  node tools/ame-mesh.js trigger --action add|list|remove|pause|resume [--projectId <id>] [--triggerId <id>] [--machine <pc>] [--path <dir>] [--glob <pattern>] [--maxDepth <1-6>] [--targetNodeId <id>] [--label <text>]',
      '  node tools/ame-mesh.js board-post --text <msg> [--projectId <id>] [--channel main] [--artifacts a,b] [--done] [--doneWhenStatus s1,s2] [--checksOutput <text>] [--boundaries p1,p2]',
      '  node tools/ame-mesh.js board-read [--projectId <id>] [--since <seq>] [--limit <n>] [--channel main] [--seqList 1,2,3]',
      '  node tools/ame-mesh.js task --action list|add|claim|update|remove [--projectId <id>] [--taskId <id>] [--title <text>] [--desc <text>] [--ownerNodeId <node>] [--status pending|in_progress|review|done|blocked] [--blockedBy t1,t2] [--boundaries p1,p2] [--doneWhen w1,w2] [--checks c1,c2] [--boardRefs 1,2] [--artifacts a,b]',
      '  node tools/ame-mesh.js channel --action list|create|subscribe|unsubscribe|archive [--projectId <id>] [--channel <name>] [--desc <text>] [--nodeId <id>]',
      '  node tools/ame-mesh.js mcp   (启动标准 stdio MCP Server)',
    ].join('\n'));
    return;
  }
  for (const key of ['artifacts', 'boundaries', 'doneWhen', 'checks', 'blockedBy', 'doneWhenStatus']) {
    if (typeof flags[key] === 'string') {
      flags[key] = flags[key].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  for (const key of ['seqList', 'boardRefs']) {
    if (typeof flags[key] === 'string') {
      flags[key] = flags[key].split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));
    }
  }
  if (flags.size != null) flags.size = +flags.size || 0;
  if (flags.depth != null) flags.depth = +flags.depth || 3;
  for (const key of ['since', 'limit', 'maxDepth']) {
    if (flags[key] != null) {
      const n = Number(flags[key]);
      if (Number.isFinite(n)) flags[key] = n;
    }
  }
  if (flags.done === true || flags.done === 'true') flags.done = true;
  else if (flags.done === false || flags.done === 'false') flags.done = false;
  delete flags._;
  const CLI_OP_MAP = {
    'board-post': 'board_post',
    'board-read': 'board_read',
    task: 'task',
    channel: 'channel',
  };
  const op = CLI_OP_MAP[cmd] || cmd;
  const res = await rpc(op, flags, opts);
  console.log(JSON.stringify(res, null, 2));
  if (res.ok === false) process.exitCode = 1;
}

if (require.main === module) {
  runCli();
}

module.exports = { rpc, handleMcpCall, MCP_TOOLS, loadAuth, callLocal, savePendingMeshEvent, executeCommandWorker, watchPidWorker, runBgMcp, runCli, parseCliFlags };
