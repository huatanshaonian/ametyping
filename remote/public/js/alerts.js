// Sounds for what happens on the machines & collaborative mesh:
// - Permission prompt vs AI question (`perm` notify vs `ringin` telephone call)
// - Short turn vs genuine long task (`done` chimes vs `tada` fanfare, tracking active work time excluding `waiting` & sleep gaps + delta steps)
// - AmeMesh project all-tasks-done & Mini-Slurm HPC job completion (`tada`), watchdog/mention (`ringin`), file transfer completion (`ding`).
import * as net from './net.js';
import * as mesh from './mesh.js';
import * as sound from './sound.js';
import { isWorking } from './util.js';

const PERM_GRACE_MS = 1500;
const LONG_ACTIVE_MS = 180_000;          // >= 3 min of actual AI execution (excluding human waiting & laptop sleep)
const LONG_MIN_DELTA_STEPS = 8;          // >= 8 tool/reasoning steps in this run (prevents short follow-up in old chat from triggering tada)
const SUBAGENT_LONG_MS = 90_000;         // >= 1.5 min when orchestrating subagents
const MAX_TICK_GAP_MS = 30_000;          // clamp single tick gap so system sleep/wake never inflates active work time

let first = true;
const perms = new Set();                 // "machine|perm id" currently live
const announcedPerms = new Set();        // "machine|perm id" already sounded (or present on initial load)
const pendingPerms = new Map();          // "machine|perm id" -> grace timer
const askingKeys = new Set();            // "machine|session id" currently asking without perm card
// key -> { activeMs, lastTickAt, startSteps, maxSteps, hadAgents }
const activeWork = new Map();

export function classifyRunCompletion(rec, s) {
  if (!rec) return 'done';
  const curSteps = Number(s && s.steps) || 0;
  const maxSteps = Math.max(curSteps, rec.maxSteps || 0);
  const deltaSteps = Math.max(0, maxSteps - (rec.startSteps || 0));
  const hadAgents = Boolean(rec.hadAgents || (s && Array.isArray(s.agents) && s.agents.length > 0));
  if (rec.activeMs >= LONG_ACTIVE_MS && (deltaSteps >= LONG_MIN_DELTA_STEPS || hadAgents)) return 'tada';
  if (hadAgents && rec.activeMs >= SUBAGENT_LONG_MS && deltaSteps >= 4) return 'tada';
  return 'done';
}

net.on('sessions', (machines) => {
  const now = Date.now();
  let finishedSound = null;              // null | 'done' | 'tada' ('tada' wins over 'done')
  let ringIncoming = false;
  const nowPerms = new Set(), nowAsking = new Set(), seenWorkKeys = new Set();

  for (const m of machines) {
    for (const s of m.sessions) {
      const key = m.machine + '|' + s.id;
      let hasAskPerm = false;
      for (const p of s.perms || []) {
        if (p && p.ask) hasAskPerm = true;
        const k = m.machine + '|' + p.id;
        nowPerms.add(k);
        if (first) {
          announcedPerms.add(k);
        } else if (!announcedPerms.has(k) && !pendingPerms.has(k)) {
          const isAsk = Boolean(p && p.ask);
          pendingPerms.set(k, setTimeout(() => {
            pendingPerms.delete(k);
            if (!perms.has(k) || announcedPerms.has(k)) return;
            announcedPerms.add(k);
            sound.play(isAsk ? 'ringin' : 'perm');
            sound.buzz();
          }, isAsk ? 300 : PERM_GRACE_MS));
        }
      }
      if (s.asking && !hasAskPerm) {
        nowAsking.add(key);
        if (!first && !askingKeys.has(key)) ringIncoming = true;
      }

      const steps = Number(s.steps) || 0;
      const hasAgents = Array.isArray(s.agents) && s.agents.length > 0;
      if (isWorking(s.state)) {
        seenWorkKeys.add(key);
        const rec = activeWork.get(key);
        if (!rec) {
          activeWork.set(key, {
            activeMs: 0,
            lastTickAt: now,
            startSteps: steps,
            maxSteps: steps,
            hadAgents: hasAgents,
          });
        } else {
          const dt = Math.max(0, Math.min(now - rec.lastTickAt, MAX_TICK_GAP_MS));
          rec.activeMs += dt;
          rec.lastTickAt = now;
          if (steps > rec.maxSteps) rec.maxSteps = steps;
          if (hasAgents) rec.hadAgents = true;
        }
      } else if (s.state === 'waiting' && activeWork.has(key)) {
        // Freeze active timer while waiting on human confirmation/answer
        seenWorkKeys.add(key);
        const rec = activeWork.get(key);
        rec.lastTickAt = now;
        if (steps > rec.maxSteps) rec.maxSteps = steps;
        if (hasAgents) rec.hadAgents = true;
      } else if (s.state === 'done' && activeWork.has(key)) {
        const rec = activeWork.get(key);
        const dt = Math.max(0, Math.min(now - rec.lastTickAt, MAX_TICK_GAP_MS));
        rec.activeMs += dt;
        const kind = classifyRunCompletion(rec, s);
        if (kind === 'tada' || !finishedSound) finishedSound = kind;
      }
    }
  }

  for (const [k, timer] of pendingPerms) {
    if (!nowPerms.has(k)) { clearTimeout(timer); pendingPerms.delete(k); }
  }
  for (const k of announcedPerms) if (!nowPerms.has(k)) announcedPerms.delete(k);
  perms.clear(); for (const k of nowPerms) perms.add(k);
  askingKeys.clear(); for (const k of nowAsking) askingKeys.add(k);
  for (const k of [...activeWork.keys()]) if (!seenWorkKeys.has(k)) activeWork.delete(k);

  if (first) { first = false; return; }
  if (ringIncoming) { sound.play('ringin'); sound.buzz(); }
  if (finishedSound) sound.play(finishedSound);
});

