// AmeTyping's OpenCode plugin (server part).
//
// OpenCode's server knows every session, its messages and its permission prompts, so this plugin needs neither
// terminal scraping nor a hook process. It:
//   * forwards session progress to Ame's local service (127.0.0.1:3940, the same /event endpoints the Claude Code
//     and Codex hooks use), so the pet panel and the Windose dashboard show OpenCode sessions like the others;
//   * appends the conversation to ~/.ametyping/opencode/sessions/<id>.jsonl in the slim record format the dashboard
//     archives (what you and the model said in full, each tool call one line, tool output left out);
//   * offers a loopback control endpoint so Ame can reply into a session, interrupt it, or read its conversation;
//   * asks Ame about permission prompts and answers them through ctx.permission.reply -- the terminal asks at the
//     same time, and either side can answer.
//
// Install with `node install-opencode-plugin.js` (adds this directory to ~/.config/opencode/opencode.json).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { recordsForMessages, mapEvent, screenText, toolLine, projectOf, cut } from './protocol.js';

const AME_PORT = +process.env.AME_PORT || 3940;
const HOME = os.homedir();
const ROOT = process.env.OPENCODE_AME_HOME || path.join(HOME, '.ametyping', 'opencode');
const SESSIONS = path.join(ROOT, 'sessions');
const BRIDGES = path.join(ROOT, 'bridges');
const PERMISSION_WAIT = 3610e3;   // Ame's card waits an hour; outlive it a little
// the stream carries a delta for every token: only these say something Ame acts on (the mirror is refreshed after them)
const WATCH = new Set([
  'session.created', 'session.inbox.delivered', 'session.execution.started', 'session.execution.succeeded',
  'session.execution.failed', 'session.execution.interrupted', 'session.compaction.started', 'session.compaction.ended',
  'session.retry.scheduled', 'session.status', 'session.text.ended', 'session.tool.called', 'session.tool.success',
  'session.tool.failed', 'session.renamed', 'session.deleted', 'session.idle', 'permission.asked', 'permission.replied',
]);
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function writeJson(file, value, mode = 0o600) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode });
    fs.renameSync(tmp, file);
  } catch {}
}
function append(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
  } catch {}
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}

