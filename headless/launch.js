// Starts Claude Code in a folder, in a new detached tmux session (the same tmux server you use: `tmux attach -t <name>`
// takes it over), so it shows up on the dashboard and can be replied to like any other session.
// The service's own environment usually lacks what your shell sets up (a proxy, API settings), so those variables
// are carried over from a Claude session you started yourself -- through a private temp file the new shell reads and
// deletes, never on a command line where other users could see them. ~/.ametyping/launch.sh, if present, is sourced
// right before starting (e.g. `source ~/proxy.sh`) for when no session of yours has been seen yet.
// A folder Claude Code has not seen before first asks whether to trust it -- before any hook runs, so the dashboard
// could not even see the session. Starting it from the dashboard is the choice to trust that folder: the prompt is
// answered here (the pane is watched for a little while after the start).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CARRY = /^(https?_proxy|all_proxy|no_proxy|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|ANTHROPIC_[A-Z0-9_]+|CLAUDE_[A-Z0-9_]+|LANG|LC_ALL)$/;
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function claudeBin(env) {
  for (const dir of ((env && env.PATH) || process.env.PATH || '').split(path.delimiter)) {
    const f = dir && path.join(dir, 'claude');
    if (f && fs.existsSync(f)) return f;
  }
  const f = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(f) ? f : null;
}

// cwd: a folder the agent already checked; env: a recent session's environment (or null); prompt: optional first message
function launch({ cwd, prompt, env }) {
  return new Promise((resolve) => {
    let st; try { st = fs.statSync(cwd); } catch { return resolve({ ok: false, msg: '找不到这个文件夹' }); }
    if (!st.isDirectory()) return resolve({ ok: false, msg: '这不是文件夹' });
    const bin = claudeBin(env);
    if (!bin) return resolve({ ok: false, msg: '找不到 claude' });
    const tag = crypto.randomBytes(3).toString('hex');
    const name = `claude-${path.basename(cwd).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'dir'}-${tag}`;
    const envFile = path.join(os.tmpdir(), `ame-launch-${crypto.randomBytes(8).toString('hex')}.env`);
    const lines = Object.entries(env || {}).filter(([k]) => CARRY.test(k)).map(([k, v]) => `export ${k}=${q(v)}`);
    try { fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 }); } catch { return resolve({ ok: false, msg: '写临时文件失败' }); }
    const pre = path.join(os.homedir(), '.ametyping', 'launch.sh');
    const cmd = `. ${q(envFile)}; rm -f ${q(envFile)}; [ -f ${q(pre)} ] && . ${q(pre)}; exec ${q(bin)}${prompt && prompt.trim() ? ' ' + q(prompt) : ''}`;
    execFile('tmux', ['new-session', '-d', '-s', name, '-c', cwd, cmd], { timeout: 8000 }, (err, _o, stderr) => {
      if (err) { try { fs.unlinkSync(envFile); } catch {} return resolve({ ok: false, msg: '启动失败：' + String(stderr || err.message).trim().slice(0, 150) }); }
      answerTrust(name);
      resolve({ ok: true, msg: `已在 tmux 会话「${name}」里启动（ssh 上去 tmux attach -t ${name} 可接手；新文件夹会自动确认信任）` });
    });
  });
}

// answer the folder-trust prompt of a freshly started session (only that prompt; gives up after ~25 s)
function answerTrust(name) {
  const pane = () => new Promise((r) => execFile('tmux', ['capture-pane', '-p', '-t', name + ':'], { timeout: 3000 }, (e, out) => r(e ? null : String(out))));
  const keys = (...k) => new Promise((r) => execFile('tmux', ['send-keys', '-t', name + ':', ...k], { timeout: 3000 }, () => r()));
  let n = 0;
  const tick = async () => {
    if (++n > 35) return;
    const text = await pane();
    if (text == null) return;                                        // the session is gone
    if (/Yes, I trust this folder/.test(text)) {
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

module.exports = { launch };
