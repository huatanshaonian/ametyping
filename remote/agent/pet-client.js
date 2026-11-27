'use strict';
// Loopback client for the local AmeTyping pet / headless service (127.0.0.1:3940/control/*).

const fs = require('fs');
const http = require('http');
const { cleanMeshEnv } = require('../../app/cli-common');
const records = require('./records');
const { createGitWorktree, checkGitWorktree, removeGitWorktree, collectGitAudit } = require('./worktree');

function apiOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const id = /^[A-Za-z0-9._-]{1,40}$/.test(String(v.id || '')) ? String(v.id) : '';
  return id && v.local === true ? { id, local: true } : null;
}

function createPetClient({
  controlEnabled,
  petPort,
  petTokenFile,
  browse,
  sessionFile,
  sendJSON,
  isOnline,
  onPollDone = () => {},
  onAfterControl = () => {},
}) {
  const pet = new Map();
  let petUp = false;
  let petAllows = false;
  const sentCliUpdates = new Map();

  const controlOn = () => controlEnabled && petUp && petAllows;

  function petCall(method, p, body) {
    let token;
    try { token = fs.readFileSync(petTokenFile, 'utf8').trim(); } catch { return Promise.resolve(null); }
    return new Promise((resolve) => {
      let settled = false;
      let req = null;
      const done = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        resolve(val);
      };
      const hardTimer = setTimeout(() => {
        if (req) { try { req.destroy(); } catch {} }
        done(null);
      }, 9000);
      if (hardTimer.unref) hardTimer.unref();

      const data = body ? JSON.stringify(body) : '';
      req = http.request({
        host: '127.0.0.1',
        port: petPort,
        method,
        path: p,
        timeout: 8000,
        headers: {
          'X-Ame-Control': token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      }, (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          b += c;
          if (b.length > 4e6) {
            try { res.destroy(); } catch {}
            try { req.destroy(); } catch {}
            done(null);
          }
        });
        res.on('error', () => done(null));
        res.on('end', () => {
          try { done(res.statusCode === 200 ? JSON.parse(b) : null); } catch { done(null); }
        });
        res.on('close', () => done(null));
      });
      req.on('timeout', () => { try { req.destroy(); } catch {} done(null); });
      req.on('error', () => done(null));
      req.end(data);
    });
  }

  async function pollPet() {
    const r = controlEnabled ? await petCall('GET', '/control/state') : null;
    pet.clear();
    petUp = !!r;
    petAllows = !!r && r.control !== false;
    if (r && Array.isArray(r.sessions)) {
      for (const s of r.sessions) {
        if (s && typeof s.id === 'string') pet.set(s.id, s);
      }
    }
    if (r && Array.isArray(r.cliUpdates) && isOnline()) {
      for (const u of r.cliUpdates) {
        if (!u || typeof u.tool !== 'string' || !u.tool) continue;
        const at = Number(u.at) || 0;
        if (sentCliUpdates.get(u.tool) === at) continue;
        sentCliUpdates.set(u.tool, at);
        sendJSON({ t: 'cli-update', tool: u.tool, detail: String(u.detail || '').slice(0, 160), at });
      }
    }
    onPollDone();
  }

  async function control(d) {
    if (!controlEnabled) return { ok: false, msg: '这台机器没开远程控制（agent.json 里设 "control": true）' };
    const api = apiOf(d.api);
    if (d.api && !api && d.tool !== 'codex' && d.tool !== 'agy' && d.tool !== 'kiro' && !/^(codex|agy|kiro):/.test(String(d.id || ''))) {
      return { ok: false, msg: '启动入口格式已更新，请刷新看板后再试' };
    }
    let r;
    let wtMeta = null;
    let gitBaseline = null;

    if (d.t === 'send' && typeof d.id === 'string' && typeof d.text === 'string' && d.text.trim() && d.text.length <= 8000) {
      r = await petCall('POST', '/control/send', { id: d.id, text: d.text });
    } else if (d.t === 'key' && typeof d.id === 'string' && typeof d.key === 'string' && /^(up|down|left|right|enter|esc|tab|btab|bksp|ctrlxs|ctrl[abe-y]|btwfork|c:[^\x00-\x1f\x7f]{1,200})$/.test(d.key)) {
      r = await petCall('POST', '/control/key', { id: d.id, key: d.key, screen: d.screen === true, hl: d.hl === true });
    } else if (d.t === 'screen' && typeof d.id === 'string') {
      r = await petCall('POST', '/control/screen', { id: d.id, hl: d.hl === true });
    } else if (d.t === 'launch' && typeof d.cwd === 'string' && typeof d.prompt === 'string' && d.prompt.length <= 8000) {
      if (!browse.enabled) return { ok: false, msg: '这台电脑没开放文件浏览' };
      let cwd;
      try { cwd = await browse.folder(d.cwd); } catch (e) { return { ok: false, msg: e.message }; }
      if (d.workspaceMode === 'worktree') {
        const wt = createGitWorktree(cwd, d.worktreeAlias || 'worker', d.worktreeBranch || '');
        if (!wt.ok) return { ok: false, msg: wt.msg };
        cwd = wt.worktreePath;
        wtMeta = {
          worktreePath: wt.worktreePath,
          worktreeBranch: wt.worktreeBranch,
          worktreeParentRepo: wt.worktreeParentRepo,
        };
      }
      gitBaseline = collectGitAudit(cwd);
      const meshEnv = cleanMeshEnv(d.meshEnv);
      const tool = ['codex', 'opencode', 'agy', 'kiro'].includes(d.tool) ? d.tool : 'claude';
      const model = typeof d.model === 'string' && /^[A-Za-z0-9._:/-]{1,120}$/.test(d.model.trim()) ? d.model.trim() : undefined;
      r = await petCall('POST', '/control/launch', {
        cwd,
        prompt: d.prompt,
        tool,
        ...(model ? { model } : {}),
        api: ['codex', 'opencode', 'agy', 'kiro'].includes(d.tool) ? undefined : api || undefined,
        ...(meshEnv ? { meshEnv } : {}),
      });
    } else if (d.t === 'resume' && typeof d.id === 'string' && (/^opencode:ses_[A-Za-z0-9]{6,80}$/.test(d.id) || /^(codex:|agy:|kiro:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.id))) {
      const f = sessionFile(d.id);
      const cwd = !f ? '' : (f.codex || f.opencode || f.agy || f.kiro) ? f.cwd || '' : records.lastCwd(f.file);
      if (!cwd) return { ok: false, msg: '这台电脑上找不到这个会话的记录' };
      r = await petCall('POST', '/control/launch', { cwd, resume: d.id, api: /^(codex|opencode|agy|kiro):/.test(d.id) ? undefined : api || undefined });
    } else if (d.t === 'decide' && typeof d.id === 'string' && typeof d.perm === 'string' && ['allow', 'always', 'deny', 'defer', 'answer', 'chat'].includes(d.choice)) {
      r = await petCall('POST', '/control/decide', { session: d.id, id: d.perm, choice: d.choice, answers: d.choice === 'answer' ? d.answers : undefined });
    } else if (d.t === 'worktree-check') {
      if (typeof d.worktreePath !== 'string' || !d.worktreePath.trim()) return { ok: false, msg: '缺少 worktreePath 参数' };
      return checkGitWorktree(d.worktreePath, d.worktreeParentRepo || d.parentRepo || '', d.worktreeBranch || d.branch || '');
    } else if (d.t === 'worktree-remove') {
      if (typeof d.worktreePath !== 'string' || !d.worktreePath.trim()) return { ok: false, msg: '缺少 worktreePath 参数' };
      return removeGitWorktree(d.worktreePath, d.worktreeParentRepo || d.parentRepo || '', d.worktreeBranch || d.branch || '', d.force === true);
    } else {
      return { ok: false, msg: '无效请求' };
    }

    if (!r) return { ok: false, msg: '本机糖糖没在运行，没法操作' };
    if (r.ok === false && !petAllows) return { ok: false, msg: '糖糖菜单里没勾「允许远程控制」' };
    onAfterControl();
    return {
      ok: !!r.ok,
      msg: typeof r.msg === 'string' ? r.msg.slice(0, 200) : '',
      mode: typeof r.mode === 'string' ? r.mode : undefined,
      screen: typeof r.screen === 'string' ? r.screen.slice(0, 9000) : undefined,
      ...(r.ok && wtMeta ? wtMeta : {}),
      ...(r.ok && gitBaseline && gitBaseline.isGit ? { gitBaseline } : {}),
    };
  }

  return { pet, controlOn, petCall, pollPet, control };
}

module.exports = { createPetClient, apiOf };
