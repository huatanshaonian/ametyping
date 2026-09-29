// Sounds for what happens on the machines: a new permission card anywhere, a session that finished its work.
// Only changes seen while the page is open count -- what is already there when it opens stays quiet.
import * as net from './net.js';
import * as sound from './sound.js';
import { isWorking } from './util.js';

let first = true;
const perms = new Set();                 // "machine|perm id" already seen
const working = new Set();               // "machine|session id" last seen working

net.on('sessions', (machines) => {
  let newPerm = false, finished = false;
  const nowPerms = new Set(), nowWorking = new Set();
  for (const m of machines) {
    for (const s of m.sessions) {
      const key = m.machine + '|' + s.id;
      for (const p of s.perms || []) { const k = m.machine + '|' + p.id; nowPerms.add(k); if (!perms.has(k)) newPerm = true; }
      if (isWorking(s.state)) nowWorking.add(key);
      else if (s.state === 'done' && working.has(key)) finished = true;
    }
  }
  perms.clear(); for (const k of nowPerms) perms.add(k);
  working.clear(); for (const k of nowWorking) working.add(k);
  if (first) { first = false; return; }
  if (newPerm) sound.play('perm');                    // one sound per update, the one that needs you first
  else if (finished) sound.play('done');
});
