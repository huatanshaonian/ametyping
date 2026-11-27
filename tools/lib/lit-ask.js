// Shared LLM caller for literature batch scripts (run-cards-batch.js, run-teams-batch.js, run-full-kb-batch.js).
// Supports:
//   --provider google  (Google AI Studio API, e.g. gemini-4-neon)
//   --provider agy     (Antigravity CLI `agy --output-format json --json-schema ...`, local or via --agy-ssh <host>)
//   --provider magpie  (Magpie gateway, e.g. auto/gemini-4-carbon)
//   --provider auto    (tries agy first if available, falls back to google on error)
'use strict';
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function createLitAsker({
  serverDir,
  cfg = {},
  dataDir,
  egress = null,
  provider = 'google',
  model = 'gemini-4-neon',
  effort = 'low',
  agyBin = 'agy',
  agySsh = '',
  log = () => {},
}) {
  const { createGoogleAiKey, runGoogleAi } = require(path.join(serverDir, 'ai', 'google-ai-api'));
  const { createMagpie } = require(path.join(serverDir, 'magpie'));

  const normProv = String(provider || 'google').toLowerCase();
  const gKey = createGoogleAiKey({ dataDir });
  let magpie = null;
  let magpiePolled = false;

  const googleModel = String(model || 'gemini-4-neon').replace(/^(google:|antigravity\/|magpie:)/, '');

  async function callGoogle(prompt, schema, opts = {}) {
    if (!gKey.has()) throw new Error('Google AI Studio key 未配置');
    const r = await runGoogleAi({
      key: gKey.get(),
      model: googleModel,
      effort: opts.effort != null ? opts.effort : effort,
      prompt,
      schema,
      images: opts && opts.images ? opts.images : undefined,
      egress,
      timeoutMs: opts.timeoutMs || 300000,
    });
    return r.data || r.parsed || (typeof r.text === 'string' ? JSON.parse(r.text) : r);
  }

  async function callMagpie(prompt, schema, opts = {}) {
    if (!cfg.magpie) throw new Error('Magpie 未配置');
    if (!magpie) magpie = createMagpie({ config: cfg.magpie, dataDir, autoStart: false });
    if (!magpiePolled) { await magpie.poll(); magpiePolled = true; }
    const r = await magpie.run({
      model: String(model || 'auto/gemini-4-carbon'),
      effort: opts.effort != null ? opts.effort : effort,
      prompt,
      schema,
      images: opts && opts.images ? opts.images : undefined,
      timeoutMs: opts.timeoutMs || 300000,
    });
    return r.data || r.parsed || (typeof r.text === 'string' ? JSON.parse(r.text) : r);
  }

  function callAgy(prompt, schema, opts = {}) {
    const id = crypto.randomBytes(6).toString('hex');
    const eff = opts.effort != null ? opts.effort : effort;
    const timeoutMs = opts.timeoutMs || 300000;
    const args = ['--output-format', 'json', '--disable-slash-commands'];
    if (model && model !== 'default') args.push('--model', String(model).replace(/^(google:|antigravity\/|magpie:)/, ''));
    if (eff && ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(eff))) args.push('--effort', String(eff));

    if (agySsh) {
      // Run agy on a remote host (e.g. dell97) via SSH; send schema + prompt cleanly via stdin
      const remoteScript = `node -e '
        const fs=require("fs"), cp=require("child_process"), os=require("os"), path=require("path");
        const payload=JSON.parse(fs.readFileSync(0,"utf8"));
        const sf=path.join(os.tmpdir(),"agy-sch-"+Date.now()+"-"+Math.random().toString(16).slice(2)+".json");
        if (payload.schema) fs.writeFileSync(sf, JSON.stringify(payload.schema));
        const a=[...payload.args];
        if (payload.schema) a.push("--json-schema", sf);
        a.push("--print", "Follow the instructions from stdin and return only the requested JSON.");
        const r=cp.spawnSync(payload.bin, a, { input: payload.prompt, encoding:"utf8", timeout: payload.timeoutMs, maxBuffer: 32*1024*1024 });
        try { fs.unlinkSync(sf); } catch {}
        if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(r.status || 1); }
        process.stdout.write(r.stdout);
      '`;
      const r = cp.spawnSync('ssh', ['-o', 'BatchMode=yes', agySsh, remoteScript], {
        input: JSON.stringify({ bin: agyBin, args, schema, prompt, timeoutMs }),
        encoding: 'utf8',
        timeout: timeoutMs + 10000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`agy(${agySsh}) 失败（${r.status}）：${String(r.stderr || r.stdout || '').slice(0, 300)}`);
      const out = JSON.parse(String(r.stdout || '').trim());
      if (out.structured_output != null) return out.structured_output;
      return typeof out.response === 'string' ? JSON.parse(out.response) : out;
    }

    const sf = schema ? path.join(os.tmpdir(), `agy-schema-${id}.json`) : '';
    try {
      if (sf) {
        fs.writeFileSync(sf, JSON.stringify(schema));
        args.push('--json-schema', sf);
      }
      args.push('--print', 'Follow the instructions from stdin and return only the requested JSON.');
      const r = cp.spawnSync(agyBin, args, {
        input: String(prompt || ''),
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`agy 失败（${r.status}）：${String(r.stderr || r.stdout || '').slice(0, 300)}`);
      const out = JSON.parse(String(r.stdout || '').trim());
      if (out.structured_output != null) return out.structured_output;
      return typeof out.response === 'string' ? JSON.parse(out.response) : out;
    } finally {
      if (sf) { try { fs.unlinkSync(sf); } catch {} }
    }
  }

  async function ask(prompt, schema, opts = {}) {
    if (normProv === 'agy') return callAgy(prompt, schema, opts);
    if (normProv === 'magpie') return callMagpie(prompt, schema, opts);
    if (normProv === 'auto') {
      try { return callAgy(prompt, schema, opts); }
      catch (e) {
        log(`agy 调用失败，自动回落 Google API：${e.message}`);
        return callGoogle(prompt, schema, opts);
      }
    }
    return callGoogle(prompt, schema, opts);
  }

  return {
    ask,
    provider: normProv,
    model: normProv === 'magpie' ? String(model) : googleModel,
    close: () => { try { magpie && magpie.stop && magpie.stop(); } catch {} },
  };
}

module.exports = { createLitAsker };
