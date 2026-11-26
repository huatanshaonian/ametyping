// Keyless, Zero-Harness Pure-API HPC Failure Advisor for Sugon / SCNet Slurm jobs.
// Priority:
//   1. Google AI Studio API (configured in Win98 <dataDir>/google-ai-api.json, zero Magpie quota cost)
//   2. Magpie LLM API fallback (if Google AI Studio is unset or fails)
//   3. Deterministic rule-based diagnosis fallback
// Never uses a CLI harness, never modifies research code, and never auto-resubmits jobs.
'use strict';
const { createGoogleAiKey, runGoogleAi } = require('./ai/google-ai-api');

const DIAG_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', description: '故障分类，如 OOM / Walltime超时 / 节点故障 / 数值发散 / 网格或输入错误 / 环境模块缺失 / 许可证错误 / 代码异常' },
    rootCause: { type: 'string', description: '1-2句直击根因的技术判断，引用日志中的关键报错行或峰值内存/退出码' },
    suggestion: { type: 'string', description: '1-2句给用户或Master的具体排查/调整建议，不自动改代码' },
  },
  required: ['category', 'rootCause', 'suggestion'],
};

function ruleBasedDiagnose(alert = {}) {
  const state = String(alert.state || '').toUpperCase();
  const tail = String(alert.logTail || alert.tail || '');
  const exitCode = String(alert.exitCode || '');
  const rss = String(alert.maxRss || '');

  if (/OUT_OF_MEMORY|OOM/i.test(state) || /oom-kill|out of memory|Cannot allocate memory|std::bad_alloc|MemoryError|CUDA out of memory/i.test(tail)) {
    return {
      category: '内存溢出 (OOM)',
      rootCause: `作业因内存不足被强杀（状态 ${state || 'FAILED'}${rss ? `，峰值内存 ${rss}` : ''}）。`,
      suggestion: '建议改投大内存分区（如合肥 hfacnormal04 512G、哈尔滨 hebhcnormal03 1TB 或星河 xhhcnormal01 2TB），或降低单节点进程数。',
    };
  }
  if (/TIMEOUT/i.test(state) || /DUE TO TIME LIMIT/i.test(tail)) {
    return {
      category: '墙钟超时 (TIMEOUT)',
      rootCause: `作业运行至 ${alert.elapsed || '上限'} 触发 Slurm Walltime 限制被中止。`,
      suggestion: '请检查收敛进度或中间 checkpoint，适当增大 -t walltime 或从断点续算。',
    };
  }
  if (/NODE_FAIL/i.test(state) || /NODE_FAIL/i.test(tail)) {
    return {
      category: '计算节点硬件/通信故障 (NODE_FAIL)',
      rootCause: '超算底层计算节点异常掉线，非算例本身错误。',
      suggestion: '建议确认原目录无损坏输出后重新提交。',
    };
  }
  if (/Segmentation fault|SIGSEGV|core dumped|forrtl:\s*severe/i.test(tail)) {
    return {
      category: '段错误 / 运行时崩溃 (SIGSEGV)',
      rootCause: '求解器或底层库触发内存越界/段错误，需核对网格、边界或 MPI 内存配置。',
      suggestion: '建议先在单节点小算例复现，检查输入文件、数组越界或 ulimit -s 栈大小设置。',
    };
  }
  if (/NaN|Inf\b|diverg|not converge|singular matrix|奇异/i.test(tail)) {
    return {
      category: '数值发散 / 矩阵奇异',
      rootCause: '日志出现 NaN/Inf 或求解未收敛/矩阵奇异特征。',
      suggestion: '请核对网格质量、时间步长/松弛因子或边界条件设置，不要盲目重投。',
    };
  }
  if (/command not found|ModuleNotFoundError|No module named|cannot open shared object|license/i.test(tail)) {
    return {
      category: '环境依赖 / 模块或 License 缺失',
      rootCause: '计算节点缺少对应可执行程序、Python 依赖、动态库或商业软件 License。',
      suggestion: '请在 sbatch 脚本中补充正确的 module load / conda activate 或检查 License 服务器连通性。',
    };
  }
  return {
    category: state || 'Slurm 作业异常结束',
    rootCause: `作业非零退出（状态 ${state || 'FAILED'}，exit=${exitCode || '?'}）。`,
    suggestion: '请查看附带日志尾部定位具体报错行后再决定修复方案。',
  };
}

function pickFastGoogleModel(models = []) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return 'gemini-2.5-flash';
  const preferred = [
    /^gemini-2\.5-flash$/i,
    /flash/i,
    /gemini-2\.5-pro/i,
    /^gemini-/i,
  ];
  for (const re of preferred) {
    const m = list.find((x) => x && (x.model || x.id) && re.test(x.model || x.id));
    if (m) return m.model || m.id;
  }
  return (list[0] && (list[0].model || list[0].id)) || 'gemini-2.5-flash';
}

function pickFastMagpieModel(magpieStatus) {
  const models = Array.isArray(magpieStatus && magpieStatus.models) ? magpieStatus.models : [];
  if (!models.length) return '';
  const preferred = [
    /flash/i,
    /mini/i,
    /haiku/i,
    /sonnet/i,
    /deepseek/i,
    /gpt-5/i,
  ];
  for (const re of preferred) {
    const m = models.find((x) => x && x.id && re.test(x.id));
    if (m) return m.id;
  }
  return (models[0] && models[0].id) || '';
}

