// Replying to a session from the panel or the dashboard: type text into its terminal, press a navigation key
// there (the terminal's own menus -- /model, /resume, prompts), or, when its process is gone, continue it in the
// background with `claude -p --resume`. Also starts Claude Code in a folder, in a new console window.
// Windows only (console input via bridge.js).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { modeFromScreen } = require('./permission-mode');

// (ctrlb / ctrls / ctrlxs: Claude Code's Ctrl+B, Ctrl+S, Ctrl+X Ctrl+S -- to the background, stash the draft, send now)
const KEYS = new Set(['up', 'down', 'left', 'right', 'enter', 'esc', 'tab', 'btab', 'ctrlb', 'ctrls', 'ctrlxs']);
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
    const exe = claudeExe();
    if (!exe) return { ok: false, msg: '找不到 claude.exe，没法在后台续聊' };
    const p = spawn(exe, ['-p', '--resume', s.id], { cwd: s.cwd && fs.existsSync(s.cwd) ? s.cwd : home(),
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.stdin.on('error', () => {});
    p.stdin.end(text);                                             // prompt on stdin: never parsed as an option
    p.on('exit', () => { s.headless = false; s.claudePid = null; s.fromPid = null; s.state = 'ended'; s.last = Date.now(); pushBubble(null); });
    s.headless = true; s.state = 'message'; s.last = Date.now();
    pushBubble(null);
    return { ok: true, msg: '这个会话已经关了，在后台用 claude -p --resume 续上（需要确认权限的操作会被跳过）' };
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
    if (s.provider === 'codex') return { msg: '请在 Codex 中继续对话；这里可以查看进度和处理权限' };
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
      const r = await bridge.send(t.pid, text);
      return r.ok ? { ok: true } : { ok: false, msg: '发送失败：' + r.err };
    }
    if (s.state !== 'ended' && !s.claudePid) return { ok: false, msg: '还不知道这个会话在哪个终端里（等它下一次有动静）' };
    return resumeHeadless(s, text);
  }

  // one navigation key into the session's terminal (only a live terminal session; menus and prompts are its use)
  async function chatKey(id, key) {
    if (!KEYS.has(key)) return { ok: false, msg: '不支持的按键' };
    const t = await terminalOf(sessions.get(id));
    if (t.msg) return { ok: false, msg: t.msg };
    if (!t.pid) return { ok: false, msg: '这个会话已经不在终端里运行，按键没有对象' };
    const r = await bridge.key(t.pid, key);
    if (!r.ok) return { ok: false, msg: '按键失败：' + r.err };
    if (key !== 'btab') return { ok: true };
    // Shift+Tab: the mode it switched to, read once from the redrawn status line (the transcript only records the
    // mode with the next message)
    await sleep(350);
    return { ok: true, mode: modeFromScreen(await bridge.screen(t.pid)) };
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
  async function launch(cwd, prompt) {
    let st; try { st = fs.statSync(cwd); } catch { return { ok: false, msg: '找不到这个文件夹' }; }
    if (!st.isDirectory()) return { ok: false, msg: '这不是文件夹' };
    const exe = claudeExe();
    if (!exe) return { ok: false, msg: '找不到 claude.exe' };
    const first = String(prompt || '').trim();
    const pid = await bridge.launch(exe, first ? [first] : [], cwd);
    if (!pid) return { ok: false, msg: '启动失败' };
    answerTrust(pid);
    return { ok: true, msg: '已在这台电脑上打开一个新的命令行窗口启动（新文件夹会自动确认信任）' };
  }

  return { chatSend, chatKey, launch, KEYS };
}

module.exports = { createRemoteControl };
