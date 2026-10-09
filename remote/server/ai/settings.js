// Which model -- and how hard it thinks (reasoning effort) -- each AI job uses: the daily report, long conversations'
// summaries, the weekly report, 问一问, the mail triage, mail drafts, the literature. One setting for all of them, each
// job may differ; and a backup model (后备模型) for when the chosen one fails or is out of usage (ask.js).
//   <dataDir>/ai-settings.json   { default: { model, effort }, backup: { model, effort }, tasks: { <job>: { model, effort } } }
//                                ('' = as above; backup '' = none)
// The models offered are the ones Codex lists for the account (~/.codex/models_cache.json) and the ones Claude Code
// lists (~/.claude/cache/model-catalog/*.json), both refreshed by the tools themselves, each with the efforts it
// supports; an effort a model does not have falls back to that model's own default. A model's provider says which
// tool runs it. (Claude's models are asked over the Claude API first when there is a key for it, Claude Code after
// that: ask.js decides, the list is the same.)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TASKS = [
  { id: 'daily', name: '工作日报', note: '每天早上读前一天的全部对话写日报，也核对重要计划' },
  { id: 'session', name: '长对话摘要', note: '写日报前，先把特别长的对话单独总结一遍' },
  { id: 'weekly', name: '周报', note: '周日根据七天的日报写周报' },
  { id: 'ask', name: '问一问', note: '找资料、回答你在日报窗口里问的问题' },
  { id: 'mailTriage', name: '邮件把关', note: '每封新邮件：要不要提醒你、有没有值得看的文献' },
  { id: 'mailDraft', name: '邮件起草', note: '写信时「让 GPT 起草」' },
  { id: 'litFeed', name: '文献推送', note: '起草画像、每天挑文献并写推荐理由、复习题、速读卡' },
  { id: 'litRead', name: '文献深读', note: '深读卡、读前理解的对照、深读对话、沉淀、专题和相关工作段落' },
  { id: 'litReview', name: '研究回顾', note: '月度 / 季度回顾：各问题的进展、问题和主线该怎么调整的建议（都要你审批）' },
  { id: 'litVision', name: '文献读图', note: '把论文页面看成图片逐页转写（公式、表格），深读前自动做；超过页数上限的要你批准' },
];
const SLUG = /^[\w.:-]{1,60}$/, EFFORT = /^[a-z]{2,10}$/;
// Claude Code's catalog missing (not run yet on this machine): its current main models
const CLAUDE_KNOWN = [
  { slug: 'claude-opus-5-5', name: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { slug: 'claude-fable-5-1', name: 'Fable 5.1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { slug: 'claude-sonnet-5-5', name: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { slug: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [], defaultEffort: '' },
];
const isClaude = (slug) => /^(claude-|opus$|sonnet$|haiku$|fable$)/.test(slug);

// codexHome / claudeHome: the tools' own folders (~/.codex, ~/.claude); fallbackModel: config.json's summary.model
function createAiSettings({ dataDir, codexHome = path.join(os.homedir(), '.codex'), claudeHome = path.join(os.homedir(), '.claude'), fallbackModel = 'gpt-6-luna' }) {
  const file = path.join(dataDir, 'ai-settings.json');
  let st = { default: { model: '', effort: '' }, backup: { model: '', effort: '' }, tasks: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };

  function codexModels() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8'));
      const list = (j.models || []).filter((m) => m && m.slug && m.visibility !== 'hide').map((m) => ({ slug: m.slug, name: m.display_name || m.slug,
        note: String(m.description || '').slice(0, 80), efforts: (m.supported_reasoning_levels || []).map((e) => e.effort || e).filter((e) => EFFORT.test(e)),
        defaultEffort: m.default_reasoning_level || '', provider: 'codex' }));
      if (list.length) return list;
    } catch {}
    return isClaude(fallbackModel) ? [] : [{ slug: fallbackModel, name: fallbackModel, note: '', efforts: ['low', 'medium', 'high'], defaultEffort: '', provider: 'codex' }];
  }
  // the newest of Claude Code's catalog files: the main models first, then the older ones it still offers
  function claudeModels() {
    try {
      const dir = path.join(claudeHome, 'cache', 'model-catalog');
      let best = null;
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (!best || (j.fetchedAt || 0) > (best.fetchedAt || 0)) best = j; } catch {}
      }
      const ms = (best && best.catalog && best.catalog.config && best.catalog.config.models) || [];
      const list = ms.filter((m) => m && SLUG.test(m.id || '')).map((m) => {
        const opts = (m.thinking && m.thinking.effort_options) || [];
        const rec = opts.find((o) => o.badge);
        return { slug: m.id, name: m.name || m.id, note: String(m.description || (m.section === 'main' ? '' : '旧版')).slice(0, 80), main: m.section === 'main',
          efforts: opts.map((o) => o.id).filter((e) => EFFORT.test(e)), defaultEffort: rec ? rec.id : '', provider: 'claude' };
      }).sort((a, b) => b.main - a.main).map(({ main, ...m }) => m);
      if (list.length) return list;
    } catch {}
    return CLAUDE_KNOWN.map((m) => ({ ...m, note: '', provider: 'claude' }));
  }
  // [{ slug, name, note, efforts: [], defaultEffort, provider: 'codex' | 'claude' }] -- what the accounts can use
  const models = () => [...codexModels(), ...claudeModels()];

  // a model + effort as it will run: the effort only when that model has it; who runs it
  function resolve(model, effort, list = models()) {
    const m = list.find((x) => x.slug === model);
    if (effort && m && m.efforts.length && !m.efforts.includes(effort)) effort = '';      // (not one this model has)
    if (m && !m.efforts.length) effort = '';                                               // (one that does not think)
    return { model, effort, provider: m ? m.provider : isClaude(model) ? 'claude' : 'codex' };
  }
  // what a job runs with: { model, effort ('' = the model's default), provider, backup: { model, effort, provider } | null }
  function pick(task) {
    const list = models();
    const t = st.tasks[task] || {}, d = st.default || {}, b = st.backup || {};
    const use = resolve(t.model || d.model || fallbackModel, t.effort || d.effort || '', list);
    const backup = b.model && b.model !== use.model ? resolve(b.model, b.effort || '', list) : null;
    return { ...use, backup };
  }

  // { default?: { model, effort }, backup?: { model, effort }, tasks?: { <job>: { model, effort } } } -- '' clears one
  function set(d) {
    const clean = (x) => ({ model: SLUG.test(x && x.model) ? x.model : '', effort: EFFORT.test(x && x.effort) ? x.effort : '' });
    if (d.default) st.default = clean(d.default);
    if (d.backup) st.backup = clean(d.backup);
    if (d.tasks) for (const t of TASKS) if (d.tasks[t.id]) {
      const c = clean(d.tasks[t.id]);
      if (c.model || c.effort) st.tasks[t.id] = c; else delete st.tasks[t.id];
    }
    save();
    return { ok: true };
  }

  const view = () => ({ tasks: TASKS.map((t) => ({ ...t, set: st.tasks[t.id] || { model: '', effort: '' }, uses: pick(t.id) })),
    default: st.default, backup: st.backup || { model: '', effort: '' }, fallbackModel, models: models() });
  return { pick, set, view, models, TASKS };
}

module.exports = { createAiSettings, TASKS };