// AmeMesh collaborative project milestones, incoming @master mentions/watchdog alerts, and file transfer completion
let meshInit = false;
const projPendingCounts = new Map();     // projectId -> number of unfinished tasks
const seenAlerts = new Set();            // "projectId|nodeId|code"
const seenMasterMentions = new Map();    // "projectId|nodeId" -> lastMentionedSeq
const doneTransfers = new Set();         // "projectId|transferId"

mesh.subscribe((projects) => {
  if (!Array.isArray(projects)) return;
  let playTada = false, playRingin = false, playDing = false;
  const liveAlerts = new Set();

  for (const p of projects) {
    const tasks = Array.isArray(p.tasks) ? p.tasks : [];
    const unfinished = tasks.filter((t) => t && t.status !== 'done').length;
    if (meshInit && tasks.length >= 2 && (projPendingCounts.get(p.id) || 0) > 0 && unfinished === 0) {
      playTada = true;
    }
    projPendingCounts.set(p.id, unfinished);

    for (const n of p.nodes || []) {
      if (n.archived) continue;
      if (n.watchdogAlert) {
        const ak = `${p.id}|${n.id}|${n.watchdogAlert.code || ''}`;
        liveAlerts.add(ak);
        if (meshInit && !seenAlerts.has(ak)) playRingin = true;
      }
      if (n.role === 'master') {
        const mk = `${p.id}|${n.id}`;
        const seq = Number(n.lastMentionedSeq) || 0;
        const prev = seenMasterMentions.get(mk);
        if (meshInit && prev != null && seq > prev) playRingin = true;
        seenMasterMentions.set(mk, seq);
      }
    }

    for (const tr of p.transfers || []) {
      const tk = `${p.id}|${tr.id}`;
      const isDone = tr && (tr.status === 'done' || tr.status === 'completed');
      if (isDone) {
        if (meshInit && !doneTransfers.has(tk)) playDing = true;
        doneTransfers.add(tk);
      }
    }
  }

  seenAlerts.clear(); for (const ak of liveAlerts) seenAlerts.add(ak);
  if (!meshInit) { if (projects.length) meshInit = true; return; }
  if (playTada) sound.play('tada');
  else if (playDing) sound.play('ding');
  if (playRingin) { sound.play('ringin'); sound.buzz(); }
});

// Mini-Slurm HPC compute queue: play tada when an active/queued compute job finishes with status === 'done'
let queueInit = false;
const activeJobIds = new Set();
async function checkQueueCompletion() {
  const d = await net.getJson('/api/mesh/queue');
  if (!d || !d.ok) return;
  const running = [...(d.running || []), ...(d.queued || [])];
  const history = d.history || [];
  let jobWon = false;
  if (queueInit) {
    for (const h of history) {
      if (h && activeJobIds.has(h.id) && (h.status === 'done' || h.exitCode === 0)) {
        jobWon = true;
      }
    }
  }
  activeJobIds.clear();
  for (const j of running) if (j && j.id) activeJobIds.add(j.id);
  queueInit = true;
  if (jobWon) sound.play('tada');
}
net.on('open', checkQueueCompletion);
net.on('mesh', checkQueueCompletion);
