// The one way every AI job asks a model (日报、周报、问一问、邮件、文献): the job's model (settings.js pick) decides
// who runs it -- Codex for OpenAI's models, Claude Code for Claude's -- each through whichever proxy reaches its own
// host. A Claude model is asked over the Claude API first when there is a key for it (anthropic-api.js: paid from the
// Console organization's monthly credit), and through Claude Code -- the subscription's usage -- when the API fails or
// the credit is used up; the API then rests 15 minutes too. When it fails (out of usage, an error, no proxy gets through, a timeout) the backup model (后备模型) does the
// job instead, and the one that failed rests for 15 minutes: the next calls in that time go to the other first (a day
// report asks several times; each would otherwise wait for the same failure). Both failing: the job fails.
'use strict';
const path = require('path');
const { runCodex } = require('../summary/codex');
const { runClaude } = require('../summary/claude');
const { runApi, plain } = require('./anthropic-api');

const REST_MS = 15 * 60e3;
const HOST = { codex: 'chatgpt.com', claude: 'api.anthropic.com' };
const WHO = { codex: 'OpenAI', claude: 'Anthropic' };

// codex / claude: { bin, pathPrefix, timeoutMs }; api: { key(), base, timeoutMs };
// pick(task) -> { model, effort, provider, api?, backup: { ... } | null }
// claudeApis: the Claude Code API aliases; an alias model runs through that API (base URL / key / proxy mode)
function createAsk({ codex, claude, api = null, egress = null, pick, claudeApis = null, machine = 'nas', log = () => {}, now = Date.now }) {
  const down = new Map();                     // model -> { at, error, task }
  let apiDown = null;                         // the Claude API as last failed: { at, error, task }

  const PROXY_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
  const CONFIG_DIR = /^CLAUDE_CONFIG_DIR$/i;
  const keyOf = (u) => (u.api ? u.api + '|' : '') + u.model;

  async function once(use, prompt, schema, images, task) {
    // an alias model is always Claude Code through that API -- the Anthropic API key path does not apply
    if (use.provider === 'claude' && !use.api && api && api.key() && !(apiDown && now() - apiDown.at < REST_MS)) {
      try {
        // (a prompt marked for the cache: what it took, so that the log shows the cache at work)
        const onUsage = prompt.includes('\u0000') ? (u) => log(`AI：${task} 输入 ${u.input + u.cacheRead + u.cacheWrite} token（缓存读 ${u.cacheRead}、写 ${u.cacheWrite}），输出 ${u.output}`) : null;
        const v = await runApi({ key: api.key(), model: use.model, effort: use.effort, prompt, schema, images, egress, base: api.base, timeoutMs: api.timeoutMs || codex.timeoutMs, onUsage });
        apiDown = null;
        return v;
      } catch (e) {
        apiDown = { at: now(), error: String(e.message).slice(0, 300), task };
        if (egress) egress.forget(HOST.claude);
        log(`AI：${task} 走 Claude API 出错（${String(e.message).slice(0, 200)}），改用 Claude Code（订阅用量）`);
      }
    }
    const cli = use.provider === 'claude' ? claude : codex;
    let env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;                        // the NAS jobs always use the default memory directory
    let host = HOST[use.provider];
    let alias = null;
    if (use.api) {
      alias = claudeApis && typeof claudeApis.resolve === 'function' ? claudeApis.resolve(use.api, machine) : null;
      if (!alias) throw new Error(`API 别名 ${use.api} 没有配置`);
      const extra = alias.settings && alias.settings.env && typeof alias.settings.env === 'object' ? { ...alias.settings.env } : {};
      const base = String(extra.ANTHROPIC_BASE_URL || '');
      if (!base) throw new Error(`API 别名 ${use.api} 没有 base URL`);
      try { host = new URL(base).hostname; } catch {}
      for (const k of [...PROXY_KEYS, 'NO_PROXY', 'no_proxy']) delete extra[k];
      for (const k of Object.keys(extra)) if (CONFIG_DIR.test(k)) delete extra[k];
      // inherit: keep the process's proxy when there is no egress; direct clears it; an explicit URL replaces it
      const proxy = alias.proxy === 'direct' || /^https?:\/\//.test(alias.proxy || '') ? null : (egress ? await egress.pick(host) : null);
      if (alias.proxy === 'direct') { env.NO_PROXY = '*'; env.no_proxy = '*'; }
      else if (/^https?:\/\//.test(alias.proxy || '')) {
        for (const k of PROXY_KEYS) env[k] = alias.proxy;
        env.NO_PROXY = 'localhost,127.0.0.1'; env.no_proxy = 'localhost,127.0.0.1';
      } else if (egress) {
        if (!proxy) throw new Error(`连不上 ${host}：电脑上的代理和 AWS 备用线路都不通`);
        env = egress.env(proxy, env);
      }
      Object.assign(env, extra);                                // base URL, key, model settings: the alias's own
      delete env.CLAUDE_CONFIG_DIR;
      if (alias.proxy === 'direct') { for (const k of PROXY_KEYS) delete env[k]; env.NO_PROXY = '*'; env.no_proxy = '*'; }
    } else if (egress) {
      const proxy = await egress.pick(host);
      if (!proxy) throw new Error(`连不上 ${WHO[use.provider]}：电脑上的代理和 AWS 备用线路都不通`);
      env = egress.env(proxy, env);
    }
    if (cli.pathPrefix) env.PATH = cli.pathPrefix + path.delimiter + (env.PATH || '');
    const run = use.provider === 'claude' ? runClaude : runCodex;
    try { return await run({ bin: cli.bin, model: use.model, effort: use.effort, prompt: plain(prompt), schema, env, timeoutMs: cli.timeoutMs, images }); }
    catch (e) { if (egress) egress.forget(host); throw e; }
  }

  const resting = (u) => { const d = down.get(keyOf(u)); return !!d && now() - d.at < REST_MS; };

  // task: which job asks (daily, session, weekly, ask, mailTriage, mailDraft, litFeed, litRead, litReview, litVision, board, boardDesign);
  // images: files the model looks at too (文献's page images)
  async function ask(prompt, schema, task = 'daily', { images = [] } = {}) {
    const use = pick(task);
    const list = [use, use.backup].filter((u, i) => u && u.model && (i === 0 || keyOf(u) !== keyOf(use)));
    // the one that failed lately last (still tried when the other fails too)
    const order = [...list.filter((u) => !resting(u)), ...list.filter(resting)];
    if (order[0] !== use) log(`AI：${task} 先用后备模型 ${order[0].model}（${use.model} ${Math.round((now() - down.get(keyOf(use)).at) / 60e3)} 分钟前出错）`);
    const errs = [];
    for (let i = 0; i < order.length; i++) {
      const u = order[i];
      try {
        const v = await once(u, prompt, schema, images, task);
        down.delete(keyOf(u));
        return v;
      } catch (e) {
        down.set(keyOf(u), { at: now(), error: String(e.message).slice(0, 300), task });
        errs.push(e);
        if (order[i + 1]) log(`AI：${task} 用 ${u.model} 出错（${String(e.message).slice(0, 200)}），改用 ${order[i + 1].model}`);
      }
    }
    if (errs.length === 1) throw errs[0];
    throw new Error(order.map((u, i) => `${u.model}：${errs[i].message}`).join('；'));
  }

  // the models that failed within the last 15 minutes (控制面板 → AI 模型 shows them)
  const state = () => [...down].filter(([, d]) => now() - d.at < REST_MS).map(([key, d]) => {
    const i = key.indexOf('|');
    return { model: i >= 0 ? key.slice(i + 1) : key, api: i >= 0 ? key.slice(0, i) : undefined, ...d, until: d.at + REST_MS };
  });

  // the Claude API when it failed within the last 15 minutes (Claude's models go through Claude Code meanwhile)
  const apiState = () => (apiDown && now() - apiDown.at < REST_MS ? { ...apiDown, until: apiDown.at + REST_MS } : null);

  return { ask, state, apiState };
}

module.exports = { createAsk, REST_MS };
