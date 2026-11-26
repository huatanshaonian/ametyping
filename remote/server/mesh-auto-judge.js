// L3 Auto-Mode Independent Judge (zero-Harness, pure-API).
// When an L3 project's Master + all Workers become idle, sends the plan/tasks + Master's final output
// + recent board context to a lightweight LLM API (1st Google AI Studio, 2nd Magpie, 3rd rule fallback)
// to decide strictly among: CONTINUE | DONE | ESCALATE.
// Built-in anti-loop hard caps: maxAutoJudge (default 5) + blocked/stagnation detection.
'use strict';
const { createGoogleAiKey, runGoogleAi } = require('./ai/google-ai-api');
const { pickFastGoogleModel, pickFastMagpieModel } = require('./mesh-sugon-advisor');

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['CONTINUE', 'DONE', 'ESCALATE'],
      description: 'CONTINUE=还有明确计划步骤且无阻塞/无主观分叉需自动续推；DONE=计划目标均已验证完成可收官；ESCALATE=遇到反复失败/原地打转/需人类拍板或缺失外部信息',
    },
    reason: { type: 'string', description: '1-2句精炼中文裁决依据' },
    followupPrompt: { type: 'string', description: '仅当 verdict=CONTINUE 时给出直接发给 Master 的精准推进/追问指令；否则留空字符串' },
  },
  required: ['verdict', 'reason', 'followupPrompt'],
};

function ruleBasedJudge({ project = {}, autoJudgeCount = 0, maxAutoJudge = 5 } = {}) {
  const tasks = Array.isArray(project.tasks) ? project.tasks : [];
  const blocked = tasks.filter((t) => t && t.status === 'blocked');
  const open = tasks.filter((t) => t && t.status !== 'done' && t.status !== 'blocked');
  const done = tasks.filter((t) => t && t.status === 'done');

  if (autoJudgeCount >= maxAutoJudge) {
    return {
      verdict: 'ESCALATE',
      reason: `已达到 L3 自动续推上限（${maxAutoJudge} 轮），为防止死循环强制交由用户复盘。`,
      followupPrompt: '',
    };
  }
  if (blocked.length > 0) {
    return {
      verdict: 'ESCALATE',
      reason: `存在 ${blocked.length} 个阻塞任务（${blocked.map((t) => t.title).slice(0, 2).join('、')}），需人工介入。`,
      followupPrompt: '',
    };
  }
  if (tasks.length > 0 && open.length === 0 && done.length === tasks.length) {
    return {
      verdict: 'DONE',
      reason: `全部 ${done.length} 项计划任务均已标记完成。`,
      followupPrompt: '',
    };
  }
  if (open.length > 0) {
    const nextTitles = open.slice(0, 3).map((t) => `${t.id}:${t.title}`).join('；');
    return {
      verdict: 'CONTINUE',
      reason: `仍有 ${open.length} 项未完成任务且无阻塞项，可继续推进。`,
      followupPrompt: `[L3 自动裁判续推 ${autoJudgeCount + 1}/${maxAutoJudge}] 当前仍有未完成计划任务（${nextTitles}），且无阻塞项。请核对最新进度并继续推进下一步，若确实遇到需要用户拍板的分叉请明确标为 blocked 并说明原因。`,
    };
  }
  return {
    verdict: 'ESCALATE',
    reason: '任务表为空且无法从规则判断是否完成，转交用户确认。',
    followupPrompt: '',
  };
}

