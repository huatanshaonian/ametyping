'use strict';
// Session table, transcript chat polling, permission cards, and loopback HTTP server (127.0.0.1:3940) for app/main.js.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createRemoteControl } = require('./remote-control');
const { createLocator } = require('./session-locate');
const { lineage } = require('./running-sessions');
const transcript = require('./transcript');
const codexRecords = require('./codex-records');
const codexSessions = require('./codex-sessions');
const opencodeRecords = require('./opencode-records');
const agyRecords = require('./agy-records');
const agySessions = require('./agy-sessions');
const kiroRecords = require('./kiro-records');
const kiroSessions = require('./kiro-sessions');
const { createPermissions } = require('./permissions');
const { normalizeSession } = require('./session-source');
const { PERM_END, createControlGuard, createCliUpdateTracker } = require('./control-guard');

const WORKING = new Set(['message', 'thinking', 'reading', 'error']);
const STALE_WORK_MS = 10 * 60e3, WAIT_SHOW_MS = 10 * 60e3, AUTOHIDE_MS = 25e3;
const KEEP_MS = +process.env.AME_KEEP_MS || 20 * 60e3;
const ALIVE_CHECK_MS = +process.env.AME_ALIVE_CHECK_MS || 30 * 60e3;
const GONE_CHECK_MS = 2 * 60e3;
const CHAT_KEEP_MS = 12 * 3600e3;

