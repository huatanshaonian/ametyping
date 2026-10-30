// Starts Claude Code in a folder, in a new detached tmux session (the same tmux server you use: `tmux attach -t <name>`
// takes it over), so it shows up on the dashboard and can be replied to like any other session. On Linux tmux is started
// in a systemd scope of its own, so an update restarting the service leaves the sessions running (newSession).
// The service's own environment usually lacks what your shell sets up (a proxy, API settings), so those variables
// are carried over from a Claude session you started yourself -- through a private temp file the new shell reads and
// deletes, never on a command line where other users could see them. ~/.ametyping/launch.sh, if present, is sourced
// right before starting (e.g. `source ~/proxy.sh`) for when no session of yours has been seen yet.
// A folder Claude Code has not seen before first asks whether to trust it -- before any hook runs, so the dashboard
// could not even see the session. Starting it from the dashboard is the choice to trust that folder: the prompt is
// answered here (the pane is watched for a little while after the start).
// A Codex thread ("codex:<id>") is opened again the same way, with `codex resume <id>`; tool 'codex' starts a new
// Codex session instead (its questions before it is ready -- trust this folder, update now -- answered likewise).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { codexBin, threadOf } = require('./codex');
const { agyBin, threadOf: agyThreadOf } = require('./agy');
const { kiroBin, threadOf: kiroThreadOf } = require('./kiro');
const opencode = require('../app/opencode');
const claudeApi = require('../app/claude-api');

const CARRY = /^(https?_proxy|all_proxy|no_proxy|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|ANTHROPIC_[A-Z0-9_]+|CLAUDE_[A-Z0-9_]+|OPENAI_[A-Z0-9_]+|CODEX_[A-Z0-9_]+|GEMINI_[A-Z0-9_]+|AGY_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|LANG|LC_ALL)$/;
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function claudeBin(env) {
  for (const dir of ((env && env.PATH) || process.env.PATH || '').split(path.delimiter)) {
    const f = dir && path.join(dir, 'claude');
    if (f && fs.existsSync(f)) return f;
  }
  const f = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(f) ? f : null;
}

// cwd: a folder the agent already checked; env: a recent session's environment (or null); prompt: optional first message;
// resume: a past conversation's id -- `claude --resume <id>` in its folder instead of a new session; a Codex thread's
// ("codex:<id>") -- `codex resume <id>`
function launch({ cwd, prompt, env, resume = '', tool = 'claude', api: apiArg = null }) {
  return new Promise((resolve) => {
    const thread = threadOf(resume);
    const agyThread = agyThreadOf(resume);
    const kiroThread = kiroThreadOf(resume);
    const ocThread = /^opencode:/.test(resume) ? opencode.rawId(resume) : '';
    const openMode = !!ocThread || (!resume && tool === 'opencode');
    if (resume && openMode) { if (!opencode.isId(ocThread)) return resolve({ ok: false, msg: '无效请求' }); }
    else if (resume && !thread && !agyThread && !kiroThread && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(resume)) return resolve({ ok: false, msg: '无效请求' });
    let st; try { st = fs.statSync(cwd); } catch { return resolve({ ok: false, msg: resume ? '这个会话原来的文件夹已经不在了：' + cwd : '找不到这个文件夹' }); }
    if (!st.isDirectory()) return resolve({ ok: false, msg: '这不是文件夹' });
    if (openMode) {
      const oc = opencode.command(env);
      if (!oc) return resolve({ ok: false, msg: '找不到 opencode' });
      const tag = crypto.randomBytes(3).toString('hex');
      const name = `opencode-${path.basename(cwd).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'dir'}-${tag}`;
      const first = String(prompt || '').trim();
      const args = [...oc.args, ...(ocThread ? ['-s', ocThread] : first ? ['--prompt', first] : [])];
      const cmd = `exec ${q(oc.exe)}${args.map((a) => ' ' + q(a)).join('')}`;
      newSession(['new-session', '-d', '-s', name, '-c', cwd, cmd], tag, (err, _o, stderr) => {
        if (err) return resolve({ ok: false, msg: '启动失败：' + String(stderr || err.message).trim().slice(0, 150) });
        resolve({ ok: true, msg: ocThread ? `已在 tmux 会话「${name}」里接着这个 OpenCode 对话（ssh 上去 tmux attach -t ${name} 可接手）` : `已在 tmux 会话「${name}」里启动 OpenCode（ssh 上去 tmux attach -t ${name} 可接手）` });
      });
      return;
    }
    const codex = !!thread || (!resume && tool === 'codex');
    const agy = !!agyThread || (!resume && tool === 'agy');
    const kiro = !!kiroThread || (!resume && tool === 'kiro');
    const bin = codex ? codexBin(env) : agy ? agyBin(env) : kiro ? kiroBin(env) : claudeBin(env);
    if (!bin) return resolve({ ok: false, msg: codex ? '找不到 codex' : agy ? '找不到 agy' : kiro ? '找不到 kiro-cli' : '找不到 claude' });
    const api = (codex || agy || kiro) ? null : claudeApi.valid(apiArg);
    if (!codex && !agy && !kiro && apiArg && !api) return resolve({ ok: false, msg: 'API 别名配置不对' });
    const sf = api ? claudeApi.settingsFile(api) : null;
    if (api && !sf) return resolve({ ok: false, msg: '写 API 设置失败' });
    const tag = crypto.randomBytes(3).toString('hex');
    const name = `${codex ? 'codex' : agy ? 'agy' : kiro ? 'kiro' : 'claude'}-${path.basename(cwd).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'dir'}-${tag}`;
    const envFile = path.join(os.tmpdir(), `ame-launch-${crypto.randomBytes(8).toString('hex')}.env`);
    // an alias is the authority for the API: do not carry a recent session's ANTHROPIC_* / CLAUDE_* along with it
    const lines = Object.entries(env || {}).filter(([k]) => CARRY.test(k) && !/^CLAUDE_CONFIG_DIR$/i.test(k) && (!api || !/^(ANTHROPIC_|CLAUDE_)/.test(k))).map(([k, v]) => `export ${k}=${q(v)}`);
    if (api) lines.push(`export AME_CLAUDE_API=${q(api.id)}`);
    const proxy = api ? (claudeApi.PROXY.test(api.proxy || '') ? api.proxy : 'inherit') : 'inherit';
    if (api && proxy !== 'inherit' && /^https?:\/\//.test(proxy)) {
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) lines.push(`export ${k}=${q(proxy)}`);
    }
    try { fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 }); } catch { if (sf) sf.cleanup(); return resolve({ ok: false, msg: '写临时文件失败' }); }
    const pre = path.join(os.homedir(), '.ametyping', 'launch.sh');
    const direct = api && proxy === 'direct'
      ? `unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; export NO_PROXY='*' no_proxy='*'; ` : '';
    // an inherited NO_PROXY=* (from a recent direct session or launch.sh) would bypass an explicit proxy
    const explicit = api && proxy !== 'inherit' && /^https?:\/\//.test(proxy)
      ? `export NO_PROXY='localhost,127.0.0.1' no_proxy='localhost,127.0.0.1'; ` : '';
    const settings = sf ? ' ' + sf.args.map(q).join(' ') : '';
    // every alias uses the default ~/.claude memory, even if launch.sh or a recent session set another one
    const tail = thread ? ' resume ' + q(thread) : agyThread ? ' --conversation ' + q(agyThread)
      : kiroThread ? ' chat --resume-id ' + q(kiroThread) : kiro ? ' chat' + (prompt && prompt.trim() ? ' ' + q(prompt) : '')
      : resume ? ' --resume ' + q(resume) : prompt && prompt.trim() ? ' ' + q(prompt) : '';
    const cmd = `. ${q(envFile)}; rm -f ${q(envFile)}; [ -f ${q(pre)} ] && . ${q(pre)}; unset CLAUDE_CONFIG_DIR; ${direct}${explicit}exec ${q(bin)}${settings}${tail}`;
    newSession(['new-session', '-d', '-s', name, '-c', cwd, cmd], tag, (err, _o, stderr) => {
      if (err) { try { fs.unlinkSync(envFile); } catch {} if (sf) sf.cleanup(); return resolve({ ok: false, msg: '启动失败：' + String(stderr || err.message).trim().slice(0, 150) }); }
      answerTrust(name, codex || kiro);
      resolve({ ok: true, msg: resume ? `已在 tmux 会话「${name}」里接着这个对话（ssh 上去 tmux attach -t ${name} 可接手）` : `已在 tmux 会话「${name}」里启动（ssh 上去 tmux attach -t ${name} 可接手；新文件夹会自动确认信任）` });
    });
  });
}