function buildJudgePrompt({ project = {}, masterLastOutput = '', boardEntries = [], autoJudgeCount = 0, maxAutoJudge = 5 } = {}) {
  const tasks = Array.isArray(project.tasks) ? project.tasks : [];
  const taskLines = tasks.length
    ? tasks.slice(0, 30).map((t) => `- [${t.status}] ${t.id} ${t.title}${t.desc ? ` — ${String(t.desc).slice(0, 120)}` : ''}`).join('\n')
    : '(无结构化任务表)';
  const boardLines = (Array.isArray(boardEntries) ? boardEntries : [])
    .slice(-15)
    .map((e) => `#${e.seq} [${e.kind || 'post'}] ${e.agent || '成员'}: ${String(e.text || '').replace(/\s+/g, ' ').slice(0, 240)}`)
    .join('\n') || '(无黑板记录)';

  return [
    '你是多 Agent 协作系统的 L3 Auto-Mode 独立裁判。当前项目的 Master 与全部 Worker 均已停下（idle/done）。',
    '请严格阅读【项目计划与任务表】、【黑板近期进展】和【Master 最后一轮输出】，输出 JSON 裁决（CONTINUE / DONE / ESCALATE）：',
    '判据：',
    '1. 选 CONTINUE：Master 只是完成一个子步骤后习惯性停下询问"要不要继续"，而计划中还有明确下一步、前置验收已通过、且无冲突/无主观分叉/无反复报错；此时在 followupPrompt 中写一句精炼直接的推进指令发给 Master。',
    '2. 选 DONE：计划中的全部核心目标和验证均已完成并给出证据，可以收官汇报用户。',
    '3. 选 ESCALATE：发现 Master 在原地打转/重复同类报错、测试未通过、存在阻塞项、缺少外部信息/凭据/权限、或面临需要人类拍板的主观技术分叉。宁可谨慎 ESCALATE，绝不盲目放任死循环。',
    '',
    `【项目名称】${project.name || project.id || '未命名项目'}`,
    project.goal ? `【项目总目标】${String(project.goal).slice(0, 600)}` : null,
    `【自动续推轮次】已完成 ${autoJudgeCount} 轮 / 上限 ${maxAutoJudge} 轮`,
    `【任务表 (${tasks.length} 项)】\n${taskLines}`,
    `【黑板近期进展】\n${boardLines}`,
    `【Master 最后输出】\n${String(masterLastOutput || '(无输出)').slice(-3000)}`,
  ].filter(Boolean).join('\n');
}

async function judgeL3Stall({
  project = {},
  masterLastOutput = '',
  boardEntries = [],
  autoJudgeCount = 0,
  maxAutoJudge = 5,
  dataDir = '',
  egress = null,
  googleAiKey = null,
  runGoogleAiFn = runGoogleAi,
  magpie = null,
  timeoutMs = 25000,
} = {}) {
  const cap = Math.max(1, Math.min(20, Math.trunc(Number(maxAutoJudge) || 5)));
  const count = Math.max(0, Math.trunc(Number(autoJudgeCount) || 0));

  // Hard anti-loop cap BEFORE calling any LLM
  if (count >= cap) {
    return {
      verdict: 'ESCALATE',
      reason: `已达到 L3 自动续推硬上限（${cap}/${cap} 轮），自动停机交由用户复盘。`,
      followupPrompt: '',
      viaLlm: false,
      provider: 'hard-cap',
      model: '',
    };
  }

  const fallback = ruleBasedJudge({ project, autoJudgeCount: count, maxAutoJudge: cap });
  let result = fallback;
  let viaLlm = false;
  let provider = '';
  let model = '';

  const normalizeVerdict = (raw) => {
    const v = String(raw && raw.verdict || '').trim().toUpperCase();
    if (!['CONTINUE', 'DONE', 'ESCALATE'].includes(v)) return null;
    const reason = String(raw.reason || '').trim().slice(0, 300) || fallback.reason;
    const followupPrompt = v === 'CONTINUE'
      ? (String(raw.followupPrompt || '').trim().slice(0, 600) || fallback.followupPrompt || '请继续按计划推进下一阶段。')
      : '';
    return { verdict: v, reason, followupPrompt };
  };

  // 1. Prefer Google AI Studio (zero Magpie quota cost)
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

  const prompt = buildJudgePrompt({ project, masterLastOutput, boardEntries, autoJudgeCount: count, maxAutoJudge: cap });

  if (gKey && typeof runGoogleAiFn === 'function') {
    try {
      model = pickFastGoogleModel(gModels);
      const llmRes = await runGoogleAiFn({
        key: gKey,
        model,
        effort: /gemini-2\.5/i.test(model) ? 'low' : '',
        prompt,
        schema: JUDGE_SCHEMA,
        egress,
        timeoutMs,
      });
      const norm = normalizeVerdict(llmRes);
      if (norm) {
        result = norm;
        viaLlm = true;
        provider = 'Google AI Studio';
      }
    } catch {
      model = '';
    }
  }

  // 2. Fallback to Magpie API
  if (!viaLlm && magpie && typeof magpie.run === 'function' && typeof magpie.status === 'function') {
    try {
      const st = magpie.status();
      if (st && st.enabled) {
        model = pickFastMagpieModel(st);
        if (model) {
          const llmRes = await magpie.run({
            model,
            prompt,
            schema: JUDGE_SCHEMA,
            timeoutMs,
          });
          const norm = normalizeVerdict(llmRes);
          if (norm) {
            result = norm;
            viaLlm = true;
            provider = 'Magpie API';
          }
        }
      }
    } catch {}
  }

  return {
    ...result,
    viaLlm,
    provider: viaLlm ? provider : 'rule',
    model,
  };
}

module.exports = {
  JUDGE_SCHEMA,
  ruleBasedJudge,
  buildJudgePrompt,
  judgeL3Stall,
};