function buildDiagnosisPrompt(alert = {}) {
  return [
    '你是资深 HPC / 计算电磁与力学超算运维诊断专家。请根据以下曙光/SCNet Slurm 作业报错现场，给出精炼、准确的中文 JSON 诊断（严禁编造日志里没有的信息）：',
    `- 集群/账号：${alert.profileLabel || alert.profileId || alert.sshHost || '未知'}`,
    `- 作业：ID=${alert.slurmJobId || alert.jobId || '未知'}，名称=${alert.jobName || alert.label || '未知'}，分区=${alert.partition || '未知'}`,
    `- 终态：${alert.state || 'FAILED'}，ExitCode=${alert.exitCode || '未知'}，耗时=${alert.elapsed || '未知'}，峰值内存MaxRSS=${alert.maxRss || '未知'}`,
    alert.workDir ? `- 工作目录：${alert.workDir}` : null,
    alert.command ? `- 提交命令：${String(alert.command).slice(0, 300)}` : null,
    `- 日志尾部（stderr/stdout）：\n${String(alert.logTail || alert.tail || '(无日志输出)').slice(-3000)}`,
  ].filter(Boolean).join('\n');
}

async function diagnoseSugonFailure({
  alert = {},
  dataDir = '',
  egress = null,
  googleAiKey = null,
  runGoogleAiFn = runGoogleAi,
  magpie = null,
  timeoutMs = 25000,
} = {}) {
  const fallback = ruleBasedDiagnose(alert);
  let result = fallback;
  let viaLlm = false;
  let provider = '';
  let model = '';

  // 1. Prefer Google AI Studio API configured in Win98 (zero Magpie quota cost)
  let gKey = '';
  let gModels = [];
  if (googleAiKey && typeof googleAiKey.get === 'function') {
    gKey = googleAiKey.get() || '';
    gModels = typeof googleAiKey.models === 'function' ? googleAiKey.models() : [];
  } else if (dataDir) {
    try {
      const store = createGoogleAiKey({ dataDir });
      gKey = store.get() || '';
      gModels = store.models();
    } catch {}
  }

  if (gKey && typeof runGoogleAiFn === 'function') {
    try {
      model = pickFastGoogleModel(gModels);
      const llmRes = await runGoogleAiFn({
        key: gKey,
        model,
        effort: /gemini-2\.5/i.test(model) ? 'low' : '',
        prompt: buildDiagnosisPrompt(alert),
        schema: DIAG_SCHEMA,
        egress,
        timeoutMs,
      });
      if (llmRes && typeof llmRes.category === 'string' && typeof llmRes.rootCause === 'string') {
        result = {
          category: llmRes.category.trim().slice(0, 80) || fallback.category,
          rootCause: llmRes.rootCause.trim().slice(0, 400) || fallback.rootCause,
          suggestion: String(llmRes.suggestion || fallback.suggestion).trim().slice(0, 400),
        };
        viaLlm = true;
        provider = 'Google AI Studio';
      }
    } catch {
      model = '';
    }
  }

  // 2. Fallback to Magpie API if Google AI Studio is unset or unavailable
  if (!viaLlm && magpie && typeof magpie.run === 'function' && typeof magpie.status === 'function') {
    try {
      const st = magpie.status();
      if (st && st.enabled) {
        model = pickFastMagpieModel(st);
        if (model) {
          const llmRes = await magpie.run({
            model,
            prompt: buildDiagnosisPrompt(alert),
            schema: DIAG_SCHEMA,
            timeoutMs,
          });
          if (llmRes && typeof llmRes.category === 'string' && typeof llmRes.rootCause === 'string') {
            result = {
              category: llmRes.category.trim().slice(0, 80) || fallback.category,
              rootCause: llmRes.rootCause.trim().slice(0, 400) || fallback.rootCause,
              suggestion: String(llmRes.suggestion || fallback.suggestion).trim().slice(0, 400),
            };
            viaLlm = true;
            provider = 'Magpie API';
          }
        }
      }
    } catch {
      // Gracefully fall back to deterministic rules
    }
  }

  const header = `[超算报错诊断] ${alert.profileLabel || alert.profileId || '曙光超算'} · 作业 ${alert.slurmJobId || alert.jobId || ''} (${alert.jobName || alert.label || '未命名'})`;
  const summaryText = [
    header,
    `- 分类：${result.category}${viaLlm ? `（${provider} · ${model}）` : '（规则诊断）'}`,
    `- 状态：${alert.state || 'FAILED'} | Exit=${alert.exitCode || '?'} | 峰值内存=${alert.maxRss || '—'} | 耗时=${alert.elapsed || '—'}`,
    `- 根因：${result.rootCause}`,
    `- 建议：${result.suggestion}`,
  ].join('\n');

  return {
    ...result,
    viaLlm,
    provider,
    model,
    header,
    summaryText,
  };
}

module.exports = {
  ruleBasedDiagnose,
  pickFastGoogleModel,
  pickFastMagpieModel,
  buildDiagnosisPrompt,
  diagnoseSugonFailure,
};
