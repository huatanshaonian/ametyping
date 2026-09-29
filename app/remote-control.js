// Replying to a session from the panel or the dashboard: type text into its terminal, press a navigation key
// there (the terminal's own menus -- /model, /resume, prompts), or, when its process is gone, continue it in the
// background with `claude -p --resume`. Windows only (console input via bridge.js).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const KEYS = new Set(['up', 'down', 'left', 'right', 'enter', 'esc', 'tab']);

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
    return r.ok ? { ok: true } : { ok: false, msg: '按键失败：' + r.err };
  }

  return { chatSend, chatKey, KEYS };
}

module.exports = { createRemoteControl };
