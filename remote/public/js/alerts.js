// Sounds for what happens on the machines: a new permission card anywhere, a session that finished its work.
// Only changes seen while the page is open count -- what is already there when it opens stays quiet.
// New permission cards wait briefly (PERM_GRACE_MS) so prompts auto-approved by Codex auto_review stay silent.
import * as net from './net.js';
import * as sound from './sound.js';
import { isWorking } from './util.js';

const PERM_GRACE_MS = 1500;
let first = true;
const perms = new Set();                 // "machine|perm id" currently live
const announcedPerms = new Set();        // "machine|perm id" already sounded (or present on initial load)
const pendingPerms = new Map();          // "machine|perm id" -> grace timer
const working = new Set();               // "machine|session id" currently working (kept across waiting prompts)

net.on('sessions', (machines) => {
  let finished = false;
  const nowPerms = new Set(), nowWorking = new Set();
  for (const m of machines) {
    for (const s of m.sessions) {
      const key = m.machine + '|' + s.id;
      for (const p of s.perms || []) {
        const k = m.machine + '|' + p.id;
        nowPerms.add(k);
        if (first) {
          announcedPerms.add(k);
        } else if (!announcedPerms.has(k) && !pendingPerms.has(k)) {
          pendingPerms.set(k, setTimeout(() => {
            pendingPerms.delete(k);
            if (!perms.has(k) || announcedPerms.has(k)) return;
            announcedPerms.add(k);
            sound.play('perm'); sound.buzz();
          }, PERM_GRACE_MS));
        }
      }
      if (isWorking(s.state) || (s.state === 'waiting' && working.has(key))) nowWorking.add(key);
      else if (s.state === 'done' && working.has(key)) finished = true;
    }
  }
  for (const [k, timer] of pendingPerms) {
    if (!nowPerms.has(k)) { clearTimeout(timer); pendingPerms.delete(k); }
  }
  for (const k of announcedPerms) if (!nowPerms.has(k)) announcedPerms.delete(k);
  perms.clear(); for (const k of nowPerms) perms.add(k);
  working.clear(); for (const k of nowWorking) working.add(k);
  if (first) { first = false; return; }
  if (finished) sound.play('done');
});
