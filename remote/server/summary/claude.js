// Runs one question through Claude Code, as codex.js does through Codex: `claude -p` with no tools at all, a short
// system prompt of our own (not Claude Code's coding one: ~1k tokens instead of ~7k), no settings, MCP servers or
// skills of the NAS loaded, not saved as a session (--no-session-persistence), the answer forced into a JSON schema
// (--json-schema; it comes back as structured_output in the --output-format json result). The prompt goes in on stdin.
//   bin: the claude executable, or [command, ...leading args] (tests use a fake: ["node", "fake-claude.js"])
//   model / effort: which model and how hard it thinks (ai/settings.js; effort '' = the model's own default)
//   images: PNG / JPEG files the model looks at along with the prompt (文献's page images); they go in as one
//   stream-json user message (--input-format stream-json), the answer comes back as the stream's result line
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SYSTEM = '你是 Windose 在群晖上的后台助手，替用户完成日报、周报、邮件、文献等自动化任务。严格按用户消息里的要求作答，答案只通过结构化输出给出。';

function runClaude({ bin, model, effort = '', prompt, schema, env, timeoutMs = 20 * 60e3, images = [] }) {
  const [cmd, ...pre] = Array.isArray(bin) ? bin : [bin];
  let input = prompt;
  if (images.length) {
    try {
      input = JSON.stringify({ type: 'user', message: { role: 'user', content: [
        ...images.map((f) => ({ type: 'image', source: { type: 'base64', media_type: /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/png', data: fs.readFileSync(f).toString('base64') } })),
        { type: 'text', text: prompt }] } }) + '\n';
    } catch (e) { return Promise.reject(new Error('读不到要给 claude 看的图片：' + e.message)); }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-claude-'));
  const args = [...pre, '-p', ...(model ? ['--model', model] : []), ...(/^[a-z]{2,10}$/.test(effort) ? ['--effort', effort] : []),
    '--system-prompt', SYSTEM, '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '',
    '--no-session-persistence', ...(images.length ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
    '--json-schema', JSON.stringify(schema)];
  return new Promise((resolve, reject) => {
    // the working folder is the empty temp folder (and no tools): nothing of the NAS is in reach
    const p = spawn(cmd, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
    const done = (e, v) => { clearTimeout(timer); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} e ? reject(e) : resolve(v); };
    p.on('error', (e) => done(new Error(`启动 claude 失败：${e.message}`)));
    p.on('close', (code, sig) => {
      // one JSON object: { type: 'result', is_error, result (the text, or why it failed), api_error_status, structured_output }
      let r = null;
      for (const l of [out.trim(), ...out.trim().split('\n').reverse()]) { try { const j = JSON.parse(l); if (j && j.type === 'result') { r = j; break; } } catch {} }
      if (!r) {
        const why = sig === 'SIGKILL' ? '超时' : `退出码 ${code}`;
        const last = err.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' / ');
        return done(new Error(`claude 没有给出结果（${why}）${last ? '：' + last.slice(0, 400) : ''}`));
      }
      if (r.is_error) return done(new Error(`claude 出错${r.api_error_status ? `（${r.api_error_status}）` : ''}：${String(r.result || r.subtype || '').slice(0, 400)}`));
      if (r.structured_output && typeof r.structured_output === 'object') return done(null, r.structured_output);
      try { done(null, JSON.parse(r.result)); } catch { done(new Error('claude 的回答不是 JSON：' + String(r.result || '').slice(0, 200))); }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

module.exports = { runClaude, SYSTEM };
