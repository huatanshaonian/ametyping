'use strict';
// Shared local control-channel security token, permission resolution labels,
// and CLI update tracker for app/main.js, headless/ame-headless.js, and headless/ame-headless-win.js.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PERM_END = {
  decided: (e) => (
    e.choice === 'allow' ? '已允许'
    : e.choice === 'always' ? '已总是允许'
    : e.choice === 'answer' ? '已回答'
    : e.choice === 'chat' ? '先聊聊'
    : '已拒绝'
  ),
  closed: () => '已在终端处理',
  advanced: () => '已在终端处理',
};

function createControlGuard(port, getHome = () => os.homedir()) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenBuf = Buffer.from(token);
  const tokenFileOf = () => path.join(typeof getHome === 'function' ? getHome() : getHome, '.ametyping', `control-token-${port}`);

  function writeToken() {
    const file = tokenFileOf();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, token, { mode: 0o600 });
    return file;
  }

  function removeToken() {
    const file = tokenFileOf();
    try {
      if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file);
    } catch {}
  }

  function controlOk(req) {
    const t = Buffer.from(String((req && req.headers && req.headers['x-ame-control']) || ''));
    return !(req && req.headers && req.headers.origin) && t.length === tokenBuf.length && crypto.timingSafeEqual(t, tokenBuf);
  }

  return { token, tokenFileOf, writeToken, removeToken, controlOk };
}

function createCliUpdateTracker() {
  const map = new Map();
  return {
    record(u) {
      if (u && u.tool) {
        map.set(String(u.tool), {
          tool: String(u.tool).slice(0, 32),
          detail: String(u.detail || '').slice(0, 160),
          at: Number(u.at) || Date.now(),
        });
      }
    },
    values() {
      return [...map.values()];
    },
  };
}

module.exports = { PERM_END, createControlGuard, createCliUpdateTracker };
