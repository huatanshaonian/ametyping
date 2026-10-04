// What Claude Code's "always allow" option would add, said in one line for the permission cards (pet panel, dashboard).
// Claude Code sends these with every permission prompt (the hook's permission_suggestions -- what its terminal offers as
// "Yes, and don't ask again for ..."); permission-hook.js hands them back unchanged when you pick 总是允许.
//   { type: 'addRules', rules: [{ toolName, ruleContent }], behavior: 'allow', destination }
//   { type: 'addDirectories', directories: [...], destination }
//   { type: 'setMode', mode, destination }
'use strict';

const WHERE = { session: '本会话', localSettings: '这个项目（仅这台电脑）', projectSettings: '这个项目', userSettings: '所有项目', cliArg: '本次运行' };
const MODES = { acceptEdits: '自动接受编辑', plan: '计划模式', bypassPermissions: '跳过所有权限确认', default: '手动确认', auto: '自动' };
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

function what(s) {
  if (!s || typeof s !== 'object') return '';
  if ((s.type === 'addRules' || s.type === 'replaceRules') && s.behavior === 'allow' && Array.isArray(s.rules)) {
    return s.rules.map((r) => (r && r.toolName ? (r.ruleContent ? `${r.toolName}(${clip(r.ruleContent, 80)})` : r.toolName) : '')).filter(Boolean).join('、');
  }
  if (s.type === 'addDirectories' && Array.isArray(s.directories)) return '访问 ' + s.directories.map((d) => clip(d, 80)).join('、');
  if (s.type === 'setMode' && s.mode) return '切到' + (MODES[s.mode] || s.mode);
  return '';
}

// suggestions -> "Bash(npm test:*) · 本会话"; '' when there is nothing an "always" could add
function alwaysLabel(suggestions) {
  if (!Array.isArray(suggestions)) return '';
  return suggestions.map((s) => { const w = what(s); return w ? `${w} · ${WHERE[s.destination] || s.destination || '本会话'}` : ''; })
    .filter(Boolean).join('；').slice(0, 300);
}

module.exports = { alwaysLabel };
