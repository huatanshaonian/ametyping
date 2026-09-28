// Client for console-bridge.ps1: one hidden powershell started on demand, commands answered in order.
// The script is passed with -EncodedCommand so it also works from inside the packaged app.asar.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let ps = null, buf = '', queue = [], ready = null;

function start() {
  if (ps) return ready;
  const script = fs.readFileSync(path.join(__dirname, 'console-bridge.ps1'), 'utf8');
  ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
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

module.exports = {
  start,
  ancestors: async (pid) => {
    const r = await call(`anc ${pid | 0}`, 3000);
    return r.ok && r.v ? r.v.split('|').map((x) => { const [p, n] = x.split(':'); return { pid: +p, name: n || '' }; }) : [];
  },
  alive: async (pid) => { const r = await call(`alive ${pid | 0}`, 3000); return r.ok && r.v === '1'; },
  send: (pid, text) => call(`send ${pid | 0} ${b64(text)}`, 15000),
  stop: () => { try { ps && ps.stdin.end(); ps && ps.kill(); } catch {} ps = null; },
};
