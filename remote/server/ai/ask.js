// The one way every AI job asks a model (日报、周报、问一问、邮件、文献): the job's model (settings.js pick) decides
// who runs it -- Codex for OpenAI's models, Claude Code for Claude's -- each through whichever proxy reaches its own
// host. When it fails (out of usage, an error, no proxy gets through, a timeout) the backup model (后备模型) does the
// job instead, and the one that failed rests for 15 minutes: the next calls in that time go to the other first (a day
// report asks several times; each would otherwise wait for the same failure). Both failing: the job fails.
'use strict';
const path = require('path');
const { runCodex } = require('../summary/codex');
const { runClaude } = require('../summary/claude');

const REST_MS = 15 * 60e3;
const HOST = { codex: 'chatgpt.com', claude: 'api.anthropic.com' };
const WHO = { codex: 'OpenAI', claude: 'Anthropic' };

// codex / claude: { bin, pathPrefix, timeoutMs }; pick(task) -> { model, effort, provider, backup: { ... } | null }
function createAsk({ codex, claude, egress = null, pick, log = () => {}, now = Date.now }) {
  const down = new Map();                     // model -> { at, error, task }

  async function once(use, prompt, schema, images) {
    const cli = use.provider === 'claude' ? claude : codex;
    let env = { ...process.env };
    if (egress) {
      const proxy = await egress.pick(HOST[use.provider]);
      if (!proxy) throw new Error(`连不上 ${WHO[use.provider]}：电脑上的代理和 AWS 备用线路都不通`);
      env = egress.env(proxy);
    }
    if (cli.pathPrefix) env.PATH = cli.pathPrefix + path.delimiter + (env.PATH || '');
    const run = use.provider === 'claude' ? runClaude : runCodex;
    try { return await run({ bin: cli.bin, model: use.model, effort: use.effort, prompt, schema, env, timeoutMs: cli.timeoutMs, images }); }
    catch (e) { if (egress) egress.forget(HOST[use.provider]); throw e; }
  }

  const resting = (u) => { const d = down.get(u.model); return !!d && now() - d.at < REST_MS; };

  // task: which job asks (daily, session, weekly, ask, mailTriage, mailDraft, litFeed, litRead, litVision);
  // images: files the model looks at too (文献's page images)
  async function ask(prompt, schema, task = 'daily', { images = [] } = {}) {
    const use = pick(task);
    const list = [use, use.backup].filter((u, i) => u && u.model && (i === 0 || u.model !== use.model));
    // the one that failed lately last (still tried when the other fails too)
    const order = [...list.filter((u) => !resting(u)), ...list.filter(resting)];
    if (order[0] !== use) log(`AI：${task} 先用后备模型 ${order[0].model}（${use.model} ${Math.round((now() - down.get(use.model).at) / 60e3)} 分钟前出错）`);
    const errs = [];
    for (let i = 0; i < order.length; i++) {
      const u = order[i];
      try {
        const v = await once(u, prompt, schema, images);
        down.delete(u.model);
        return v;
      } catch (e) {
        down.set(u.model, { at: now(), error: String(e.message).slice(0, 300), task });
        errs.push(e);
        if (order[i + 1]) log(`AI：${task} 用 ${u.model} 出错（${String(e.message).slice(0, 200)}），改用 ${order[i + 1].model}`);
      }
    }
    if (errs.length === 1) throw errs[0];
    throw new Error(order.map((u, i) => `${u.model}：${errs[i].message}`).join('；'));
  }

  // the models that failed within the last 15 minutes (控制面板 → AI 模型 shows them)
  const state = () => [...down].filter(([, d]) => now() - d.at < REST_MS).map(([model, d]) => ({ model, ...d, until: d.at + REST_MS }));

  return { ask, state };
}

module.exports = { createAsk, REST_MS };