const apiId = (v) => (typeof v === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(v) ? v : '');
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function createSessionRuntime({
  app,
  ipcMain,
  screen,
  port,
  settings,
  bridge,
  getWin,
  getBubbleWin,
  chatMode,
  folded,
  placeBubble,
  hideBubble,
  sendPanel,
  keepAmeOnTop,
  morning,
  mailNotice,
  quotaNotice,
}) {
  const sessions = new Map();
  const chats = new Map();
  let chatSel = null;
  let hideTimer = null;

  function sessionLabel(s) {
    if (s.title) return s.title;
    const same = [...sessions.values()].filter((o) => o.provider === s.provider && o.project === s.project && !o.title);
    const base = s.project || (s.provider === 'codex' ? 'Codex' : s.provider === 'opencode' ? 'OpenCode' : s.provider === 'agy' ? 'Antigravity' : s.provider === 'kiro' ? 'Kiro' : 'Claude');
    return same.length > 1 ? `${base} #${String(s.rawSession || s.id).slice(0, 4)}` : base;
  }

  let lineageAt = 0, lineageNow = { bg: new Set(), parked: new Set() };
  function sessionLineage() {
    if (Date.now() - lineageAt > 3000) {
      lineageAt = Date.now();
      try { lineageNow = lineage(app.getPath('home'), pidAlive); } catch {}
    }
    return lineageNow;
  }

  const listed = () => {
    const { parked } = sessionLineage();
    return [...sessions.values()].filter((s) => !parked.has(s.id));
  };

  function replyVia(s) {
    if (s.state === 'ended') return 'resume';
    if (s.headless) return 'busy';
    if (s.provider === 'opencode') return s.claudePid ? 'terminal' : 'unknown';
    if (s.claudePid && s.terminal) return 'terminal';
    return s.claudePid ? 'none' : 'unknown';
  }

  const permissions = createPermissions((sid, end) => {
    const s = sessions.get(sid), say = end && PERM_END[end.why];
    if (say && s && s.state === 'waiting' && !permissions.list(sid).length) onClaudeEvent('thinking', { session: sid, text: `${say(end)}：${end.tool}` });
    else pushBubble(null);
  });

  ipcMain.handle('permission-decide', (e, id, choice, extra) => {
    const bubbleWin = getBubbleWin();
    if (!bubbleWin || bubbleWin.isDestroyed() || e.sender !== bubbleWin.webContents) return { ok: false };
    return { ok: permissions.decide(id, choice, extra) };
  });
  app.on('before-quit', () => permissions.clear());

  function pushBubble(changedId) {
    const bubbleWin = getBubbleWin();
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    const list = listed().sort((x, y) => x.born - y.born).map((s) => ({
      id: s.id, label: sessionLabel(s), project: s.project, state: s.state, lines: s.lines, steps: s.steps, t0: s.t0, last: s.last, bg: sessionLineage().bg.has(s.id),
      provider: s.provider, via: replyVia(s), permissions: permissions.list(s.id), ai: s.ai || undefined, model: s.model || undefined,
    }));
    sendPanel();
    if (!list.length && !chatMode()) { hideBubble(); return; }
    bubbleWin.webContents.send('bubble-state', { sessions: list, changedId, mode: settings.panelMode, sound: settings.petSound !== false });
    if (changedId && settings.panelMode !== 'off') {
      placeBubble();
      if (!folded() && !bubbleWin.isVisible()) bubbleWin.showInactive();
      keepAmeOnTop();
    }
    clearTimeout(hideTimer);
    if (!chatMode() && !list.some((s) => WORKING.has(s.state) || s.state === 'waiting' || s.permissions.length)) {
      hideTimer = setTimeout(function check() {
        const bw = getBubbleWin();
        if (!bw || bw.isDestroyed()) return;
        const c = screen.getCursorScreenPoint(), bb = bw.getBounds();
        const over = c.x >= bb.x && c.x < bb.x + bb.width && c.y >= bb.y && c.y < bb.y + bb.height;
        if (over) hideTimer = setTimeout(check, 3000); else hideBubble();
      }, AUTOHIDE_MS);
    }
  }

  const anyWorking = (exceptId) => [...sessions.values()].some((s) => s.id !== exceptId && WORKING.has(s.state));
  const { locate: locateSession, procAlive } = createLocator({ bridge, onChange: () => pushBubble(null) });

  function onClaudeEvent(type, d) {
    const win = getWin();
    const id = d.session || 'unknown', t = Date.now();
    if (type === 'quit') {
      const q = sessions.get(id);
      if (q && q.provider === 'codex') codexSessions.forget(q.rawSession);
      if (q && q.provider === 'agy') agySessions.forget(q.rawSession);
      if (q && q.provider === 'kiro') kiroSessions.forget(q.rawSession);
      if (chatMode() && q) { q.state = 'ended'; q.claudePid = null; q.headless = false; q.fromPid = null; q.last = t; }
      else sessions.delete(id);
      if (win && !win.isDestroyed() && ![...sessions.values()].some((s) => WORKING.has(s.state))) win.webContents.send('claude', 'idle');
      return pushBubble(null);
    }
    let s = sessions.get(id);
    if (!s) {
      s = { id, provider: d.provider || 'claude', rawSession: d.rawSession || id, project: '', state: 'idle', lines: [], steps: 0, t0: t, last: t, born: t };
      sessions.set(id, s);
    }
    s.dormant = false;
    if (d.project && !((d.provider === 'codex' || d.provider === 'agy') && d.agentId)) s.project = String(d.project).slice(0, 40);
    if (d.title) s.title = String(d.title).slice(0, 60);
    if (d.transcript) s.transcript = String(d.transcript);
    if (d.cwd && !((d.provider === 'codex' || d.provider === 'agy') && d.agentId)) s.cwd = String(d.cwd);
    if (d.model) s.model = d.model;
    if (d.ai) s.ai = d.ai;
    if (s.provider === 'agy' && !d.model && s.transcript && !(s.modelReadAt > t - 15000)) {
      s.modelReadAt = t;
      try { const m = agyRecords.metaOf(s.transcript); if (m && m.model) { s.model = m.model; s.ai = m.ai || s.ai; } } catch {}
    }
    if (apiId(d.api)) s.api = apiId(d.api);
    if (s.provider === 'opencode' && Number.isInteger(d.pid) && d.pid > 0) {
      s.claudePid = d.pid; s.fromPid = null; s.headless = false; s.terminal = true;
    }
    codexSessions.remember(s);
    agySessions.remember(s);
    kiroSessions.remember(s);
    if (type === 'meta') { s.last = t; pushBubble(null); return; }
    if (type === 'idle') { s.last = t; if (s.state === 'ended') s.state = 'idle'; return pushBubble(null); }
    if (type === 'message' || s.state === 'done') { s.steps = 0; s.t0 = t; if (type === 'message' && s.lines.length) s.lines.push({ sep: true, t }); }
    if (type === 'thinking' || type === 'reading') s.steps++;
    s.state = type; s.last = t;
    const text = d.text ? String(d.text).slice(0, 300) : '';
    const lastLine = s.lines[s.lines.length - 1];
    if (text && !(lastLine && lastLine.text === text)) s.lines.push({ text, t, type });
    s.lines = s.lines.slice(-60);
    if (win && !win.isDestroyed()) {
      if (type === 'done') win.webContents.send('claude', anyWorking(id) ? 'done-partial' : 'done');
      else if (type === 'waiting') win.webContents.send('claude', 'waiting');
      else win.webContents.send('claude', type === 'paused' ? (anyWorking(id) ? 'thinking' : 'idle') : type);
    }
    if (text || type === 'done') pushBubble(id);
  }

  // Expire stale states and drop long-inactive sessions
  setInterval(() => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    const t = Date.now();
    let changed = false;
    for (const [id, s] of sessions) {
      if (WORKING.has(s.state) && t - s.last > STALE_WORK_MS) { s.state = 'idle'; changed = true; }
      if (s.claudePid && !s.headless && !s.checking && s.state !== 'ended' && t - s.last > 60e3 && t - (s.aliveAt || 0) > GONE_CHECK_MS) {
        s.checking = true; s.aliveAt = t;
        procAlive(s.claudePid).then((alive) => {
          s.checking = false;
          if (!alive && sessions.get(id) === s) {
            permissions.advance({ session: id, hookEvent: 'SessionEnd' });
            onClaudeEvent('quit', { session: id });
          }
        });
      }
      if (s.state === 'waiting' && t - s.last > WAIT_SHOW_MS && !permissions.list(id).length) { s.state = 'idle'; changed = true; }
      if (t - s.last > (chatMode() ? CHAT_KEEP_MS : KEEP_MS) && !s.dormant && !s.checking) {
        if (!s.claudePid) { sessions.delete(id); chats.delete(id); changed = true; continue; }
        s.checking = true;
        procAlive(s.claudePid).then((alive) => {
          s.checking = false;
          if (sessions.get(id) !== s) return;
          if (alive) { s.dormant = true; s.aliveAt = Date.now(); } else { sessions.delete(id); chats.delete(id); }
          pushBubble(null);
        });
      }
      if (s.dormant && s.claudePid && !s.checking && t - (s.aliveAt || 0) > ALIVE_CHECK_MS) {
        s.checking = true; s.aliveAt = t;
        procAlive(s.claudePid).then((alive) => {
          s.checking = false;
          if (!alive && sessions.get(id) === s) { sessions.delete(id); chats.delete(id); pushBubble(null); }
        });
      }
    }
    if (changed) {
      if (![...sessions.values()].some((s) => WORKING.has(s.state))) win.webContents.send('claude', 'idle');
      pushBubble(null);
    }
  }, 5000);

  // ---- Chat mode: full conversation + /btw replies ----
  function findTranscript(id) {
    const root = path.join(app.getPath('home'), '.claude', 'projects');
    try {
      for (const d of fs.readdirSync(root)) {
        const f = path.join(root, d, `${id}.jsonl`);
        if (fs.existsSync(f)) return f;
      }
    } catch {}
    return null;
  }

  const PROVIDER_RECORDS = {
    codex: codexRecords,
    opencode: opencodeRecords,
    agy: agyRecords,
    kiro: kiroRecords,
  };

  function pushChat(force) {
    const bubbleWin = getBubbleWin();
    const s = chatSel && sessions.get(chatSel);
    if (!s || !chatMode() || !bubbleWin || bubbleWin.isDestroyed() || !bubbleWin.isVisible()) return;
    const recMod = PROVIDER_RECORDS[s.provider];
    if (recMod && !s.transcript && Date.now() - (s.lookedAt || 0) > 5000) {
      s.lookedAt = Date.now();
      s.transcript = recMod.fileOf(s.rawSession);
      const title = recMod.titleOf(s.rawSession);
      if (title && !s.title) { s.title = title.slice(0, 60); pushBubble(null); }
    }
    if (recMod && !s.transcript) {
      if (force || s.chatPushed !== s.last) {
        s.chatPushed = s.last;
        const banner = s.provider === 'codex' ? 'Codex 实时进度' : s.provider === 'opencode' ? 'OpenCode 实时进度' : s.provider === 'agy' ? 'Antigravity 实时进度' : 'Kiro 实时进度';
        bubbleWin.webContents.send('chat-log', {
          id: s.id,
          msgs: [
            { role: 'sys', text: banner, t: s.born },
            ...s.lines.filter((l) => !l.sep).map((l) => ({ role: 'sys', text: l.text, t: l.t })),
          ],
        });
      }
      return;
    }
    if (!s.transcript && s.provider === 'claude') s.transcript = findTranscript(s.id);
    if (!s.transcript) return;
    let c = chats.get(s.id);
    if (!c || c.file !== s.transcript) { c = { file: s.transcript }; chats.set(s.id, c); }
    let changed = false;
    try { changed = transcript.poll(c, recMod ? recMod.recordsOf : undefined); } catch (e) { console.error('transcript: ' + e.message); }
    if (c.title && !s.title) { s.title = String(c.title).slice(0, 60); pushBubble(null); }
    if ((changed || force) && c.msgs) bubbleWin.webContents.send('chat-log', { id: s.id, msgs: c.msgs.slice(-200) });
  }
  setInterval(() => pushChat(false), 1000);

  function btwToChat(s, it) {
    const bubbleWin = getBubbleWin();
    const c = chats.get(s.id);
    if (!c || !c.msgs) return;
    const add = [];
    if (!it.shownQ) { it.shownQ = true; add.push({ role: 'user', text: '/btw ' + it.q, t: it.t }); (c.msgs.btwAsked = c.msgs.btwAsked || new Set()).add('/btw ' + it.q); }
    if (it.a && !it.shownA) { it.shownA = true; add.push({ role: 'btw', text: it.a, t: it.ta }); }
    if (!add.length) return;
    transcript.mergeRecords(c.msgs, add);
    if (chatSel === s.id && bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.webContents.send('chat-log', { id: s.id, msgs: c.msgs.slice(-200) });
  }
  ipcMain.on('chat-select', (_e, id) => { chatSel = id; pushChat(true); });

  const cliUpdates = createCliUpdateTracker();
  const { chatSend, chatKey, chatScreen, launch, btwList } = createRemoteControl({
    sessions,
    permissions,
    bridge,
    procAlive,
    pushBubble,
    home: () => app.getPath('home'),
    onBtw: btwToChat,
    onCliUpdate: cliUpdates.record,
  });
  ipcMain.handle('chat-send', (_e, id, text) => (String(text || '').trim() ? chatSend(id, String(text)) : { ok: false, msg: '' }));

  // ---- Control & Hook HTTP server ----
  const { writeToken, removeToken, controlOk } = createControlGuard(port, () => app.getPath('home'));
  app.on('will-quit', removeToken);

  function controlState() {
    return listed().sort((x, y) => x.born - y.born).map((s) => ({
      id: s.id, label: sessionLabel(s), project: s.project, provider: s.provider, state: s.state, via: replyVia(s), bg: sessionLineage().bg.has(s.id),
      t0: s.t0, last: s.last, lines: s.lines.filter((l) => !l.sep).slice(-8), btw: btwList(s), api: s.api || undefined,
      ai: s.ai || undefined, model: s.model || undefined,
      perms: permissions.list(s.id).map((p) => ({
        id: p.id, provider: p.provider, tool: p.tool, cwd: p.cwd, subagent: p.subagent, always: p.always, ask: p.ask || undefined,
        input: JSON.stringify(p.input || {}, null, 2).slice(0, 8000),
      })),
    }));
  }

  async function onControl(req, res, body) {
    const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!controlOk(req)) return out(403, { ok: false });
    if (req.method === 'GET' && req.url === '/control/state') {
      return out(200, { control: !!settings.remoteControl, sessions: controlState(), cliUpdates: cliUpdates.values() });
    }
    let d = {};
    try { d = JSON.parse(body || '{}'); } catch {}
    if (req.method === 'POST' && req.url === '/control/report') return out(200, { ok: morning().setNote(d) });
    if (req.method === 'POST' && req.url === '/control/quota') return out(200, { ok: quotaNotice().add(d) });
    if (req.method === 'POST' && req.url === '/control/mail') return out(200, { ok: mailNotice().add(d) });
    if (req.method === 'POST' && req.url === '/control/title') {
      const s = typeof d.id === 'string' && sessions.get(d.id), t = typeof d.title === 'string' ? d.title.trim().slice(0, 60) : '';
      if (s && t && t !== s.title) { s.title = t; pushBubble(null); }
      return out(200, { ok: !!s });
    }
    if (!settings.remoteControl) return out(200, { ok: false, msg: '糖糖菜单里没勾「允许远程控制」' });
    if (req.method === 'POST' && req.url === '/control/send') {
      const text = typeof d.text === 'string' ? d.text : '';
      if (typeof d.id !== 'string' || !text.trim() || text.length > 8000) return out(400, { ok: false, msg: '内容为空或太长' });
      return out(200, await chatSend(d.id, text));
    }
    if (req.method === 'POST' && req.url === '/control/key') {
      if (typeof d.id !== 'string' || typeof d.key !== 'string') return out(400, { ok: false, msg: '无效请求' });
      return out(200, await chatKey(d.id, d.key, d.screen === true, d.hl === true));
    }
    if (req.method === 'POST' && req.url === '/control/screen') {
      if (typeof d.id !== 'string') return out(400, { ok: false, msg: '无效请求' });
      return out(200, await chatScreen(d.id, d.hl === true));
    }
    if (req.method === 'POST' && req.url === '/control/launch') {
      if (typeof d.cwd !== 'string' || !d.cwd || (d.prompt != null && typeof d.prompt !== 'string')) return out(400, { ok: false, msg: '无效请求' });
      return out(200, await launch(d.cwd, d.prompt || '', typeof d.resume === 'string' ? d.resume : '', ['codex', 'opencode', 'agy', 'kiro'].includes(d.tool) ? d.tool : 'claude', d.api, d.meshEnv, d.model));
    }
    if (req.method === 'POST' && req.url === '/control/decide') {
      if (typeof d.session !== 'string' || !permissions.list(d.session).some((p) => p.id === d.id)) return out(200, { ok: false, msg: '这个确认已经结束了' });
      return out(200, permissions.decide(d.id, d.choice, { answers: d.answers }) ? { ok: true } : { ok: false, msg: '请求已结束' });
    }
    return out(404, { ok: false });
  }

  http.createServer((req, res) => {
    const m = req.method === 'POST' && /^\/event\/([a-z]+)$/.exec(req.url);
    const permission = req.method === 'POST' && req.url === '/permission';
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > (permission ? 2e6 : 20000)) req.destroy(); });
    req.on('end', async () => {
      if (req.url.startsWith('/control/')) return onControl(req, res, body).catch(() => { try { res.writeHead(500); res.end('{}'); } catch {} });
      let d = {};
      try { d = JSON.parse(body || '{}'); } catch {}
      if (!d || typeof d !== 'object' || Array.isArray(d)) d = {};
      d = normalizeSession(d);
      const win = getWin();
      const bubbleWin = getBubbleWin();
      if (permission) {
        if (!win || win.isDestroyed() || !bubbleWin || bubbleWin.isDestroyed()) { res.end('{}'); return; }
        if (typeof d.session !== 'string' || !d.session || typeof d.tool !== 'string' || !d.tool) {
          res.writeHead(400); res.end('{}'); return;
        }
        permissions.add(d, res);
        onClaudeEvent('waiting', { ...d, text: `需要确认：${d.tool}` });
        pushBubble(d.session);
        if (d.pid && d.provider !== 'opencode') locateSession(sessions.get(d.session), d.pid).catch(() => {});
        return;
      }
      if (m) permissions.advance(d);
      if (m && d.pid && win && !win.isDestroyed()) {
        const id = d.session || 'unknown';
        let s = sessions.get(id);
        if (!s) { onClaudeEvent('idle', { ...d, session: id }); s = sessions.get(id); }
        if (s && s.provider !== 'opencode') await Promise.race([locateSession(s, d.pid).catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
      }
      res.writeHead(m ? 200 : 404); res.end();
      if (!m || !win || win.isDestroyed()) return;
      onClaudeEvent(m[1], d);
    });
  }).on('error', () => {}).listen(port, '127.0.0.1', () => {
    try { writeToken(); } catch (e) { console.error('control token: ' + e.message); }
  });

  return { sessions, pushBubble, onClaudeEvent };
}

module.exports = { createSessionRuntime };
