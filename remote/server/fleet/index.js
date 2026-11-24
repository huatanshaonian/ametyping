// 设备更新 & 一键配置: every computer's agent version, the update after a deploy pushed over the agent's own
// connection (no SSH), and its coding agents pointed at Magpie with a gateway key of its own.
//   the bundle   <dataDir>/fleet/bundle/{manifest.json, files/...}: what an agent machine runs at the deployed commit,
//                put there by remote/deploy/deploy.js (manifest: { commit, files: { path: blob }, headless: [paths],
//                known: [every blob id these paths ever had] -- a file with another id was edited on that machine)
//   agent -> server  fleet-version { mode, commit, auto, why, last, control, magpieKey, harnesses, proxy }   on connecting
//                    fleet-have / fleet-ack / fleet-result / agent-config-result / harness-result  answers (by rid)
//   server -> agent  fleet-check { files } -> fleet-files { items } ... -> fleet-apply { commit, mode, files, headless }
//                    agent-config { gateway, key?, models, targets, proxy, template }
//                    harness-run { id, action: install|update, proxy }   Claude Code / Codex / OpenCode / Antigravity
// Harnesses: Claude Code and OpenCode use Magpie on the LAN (no proxy); Codex keeps its ChatGPT sign-in and goes through
// the computer's proxy (per computer, else settings.proxy), as do the downloads of an install or update.
// The update goes out by itself (settings.auto) when the bundle changes and when a machine behind it connects -- once
// a commit and machine: a failure waits for 「更新」 in the panel. A machine whose agent says it is a development copy
// (agent/fleet.js: several worktrees, a branch, uncommitted changes, "autoUpdate": false) is never updated.
//   GET  /api/fleet                         the picture
//   POST /api/fleet/settings   (code)       { auto, gateway, models }
//   POST /api/fleet/update     (code)       { machine, force }      force: also over files edited on that machine
//   POST /api/fleet/configure  (code)       { machine, targets, reissue, proxy }
//   POST /api/fleet/harness    (code)       { machine | '*', id | '*', action }   '*': every installed one, one after
//                                           another on a computer (all computers at once); answers at once, the
//                                           outcome comes with the 'fleet' broadcast
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createMagpieKeys } = require('./magpie-keys');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const TARGETS = ['claude', 'opencode', 'codex'];
const KEYED = ['claude', 'opencode'];                 // (use the computer's Magpie key; Codex only gets the proxy)
const HARNESSES = ['claude', 'codex', 'opencode', 'agy'];
const PROXY = /^https?:\/\/[^\s'"\\]+$/;
const BATCH = 1.5 * 1024 * 1024;
const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');

function createFleet({ dataDir, machines, control = false, audit = () => {}, onChange = () => {}, log = () => {},
  magpieConfig = {}, magpieKeys = createMagpieKeys({ config: magpieConfig }), models = () => [],
  templateFile = path.join(__dirname, '..', '..', 'public', 'downloads', 'opencode-magpie.json'),
  replyTimeoutMs = 60e3, applyTimeoutMs = 15 * 60e3, harnessTimeoutMs = 17 * 60e3, backTimeoutMs = 5 * 60e3, tickMs = 60e3 }) {
  const dir = path.join(dataDir, 'fleet'), bundleDir = path.join(dir, 'bundle'), stateFile = path.join(dir, 'state.json');
  // net: { machine: { proxy } }; harness: { machine: { id: { action, status, msg, before, after, notes, log, at } } }
  let state = { settings: { auto: true, gateway: '', models: {}, proxy: '' }, keys: {}, runs: {}, net: {}, harness: {} };
  try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); state = { ...state, ...s, settings: { ...state.settings, ...(s.settings || {}) } }; } catch {}
  for (const k of ['net', 'harness']) if (!state[k] || typeof state[k] !== 'object') state[k] = {};
  if (!state.settings.models || typeof state.settings.models !== 'object') state.settings.models = {};
  delete state.settings.models.codex;                  // (Codex is not pointed at Magpie any more)
  const proxyOf = (name) => (state.net[name] && state.net[name].proxy) || state.settings.proxy || '';
  if (!state.settings.gateway) {
    try { const t = JSON.parse(fs.readFileSync(templateFile, 'utf8')); state.settings.gateway = String(t.providers.magpie.settings.baseURL || '').replace(/\/v1\/?$/, ''); } catch {}
  }
  function save() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(stateFile + '.tmp', stateFile);
  }
  let manifest = null, manifestAt = 0, known = new Set();
  function bundle() {
    let st; try { st = fs.statSync(path.join(bundleDir, 'manifest.json')); } catch { manifest = null; return null; }
    if (st.mtimeMs !== manifestAt) {
      manifestAt = st.mtimeMs;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
        if (!/^[0-9a-f]{40}$/.test(m.commit) || !m.files) throw new Error('manifest.json 格式不对');
        manifest = m; known = new Set(m.known || []);
      } catch (e) { manifest = null; log('更新包读不了：' + e.message); }
    }
    return manifest;
  }

  // ---- talking to one agent socket: a request and its answer by rid ----
  const pending = new Map();
  function ask(ws, msg, want, timeoutMs = replyTimeoutMs) {
    const rid = 'fl-' + crypto.randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(rid); resolve({ ok: false, msg: '等这台电脑回答超时' }); }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(rid, { ws, want, done: (d) => { clearTimeout(timer); pending.delete(rid); resolve(d); } });
      try { ws.send(JSON.stringify({ ...msg, rid })); } catch { pending.get(rid).done({ ok: false, msg: '发送失败（连接断了）' }); }
    });
  }
  const socketOf = (name) => { const m = machines.get(name); return m && m.sockets && [...m.sockets].reverse().find((s) => s.readyState === 1 && s.fleet) || null; };

  // ---- the update of one machine ----
  const running = new Set();
  function setRun(name, r) { state.runs[name] = { ...r, at: new Date().toISOString() }; try { save(); } catch {} onChange(); }
  async function update(name, { force = false, by = 'auto' } = {}) {
    const b = bundle();
    if (!b) return { ok: false, msg: 'NAS 上还没有更新包：先运行一次 deploy（remote/deploy/deploy.js）' };
    const ws = socketOf(name), v = ws && ws.fleet;
    if (!ws) return { ok: false, msg: machines.get(name) && machines.get(name).online ? '这台电脑的 agent 版本太旧，不会自动更新：这一次用 deploy.js --ssh-agents 更新它' : '这台电脑不在线' };
    if (!v.control) return { ok: false, msg: '这台电脑没开远程控制（agent.json "control": true），不能远程更新' };
    if (!v.auto) return { ok: false, msg: v.why || '这台电脑不自动更新' };
    if (v.commit === b.commit) return { ok: true, msg: '已经是这个版本' };
    if (running.has(name)) return { ok: false, msg: '正在更新' };
    running.add(name);
    const run = { commit: b.commit, from: v.commit || '', by }, id = 'run-' + crypto.randomBytes(6).toString('hex');
    try {
      setRun(name, { ...run, status: 'running', msg: '检查文件' });
      let r;
      if (v.mode === 'git') {
        setRun(name, { ...run, status: 'running', msg: 'git pull' });
        r = await ask(ws, { t: 'fleet-apply', run: id, mode: 'git', commit: b.commit }, 'fleet-result', applyTimeoutMs);
      } else {
        const have = await ask(ws, { t: 'fleet-check', files: b.files }, 'fleet-have');
        if (!have.have) { setRun(name, { ...run, status: 'failed', msg: have.msg || '没拿到这台电脑的文件清单' }); return { ok: false, msg: have.msg }; }
        const changed = Object.keys(b.files).filter((p) => have.have[p] !== b.files[p]);
        const local = changed.filter((p) => have.have[p] && !known.has(have.have[p]));
        if (local.length && !force) {
          const msg = `有 ${local.length} 个文件在这台电脑上被直接改过（git 里没有这个版本）：${local.slice(0, 5).join('、')}${local.length > 5 ? ' …' : ''}`;
          setRun(name, { ...run, status: 'blocked', msg, local: local.slice(0, 50) });
          return { ok: false, msg };
        }
        let batch = [], size = 0, sent = 0;
        const flush = async () => {
          if (!batch.length) return true;
          const a = await ask(ws, { t: 'fleet-files', run: id, items: batch }, 'fleet-ack');
          batch = []; size = 0;
          if (a.n == null) { setRun(name, { ...run, status: 'failed', msg: a.msg || '传文件失败' }); return false; }
          setRun(name, { ...run, status: 'running', msg: `传文件 ${sent}/${changed.length}` });
          return true;
        };
        for (const p of changed) {
          const buf = fs.readFileSync(path.join(bundleDir, 'files', p));
          if (size && size + buf.length > BATCH && !(await flush())) return { ok: false, msg: state.runs[name].msg };
          batch.push({ path: p, blob: b.files[p], b64: buf.toString('base64') }); size += buf.length; sent++;
        }
        if (!(await flush())) return { ok: false, msg: state.runs[name].msg };
        setRun(name, { ...run, status: 'running', msg: '写入' });
        r = await ask(ws, { t: 'fleet-apply', run: id, mode: 'files', commit: b.commit, files: changed,
          headless: changed.some((p) => (b.headless || []).includes(p)) }, 'fleet-result', applyTimeoutMs);
      }
      if (!r.ok) { setRun(name, { ...run, status: 'failed', msg: r.msg || '更新失败' }); return { ok: false, msg: r.msg }; }
      if (!r.restart) { setRun(name, { ...run, status: 'ok', msg: r.msg || '完成', notes: r.notes }); return { ok: true, msg: r.msg }; }
      setRun(name, { ...run, status: 'restarting', msg: 'agent 正在重启，等它连回来', notes: r.notes });
      const t = setTimeout(() => {
        const cur = state.runs[name];
        if (cur && cur.status === 'restarting' && cur.commit === b.commit) setRun(name, { ...cur, status: 'failed', msg: `重启后 ${Math.round(backTimeoutMs / 60e3)} 分钟没连回来（看那台电脑的 agent）` });
      }, backTimeoutMs);
      if (t.unref) t.unref();
      audit('fleet-update', name, b.commit.slice(0, 7), by);
      return { ok: true, msg: '已写入，agent 正在重启' };
    } catch (e) {
      setRun(name, { ...run, status: 'failed', msg: '更新出错：' + e.message });     // (e.g. the bundle replaced by a deploy meanwhile)
      return { ok: false, msg: e.message };
    } finally { running.delete(name); }
  }

  // the update by itself: once per machine and commit
  function maybeAuto(name) {
    const b = bundle(), ws = socketOf(name), v = ws && ws.fleet;
    if (!control || !state.settings.auto || !b || !v || !v.control || !v.auto || v.commit === b.commit) return;
    const last = state.runs[name];
    if (last && last.commit === b.commit) return;
    update(name, { by: 'auto' }).catch((e) => log('自动更新 ' + name + ' 出错：' + e.message));
  }
  let lastCommit = (bundle() || {}).commit || '';
  const timer = setInterval(() => {
    const b = bundle();
    if (b && b.commit !== lastCommit) { lastCommit = b.commit; log('更新包换成了 ' + b.commit.slice(0, 7)); onChange(); for (const name of machines.keys()) maybeAuto(name); }
  }, tickMs);
  if (timer.unref) timer.unref();

  // ---- agent messages ----
  function fromAgent(m, d, ws) {
    if (d.t === 'fleet-version') {
      ws.fleet = { mode: d.mode === 'git' ? 'git' : 'files', commit: /^[0-9a-f]{40}$/.test(d.commit) ? d.commit : '', branch: str(d.branch, 80),
        dirty: +d.dirty || 0, auto: d.auto === true, why: str(d.why, 200), platform: str(d.platform, 20), node: str(d.node, 20),
        control: d.control === true, pending: d.pending === true,
        last: d.last && typeof d.last === 'object' ? { ok: d.last.ok === true, commit: str(d.last.commit, 40), tried: str(d.last.tried, 40), msg: str(d.last.msg, 300), at: str(d.last.at, 40), notes: Array.isArray(d.last.notes) ? d.last.notes.slice(0, 8).map((n) => str(n, 200)) : [] } : null,
        magpieKey: d.magpieKey && typeof d.magpieKey === 'object' ? { id: str(d.magpieKey.id, 80), name: str(d.magpieKey.name, 120) } : null,
        proxy: PROXY.test(d.proxy || '') ? d.proxy : '',
        harnesses: Array.isArray(d.harnesses) ? d.harnesses.filter((x) => x && HARNESSES.includes(x.id)).map((x) => ({
          id: x.id, label: str(x.label, 40), installed: x.installed === true, version: str(x.version, 80), path: str(x.path, 300) })) : null };
      m.fleet = ws.fleet;
      // an update that restarted the agent: done when it is back at that commit (or rolled back: the guard says so)
      const run = state.runs[m.name];
      if (run && run.status === 'restarting' && !ws.fleet.pending) {
        const l = ws.fleet.last;
        if (ws.fleet.commit === run.commit || (l && l.ok && l.commit === run.commit)) setRun(m.name, { ...run, status: 'ok', msg: '已更新并重启', notes: l && l.notes || run.notes });
        else if (l && !l.ok && l.tried === run.commit) setRun(m.name, { ...run, status: 'failed', msg: l.msg || '新版本没起来，已回滚' });
      }
      onChange();
      setTimeout(() => maybeAuto(m.name), 3000).unref?.();
      return true;
    }
    if (['fleet-have', 'fleet-ack', 'fleet-result', 'agent-config-result', 'harness-result'].includes(d.t) && typeof d.rid === 'string') {
      const p = pending.get(d.rid);
      if (p && p.ws === ws && (p.want === d.t || d.t === 'fleet-result')) p.done(d);
      return true;
    }
    return false;
  }
  function dropSocket(ws) { for (const [, p] of pending) if (p.ws === ws) p.done({ ok: false, msg: '连接断了' }); }

  // ---- 一键配置 ----
  // the computer's proxy, kept here (it goes along with every 一键配置 and harness run)
  function setProxy(name, proxy) {
    if (proxy && !PROXY.test(proxy)) return false;
    if (proxy) state.net[name] = { proxy }; else delete state.net[name];
    try { save(); } catch {}
    return true;
  }
  async function configure(name, { targets, reissue = false, proxy } = {}, ip = '') {
    const ws = socketOf(name), v = ws && ws.fleet;
    if (!ws) return { ok: false, msg: '这台电脑不在线，或 agent 版本太旧' };
    if (!v.control) return { ok: false, msg: '这台电脑没开远程控制（agent.json "control": true）' };
    const list = (Array.isArray(targets) ? targets : []).filter((t) => TARGETS.includes(t));
    if (!list.length) return { ok: false, msg: '选一个要配置的 agent' };
    if (typeof proxy === 'string' && !setProxy(name, proxy.trim())) return { ok: false, msg: '代理地址要是 http(s)://… 的形式' };
    const keyed = list.some((t) => KEYED.includes(t));
    if (keyed && !state.settings.gateway) return { ok: false, msg: '先填网关地址' };
    if (list.includes('codex') && !proxyOf(name)) return { ok: false, msg: 'Codex 要走代理：先填这台电脑的代理（或默认代理）' };
    let template = null; try { template = JSON.parse(fs.readFileSync(templateFile, 'utf8')); } catch {}
    const msg = { t: 'agent-config', gateway: state.settings.gateway, models: state.settings.models || {}, targets: list, template, proxy: proxyOf(name) };
    let key = null;
    const have = v.magpieKey && v.magpieKey.id;
    if (keyed && (reissue || !have || !(await magpieKeys.usable(have).catch(() => true)))) {
      try { key = await magpieKeys.issue('windose-' + name); }
      catch (e) { if (reissue || !have) return { ok: false, msg: e.message }; }
    }
    const r = await ask(ws, key ? { ...msg, key } : msg, 'agent-config-result');
    if (r.key && r.key.id) { state.keys[name] = { id: r.key.id, name: r.key.name, at: new Date().toISOString() }; try { save(); } catch {} }
    audit('fleet-configure', ip, name, list.join(','), key ? (key.rotated ? 'key-rotated' : 'key-issued') : 'key-kept');
    onChange();
    return { ok: r.ok === true, msg: r.msg, key: r.key ? { id: r.key.id, name: r.key.name, issued: !!key } : undefined,
      results: Array.isArray(r.results) ? r.results.map((x) => ({ target: str(x.target, 20), ok: x.ok === true, file: str(x.file, 300), backup: str(x.backup, 300), msg: str(x.msg, 300) })) : [] };
  }

  // ---- harnesses: install / update ----
  const harnessBusy = new Set();                        // machine names with a run going (one harness at a time there)
  function setHarness(name, id, r) {
    state.harness[name] = { ...(state.harness[name] || {}), [id]: { ...r, at: new Date().toISOString() } };
    try { save(); } catch {}
    onChange();
  }
  async function runOne(name, id, action, by) {
    const ws = socketOf(name);
    if (!ws) { setHarness(name, id, { action, status: 'failed', msg: '这台电脑不在线，或 agent 版本太旧' }); return false; }
    setHarness(name, id, { action, status: 'running', msg: action === 'install' ? '安装中' : '更新中' });
    audit('fleet-harness', by, name, id, action);
    const r = await ask(ws, { t: 'harness-run', id, action, proxy: proxyOf(name) }, 'harness-result', harnessTimeoutMs);
    setHarness(name, id, { action, status: r.ok ? 'ok' : 'failed', msg: str(r.msg, 300) || (r.ok ? '完成' : '失败'),
      before: str(r.before, 80), after: str(r.after, 80), notes: Array.isArray(r.notes) ? r.notes.slice(0, 6).map((n) => str(n, 300)) : [],
      log: str(r.log, 3000) });
    return r.ok === true;
  }
  // one machine: one harness, or with id '*' every installed one (update only), one after another
  function harnessRun(name, id, action, by = '') {
    const ws = socketOf(name), v = ws && ws.fleet;
    if (!ws) return { ok: false, msg: '这台电脑不在线，或 agent 版本太旧' };
    if (!v.control) return { ok: false, msg: '这台电脑没开远程控制（agent.json "control": true）' };
    if (action !== 'install' && action !== 'update') return { ok: false, msg: '只能安装或更新' };
    const ids = id === '*' ? (v.harnesses || []).filter((x) => x.installed).map((x) => x.id) : [id];
    if (id === '*' && action !== 'update') return { ok: false, msg: '只能一起更新，不能一起安装' };
    if (!ids.length || !ids.every((x) => HARNESSES.includes(x))) return { ok: false, msg: id === '*' ? '这台电脑没有装任何 harness' : '不认识的 harness' };
    if (harnessBusy.has(name)) return { ok: false, msg: '这台电脑正在安装或更新' };
    harnessBusy.add(name);
    (async () => { try { for (const x of ids) await runOne(name, x, action, by); } finally { harnessBusy.delete(name); onChange(); } })()
      .catch((e) => log('harness ' + name + ' 出错：' + e.message));
    return { ok: true, msg: `已开始${action === 'install' ? '安装' : '更新'}：${ids.join('、')}` };
  }
  function harnessAll(by = '') {
    const started = [], skipped = [];
    for (const name of machines.keys()) {
      const ws = socketOf(name), v = ws && ws.fleet;
      if (!ws || !v.control || !(v.harnesses || []).some((x) => x.installed)) continue;
      const r = harnessRun(name, '*', 'update', by);
      if (r.ok) started.push(name); else skipped.push(name + '（' + r.msg + '）');
    }
    return { ok: started.length > 0, msg: started.length ? `已开始更新：${started.join('、')}${skipped.length ? '；没开始：' + skipped.join('、') : ''}` : '没有可以更新的电脑' + (skipped.length ? '：' + skipped.join('、') : '') };
  }

  function view() {
    const b = bundle();
    const names = new Set([...machines.keys(), ...Object.keys(state.runs)]);
    const list = [...names].filter((n) => n !== 'nas').sort().map((name) => {
      const m = machines.get(name), ws = socketOf(name), v = (ws && ws.fleet) || (m && m.fleet) || null;
      return { name, online: !!(m && m.online), version: v, supported: !!ws, run: state.runs[name] || null,
        key: state.keys[name] || null, behind: !!(b && v && v.commit && v.commit !== b.commit),
        proxy: (state.net[name] && state.net[name].proxy) || '', harness: state.harness[name] || {}, harnessBusy: harnessBusy.has(name) };
    });
    let tpl = false; try { fs.accessSync(templateFile); tpl = true; } catch {}
    return { control, bundle: b ? { commit: b.commit, at: b.at || '', files: Object.keys(b.files).length } : null,
      settings: state.settings, magpie: magpieKeys.available(), template: tpl, models: models(), machines: list, targets: TARGETS, harnesses: HARNESSES };
  }

  async function handle(req, res, url, ip, json, readBody, fresh) {
    const p = url.pathname;
    if (!p.startsWith('/api/fleet')) return false;
    if (req.method === 'GET' && p === '/api/fleet') { json(res, 200, view()); return true; }
    if (req.method !== 'POST' || !['/api/fleet/settings', '/api/fleet/update', '/api/fleet/configure', '/api/fleet/harness'].includes(p)) return false;
    if (!control) { json(res, 200, { ok: false, msg: '服务器处于只读模式' }); return true; }
    if (!fresh()) { json(res, 200, { ok: false, need: 'totp', msg: '需要再输一次验证码' }); return true; }
    let d = {}; try { d = JSON.parse(await readBody(req, 20000)); } catch { json(res, 200, { ok: false, msg: '请求格式不正确' }); return true; }
    if (p === '/api/fleet/settings') {
      const s = { ...state.settings };
      if (typeof d.auto === 'boolean') s.auto = d.auto;
      if (typeof d.gateway === 'string') {
        if (d.gateway) { try { const u = new URL(d.gateway); if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search) throw 0; s.gateway = u.href.replace(/\/+$/, '').replace(/\/v1$/, ''); } catch { json(res, 200, { ok: false, msg: '网关地址要是 http(s)://… 的形式' }); return true; } }
        else s.gateway = '';
      }
      if (d.models && typeof d.models === 'object') {
        s.models = {};
        for (const k of ['opus', 'sonnet', 'haiku', 'fable']) if (typeof d.models[k] === 'string' && /^[\w./:@#-]{0,160}$/.test(d.models[k]) && d.models[k]) s.models[k] = d.models[k];
      }
      if (typeof d.proxy === 'string') {
        if (d.proxy.trim() && !PROXY.test(d.proxy.trim())) { json(res, 200, { ok: false, msg: '默认代理要是 http(s)://… 的形式' }); return true; }
        s.proxy = d.proxy.trim();
      }
      state.settings = s; save(); audit('fleet-settings', ip, s.auto ? 'auto' : 'manual'); onChange();
      if (s.auto) for (const name of machines.keys()) maybeAuto(name);
      json(res, 200, { ok: true, settings: s }); return true;
    }
    const name = String(d.machine || '');
    if (p === '/api/fleet/harness') {
      const id = String(d.id || ''), action = String(d.action || '');
      if (name === '*') { json(res, 200, action === 'update' && id === '*' ? harnessAll(ip) : { ok: false, msg: '所有电脑只能一起更新全部 harness' }); return true; }
      if (!NAME.test(name)) { json(res, 200, { ok: false, msg: '电脑名不对' }); return true; }
      json(res, 200, harnessRun(name, id, action, ip)); return true;
    }
    if (!NAME.test(name)) { json(res, 200, { ok: false, msg: '电脑名不对' }); return true; }
    if (p === '/api/fleet/update') {
      audit('fleet-update-request', ip, name, d.force ? 'force' : '');
      json(res, 200, await update(name, { force: d.force === true, by: 'manual' })); return true;
    }
    json(res, 200, await configure(name, { targets: d.targets, reissue: d.reissue === true, proxy: typeof d.proxy === 'string' ? d.proxy : undefined }, ip)); return true;
  }

  return { fromAgent, dropSocket, handle, view, update, configure, harnessRun, harnessAll, bundle, close: () => clearInterval(timer) };
}

module.exports = { createFleet };