export default {
  id: 'ametyping',
  async setup(ctx) {
    const directory = (ctx.location && ctx.location.directory)
      || (ctx.location && ctx.location.project && ctx.location.project.canonical) || process.cwd();
    const location = norm(directory);
    const token = crypto.randomBytes(32).toString('hex');
    const bridgeId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const state = new Map();          // sessionID -> per-session bookkeeping
    const childSessions = new Set();  // child sessions (subagents): their tool calls are the parent's progress
    const eventsSeen = new Set();     // de-duplicated event ids (a plugin can be loaded more than once per location)
    const eventOrder = [];

    // ---------- one session's local files and cached messages ----------
    const mirrorOf = (id) => path.join(SESSIONS, `${id}.jsonl`);
    const metaOf = (id) => path.join(SESSIONS, `${id}.json`);
    const sessionState = (id) => {
      let s = state.get(id);
      if (s) return s;
      s = { id, seen: new Set(), timer: null, msgs: null, lastText: '', doneAt: 0, title: '', cwd: directory, tokens: null, pending: new Map(), lastSent: '', metaAt: 0 };
      const file = mirrorOf(id);
      try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const o = JSON.parse(line);
          if (o && typeof o.uuid === 'string') s.seen.add(o.uuid);
          if (o && o.type === 'meta') { s.title = o.title || s.title; s.cwd = o.cwd || s.cwd; }
          else if (o && o.role === 'title' && o.text) s.title = String(o.text);
        }
      } catch {}
      state.set(id, s);
      return s;
    };

    function writeSessionFile(s, force = false) {
      const now = Date.now();
      if (!force && now - s.metaAt < 1000) return;
      s.metaAt = now;
      writeJson(metaOf(s.id), {
        v: 1, id: s.id, provider: 'opencode', pid: process.pid, bridge: bridgeId, port, token,
        directory, cwd: s.cwd || directory, title: s.title || '', transcript: mirrorOf(s.id), updated: Date.now(),
      });
    }

    async function refreshMeta(s) {
      try {
        const info = await ctx.session.get({ sessionID: s.id });
        if (info) {
          if (typeof info.title === 'string') s.title = info.title;
          if (info.location && typeof info.location.directory === 'string') s.cwd = info.location.directory;
          if (info.tokens && typeof info.tokens === 'object') s.tokens = info.tokens;
        }
      } catch {}
      writeSessionFile(s);
    }

    // ---------- the conversation mirror ----------
    let syncing = new Map();
    function scheduleSync(s) {
      clearTimeout(s.timer);
      s.timer = setTimeout(() => sync(s).catch(() => {}), 220);
    }
    async function sync(s) {
      if (syncing.has(s.id)) return syncing.get(s.id);
      const run = (async () => {
        let msgs;
        try { msgs = await ctx.session.context({ sessionID: s.id }); } catch { return; }
        s.msgs = msgs;
        const file = mirrorOf(s.id);
        let empty = true;
        try { empty = fs.statSync(file).size === 0; } catch {}
        if (empty) append(file, { v: 1, type: 'meta', id: s.id, cwd: s.cwd || directory, title: s.title || '', timestamp: new Date().toISOString() });
        if (s.title && s.title !== s.lastSent) {
          // a title record: the dashboard keeps the newest one (see remote/server/store.js)
          const key = `title:${s.title}`;
          if (!s.seen.has(key)) { s.seen.add(key); append(file, { v: 1, uuid: key, timestamp: new Date().toISOString(), cwd: s.cwd || directory, role: 'title', text: s.title }); }
        }
        s.lastSent = s.title || '';
        for (const rec of recordsForMessages(msgs, s.cwd || directory)) {
          if (!rec.uuid || s.seen.has(rec.uuid)) continue;
          s.seen.add(rec.uuid);
          append(file, rec);
        }
      })();
      syncing.set(s.id, run);
      try { await run; } finally { syncing.delete(s.id); }
    }

    // ---------- Ame's local endpoints ----------
    function ame(method, p, body, timeout = 1200, signal) {
      return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : '';
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        let req;
        try {
          req = http.request({ host: '127.0.0.1', port: AME_PORT, method, path: p, timeout,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
            let b = ''; res.setEncoding('utf8');
            res.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
            res.on('end', () => { try { finish(res.statusCode === 200 ? JSON.parse(b) : null); } catch { finish(null); } });
          });
        } catch { return finish(null); }
        req.on('timeout', () => req.destroy());
        req.on('error', () => finish(null));
        if (signal) signal.addEventListener('abort', () => { try { req.destroy(); } catch {} finish(null); }, { once: true });
        req.end(data);
      });
    }
    function sendEvent(s, name, extra = {}) {
      const body = {
        provider: 'opencode', session: s.id, cwd: s.cwd || directory, project: projectOf(s.cwd || directory),
        title: s.title || undefined, transcript: mirrorOf(s.id), pid: process.pid, eventAt: Date.now(), text: extra.text || '',
        hookEvent: extra.hookEvent,
      };
      ame('POST', `/event/${name}`, body, 1500).catch(() => {});
    }

    // ---------- permissions: the card waits in Ame, the terminal's own prompt stays usable ----------
    function askPermission(s, d) {
      const controller = new AbortController();
      s.pending.set(d.id, controller);
      const body = {
        provider: 'opencode', session: s.id, tool: String(d.action || 'permission'), input: { resources: d.resources || [], message: d.message, metadata: d.metadata },
        suggestions: Array.isArray(d.save) ? d.save : [], project: projectOf(s.cwd || directory), cwd: s.cwd || directory,
        transcript: mirrorOf(s.id), pid: process.pid, agentId: '', subagent: '',
      };
      (async () => {
        const answer = await ame('POST', '/permission', body, PERMISSION_WAIT, controller.signal);
        s.pending.delete(d.id);
        const choice = answer && answer.choice;
        const decision = choice === 'deny' ? 'reject' : choice === 'always' ? 'always' : choice === 'allow' ? 'once' : null;
        if (!decision) return;                        // timed out / answered in the terminal: OpenCode's own prompt decides
        try { await ctx.permission.reply({ sessionID: s.id, requestID: d.id, decision }); } catch {}
      })().catch(() => s.pending.delete(d.id));
    }

    // ---------- the event stream ----------
    async function onEvent(ev) {
      if (!ev || typeof ev.type !== 'string' || !WATCH.has(ev.type)) return;
      if (ev.location && ev.location.directory && norm(ev.location.directory) !== location) return;
      if (ev.id) {
        if (eventsSeen.has(ev.id)) return;
        eventsSeen.add(ev.id); eventOrder.push(ev.id);
        if (eventOrder.length > 2000) eventsSeen.delete(eventOrder.shift());
      }
      const d = ev.data || {};
      const sid = d.sessionID;
      if (!sid) return;
      // a child session (the subagent tool): its work shows as the parent's tool line; not a session of its own
      if (ev.type === 'session.created' && d.parentID) { childSessions.add(sid); return; }
      if (childSessions.has(sid)) { if (ev.type === 'session.deleted') childSessions.delete(sid); return; }
      const s = sessionState(sid);
      writeSessionFile(s);
      if (!s.metaLoaded) { s.metaLoaded = true; refreshMeta(s).catch(() => {}); }

      if (ev.type === 'permission.asked') { askPermission(s, d); scheduleSync(s); return; }
      if (ev.type === 'permission.replied') {
        const p = s.pending.get(d.requestID);
        if (p) { s.pending.delete(d.requestID); p.abort(); }
        scheduleSync(s);
      }

      if (ev.type === 'session.created') {
        if (d.location && d.location.directory) s.cwd = d.location.directory;
        if (d.title) s.title = d.title;
        writeSessionFile(s, true);
      }
      if (ev.type === 'session.renamed' && d.title) { s.title = d.title; writeSessionFile(s, true); }
      if (ev.type === 'session.text.ended' && typeof d.text === 'string' && d.text.trim()) s.lastText = d.text;
      if (ev.type === 'session.execution.started') { s.lastText = ''; refreshMeta(s).catch(() => {}); }
      if (ev.type === 'session.execution.succeeded' || ev.type === 'session.execution.failed') {
        s.doneAt = Date.now();
        refreshMeta(s).catch(() => {});
      }
      if (['session.created', 'session.inbox.delivered', 'session.execution.started', 'session.execution.succeeded', 'session.execution.failed',
        'session.compaction.ended', 'session.text.ended', 'session.tool.called', 'session.tool.success', 'session.tool.failed', 'session.renamed'].includes(ev.type)) scheduleSync(s);

      // tool events name only the call id: the tool's name (for the progress line) is in the message that holds it
      let mapped;
      if (ev.type === 'session.tool.called') {
        let text = '正在使用工具';
        try {
          const msgs = s.msgs || await ctx.session.context({ sessionID: s.id });
          for (const m of msgs || []) for (const p of (m && m.content) || []) if (p && p.type === 'tool' && p.id === d.id) text = toolLine(p.name, (p.state && p.state.input) || {});
        } catch {}
        mapped = { type: 'event', name: 'thinking', text };
      } else mapped = mapEvent(ev, s);
      if (!mapped) return;
      // what was just asked, for the progress line (the inbox event itself carries no text)
      if (mapped.type === 'event' && ev.type === 'session.inbox.delivered') {
        try {
          const msgs = s.msgs || await ctx.session.context({ sessionID: s.id });
          const last = [...(msgs || [])].reverse().find((m) => m && m.type === 'user' && typeof m.text === 'string' && m.text.trim());
          if (last) mapped.text = '收到：' + cut(last.text, 56);
        } catch {}
      }
      if (mapped.name === 'quit') {
        writeSessionFile(s, true);
        setTimeout(() => { if (state.get(sid) === s) state.delete(sid); }, 5000).unref?.();
      }
      if (mapped.type === 'event') {
        sendEvent(s, mapped.name, {
          text: mapped.text,
          title: mapped.title, cwd: mapped.cwd, project: mapped.project,
          transcript: mapped.transcript, hookEvent: mapped.hookEvent,
        });
        if (mapped.name === 'meta') writeSessionFile(s, true);
      }
    }

    // ---------- the control endpoint Ame calls (reply / interrupt / screen) ----------
    const control = http.createServer((req, res) => {
      const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const t = Buffer.from(String(req.headers['x-ame-bridge'] || ''));
      if (req.headers.origin || t.length !== token.length || !crypto.timingSafeEqual(t, Buffer.from(token))) return out(403, { ok: false });
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; if (body.length > 256e3) req.destroy(); });
      req.on('end', async () => {
        let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
        if (req.method === 'GET' && req.url === '/health') return out(200, { ok: true, pid: process.pid, directory });
        if (typeof d.sessionID !== 'string' || !d.sessionID) return out(400, { ok: false, msg: '无效请求' });
        const s = sessionState(d.sessionID);
        try {
          if (req.method === 'POST' && req.url === '/prompt') {
            if (typeof d.text !== 'string' || !d.text.trim() || d.text.length > 8000) return out(400, { ok: false, msg: '内容为空或太长' });
            await ctx.session.prompt({ sessionID: d.sessionID, text: d.text });
            s.lastText = '';
            scheduleSync(s);
            return out(200, { ok: true });
          }
          if (req.method === 'POST' && req.url === '/interrupt') {
            await ctx.session.interrupt({ sessionID: d.sessionID, resume: false });
            return out(200, { ok: true });
          }
          if (req.method === 'POST' && req.url === '/screen') {
            let msgs = s.msgs;
            if (!msgs) { try { msgs = await ctx.session.context({ sessionID: d.sessionID }); s.msgs = msgs; } catch {} }
            return out(200, { ok: true, screen: screenText(msgs || []) });
          }
          if (req.method === 'POST' && req.url === '/title') {
            if (typeof d.title !== 'string' || !d.title.trim()) return out(400, { ok: false });
            await ctx.session.update({ sessionID: d.sessionID, title: d.title.trim().slice(0, 80) });
            s.title = d.title.trim().slice(0, 80);
            scheduleSync(s); writeSessionFile(s);
            return out(200, { ok: true });
          }
        } catch (e) {
          return out(200, { ok: false, msg: String((e && e.message) || e).slice(0, 200) });
        }
        return out(404, { ok: false });
      });
    });
    const port = await listen(control);
    writeJson(path.join(BRIDGES, `${bridgeId}.json`), { v: 1, pid: process.pid, port, token, directory, started: Date.now() });
    fs.mkdirSync(SESSIONS, { recursive: true, mode: 0o700 });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });

    const ac = new AbortController();
    (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
          try { await onEvent(ev); } catch {}
        }
      } catch {}
    })();

    // Sessions that already exist (the plugin was just installed, or OpenCode was restarted): register their
    // control endpoint and catch the conversation up once, so "在电脑上继续" and the archive work for them too.
    // Only the newest few, and only when the mirror is older than the session itself, so a reload is cheap.
    (async () => {
      let page;
      try { page = await ctx.session.list({ directory, limit: 10 }); } catch { return; }
      for (const info of (page && page.data) || []) {
        try {
          if (!info || !info.id || info.parentID) { if (info && info.id && info.parentID) childSessions.add(info.id); continue; }
          if (info.location && info.location.directory && norm(info.location.directory) !== location) continue;
          const updated = (info.time && info.time.updated) || 0;
          if (updated && updated < Date.now() - 7 * 86400e3) continue;      // older sessions: only when they speak again
          const s = sessionState(info.id);
          s.cwd = (info.location && info.location.directory) || s.cwd;
          if (info.title) s.title = info.title;
          writeSessionFile(s, true);
          let mtime = 0;
          try { mtime = fs.statSync(mirrorOf(s.id)).mtimeMs; } catch {}
          if (updated > mtime) await sync(s);                                 // one at a time: a reload is cheap
        } catch {}
      }
    })();

    return async () => {
      ac.abort();
      for (const s of state.values()) {
        clearTimeout(s.timer);
        for (const c of s.pending.values()) c.abort();
        try { const meta = JSON.parse(fs.readFileSync(metaOf(s.id), 'utf8')); if (meta.bridge === bridgeId) fs.unlinkSync(metaOf(s.id)); } catch {}
      }
      try { control.close(); } catch {}
      try { fs.unlinkSync(path.join(BRIDGES, `${bridgeId}.json`)); } catch {}
    };
  },
};
