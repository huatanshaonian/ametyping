// Is a Claude Code session in a terminal the pet can type into (app/session-terminal.js)? Started by a shell or a
// terminal program: yes. Started by Claude Code itself -- a background session in the daemon's pseudo-terminal: yes
// when its screen shows Claude Code's interface; the desktop app ("Claude.exe" as well) and the IDE plugin, which
// give it no terminal: no. And sessions found already running take the same answer (app/session-adopt.js).
const path = require('path'), fs = require('fs'), os = require('os');
const R = path.resolve(__dirname, '..', '..');
const { inTerminal } = require(R + '/app/session-terminal');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
const isTermHost = (n) => /^(pwsh|powershell|cmd|WindowsTerminal|conhost|explorer)\.exe$/i.test(n);
const TUI = '● 好的\n' + '─'.repeat(60) + '\n❯ \n' + '─'.repeat(60) + '\n  ⏵⏵ auto mode on (shift+tab to cycle)';

(async () => {
  let reads = 0;
  const ask = (parent, text) => inTerminal({ parent, pid: 1, isTermHost, screen: async () => { reads++; if (text instanceof Error) throw text; return text; } });
  chk('started by a shell: a terminal, the screen not even read', await ask({ pid: 2, name: 'pwsh.exe' }, null) === true && reads === 0, reads);
  chk('started by Windows Terminal', await ask({ pid: 2, name: 'WindowsTerminal.exe' }, null) === true, 0);
  chk('a background session (started by claude.exe) showing Claude Code\'s interface: a terminal', await ask({ pid: 2, name: 'claude.exe' }, TUI) === true && reads === 1, reads);
  chk('started by Claude.exe without a console (the desktop app): not a terminal', await ask({ pid: 2, name: 'Claude.exe' }, null) === false, 0);
  chk('started by claude.exe with a console that shows something else: not a terminal', await ask({ pid: 2, name: 'claude.exe' }, 'C:\\> node server.js\nlistening') === false, 0);
  chk('the screen cannot be read (an error): not a terminal', await ask({ pid: 2, name: 'claude.exe' }, new Error('x')) === false, 0);
  reads = 0;
  chk('started by an IDE: not a terminal, the screen not read', await ask({ pid: 2, name: 'Code.exe' }, TUI) === false && reads === 0, reads);
  chk('what started it unknown: not a terminal', await ask(null, TUI) === false, 0);

  // sessions already running when the pet starts (the registry Claude Code keeps in ~/.claude/sessions)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-sterm-'));
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const reg = (pid, id, extra = {}) => fs.writeFileSync(path.join(home, '.claude', 'sessions', pid + '.json'), JSON.stringify({ pid, sessionId: id, cwd: 'D:\\proj', startedAt: Date.now(), ...extra }));
  reg(101, '11111111-1111-1111-1111-111111111111'); reg(102, '22222222-2222-2222-2222-222222222222'); reg(103, '33333333-3333-3333-3333-333333333333');
  const chains = { 101: [{ pid: 101, name: 'claude.exe' }, { pid: 201, name: 'claude.exe' }, { pid: 301, name: 'claude.exe' }],      // the daemon's
    102: [{ pid: 102, name: 'claude.exe' }, { pid: 202, name: 'Claude.exe' }], 103: [{ pid: 103, name: 'claude.exe' }, { pid: 203, name: 'pwsh.exe' }] };
  const bridge = { ancestors: async (p) => chains[p] || [], screen: async (p) => (p === 101 ? TUI : null) };
  const sessions = new Map();
  const { adoptRunning } = require(R + '/app/session-adopt');
  const n = await adoptRunning({ sessions, bridge, home, isClaude: (x) => /^claude\.exe$/i.test(x), isTerminal: isTermHost, onChange: () => {} });
  const t = (id) => (sessions.get(id) || {}).terminal;
  chk('found running: the background session and the one in a shell are in a terminal, the desktop app\'s is not', n === 3 && t('11111111-1111-1111-1111-111111111111') === true &&
    t('22222222-2222-2222-2222-222222222222') === false && t('33333333-3333-3333-3333-333333333333') === true, [n, [...sessions.values()].map((s) => [s.id.slice(0, 4), s.terminal])]);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  console.log(res.join('\n'));
})();
