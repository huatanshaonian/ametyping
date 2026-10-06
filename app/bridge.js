// Client for console-bridge.ps1: one hidden powershell started on demand, commands answered in order.
// The script is handed over in an environment variable (read here, so it also works from inside the packaged
// app.asar): on the command line (-EncodedCommand) it has to stay under Windows' 32767 characters, which the script
// reaches at about 12 KB; a variable holds as much again as text, without the base64.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let ps = null, buf = '', queue = [], ready = null;

function start() {
  if (ps) return ready;
  const script = fs.readFileSync(path.join(__dirname, 'console-bridge.ps1'), 'utf8');
  // (a script that outgrew even that fails to start here, at once: every call then answers "bridge exited")
  try {
    ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', '$s = $env:AME_BRIDGE_PS; $env:AME_BRIDGE_PS = $null; Invoke-Expression $s'],
    { windowsHide: true, env: { ...process.env, AME_BRIDGE_PS: script } });
  } catch { ps = null; return Promise.resolve(); }
  ready = new Promise((res) => queue.push({ res, t: Date.now() }));      // the first line is "ready"
  ps.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const w = queue.shift(); if (w) w.res(line);
    }
  });
  ps.stderr.on('data', () => {});
  const dead = () => { ps = null; buf = ''; for (const w of queue.splice(0)) w.res('err bridge exited'); };
  ps.on('exit', dead); ps.on('error', dead);
  return ready;
}

async function call(cmd, timeout = 8000) {
  await start();
  if (!ps) return { ok: false, err: 'bridge exited' };
  const line = await new Promise((res) => {
    const w = { res };
    queue.push(w);
    ps.stdin.write(cmd + '\n');
    // a stuck command would shift every later answer onto the wrong caller: restart the bridge instead
    setTimeout(() => { if (queue.includes(w)) { try { ps.kill(); } catch {} } }, timeout);
  });
  return line.startsWith('ok') ? { ok: true, v: line.slice(3) } : { ok: false, err: line.slice(4) || line };
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
// one argument for a Windows command line (CommandLineToArgvW rules)
const winArg = (a) => (a && !/[\s"]/.test(a) ? a : '"' + String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"');

module.exports = {
  start,
  ancestors: async (pid) => {
    const r = await call(`anc ${pid | 0}`, 3000);
    return r.ok && r.v ? r.v.split('|').map((x) => { const [p, n] = x.split(':'); return { pid: +p, name: n || '' }; }) : [];
  },
  alive: async (pid) => { const r = await call(`alive ${pid | 0}`, 3000); return r.ok && r.v === '1'; },
  send: (pid, text) => call(`send ${pid | 0} ${b64(text)}`, 15000),
  // hl: with what is highlighted on the screen (a menu's current tab) between U+E000 and U+E001
  screen: async (pid, hl) => { const r = await call(`screen ${pid | 0}${hl ? ' hl' : ''}`, 5000); return r.ok ? Buffer.from(r.v || '', 'base64').toString('utf8') : null; },
  // start exe in a new console window (in cwd); resolves the pid or null
  launch: async (exe, args, cwd) => {
    const r = await call(`launch ${b64(JSON.stringify({ exe, args: args.map(winArg).join(' '), cwd }))}`, 10000);
    return r.ok ? +r.v : null;
  },
  // (typed without Enter: tests)
  type: (pid, text) => call(`type ${pid | 0} ${b64(text)}`, 15000),
  key: (pid, name) => (/^(up|down|left|right|enter|esc|tab|btab|bksp|ctrlxs|ctrl[abe-y]|clear)$/.test(name) ? call(`key ${pid | 0} ${name}`, 5000) : Promise.resolve({ ok: false, err: 'unknown key' })),
  stop: () => { try { ps && ps.stdin.end(); ps && ps.kill(); } catch {} ps = null; },
};
