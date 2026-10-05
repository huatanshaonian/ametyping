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

  // A session moved to the background (Claude Code's agent view): the daemon runs a copy of it (kind "bg", jobId)
  // and the terminal it came from stays as that copy's window (parkedJobId). The window is not a session of its own.
  const { lineage, listRunning } = require(R + '/app/running-sessions');
  const BG = '44444444-4444-4444-4444-444444444444', WIN = '55555555-5555-5555-5555-555555555555', OLD = '66666666-6666-6666-6666-666666666666';
  reg(104, BG, { kind: 'bg', jobId: '44444444' }); reg(105, WIN, { kind: 'interactive', parkedJobId: '44444444' });
  reg(106, OLD, { kind: 'interactive', parkedJobId: '99999999' });                 // parked on a job that is no more
  reg(107, '77777777-7777-7777-7777-777777777777', { kind: 'print' });              // a `claude -p` run
  let l = lineage(home);
  chk('the background session is marked, the terminal parked on it is its window', l.bg.has(BG) && l.bg.size === 1 && l.parked.has(WIN) && l.parked.size === 1, [[...l.bg], [...l.parked]]);
  chk('parked on a job that is gone: an ordinary session again', !l.parked.has(OLD), [...l.parked]);
  l = lineage(home, (pid) => pid !== 104);
  chk('the background session\'s process gone: nothing parked on it any more', l.bg.size === 0 && l.parked.size === 0, [[...l.bg], [...l.parked]]);
  const kinds = listRunning(home).map((r) => r.sessionId.slice(0, 2) + ':' + (r.kind || '-')).join();
  chk('sessions with Claude Code\'s interface are listed, background ones too; `claude -p` runs are not', /44:bg/.test(kinds) && /55:interactive/.test(kinds) && !/77:/.test(kinds), kinds);
  chains[104] = [{ pid: 104, name: 'claude.exe' }, { pid: 204, name: 'claude.exe' }]; chains[105] = [{ pid: 105, name: 'claude.exe' }, { pid: 205, name: 'pwsh.exe' }];
  chains[106] = [{ pid: 106, name: 'claude.exe' }, { pid: 206, name: 'pwsh.exe' }];
  bridge.screen = async (p) => (p === 101 || p === 104 ? TUI : null);
  const s2 = new Map();
  await adoptRunning({ sessions: s2, bridge, home, isClaude: (x) => /^claude\.exe$/i.test(x), isTerminal: isTermHost, onChange: () => {} });
  chk('found running: the background session taken on (in its own terminal), its parked window left out, the other one kept', s2.has(BG) && s2.get(BG).terminal === true && !s2.has(WIN) && s2.has(OLD), [...s2.keys()].map((k) => k.slice(0, 2)));
  fs.rmSync(path.join(home, '.claude', 'sessions'), { recursive: true, force: true });
  l = lineage(home);
  chk('no records at all (or another Claude Code that keeps none): nothing marked, nothing hidden', l.bg.size === 0 && l.parked.size === 0, 0);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  console.log(res.join('\n'));
})();
