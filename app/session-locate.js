// Which process is a session, and does it sit in a terminal? Shared by the pet (main.js) and the Windows headless
// service (../headless/ame-headless-win.js). The hook sends its parent pid; walk up to the Claude Code process
// (claude.exe, or node/bun for an npm install) and look at what started it: a shell or terminal = an interactive
// session we can type into; an IDE / the desktop app = no console to use; Claude Code itself = a background session in
// its own pseudo-terminal, usable all the same (session-terminal.js).
// A Codex session the same way, by its own process (codex-cli.js): Codex CLI in a terminal can be typed into, the
// desktop app cannot.
'use strict';
const codexCli = require('./codex-cli');
const { inTerminal } = require('./session-terminal');

const CLAUDE_EXE = /^(claude|node|bun)\.exe$/i;
const TERM_HOSTS = /^(pwsh|powershell|cmd|bash|sh|zsh|fish|nu|elvish|xonsh|WindowsTerminal|OpenConsole|conhost|explorer|wezterm-gui|alacritty|mintty|Tabby|Hyper|ConEmu64|ConEmuC64|ConEmu|ConEmuC|wsl|wslhost|tmux)\.exe$/i;

// bridge: the console bridge (bridge.js); onChange(): a session's terminal became known (the reply box may be usable)
function createLocator({ bridge, onChange = () => {} }) {
  async function locate(s, pid) {
    if (!s || !pid || s.fromPid === pid) return;
    const chain = await bridge.ancestors(pid);
    if (s.provider === 'codex') {
      const c = codexCli.findCodex(chain, process.pid);
      if (!c) return;
      s.fromPid = pid; s.claudePid = c.pid;
      s.headless = c.own;                                            // a `codex exec resume` we started ourselves
      s.terminal = !c.own && !!c.parent && TERM_HOSTS.test(c.parent.name);
      return onChange();
    }
    const i = chain.findIndex((p) => CLAUDE_EXE.test(p.name));
    if (i < 0) return;                                               // not found: try again on the next event
    s.fromPid = pid;
    s.claudePid = chain[i].pid;
    const parent = chain[i + 1];
    s.headless = !!parent && parent.pid === process.pid;             // a `claude -p --resume` we started ourselves
    s.terminal = await inTerminal({ parent, pid: s.claudePid, isTermHost: (n) => TERM_HOSTS.test(n), screen: (p) => bridge.screen(p) });
    onChange();
  }
  // "gone" must be certain: a session taken for ended is off the list (and "历史" on the dashboard) until its next hook.
  // The bridge not answering (its PowerShell slow or restarting gives an empty chain) says nothing about the process.
  async function procAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; }
    const c = await bridge.ancestors(pid);
    if (!c.length) return true;
    return CLAUDE_EXE.test(c[0].name) || codexCli.CODEX_EXE.test(c[0].name);   // same pid, still that process (not a reused pid)
  }
  return { locate, procAlive };
}

module.exports = { CLAUDE_EXE, TERM_HOSTS, createLocator };
