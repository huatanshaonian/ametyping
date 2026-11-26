// Windose HPC MCP (windose-hpc): unified interface for Sugon/SCNet (11 clusters + rayfile-c),
// Google Colab, and local Mini-Slurm GPU/NUMA compute machines.
// All SSH keys and rayfile-c tokens stay exclusively on the gateway (ubuntu_hpc); client agents never see credentials.
'use strict';

const INSTRUCTIONS = [
  'Windose 统一超算与算力调度 MCP（覆盖曙光/SCNet 多中心集群、Google Colab 与本地 GPU/NUMA 算力机）。',
  '1. 提交前先调 hpc_status 查看可用集群/分区/GPU 负载与 Colab 余额；',
  '2. 曙光大算例产物需要高速回传（rayfile-c 720Mbps）时，工作目录应落在对应账号的快传共享根目录下（如合肥 huatan 的 /public/home/huatan/workspace/... 或 acc143g266 的 /public/home/acc143g266/TangYC/...），outputDir 指向 /mnt/nas/sugon-out/...；',
  '3. 科研算例失败严禁盲目重投或擅改科研代码，先调 hpc_logs / hpc_history 收集报错证据向用户或 Master 汇报。',
].join('\n');

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const TOOLS = [
  {
    name: 'hpc_status',
    description: '查看全部算力状态：本地 GPU/NUMA 算力机负载、Google Colab 余额/运行时、以及曙光/SCNet 全部超算入口的在线状态、分区、在途作业、快传支持与密钥到期提醒。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'hpc_jobs',
    description: '查询 Mini-Slurm 队列中的运行中、排队中与近期已完成作业列表。',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: '可选：按算力机或网关机名过滤' },
        providerType: { type: 'string', enum: ['local-agent', 'colab', 'sugon'], description: '可选：按算力提供方过滤' },
        status: { type: 'string', enum: ['running', 'queued', 'done', 'failed', 'cancelled'], description: '可选：按状态过滤' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数上限（默认 30）' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'hpc_submit',
    description: '远程提交无人值守计算作业到曙光超算（sugon）、Google Colab（colab）或本地算力机（local-agent）。',
    inputSchema: {
      type: 'object',
      properties: {
        providerType: { type: 'string', enum: ['sugon', 'colab', 'local-agent'], description: '算力提供方（默认 sugon）' },
        command: { type: 'string', description: '要执行的完整命令' },
        label: { type: 'string', description: '作业名称/备注' },
        sugonProfile: { type: 'string', description: '曙光入口 ID（如 hf-huatan / hf-acc / ks-acc / hrb-acc / wuzh-acc / xa-acc / xh5-acc / ty-acc）' },
        partition: { type: 'string', description: '曙光 Slurm 分区名（留空使用该入口默认分区）' },
        nodes: { type: 'integer', minimum: 1, maximum: 128, description: '曙光节点数（默认 1）' },
        ntasks: { type: 'integer', minimum: 1, maximum: 4096, description: '曙光总进程/核数（默认 1）' },
        gpus: { type: 'integer', minimum: 0, maximum: 16, description: 'GPU 卡数（曙光或本地 GPU）' },
        walltime: { type: 'string', description: '曙光墙钟时间上限，如 04:00:00' },
        remoteWorkDir: { type: 'string', description: '曙光远端工作目录（留空使用配置默认）' },
        uploadPaths: { type: 'array', items: { type: 'string' }, description: '需上传的网关机本地文件/目录路径列表' },
        downloadPath: { type: 'string', description: '完成后需拉回的远端相对或绝对路径' },
        outputDir: { type: 'string', description: '网关机保存目录（推荐 /mnt/nas/sugon-out/... 或 /mnt/nas/colab-out/...）' },
        colabGpu: { type: 'string', enum: ['A100', 'L4', 'T4'], description: 'Colab GPU 型号' },
        maxDurationMin: { type: 'integer', minimum: 1, maximum: 720, description: 'Colab 最大运行时长（分钟）' },
        minBalanceCcu: { type: 'number', minimum: 0, description: 'Colab 余额红线（CCU）' },
        machine: { type: 'string', description: '本地算力机名（local-agent 必填；sugon/colab 可留空自动选网关）' },
        resource: { type: 'string', enum: ['gpu', 'cpu'], description: '资源类型（local-agent 用）' },
        numa: { type: 'integer', minimum: 1, maximum: 32, description: '本地 CPU/NUMA 路数' },
        cwd: { type: 'string', description: '工作目录' },
        priority: { type: 'string', enum: ['urgent', 'normal', 'low'], description: '队列优先级（默认 normal）' },
        projectId: { type: 'string', description: '可选：关联 AmeMesh 项目 ID（完成后结果回传黑板）' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: 'hpc_cancel',
    description: '中止运行中作业（曙光自动 scancel、Colab 自动 colab stop、本地 kill）或取消排队作业。',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Mini-Slurm 作业 ID（qjob_...）' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'hpc_prioritize',
    description: '调整排队中计算作业的优先级（urgent / normal / low）。',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '排队中的作业 ID（qjob_...）' },
        priority: { type: 'string', enum: ['urgent', 'normal', 'low'], description: '目标优先级' },
      },
      required: ['jobId', 'priority'],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: 'hpc_history',
    description: '实时查询指定（或全部）曙光/SCNet 入口近 N 天的真实 Slurm 历史作业记录（sacct）。',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: '可选：曙光入口 ID（如 hf-huatan、hf-acc、ks-acc）；留空则并发查询全部入口' },
        days: { type: 'integer', minimum: 1, maximum: 180, description: '回溯天数（默认 30 天）' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '每个入口最多返回条数（默认 20）' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'hpc_logs',
    description: '读取指定曙光/SCNet Slurm 作业的 stderr/stdout 尾部日志，或读取 Mini-Slurm 作业日志尾部。',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Mini-Slurm 作业 ID（qjob_...）；与 profile+slurmJobId 二选一' },
        profile: { type: 'string', description: '曙光入口 ID（如 hf-huatan / hf-acc）' },
        slurmJobId: { type: 'string', description: 'Slurm 数字作业 ID（如 29317793）' },
        workDir: { type: 'string', description: '可选：作业目录（留空自动通过 sacct 查询）' },
        lines: { type: 'integer', minimum: 10, maximum: 300, description: '读取行数（默认 80）' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

function createHpcTools({ mesh }) {
  async function call(name, args = {}) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error('未知工具：' + name);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象');
    for (const k of Object.keys(args)) {
      if (!Object.hasOwn(tool.inputSchema.properties, k)) throw new Error('未知参数：' + k);
    }
    if (!mesh || !mesh.computeQueue) throw new Error('看板服务器未启用 Mini-Slurm 算力队列');

    if (name === 'hpc_status') {
      const q = mesh.computeQueue.list({});
      const machines = typeof mesh.machinesSummary === 'function' ? mesh.machinesSummary() : [];
      return {
        ok: true,
        providers: q.providers || [],
        machines,
        activeJobs: (q.jobs || []).filter((j) => j.status === 'running' || j.status === 'queued').length,
      };
    }

    if (name === 'hpc_jobs') {
      const q = mesh.computeQueue.list({ machine: args.machine || '' });
      let jobs = Array.isArray(q.jobs) ? q.jobs : [];
      if (args.providerType) jobs = jobs.filter((j) => j.providerType === args.providerType);
      if (args.status) jobs = jobs.filter((j) => j.status === args.status);
      const lim = Math.min(100, Math.max(1, Number(args.limit) || 30));
      return { ok: true, total: jobs.length, jobs: jobs.slice(-lim).reverse() };
    }

    if (name === 'hpc_submit') {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) throw new Error('参数无效：command 不能为空');
      const provType = args.providerType || 'sugon';
      if (provType === 'local-agent' && !args.machine) throw new Error('参数无效：local-agent 模式必须提供 machine');
      return mesh.computeQueue.enqueue({
        machine: args.machine || '',
        providerType: provType,
        mode: 'remote',
        resource: args.resource || (provType === 'colab' || (Number(args.gpus) || 0) > 0 ? 'gpu' : 'cpu'),
        gpus: args.gpus,
        numa: args.numa,
        priority: args.priority || 'normal',
        sugonProfile: args.sugonProfile || '',
        partition: args.partition || '',
        nodes: args.nodes,
        ntasks: args.ntasks,
        walltime: args.walltime || '',
        remoteWorkDir: args.remoteWorkDir || '',
        uploadPaths: args.uploadPaths,
        downloadPath: args.downloadPath || '',
        outputDir: args.outputDir || '',
        colabGpu: args.colabGpu || '',
        maxDurationMin: args.maxDurationMin,
        minBalanceCcu: args.minBalanceCcu,
        cwd: args.cwd || '',
        label: args.label || command.slice(0, 50),
        projectId: args.projectId || '',
        command,
      });
    }

    if (name === 'hpc_cancel') {
      if (typeof args.jobId !== 'string' || !args.jobId.trim()) throw new Error('参数无效：缺少 jobId');
      return mesh.computeQueue.cancel(args.jobId.trim());
    }

    if (name === 'hpc_prioritize') {
      if (typeof args.jobId !== 'string' || !args.jobId.trim()) throw new Error('参数无效：缺少 jobId');
      return mesh.computeQueue.setPriority(args.jobId.trim(), args.priority || 'urgent');
    }

    if (name === 'hpc_history') {
      if (typeof mesh.querySugon !== 'function') throw new Error('当前服务端版本不支持实时查询超算历史');
      return await mesh.querySugon('history', {
        profile: typeof args.profile === 'string' ? args.profile.trim() : '',
        days: Math.min(180, Math.max(1, Number(args.days) || 30)),
        limit: Math.min(100, Math.max(1, Number(args.limit) || 20)),
      });
    }

    if (name === 'hpc_logs') {
      if (args.jobId) {
        const q = mesh.computeQueue.list({});
        const job = (q.jobs || []).find((j) => j.id === String(args.jobId).trim());
        if (!job) throw new Error('找不到作业：' + args.jobId);
        return { ok: true, jobId: job.id, status: job.status, exitCode: job.exitCode, reason: job.reason || '', tail: job.tail || '' };
      }
      if (!args.slurmJobId || !/^\d{1,20}$/.test(String(args.slurmJobId).trim())) {
        throw new Error('参数无效：请提供 jobId 或有效的数字 slurmJobId');
      }
      if (typeof mesh.querySugon !== 'function') throw new Error('当前服务端版本不支持实时读取超算日志');
      return await mesh.querySugon('logs', {
        profile: typeof args.profile === 'string' ? args.profile.trim() : '',
        slurmJobId: String(args.slurmJobId).trim(),
        workDir: typeof args.workDir === 'string' ? args.workDir.trim() : '',
        lines: Math.min(300, Math.max(10, Number(args.lines) || 80)),
      });
    }

    throw new Error('不支持的工具：' + name);
  }

  return { tools: TOOLS, call };
}

module.exports = { TOOLS, INSTRUCTIONS, createHpcTools };
