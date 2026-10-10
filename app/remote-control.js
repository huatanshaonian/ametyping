// Replying to a session from the panel or the dashboard: type text into its terminal, press a navigation key
// there (the terminal's own menus -- /model, /resume, prompts), or, when its process is gone, continue it in the
// background with `claude -p --resume`. Also starts Claude Code in a folder, in a new console window.
// A Codex CLI session the same way; what differs for it is in codex-cli.js.
// Windows only (console input via bridge.js).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { modeFromScreen } = require('./permission-mode');
const { tidyScreen, plainScreen } = require('./screen-text');
const codexCli = require('./codex-cli');

// (ctrlb / ctrls / ctrlxs: Claude Code's Ctrl+B, Ctrl+S, Ctrl+X Ctrl+S -- to the background, stash the draft, send now;
// ctrl<letter>: the Ctrl combinations its menus name, e.g. Ctrl+A in /resume -- never C, D or Z, which interrupt or
// end the session; bksp: Backspace, for what was typed into a menu's box)
const KEYS = new Set(['up', 'down', 'left', 'right', 'enter', 'esc', 'tab', 'btab', 'bksp', 'ctrlxs']);
const CTRL = /^ctrl[abe-y]$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// deps: { sessions, permissions, bridge, procAlive, pushBubble, home }
function createRemoteControl({ sessions, permissions, bridge, procAlive, pushBubble, home }) {
  function claudeExe() {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const f = path.join(dir, 'claude.exe'); if (dir && fs.existsSync(f)) return f;
    }
    const f = path.join(home(), '.local', 'bin', 'claude.exe');
    return fs.existsSync(f) ? f : null;
  }
  // the session's process is gone: continue it in the background; its hooks report back like any other
  // session, and the transcript it appends to is the same file the panel shows
  function resumeHeadless(s, text) {
    const codex = s.provider === 'codex';
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : home();
    let p;
    if (codex) {
      p = codexCli.resume(s.rawSession, cwd, text);
      if (!p) return { ok: false, msg: '找不到 codex，没法在后台续聊' };
    } else {
      const exe = claudeExe();
      if (!exe) return { ok: false, msg: '找不到 claude.exe，没法在后台续聊' };
      p = spawn(exe, ['-p', '--resume', s.id], { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', () => {});
      p.stdin.on('error', () => {});
      p.stdin.end(text);                                           // prompt on stdin: never parsed as an option
    }
    p.on('exit', () => { s.headless = false; s.claudePid = null; s.fromPid = null; s.state = 'ended'; s.last = Date.now(); pushBubble(null); });
    s.headless = true; s.state = 'message'; s.last = Date.now();
    pushBubble(null);
    return { ok: true, msg: codex ? '这个会话已经关了，在后台用 codex exec resume 续上（不会再问你确认：按 Codex 自己的沙箱设置来）'
      : '这个会话已经关了，在后台用 claude -p --resume 续上（需要确认权限的操作会被跳过）' };
  }

  // a permission prompt is open in the terminal: typed text would land in it and pick options.
  // ("waiting" alone is not enough: Claude also notifies "waiting for your input" when it is simply idle)
  function asking(s) {
    if (permissions.list(s.id).length) return true;
    const last = [...(s.lines || [])].reverse().find((l) => !l.sep);
    return s.state === 'waiting' && !!last && /确认/.test(last.text);
  }

  // the live terminal of a session, or why there is none
  async function terminalOf(s) {
    if (!s) return { msg: '这个会话已经不在列表里了' };
    if (s.headless) return { msg: '后台续聊还在跑，等它这一轮完成再发' };
    if (!s.claudePid || !(await procAlive(s.claudePid))) return { gone: true };
    if (!s.terminal) return { msg: '这个会话不在终端里（IDE 插件 / 桌面 App），没法从这里操作' };
    return { pid: s.claudePid };
  }

  async function chatSend(id, text) {
    const s = sessions.get(id);
    const t = await terminalOf(s);
    if (t.msg) return { ok: false, msg: t.msg };
    if (t.pid) {
      if (asking(s)) return { ok: false, msg: '它在等你确认，先处理确认（面板卡片或终端里）' };
      // whatever was typed in the terminal's own input box first: out of the way (Ctrl+Y there brings it back), so the
      // reply goes as it is and not glued to half a sentence
      await bridge.key(t.pid, 'clear');
      await new Promise((res) => setTimeout(res, 150));
      const r = s.provider === 'codex' ? await codexCli.send(bridge, t.pid, text) : await bridge.send(t.pid, text);
      return r.ok ? { ok: true } : { ok: false, msg: '发送失败：' + r.err };
    }
    if (s.state !== 'ended' && !s.claudePid) return { ok: false, msg: '还不知道这个会话在哪个终端里（等它下一次有动静）' };
    return resumeHeadless(s, text);
  }

  // one navigation key into the session's terminal (only a live terminal session; menus and prompts are its use)
  // wantScreen: the screen as it is a moment after the key comes with the answer (the dashboard's 终端画面 is open)
  // "c:text": typed as it is, without Enter -- the letter a menu takes ("s to use this session only", "2" for the
  // second), what goes into a menu's search box, a path
  async function chatKey(id, key, wantScreen = false, hl = false) {
    const ch = /^c:([^\x00-\x1f\x7f]{1,200})$/.exec(key);
    if (!KEYS.has(key) && !CTRL.test(key) && !ch) return { ok: false, msg: '不支持的按键' };
    const t = await terminalOf(sessions.get(id));
    if (t.msg) return { ok: false, msg: t.msg };
    if (!t.pid) return { ok: false, msg: '这个会话已经不在终端里运行，按键没有对象' };
    const r = ch ? await bridge.type(t.pid, ch[1]) : await bridge.key(t.pid, key);
    if (!r.ok) return { ok: false, msg: '按键失败：' + r.err };
    if (key !== 'btab' && !wantScreen) return { ok: true };
    // Shift+Tab: the mode it switched to, read once from the redrawn status line (the transcript only records the
    // mode with the next message). (Text typed into a menu's search box: the list under it takes a little longer.)
    await sleep(ch && ch[1].length > 1 ? 700 : 350);
    const text = await bridge.screen(t.pid, hl);
    return { ok: true, mode: key === 'btab' ? modeFromScreen(plainScreen(text)) : undefined, screen: wantScreen ? tidyScreen(text) || '' : undefined };
  }

  // what the session's terminal shows right now (asked for by you in the dashboard, never polled): Claude Code's own
  // menus and prompts are only there
  async function chatScreen(id, hl = false) {
    const t = await terminalOf(sessions.get(id));
    if (t.msg) return { ok: false, msg: t.msg };
    if (!t.pid) return { ok: false, msg: '这个会话已经不在终端里运行，没有画面' };
    const text = await bridge.screen(t.pid, hl);
    return text == null ? { ok: false, msg: '读不到终端画面' } : { ok: true, screen: tidyScreen(text) };
  }

  // a new Claude Code session in a folder (checked by the agent), in its own console window; its hooks make it
  // appear on the panel and the dashboard like any session you started yourself. A folder Claude Code has not seen
  // asks whether to trust it before any hook runs (so the dashboard could not see it): starting it from the dashboard
  // is that choice, so the prompt is answered here by reading the window's screen for a little while.
  function answerTrust(pid) {
    let n = 0;
    const tick = async () => {
      if (++n > 35) return;
      const text = await bridge.screen(pid);
      if (text == null) return;                                    // the window is gone
      if (/Yes, I trust this folder/.test(text)) {
        if (/❯\s*(\d\.\s*)?No, exit/.test(text)) await bridge.key(pid, 'down');
        await bridge.key(pid, 'enter');
        return;
      }
      setTimeout(tick, 700);
    };
    setTimeout(tick, 1000);
  }
  // resume: a past conversation's id -- `claude --resume <id>` there instead of a new session (its folder, from its
  // own transcript, is what the agent passes as cwd); a Codex thread's ("codex:<id>") -- `codex resume <id>`
  // tool: 'codex' -- a new Codex session instead of Claude Code's
  async function launch(cwd, prompt, resume = '', tool = 'claude') {
    const thread = /^codex:/.test(resume) ? resume.slice(6) : '';
    if (resume && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(thread || resume)) return { ok: false, msg: '无效请求' };
    if (resume) { const s = sessions.get(resume); if (s && s.claudePid && await procAlive(s.claudePid)) return { ok: false, msg: '这个会话还开着' }; }
    let st; try { st = fs.statSync(cwd); } catch { return { ok: false, msg: resume ? '这个会话原来的文件夹已经不在了：' + cwd : '找不到这个文件夹' }; }
    if (!st.isDirectory()) return { ok: false, msg: '这不是文件夹' };
    const codex = !!thread || (!resume && tool === 'codex');
    const cx = codex ? codexCli.command() : null;
    const exe = codex ? cx && cx.exe : claudeExe();
    if (!exe) return { ok: false, msg: codex ? '找不到 codex' : '找不到 claude.exe' };
    const first = String(prompt || '').trim();
    // (Codex's first message is typed into it once it is up, not passed along: it may be started through cmd.exe,
    // where a sentence with quotes or an & in it does not survive as an argument)
    const args = thread ? [...cx.args, 'resume', thread] : codex ? [...cx.args] : resume ? ['--resume', resume] : first ? [first] : [];
    // ~/.ametyping/launch.ps1, when it is there, runs first in the new window (e.g. `proxy`, a function of your PowerShell
    // profile: the pet's own environment has no proxy set) -- Claude Code is then started from that PowerShell, as you
    // would by hand. (The Linux service has ~/.ametyping/launch.sh for the same.) The command goes in encoded: no quoting.
    const pre = path.join(home(), '.ametyping', 'launch.ps1');
    let pid;
    if (fs.existsSync(pre)) {
      const ps = (x) => "'" + String(x).replace(/'/g, "''") + "'";
      const cmd = `. ${ps(pre)}; & ${ps(exe)} ${args.map(ps).join(' ')}`;
      pid = await bridge.launch('powershell.exe', ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')], cwd);
    } else pid = await bridge.launch(exe, args, cwd);
    if (!pid) return { ok: false, msg: '启动失败' };
    if (codex) codexCli.greet(bridge, pid, thread ? '' : first).catch(() => {}); else answerTrust(pid);
    return { ok: true, msg: resume ? '已在这台电脑上打开一个新的命令行窗口，接着这个对话' : '已在这台电脑上打开一个新的命令行窗口启动（新文件夹会自动确认信任）' };
  }

  return { chatSend, chatKey, chatScreen, launch, KEYS };
}

module.exports = { createRemoteControl };
