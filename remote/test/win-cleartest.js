// manual check on Windows: Claude Code in a new console window; a draft typed "in the terminal" (one line, then two
// lines), then the bridge's clear (Ctrl+E Ctrl+U, Backspace Ctrl+U ...) -- the input box must be empty afterwards and
// the next text stand alone. Nothing is ever submitted (no Enter), so it costs nothing; the window is closed at the end.
//   node remote/test/win-cleartest.js [folder Claude Code already trusts]
const cp = require('child_process'), path = require('path'), os = require('os');
const bridge = require(path.resolve(__dirname, '../../app/bridge.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLAUDE = process.env.CLAUDE_EXE || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const DIR = process.argv[2] || path.resolve(__dirname, '../..');
// the input box: the lines between the two rules around the ❯ prompt
function box(screen) {
  const ls = (screen || '').split('\n'), i = ls.findIndex((l) => /^\s*❯/.test(l));
  if (i < 0) return '';
  let j = i; while (j + 1 < ls.length && !/^─{10}/.test(ls[j + 1])) j++;
  return ls.slice(i, j + 1).join(' | ');
}
(async () => {
  const pid = await bridge.launch(CLAUDE, [], DIR);
  if (!pid) { console.log('FAIL could not start', CLAUDE); process.exit(1); }
  const res = [];
  try {
    let s = '';
    for (let i = 0; i < 30; i++) { await sleep(500); s = await bridge.screen(pid) || ''; if (/❯/.test(s) && !/trust this folder/i.test(s)) break; }
    if (/trust this folder/i.test(s)) { console.log('FAIL this folder is not trusted yet: pick one Claude Code already trusts'); return; }
    for (const [name, draft] of [['one line', '终端里打了一半 halfway'], ['two lines', '第一行 firstline\n第二行 halfway']]) {
      await bridge.type(pid, draft);
      await sleep(900);
      const before = box(await bridge.screen(pid));
      await bridge.key(pid, 'clear');
      await sleep(900);
      const after = box(await bridge.screen(pid));
      await bridge.type(pid, 'Windose 的一整句');
      await sleep(900);
      const mine = box(await bridge.screen(pid));
      console.log(`${name}: typed ${JSON.stringify(before)}\n   after clear ${JSON.stringify(after)}\n   then ${JSON.stringify(mine)}`);
      const ok = before.includes('halfway') && !/halfway|firstline/.test(after) && mine.includes('Windose 的一整句') && !/halfway|firstline/.test(mine);
      res.push((ok ? 'PASS ' : 'FAIL ') + name + ': cleared, the next text stands alone');
      await bridge.key(pid, 'clear'); await sleep(500);                  // (empty again for the next case)
    }
  } finally {
    cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    bridge.stop();
    console.log(res.join('\n'));
  }
})();
