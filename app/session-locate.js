// Which process is a session, and does it sit in a terminal? Shared by the pet (main.js) and the Windows headless
// service (../headless/ame-headless-win.js).
'use strict';
const codexCli = require('./codex-cli');
const codexSessions = require('./codex-sessions');
const agyCli = require('./agy-cli');
const agySessions = require('./agy-sessions');
const kiroCli = require('./kiro-cli');
const kiroSessions = require('./kiro-sessions');
const { inTerminal } = require('./session-terminal');

const CLAUDE_EXE = /^(claude|node|bun)\.exe$/i;
const OPENCODE_EXE = /^opencode(\.exe)?$/i;
const TERM_HOSTS = /^(pwsh|powershell|cmd|bash|sh|zsh|fish|nu|elvish|xonsh|WindowsTerminal|OpenConsole|conhost|explorer|wezterm-gui|alacritty|mintty|Tabby|Hyper|ConEmu64|ConEmuC64|ConEmu|ConEmuC|wsl|wslhost|tmux)\.exe$/i;

const PROVIDER_LOCATORS = {
  codex: { find: codexCli.findCodex, registry: codexSessions },
  agy: { find: agyCli.findAgy, registry: agySessions },
  kiro: { find: kiroCli.findKiro, registry: kiroSessions },
};

function createLocator({ bridge, onChange = () => {} }) {
  async function locate(s, pid) {
    if (!s || !pid) return;
    const spec = PROVIDER_LOCATORS[s.provider];
    if (s.fromPid === pid && (!spec || s.processIdentity)) return;
    const chain = await bridge.ancestors(pid);
    if (spec) {
      const c = spec.find(chain, process.pid);
      if (!c) return;
      s.fromPid = pid;
      s.claudePid = c.pid;
      s.headless = c.own;
      s.terminal = !c.own && !!c.parent && TERM_HOSTS.test(c.parent.name);
      s.processIdentity = bridge.identity ? await bridge.identity(c.pid) : null;
      spec.registry.remember(s);
      return onChange();
    }
    const i = chain.findIndex((p) => CLAUDE_EXE.test(p.name));
    if (i < 0) return;
    s.fromPid = pid;
    s.claudePid = chain[i].pid;
    const parent = chain[i + 1];
    s.headless = !!parent && parent.pid === process.pid;
    s.terminal = await inTerminal({ parent, pid: s.claudePid, isTermHost: (n) => TERM_HOSTS.test(n), screen: (p) => bridge.screen(p) });
    onChange();
  }

  async function procAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; }
    const c = await bridge.ancestors(pid);
    if (!c.length) return true;
    const n = c[0].name;
    return CLAUDE_EXE.test(n) || codexCli.CODEX_EXE.test(n) || agyCli.AGY_EXE.test(n) || kiroCli.KIRO_EXE.test(n) || OPENCODE_EXE.test(n);
  }

  return { locate, procAlive };
}

module.exports = { CLAUDE_EXE, OPENCODE_EXE, TERM_HOSTS, createLocator };
