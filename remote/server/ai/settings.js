// Which model -- and how hard it thinks (reasoning effort) -- each AI job uses: the daily report, long conversations'
// summaries, the weekly report, 问一问, the mail triage, mail drafts. One setting for all of them, each job may differ.
//   <dataDir>/ai-settings.json   { default: { model, effort }, tasks: { <job>: { model, effort } } }   ('' = as above)
// The models offered are the ones Codex lists for the account (~/.codex/models_cache.json, refreshed by Codex itself),
// each with the efforts it supports; an effort a model does not have falls back to that model's own default.
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
];
const SLUG = /^[\w.:-]{1,60}$/, EFFORT = /^[a-z]{2,10}$/;

// codexHome: Codex's own folder (~/.codex); fallbackModel: what config.json's summary.model says (gpt-6-luna)
function createAiSettings({ dataDir, codexHome = path.join(os.homedir(), '.codex'), fallbackModel = 'gpt-6-luna' }) {
  const file = path.join(dataDir, 'ai-settings.json');
  let st = { default: { model: '', effort: '' }, tasks: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };

  // [{ slug, name, note, efforts: [], defaultEffort }] -- what the account can use
  function models() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8'));
      const list = (j.models || []).filter((m) => m && m.slug && m.visibility !== 'hide').map((m) => ({ slug: m.slug, name: m.display_name || m.slug,
        note: String(m.description || '').slice(0, 80), efforts: (m.supported_reasoning_levels || []).map((e) => e.effort || e).filter((e) => EFFORT.test(e)),
        defaultEffort: m.default_reasoning_level || '' }));
      if (list.length) return list;
    } catch {}
    return [{ slug: fallbackModel, name: fallbackModel, note: '', efforts: ['low', 'medium', 'high'], defaultEffort: '' }];
  }

  // what a job runs with: { model, effort ('' = the model's default) }
  function pick(task) {
    const t = st.tasks[task] || {}, d = st.default || {};
    const model = t.model || d.model || fallbackModel;
    let effort = t.effort || d.effort || '';
    const m = models().find((x) => x.slug === model);
    if (effort && m && m.efforts.length && !m.efforts.includes(effort)) effort = '';      // (not one this model has)
    return { model, effort };
  }

  // { default?: { model, effort }, tasks?: { <job>: { model, effort } } } -- '' clears one
  function set(d) {
    const clean = (x) => ({ model: SLUG.test(x && x.model) ? x.model : '', effort: EFFORT.test(x && x.effort) ? x.effort : '' });
    if (d.default) st.default = clean(d.default);
    if (d.tasks) for (const t of TASKS) if (d.tasks[t.id]) {
      const c = clean(d.tasks[t.id]);
      if (c.model || c.effort) st.tasks[t.id] = c; else delete st.tasks[t.id];
    }
    save();
    return { ok: true };
  }

  const view = () => ({ tasks: TASKS.map((t) => ({ ...t, set: st.tasks[t.id] || { model: '', effort: '' }, uses: pick(t.id) })),
    default: st.default, fallbackModel, models: models() });
  return { pick, set, view, TASKS };
}

module.exports = { createAiSettings, TASKS };
