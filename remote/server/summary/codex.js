// Runs one question through the Codex CLI: `codex exec` read-only, not saved as a session of its own (--ephemeral),
// answer forced into a JSON schema (--output-schema, last message written to a file). The prompt goes in on stdin.
//   bin: the codex executable, or [command, ...leading args] (tests use a fake: ["node", "fake-codex.js"])
//   model / effort: which model and how hard it thinks (ai/settings.js; effort '' = the model's own default)
//   images: PNG / JPEG files the model looks at along with the prompt (文献's page images)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function runCodex({ bin, model, effort = '', prompt, schema, env, timeoutMs = 20 * 60e3, images = [] }) {
  const [cmd, ...pre] = Array.isArray(bin) ? bin : [bin];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-summary-'));
  const schemaFile = path.join(dir, 'schema.json'), outFile = path.join(dir, 'answer.json');
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const args = [...pre, 'exec', ...(model ? ['-m', model] : []), ...(/^[a-z]{2,10}$/.test(effort) ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-s', 'read-only', '--skip-git-repo-check', '--ephemeral',
    '--color', 'never', '--output-schema', schemaFile, '-o', outFile, ...images.map((f) => '--image=' + f), '-'];
  return new Promise((resolve, reject) => {
    // the working folder is the empty temp folder: nothing of the NAS is in reach even for reading
    const p = spawn(cmd, args, { cwd: dir, env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
    const done = (e, v) => { clearTimeout(timer); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} e ? reject(e) : resolve(v); };
    p.on('error', (e) => done(new Error(`启动 codex 失败：${e.message}`)));
    p.on('close', (code, sig) => {
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch {}
      if (!text.trim()) {
        const why = sig === 'SIGKILL' ? '超时' : `退出码 ${code}`;
        const last = err.split('\n').map((l) => l.trim()).filter((l) => l && !/bubblewrap/i.test(l)).slice(-3).join(' / ');
        return done(new Error(`codex 没有给出结果（${why}）${last ? '：' + last.slice(0, 400) : ''}`));
      }
      try { done(null, JSON.parse(text)); } catch { done(new Error('codex 的回答不是 JSON：' + text.slice(0, 200))); }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
  });
}

module.exports = { runCodex };
