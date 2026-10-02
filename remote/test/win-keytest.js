// launches keytest.js in a new console, sends the seven keys through the pet's console bridge, prints what arrived
const cp = require('child_process'), path = require('path'), fs = require('fs');
const bridge = require(require('path').resolve(__dirname, '../../app/bridge.js'));
const SP = __dirname, LOG = path.join(SP, 'out', 'keytest.log');
fs.mkdirSync(path.join(SP, 'out'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // a new console window of its own (like a terminal Claude Code runs in)
  const ps = cp.spawnSync('powershell', ['-NoProfile', '-Command',
    `(Start-Process -FilePath '${process.execPath}' -ArgumentList '"${path.join(SP, 'win-keytest-target.js')}"','"${LOG}"' -PassThru).Id`]);
  const pid = +String(ps.stdout).trim();
  await sleep(1500);
  const expect = { up: '\u001b[A', down: '\u001b[B', right: '\u001b[C', left: '\u001b[D', enter: '\r', esc: '\u001b', tab: '\t' };
  const sent = [];
  for (const k of Object.keys(expect)) { const r = await bridge.key(pid, k); sent.push(`${k}:${r.ok ? 'ok' : r.err}`); await sleep(300); }
  const bad = await bridge.key(pid, 'pageup');
  await sleep(1500);
  bridge.stop();
  const got = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).join('');
  const want = Object.values(expect).join('');
  console.log('sent:', sent.join(' '), '| unknown key rejected:', !bad.ok);
  console.log('received:', JSON.stringify(got));
  console.log(got === want ? 'PASS all seven keys arrived as terminal sequences' : 'FAIL expected ' + JSON.stringify(want));
  process.exit(0);
})();
