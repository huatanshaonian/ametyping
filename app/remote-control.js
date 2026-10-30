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
const agyCli = require('./agy-cli');
const kiroCli = require('./kiro-cli');
const opencode = require('./opencode');
const btwPanel = require('./btw-panel');
const claudeApi = require('./claude-api');
const { createProfiles } = claudeApi;

// (ctrlb / ctrls / ctrlxs: Claude Code's Ctrl+B, Ctrl+S, Ctrl+X Ctrl+S -- to the background, stash the draft, send now;
// ctrl<letter>: the Ctrl combinations its menus name, e.g. Ctrl+A in /resume -- never C, D or Z, which interrupt or
// end the session; bksp: Backspace, for what was typed into a menu's box)
const KEYS = new Set(['up', 'down', 'left', 'right', 'enter', 'esc', 'tab', 'btab', 'bksp', 'ctrlxs']);
const CTRL = /^ctrl[abe-y]$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// deps: { sessions, permissions, bridge, procAlive, pushBubble, home, onBtw }
function createRemoteControl({ sessions, permissions, bridge, procAlive, pushBubble, home, onBtw = () => {} }) {
  // /btw answers read off the console (btw-panel.js): kept on the session for the agent (/control/state), and
  // onBtw(s, item) for the panel's own conversation
  const btw = btwPanel.createBtw({ onChange: onBtw });
  const consoleIo = (pid) => ({ screen: async () => plainScreen(await bridge.screen(pid)), key: (k) => (k === 'f' ? bridge.type(pid, 'f') : bridge.key(pid, k)) });
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
    if (s.provider === 'opencode') {
      const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : home();
      const p = opencode.resume(s.id, cwd, text);
      if (!p) return { ok: false, msg: '找不到 opencode，没法在后台续聊' };
      p.once('close', () => { s.headless = false; s.claudePid = null; s.fromPid = null; s.state = 'ended'; s.last = Date.now(); pushBubble(null); });
      s.headless = true; s.state = 'message'; s.last = Date.now();
      pushBubble(null);
      return { ok: true, msg: '这个会话已经关了，在后台用 opencode run 续上（按 OpenCode 的权限规则自动允许未被明确拒绝的操作）' };
    }
    const codex = s.provider === 'codex';
    const agy = s.provider === 'agy';
    const kiro = s.provider === 'kiro';
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : home();
    let p;
    if (codex) {
      p = codexCli.resume(s.rawSession, cwd, text);
      if (!p) return { ok: false, msg: '找不到 codex，没法在后台续聊' };
    } else if (agy) {
      p = agyCli.resume(s.rawSession, cwd, text);
      if (!p) return { ok: false, msg: '找不到 agy，没法在后台续聊' };
    } else if (kiro) {
      p = kiroCli.resume(s.rawSession, cwd, text);
      if (!p) return { ok: false, msg: '找不到 kiro-cli，没法在后台续聊' };
    } else {
      const exe = claudeExe();
      if (!exe) return { ok: false, msg: '找不到 claude.exe，没法在后台续聊' };
      const plan = claudeApi.resumePlan(s.api, process.env, { cwd, args: ['-p', '--resume', s.id] });
      if (!plan.ok) return plan;
      p = spawn(plan.command ? plan.command.exe : exe, plan.command ? plan.command.args : ['-p', '--resume', s.id],
        { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: plan.env });
      p.on('error', plan.cleanup);
      p.stdin.on('error', () => {});
      p.stdin.end(text);                                           // prompt on stdin: never parsed as an option
      p.on('close', plan.cleanup);
    }
    p.once('close', () => { s.headless = false; s.claudePid = null; s.fromPid = null; s.state = 'ended'; s.last = Date.now(); pushBubble(null); });
    s.headless = true; s.state = 'message'; s.last = Date.now();
    pushBubble(null);
    return { ok: true, msg: codex ? '这个会话已经关了，在后台用 codex exec resume 续上（不会再问你确认：按 Codex 自己的沙箱设置来）'
      : agy ? '这个会话已经关了，在后台用 agy --conversation -p 续上（自动允许权限操作）'
      : kiro ? '这个会话已经关了，在后台用 kiro-cli chat --resume-id 续上（--trust-all-tools 自动允许权限操作）'
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
    // OpenCode: there is no terminal; the plugin answers through OpenCode's own session API (and it knows the
    // session even when the panel has not seen it yet -- a session reopened from the dashboard's history)
    if (String(id).startsWith('opencode:')) {
      const s = sessions.get(id);
      if (s && s.state === 'ended') return resumeHeadless(s, text);
      if (s && asking(s)) return { ok: false, msg: '它在等你确认，先处理确认（面板卡片或终端里）' };
      const r = await opencode.prompt(id, text);
      if (r.ok && s) { s.last = Date.now(); }
      return r;
    }
    const s = sessions.get(id);
    const t = await terminalOf(s);
    if (t.msg) return { ok: false, msg: t.msg };
    if (t.pid) {
      if (asking(s)) return { ok: false, msg: '它在等你确认，先处理确认（面板卡片或终端里）' };
      const claude = s.provider !== 'codex' && s.provider !== 'agy' && s.provider !== 'kiro';
      if (claude) await btw.beforeSend(s, consoleIo(t.pid));       // (an open /btw overlay would swallow the message)
      // whatever was typed in the terminal's own input box first: out of the way (Ctrl+Y there brings it back), so the
      // reply goes as it is and not glued to half a sentence
      await bridge.key(t.pid, 'clear');
      await new Promise((res) => setTimeout(res, 150));
      const r = claude ? await bridge.send(t.pid, text) : s.provider === 'agy' ? await agyCli.send(bridge, t.pid, text) : s.provider === 'kiro' ? await kiroCli.send(bridge, t.pid, text) : await codexCli.send(bridge, t.pid, text);
      if (r.ok && claude && btwPanel.isBtw(text)) btw.sent(s, consoleIo(t.pid), btwPanel.questionOf(text));
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
    // OpenCode's menus live in its terminal, not in the session API; only "interrupt" maps onto a key here
    if (String(id).startsWith('opencode:')) {
      if (key !== 'esc' && key !== 'btwfork') return { ok: false, msg: 'OpenCode 没有终端按键；直接发消息即可，Esc 用来中断' };
      if (key === 'btwfork') return { ok: false, msg: '不支持' };
      const r = await opencode.interrupt(id);
      if (!r.ok) return r;
      if (!wantScreen) return { ok: true };
      const sc = await opencode.screen(id);
      return { ok: true, screen: sc.ok ? sc.screen : undefined };
    }
    const ch = /^c:([^\x00-\x1f\x7f]{1,200})$/.exec(key);
    if (!KEYS.has(key) && !CTRL.test(key) && !ch && key !== 'btwfork') return { ok: false, msg: '不支持的按键' };
    const t = await terminalOf(sessions.get(id));
    if (t.msg) return { ok: false, msg: t.msg };
    if (!t.pid) return { ok: false, msg: '这个会话已经不在终端里运行，按键没有对象' };
    if (key === 'btwfork') return btw.fork(sessions.get(id), consoleIo(t.pid));   // "f" in the /btw overlay, while it is open
    const r = ch ? await bridge.type(t.pid, ch[1]) : await bridge.key(t.pid, key);
    if (!r.ok) return { ok: false, msg: '按键失败：' + r.err };
    if (key !== 'btab' && !wantScreen) return { ok: true };
    // Shift+Tab: the mode it switched to, read once from the redrawn status line (the transcript only records the
    // mode with the next message). (Text typed into a menu's search box: the list under it takes a little longer.)
    await sleep(ch && ch[1].length > 1 ? 700 : 350);
    const text = await bridge.screen(t.pid, hl);
    return { ok: true, mode: key === 'btab' && sessions.get(id).provider !== 'codex' && sessions.get(id).provider !== 'kiro' ? modeFromScreen(plainScreen(text)) : undefined, screen: wantScreen ? tidyScreen(text) || '' : undefined };
  }

  // what the session's terminal shows right now (asked for by you in the dashboard, never polled): Claude Code's own
  // menus and prompts are only there
  async function chatScreen(id, hl = false) {
    // OpenCode: the conversation the plugin mirrors, rendered as text (its TUI's own menus are not readable here)
    if (String(id).startsWith('opencode:')) return opencode.screen(id);
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
  // A Codex thread opened again in a window of ours. Codex runs no hook until the first message of the new window
  // (Claude Code's SessionStart comes at once), so nothing would say the thread is open: it stayed "历史" on the
  // dashboard, where a message can only be sent to an open session -- never to become one. It is put on the list here,
  // by the process we started.
  async function adoptCodex(id, pid, cwd) {
    const cpid = await codexCli.started(bridge, pid);
    if (!cpid) return;
    const t = Date.now();
    let s = sessions.get(id);
    if (s && s.claudePid && s.state !== 'ended') return;           // (its own hook came in meanwhile)
    if (!s) { s = { id, provider: 'codex', rawSession: id.slice(6), project: path.basename(cwd), cwd, lines: [], steps: 0, t0: t, born: t }; sessions.set(id, s); }
    Object.assign(s, { state: 'idle', last: t, dormant: false, claudePid: cpid, fromPid: null, headless: false, terminal: true });
    s.processIdentity = bridge.identity ? await bridge.identity(cpid) : null;
    require('./codex-sessions').remember(s, home());
    pushBubble(null);
  }

  // An OpenCode session opened again in a window of ours: the plugin registers it the moment it says anything.
  // Until then the dashboard keeps it as history, where a reply goes through the plugin anyway (chatSend above).
  async function adoptOpenCode(id, cwd) {
    for (let n = 0; n < 20; n++) {
      const m = opencode.metaOf(id);
      if (m) {
        const t = Date.now();
        let s = sessions.get(id);
        if (!s) { s = { id, provider: 'opencode', rawSession: opencode.rawId(id), project: path.basename(cwd), cwd, lines: [], steps: 0, t0: t, born: t }; sessions.set(id, s); }
        Object.assign(s, { state: 'idle', last: t, dormant: false, claudePid: m.pid, fromPid: null, headless: false, terminal: true, transcript: m.transcript, title: s.title || m.title });
        pushBubble(null);
        return;
      }
      await sleep(500);
    }
  }

  async function adoptAgy(id, pid, cwd) {
    const cpid = await agyCli.started(bridge, pid);
    if (!cpid) return;
    const t = Date.now();
    let s = sessions.get(id);
    if (s && s.claudePid && s.state !== 'ended') return;
    if (!s) { s = { id, provider: 'agy', rawSession: id.slice(4), project: path.basename(cwd), cwd, lines: [], steps: 0, t0: t, born: t }; sessions.set(id, s); }
    Object.assign(s, { state: 'idle', last: t, dormant: false, claudePid: cpid, fromPid: null, headless: false, terminal: true });
    s.processIdentity = bridge.identity ? await bridge.identity(cpid) : null;
    require('./agy-sessions').remember(s, home());
    pushBubble(null);
  }

  // A Kiro thread opened again in a window of ours. Kiro's agentSpawn hook fires at session start, but a resumed
  // session may run before the hook is wired; put it on the list by the process we started so a reply can reach it.
  async function adoptKiro(id, pid, cwd) {
    const cpid = await kiroCli.started(bridge, pid);
    if (!cpid) return;
    const t = Date.now();
    let s = sessions.get(id);
    if (s && s.claudePid && s.state !== 'ended') return;
    if (!s) { s = { id, provider: 'kiro', rawSession: id.slice(5), project: path.basename(cwd), cwd, lines: [], steps: 0, t0: t, born: t }; sessions.set(id, s); }
    Object.assign(s, { state: 'idle', last: t, dormant: false, claudePid: cpid, fromPid: null, headless: false, terminal: true });
    s.processIdentity = bridge.identity ? await bridge.identity(cpid) : null;
    require('./kiro-sessions').remember(s, home());
    pushBubble(null);
  }

  // resume: a past conversation's id -- `claude --resume <id>` there instead of a new session (its folder, from its
  // own transcript, is what the agent passes as cwd); a Codex thread's ("codex:<id>") -- `codex resume <id>`
  // tool: 'codex' | 'agy' -- a new Codex or Antigravity session instead of Claude Code's
  async function launch(cwd, prompt, resume = '', tool = 'claude', apiArg = null) {
    const thread = /^codex:/.test(resume) ? resume.slice(6) : '';
    const agyThread = /^agy:/.test(resume) ? resume.slice(4) : '';
    const kiroThread = /^kiro:/.test(resume) ? resume.slice(5) : '';
    const ocThread = /^opencode:/.test(resume) ? opencode.rawId(resume) : '';
    const openMode = !!ocThread || (!resume && tool === 'opencode');
    if (resume && !openMode && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(thread || agyThread || kiroThread || resume)) return { ok: false, msg: '无效请求' };
    if (resume && openMode && !opencode.isId(ocThread)) return { ok: false, msg: '无效请求' };
    if (resume) { const s = sessions.get(resume); if (s && s.claudePid && await procAlive(s.claudePid)) return { ok: false, msg: '这个会话还开着' }; }
    let st; try { st = fs.statSync(cwd); } catch { return { ok: false, msg: resume ? '这个会话原来的文件夹已经不在了：' + cwd : '找不到这个文件夹' }; }
    if (!st.isDirectory()) return { ok: false, msg: '这不是文件夹' };
    if (openMode) {
      // OpenCode's TUI in a new console window: -s <session> continues one, --prompt <text> starts with a message
      const spec = opencode.launchSpec({ resume: ocThread, prompt });
      if (!spec) return { ok: false, msg: '找不到 opencode' };
      const pid = await bridge.launch(spec.exe, spec.args, cwd);
      if (!pid) return { ok: false, msg: '启动失败' };
      if (ocThread) adoptOpenCode(resume, cwd).catch(() => {});
      return { ok: true, msg: resume ? '已在这台电脑上打开一个新的命令行窗口，接着这个 OpenCode 会话（第一次有动静后出现在列表里）' : '已在这台电脑上打开一个新的命令行窗口启动 OpenCode' };
    }
    const codex = !!thread || (!resume && tool === 'codex');
    const agy = !!agyThread || (!resume && tool === 'agy');
    const kiro = !!kiroThread || (!resume && tool === 'kiro');
    const cx = codex ? codexCli.command() : agy ? agyCli.command() : kiro ? kiroCli.command() : null;
    const exe = (codex || agy || kiro) ? cx && cx.exe : claudeExe();
    if (!exe) return { ok: false, msg: codex ? '找不到 codex' : agy ? '找不到 agy' : kiro ? '找不到 kiro-cli' : '找不到 claude.exe' };
    const api = (codex || agy || kiro) ? null : claudeApi.localApi(apiArg);
    if (!codex && !agy && !kiro && apiArg && !api) return { ok: false, msg: '这台电脑的本地启动入口不可用，请检查 cc-environments 配置' };
    const first = String(prompt || '').trim();
    // (Codex/agy/kiro first message is typed into it once it is up, not passed along: it may be started through
    // cmd.exe, where a sentence with quotes or an & in it does not survive as an argument)
    const args = thread ? [...cx.args, 'resume', thread] : codex ? [...cx.args]
      : agyThread ? [...cx.args, '--conversation', agyThread] : agy ? [...cx.args]
      : kiroThread ? [...cx.args, 'chat', '--resume-id', kiroThread] : kiro ? [...cx.args, 'chat']
      : [...(resume ? ['--resume', resume] : first ? [first] : [])];
    // ~/.ametyping/launch.ps1, when it is there, runs first in the new window (e.g. `proxy`, a function of your PowerShell
    // profile: the pet's own environment has no proxy set) -- Claude Code is then started from that PowerShell, as you
    // would by hand. (The Linux service has ~/.ametyping/launch.sh for the same.) The command goes in encoded: no quoting.
    const pre = path.join(home(), '.ametyping', 'launch.ps1');
    let pid;
    if (fs.existsSync(pre) || api) {
      const ps = (x) => "'" + String(x).replace(/'/g, "''") + "'";
      const preCmd = fs.existsSync(pre) && !api ? `. ${ps(pre)}; ` : '';
      const cmd = api ? createProfiles().windowCommand(api.id, cwd, args) : `${preCmd}& ${ps(exe)} ${args.map(ps).join(' ')}`;
      pid = await bridge.launch('powershell.exe', ['-NoLogo', ...(api ? ['-NoProfile', '-ExecutionPolicy', 'Bypass'] : []), '-NoExit', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')], cwd);
    } else pid = await bridge.launch(exe, args, cwd);
    if (!pid) return { ok: false, msg: '启动失败' };
    if (resume && api) { const s = sessions.get(resume); if (s) s.api = api.id; }
    if (codex) codexCli.greet(bridge, pid, thread ? '' : first).catch(() => {});
    else if (agy) agyCli.greet(bridge, pid, agyThread ? '' : first).catch(() => {});
    else if (kiro) kiroCli.greet(bridge, pid, kiroThread ? '' : first).catch(() => {});
    else answerTrust(pid);
    if (thread) adoptCodex(resume, pid, cwd).catch(() => {});
    if (agyThread) adoptAgy(resume, pid, cwd).catch(() => {});
    if (kiroThread) adoptKiro(resume, pid, cwd).catch(() => {});
    return { ok: true, msg: resume ? '已在这台电脑上打开一个新的命令行窗口，接着这个对话' : '已在这台电脑上打开一个新的命令行窗口启动（新文件夹会自动确认信任）' };
  }

  return { chatSend, chatKey, chatScreen, launch, KEYS, btwList: (s) => (s && s.btw && s.btw.length ? btw.list(s) : undefined) };
}

module.exports = { createRemoteControl };