// `tmux new-session`, in a systemd scope of its own (ame-tmux-<tag>.scope) on Linux: when it starts the tmux server,
// the server and every session in it then live outside ame-headless.service, so restarting or stopping the service
// (each update) does not take them down with it. (When a server is already running, the session goes to it and the
// scope is gone as soon as the client exits.) No systemd for this user (no user bus, not Linux): tmux directly.
const NO_SCOPE = /Failed to (connect|start|create|allocate)|Unknown (operation|option)|System has not been booted with systemd|ENOENT/i;
function newSession(args, tag, done) {
  const plain = () => execFile('tmux', args, { timeout: 8000 }, done);
  if (process.platform !== 'linux') return plain();
  execFile('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=ame-tmux-${tag}`, '--', 'tmux', ...args], { timeout: 8000 }, (err, o, stderr) => {
    if (err && (err.code === 'ENOENT' || NO_SCOPE.test(String(stderr || '')))) return plain();
    done(err, o, stderr);
  });
}

// answer the folder-trust prompt of a freshly started session (only that prompt; gives up after ~25 s)
// codex: Codex's own wording of it, and its "update now?" (not now)
function answerTrust(name, codex = false) {
  const pane = () => new Promise((r) => execFile('tmux', ['capture-pane', '-p', '-t', name + ':'], { timeout: 3000 }, (e, out) => r(e ? null : String(out))));
  const keys = (...k) => new Promise((r) => execFile('tmux', ['send-keys', '-t', name + ':', ...k], { timeout: 3000 }, () => r()));
  let n = 0;
  const tick = async () => {
    if (++n > 35) return;
    const text = await pane();
    if (text == null) return;                                        // the session is gone
    if (codex) {
      if (/Do you trust the contents of this directory/.test(text)) { if (/›\s*2\.\s*No/.test(text)) await keys('Up'); await keys('Enter'); }
      else if (/Update available/.test(text) && /\d\.\s*Skip/.test(text)) { if (/›\s*1\./.test(text)) await keys('Down'); await keys('Enter'); }
      else if (/enter confirm|Press enter to continue/i.test(text) || /›\s+Ask Codex to do anything|esc to interrupt/.test(text)) return;
      return void setTimeout(tick, 700);
    }
    if (/Yes, I trust this folder|Do you trust the contents of this project/i.test(text)) {
      const onNo = /❯\s*(\d\.\s*)?No, exit/.test(text);
      if (onNo) await keys('Down');
      await keys('Enter');
      return;
    }
    // keep watching the whole window: the normal prompt can be drawn for a moment before the question appears
    setTimeout(tick, 700);
  };
  setTimeout(tick, 700);
}

module.exports = { launch, newSession };
