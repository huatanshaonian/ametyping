// The Claude API key (控制面板 → AI 模型 → Claude API): kept on the NAS only, in a file nobody else can read, and never
// sent back to the browser -- only whether there is one, its last four characters and when it was put in.
//   <dataDir>/anthropic-api.json   { key, setAt }
'use strict';
const fs = require('fs');
const path = require('path');

// (as the Console issues them: "sk-ant-..." and nothing but letters, digits, - and _)
const KEY = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

function createApiKey({ dataDir }) {
  const file = path.join(dataDir, 'anthropic-api.json');
  let st = { key: '', setAt: 0 };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j.key === 'string') st = { key: j.key, setAt: +j.setAt || 0 }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };

  // '' takes the key away
  function set(key) {
    key = String(key || '').trim();
    if (key && !KEY.test(key)) return { ok: false, msg: '这不像 Claude API 的 key（应以 sk-ant- 开头）' };
    st = { key, setAt: key ? Date.now() : 0 };
    if (key) save(); else { try { fs.rmSync(file, { force: true }); } catch {} }
    return { ok: true };
  }
  return { get: () => st.key, has: () => !!st.key, set, view: () => ({ has: !!st.key, tail: st.key ? st.key.slice(-4) : '', setAt: st.setAt }) };
}

module.exports = { createApiKey };
