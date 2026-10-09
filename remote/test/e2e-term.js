// 终端画面 read as menus (public/js/apps/term-parse.js) and slash commands kept in the conversation (app/transcript.js).
// The screens are Claude Code's own, captured from 2.1.289 (test/fixtures/screens/*.txt, personal details replaced):
// when Claude Code changes how it draws a menu, capture it again and see what these checks say.
const fs = require('fs'), path = require('path');
const R = path.resolve(__dirname, '..');
const { parseScreen, hintLine, cursorOf, plainScreen } = require(R + '/public/js/apps/term-parse.js');
const { recordsOf } = require(path.resolve(R, '..', 'app', 'transcript.js'));
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
const P = (name) => parseScreen(fs.readFileSync(path.join(__dirname, 'fixtures', 'screens', name + '.txt'), 'utf8'));
const list = (p) => (p.blocks.find((b) => b.type === 'list') || { rows: [] }).rows;
const rows = (p) => list(p).map((r) => (r.cur ? '>' : r.head ? '#' : r.more ? '~' : ' ') + r.label).join('|');
const keys = (p) => p.hints.map((h) => (h.type ? 'TYPE' : h.keys.map((k) => k.key).join('/')) + '=' + h.label).join(' ; ');

// ---- the key line ----
const hl = (s) => { const h = hintLine(s); return h && h.map((x) => (x.type ? 'TYPE' : x.keys.map((k) => k.key).join('/')) + '=' + x.label).join(' ; '); };
chk('keys: Enter / a letter / Esc', hl('Enter to set as default · s to use this session only · Esc to cancel') === 'enter=设为默认 ; c:s=只用于本会话 ; esc=取消', hl('Enter to set as default · s to use this session only · Esc to cancel'));
chk('keys: several for one thing, "for", typing', hl('Type to filter · Enter/↓ to select · ↑ to tabs · s for this session only') === 'TYPE=筛选 ; enter/down=选择 ; up=到标签页 ; c:s=只用于本会话', hl('Type to filter · Enter/↓ to select · ↑ to tabs · s for this session only'));
chk('keys: Space, "/", Ctrl+letter (never Ctrl+C), an effect without a translation', hl('Enter/Space to change · / to search · Ctrl+A to show all projects · Ctrl+C to quit · x to frobnicate') === 'enter/c: =修改 ; c:/=搜索 ; ctrla=显示所有项目 ; =quit ; c:x=frobnicate', hl('Enter/Space to change · / to search · Ctrl+A to show all projects · Ctrl+C to quit · x to frobnicate'));
chk('not a key line: sentences, rows, a line with one part that is none', !hintLine('Enter the path to the directory:') && !hintLine('❯ 1. Copy to clipboard  Copy the conversation to your system clipboard') && !hintLine('Esc to cancel · and something else') && !hintLine(''), 0);

// ---- no menu ----
let p = P('idle');
chk('no menu: the input box, the status lines, the end of what is above', p.kind === 'idle' && p.input === '' && /auto mode on/.test(p.status.join()) && /Kept model as Opus 5\.5$/.test(p.tail), p);
chk('a session with a name: its rules carry the name, still the input box', P('idle-output').kind === 'idle', P('idle-output').kind);
chk('an empty screen, text that is no menu', parseScreen('').kind === 'empty' && parseScreen('\n \n').kind === 'empty' && parseScreen('hello\nworld').kind === 'raw', 0);

// ---- menus ----
p = P('model');
chk('/model: title and what it says', p.kind === 'dialog' && p.title === 'Select model' && /^Switch between Claude models\..*--model\.$/.test(p.sub) && !p.tabs, [p.title, p.sub]);
chk('/model: rows, the cursor, the scroll mark, the rest below', rows(p) === ' Default (recommended)|>Opus 5.5| Fable 5.1| Sonnet 5.5| Haiku 4.5| Sonnet 5|~… +6 models' && list(p)[5].scroll === '↓', rows(p));
chk('/model: number, ✔ = the one in use, the description', list(p)[1].num === '2' && list(p)[1].current && list(p)[1].rest === 'For complex work and everyday tasks' && !list(p)[2].current, list(p)[1]);
chk('/model: keys', keys(p) === 'enter=设为默认 ; c:s=只用于本会话 ; esc=取消', keys(p));
chk('/model after ↓: the cursor one down', cursorOf(P('model-down')).row.label === 'Fable 5.1' && cursorOf(p).row.label === 'Opus 5.5', 0);
p = P('effort-real');
const sl = p.blocks.find((b) => b.type === 'slider');
chk('/effort: the slider, where ▲ is, its ends, the setting next to it and its key', p.title === 'Effort' && sl && sl.labels.join() === 'low,medium,high,xhigh,max' && sl.at === 2 && sl.ends.join() === 'Faster,Smarter' && sl.aside === 'Ultracode off' &&
  keys(p) === 'left/right=调整 ; enter=确认 ; c:s=只用于本会话 ; esc=取消 ; tab=切换（Ultracode）', [sl, keys(p)]);
p = P('config');
chk('/config: tabs, the search box, settings and values, a typing hint', p.title === 'Settings' && p.tabs.join() === 'Status,Config,Usage,Stats' && p.blocks[0].type === 'input' && p.blocks[0].search && p.blocks[0].empty &&
  list(p)[0].cur && list(p)[0].label === 'Auto-compact' && list(p)[0].rest === 'true' && list(p)[list(p).length - 1].more && p.typing, [p.title, p.tabs, p.blocks[0]]);
chk('/config on a tab: ←/→/Tab switch', keys(P('config-tabs')) === 'left/right/tab=切换 ; down=返回 ; esc=关闭' && cursorOf(P('config-down')).row.label === 'Continue automatically at usage limit', keys(P('config-tabs')));
p = P('status');
const kv = p.blocks.filter((b) => b.type === 'kv').flatMap((b) => b.rows);
chk('/status: name / value lines, a value wrapped onto the next line joined', p.tabs && kv.find((r) => r[0] === 'Version')[1] === '2.1.289' && kv.find((r) => r[0] === 'Model')[1] === 'opus (claude-opus-5-5)' && /scratchpad\\probe$/.test(kv.find((r) => r[0] === 'cwd')[1]), kv);
p = P('usage');
chk('/usage (taller than the window, its rule scrolled away): the bar, the paragraphs, d / w', p.kind === 'dialog' && p.blocks[0].type === 'bar' && p.blocks[0].pct === 31 && p.blocks[0].word === 'used' && keys(p) === 'c:d=按天 ; c:w=按周 ; esc=取消' && p.loading, [p.blocks[0], keys(p)]);
chk('still loading', P('plugin').loading && P('stats-loading').loading && !P('model').loading, 0);
p = P('mcp-real');
chk('/mcp: groups as headings, servers with their marks and what is said of them', p.title === 'Manage MCP servers' && p.sub === '8 servers' && rows(p).startsWith('#User MCPs (C:\\Users\\me\\.claude.json)|>notebooklm-mcp| pycharm|#claude.ai| claude.ai Claude Docs') &&
  list(p)[1].glyph === '✔' && list(p)[2].glyph === '✘' && list(p)[5].glyph === '⚠' && list(p)[5].rest === 'needs authentication', rows(p));
p = P('mcp-enter');
chk('a server: name / value lines, then numbered actions', p.title === 'Notebooklm-mcp MCP Server' && p.blocks[0].type === 'kv' && rows(p) === '>View tools| Reconnect| Disable' && keys(p) === 'up/down=移动 ; enter=选择 ; esc=返回', [rows(p), keys(p)]);
p = P('hooks');
chk('/hooks: events as headings, hooks as rows (told by the brackets)', p.title === 'Hooks' && p.sub === '9 hooks on 9 events' && list(p)[0].head && list(p)[0].label === 'PreToolUse' && list(p)[1].cur && list(p)[2].head && !list(p)[3].head && list(p)[list(p).length - 1].more, rows(p).slice(0, 200));
p = P('hooks-enter');
chk('a hook: what it is, the command as a block', p.title === 'Command hook' && p.sub === 'PreToolUse · *' && p.blocks.some((b) => b.type === 'code' && /hook-relay\.js"$/.test(b.text)) && keys(p) === 'esc=返回', p.blocks);
p = P('plugin-tab');
chk('/plugin: tabs, headings, rows; Space and f', p.title === 'Plugins' && p.tabs.length === 5 && rows(p) === '#Needs attention|>pycharm| claude.ai Gmail| claude.ai Google Calendar|#User| notebooklm-mcp' && /c: =切换 ; c:f=收藏/.test(keys(p)), [rows(p), keys(p)]);
p = P('memory');
chk('/memory: two groups, each with its cursor', p.title === 'Memory' && rows(p) === '>Auto-memory|>User instructions| Project instructions| Open auto-memory folder' && list(p)[1].gap, rows(p));
p = P('theme');
chk('/theme: the one in use marked, the preview as a block', p.title === 'Theme' && rows(p).startsWith(' Auto (match terminal)|>Dark mode| Light mode') && list(p)[1].glyph === '✔' && !list(p).some((r) => r.head) && p.blocks.some((b) => b.type === 'code' && /Hello, Claude!/.test(b.text)), rows(p));
p = P('export');
chk('/export (closed by a rule with the session\'s name in it)', p.title === 'Export conversation' && p.sub === 'Select export method' && rows(p) === '>Copy to clipboard| Save to file' && list(p)[0].rest === 'Copy the conversation to your system clipboard' && p.blocks.length === 1, p.blocks);
p = P('add-dir');
chk('/add-dir: a box to type a path into', p.title === 'Add directory to workspace' && p.blocks.some((b) => b.type === 'input' && !b.search && b.text === 'Directory path…') && p.typing && keys(p) === 'tab=补全 ; enter=添加 ; esc=取消', [p.blocks, keys(p)]);
p = P('resume');
chk('/resume: the search box, Ctrl+A / Ctrl+B', p.title === 'Resume session' && p.blocks[0].type === 'input' && p.blocks[0].search && keys(p) === 'ctrla=显示所有项目 ; ctrlb=只看当前分支 ; TYPE=搜索 ; esc=取消', keys(p));
p = P('permissions');
chk('/permissions: tabs, a numbered row without a cursor', p.title === 'Permissions' && p.tabs.join() === 'Recently denied,Allow,Ask,Deny,Auto mode,Workspace' && rows(p) === ' Add a new rule…' && keys(p) === 'left/right=切换 ; down=选择 ; esc=取消', [p.tabs, rows(p), keys(p)]);
p = P('rewind');
chk('/rewind: the points to go back to, what each would undo as its detail', p.title === 'Rewind' && rows(p) === '~↑ 1 more| /effort| /output-style| /export| /add-dir| /agents|>(current)' && list(p)[1].detail === 'No code changes' && !list(p)[6].detail && keys(p) === 'enter=继续 ; esc=取消', rows(p));
p = P('resume-list');
chk('/resume with conversations: each a row with when / branch / size as its detail', p.title === 'Resume session (1 of 40)' && rows(p) === '>看板的审批卡片| desktop-session-persistence| 论文推送和知识库| 组网方案的疑虑| 出口节点和代理| 邮件相关' &&
  list(p)[0].detail === '4 minutes ago · HEAD · 3.6MB · D:\\proj' && list(p)[5].scroll === '↓' && list(p)[5].detail === '2 days ago · feature/settings · 15MB · D:\\proj-mail', [rows(p), list(p)[0]]);
chk('/resume: a key line that runs on into the next line', keys(p) === 'ctrla=只看当前仓库 ; ctrlb=只看当前分支 ; c: =预览 ; ctrlr=改名 ; TYPE=搜索 ; esc=取消', keys(p));
p = P('resume-nocursor');
chk('/resume, the cursor in the search box: still a list (told by ↑ ↓)', rows(p) === ' 论文推送和知识库| 组网方案的疑虑| 出口节点和代理| 文献阅读功能' && !cursorOf(p) && list(p)[0].scroll === '↑' && list(p)[1].detail === '1 day ago · HEAD · 352.8KB · C:\\Users\\me\\Desktop' && keys(p) === 'TYPE=搜索 ; enter=选择 ; esc=清除', [rows(p), keys(p)]);
p = P('help');
const txt = p.blocks.filter((b) => b.type === 'text').map((b) => b.lines);
chk('/help: tabs; the shortcuts keep their columns as a block of their own, and are not taken for a key line', p.title === 'Help' && p.tabs.join() === 'General,Commands,Custom commands' && keys(p) === 'esc=取消' &&
  txt.some((ls) => ls[0].startsWith('! for shell mode          double tap esc') && ls.length === 7) && txt.some((ls) => /right from your terminal\.$/.test(ls[0]) && ls[1] === 'Shortcuts'), txt);
p = P('help-commands');
chk('/help, the commands: each with what it does as its detail', rows(p).startsWith('>/add-dir| /advisor| /artifact-capabilities') && list(p)[0].detail === 'Add a new working directory' && list(p)[list(p).length - 1].more, rows(p));
chk('/tasks, /ide: a title and a line of text', P('tasks').title === 'Background' && keys(P('tasks')) === 'up/down=选择 ; enter=查看 ; esc=关闭' && P('ide').title === 'Select IDE' && /No available IDEs/.test(P('ide').blocks[0].lines[0]), 0);

// ---- the current tab: what the terminal highlights, carried in the text between U+E000 and U+E001 ----
chk('the tab a menu is on (read with its highlights); unknown without them', P('config-hl').tab === 1 && P('config-hl').tabs[1] === 'Config' && P('permissions-hl').tab === 1 && P('permissions-hl2').tab === 2 &&
  P('permissions-hl2').tabs[2] === 'Ask' && P('config').tab === -1 && P('model').tab === -1, [P('config-hl').tab, P('permissions-hl').tab, P('permissions-hl2').tab, P('config').tab]);
chk('the marks are not part of anything else read off the screen', P('config-hl').title === 'Settings' && list(P('config-hl'))[0].label === 'Auto-compact' && !/[\uE000\uE001]/.test(JSON.stringify(P('permissions-hl'))) &&
  plainScreen('a \uE000 b \uE001 c') === 'a  b  c', P('config-hl').title);
// (Linux: tmux hands over colours as escape sequences; reverse video and backgrounds become the same marks)
const { marksFromAnsi, plainScreen: plainText, tidyScreen } = require(path.resolve(R, '..', 'app', 'screen-text.js'));
const Esc = String.fromCharCode(27);
const ansi = marksFromAnsi(`  Settings  Status  ${Esc}[7m Config ${Esc}[27m  Usage   Stats\n${Esc}[38;2;1;2;3mplain${Esc}[0m x ${Esc}[48;5;238m 中文 ${Esc}[49m y\n${Esc}[41mtrail   \n${Esc}[1mbold${Esc}[0m only`);
chk('colours -> marks: reverse video, a background (256 colours); a foreground alone and trailing blanks mark nothing', ansi === '  Settings  Status  \uE000 Config \uE001  Usage   Stats\nplain x \uE000 中文 \uE001 y\n\uE000trail\uE001\nbold only', JSON.stringify(ansi));
chk('read as a menu: the tab found the same way', parseScreen('─'.repeat(40) + '\n' + ansi.split('\n')[0] + '\n\n  ❯ Auto-compact   true\n\n  Esc to close').tab === 1 && plainText(ansi).split('\n')[0] === '  Settings  Status   Config   Usage   Stats' &&
  tidyScreen(ansi).includes('\uE000'), 0);

// ---- Claude's questions as the terminal draws them (answered on their own card; this is what 画面 shows meanwhile) ----
p = P('ask');
chk('a question: its options across the rule inside the menu, each with its line of detail', rows(p) === '>面条| 米饭| 饺子| Type something.| Chat about this' && list(p)[0].detail === '快' && list(p)[2].detail === '要包' && list(p)[4].num === '5' &&
  keys(p) === 'enter=选择 ; up/down=移动 ; esc=取消', [rows(p), keys(p)]);
p = P('ask-multi');
chk('several questions: all of the top line are tabs; boxes to tick; a part of the key line that names no key kept as words', p.title === '' && p.tabs.join('|') === '☒ 配菜|☐ 饮料|✔ Submit' && list(p)[0].glyph === '☑' && list(p)[1].glyph === '☐' &&
  rows(p) === '>青菜| 鸡蛋| 豆腐| Type something| Chat about this' && p.hints.map((x) => (x.words ? 'W:' : '') + x.label).join('|') === '选择|W:Tab/Arrow keys to navigate|取消', [p.tabs, rows(p), p.hints]);
chk('the review before submitting', P('ask-review').tabs.length === 3 && cursorOf(P('ask-review')).row.label === 'Submit answers', rows(P('ask-review')));

// ---- slash commands in the transcript ----
const E = String.fromCharCode(27);
const rec = (o) => recordsOf({ timestamp: '2026-10-05T17:12:36.633Z', isMeta: false, ...o }, {}).map((r) => r.role + ':' + r.text).join(' || ');
const CMD = (n, a = '') => `<command-name>/${n}</command-name>\n            <command-message>${n}</command-message>\n            <command-args>${a}</command-args>`;
chk('a command that ran in the terminal alone (a "system" record): as you typed it', rec({ type: 'system', subtype: 'local_command', content: CMD('context') }) === 'user:/context' && rec({ type: 'system', subtype: 'local_command', content: CMD('rename', '新名字') }) === 'user:/rename 新名字', rec({ type: 'system', subtype: 'local_command', content: CMD('context') }));
chk('what it printed: the colours taken out, the lines kept', rec({ type: 'system', subtype: 'local_command', content: `<local-command-stdout> ${E}[1mContext Usage${E}[22m\n${E}[38;2;136;136;136m⛁ ⛁${E}[39m  Opus 5.5   \n</local-command-stdout>` }) === 'cmd: Context Usage\n⛁ ⛁  Opus 5.5', rec({ type: 'system', subtype: 'local_command', content: `<local-command-stdout> ${E}[1mContext Usage${E}[22m\n</local-command-stdout>` }));
chk('the other way Claude Code records it (a "user" record): /model and what it printed', rec({ type: 'user', message: { role: 'user', content: CMD('model') } }) === 'user:/model' &&
  rec({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to `Opus 5.5` and saved as your default for new sessions</local-command-stdout>' } }) === 'cmd:Set model to `Opus 5.5` and saved as your default for new sessions', 0);
chk('errors too', rec({ type: 'user', message: { role: 'user', content: '<local-command-stderr>Unknown model</local-command-stderr>' } }) === 'cmd:Unknown model', 0);
chk('nothing printed, "(no content)": no record', rec({ type: 'user', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } }) === '' && rec({ type: 'user', message: { role: 'user', content: '<local-command-stdout>(no content)</local-command-stdout>' } }) === '', 0);
chk('still left out: the copy for the model, its caveat, reminders', rec({ type: 'user', isMeta: true, message: { role: 'user', content: '## Context Usage' } }) === '' &&
  rec({ type: 'user', message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' } }) === '' && rec({ type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }) === '', 0);
chk('the summary written when the context is compacted: a note, not something you said', rec({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. ...' } }) === 'sys:（上下文已压缩）', 0);
chk('a very long output is cut', (recordsOf({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${'x'.repeat(30000)}</local-command-stdout>` } }, {})[0].text || '').length === 20002, 0);
// /btw keeps its own pairing: the fork line is no command output, the question comes with the fork
const st = {};
const b1 = recordsOf({ type: 'system', subtype: 'local_command', timestamp: '2026-10-05T17:12:36.633Z', content: CMD('btw', '顺便问一下'), commandRun: { command: 'btw', args: '顺便问一下' } }, st);
const b2 = recordsOf({ type: 'system', subtype: 'local_command', timestamp: '2026-10-05T17:12:37.633Z', content: '<local-command-stdout>⑂ forked awsclaude (3daa)</local-command-stdout>', commandRun: { command: 'btw', args: '顺便问一下' } }, st);
chk('/btw as before: the question once, with the fork; its fork line is not shown as output', b1.length === 0 && b2.length === 1 && b2[0].role === 'user' && b2[0].text === '/btw 顺便问一下' &&
  rec({ type: 'user', message: { role: 'user', content: '<local-command-stdout>⑂ forked awsclaude (3daa)</local-command-stdout>' } }) === '', [b1, b2]);

// ---- kept by the server, written into an export ----
const os = require('os');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-term-'));
const { createStore } = require(R + '/server/store');
const store = createStore(path.join(T, 'conv'));
const t0 = Date.parse('2026-10-05T10:00:00');
const acc = store.accept('box', { id: 's1', from: 0, to: 100, recs: [{ u: 'a', i: 0, role: 'user', text: '/context', t: t0 }, { u: 'b', i: 0, role: 'cmd', text: 'Context Usage\n70k/1m', t: t0 + 1000 }, { u: 'c', i: 0, role: 'nonsense', text: 'x', t: t0 + 2000 }] });
const tail = store.tail('box', 's1').map((m) => m.role + ':' + m.text).join(' || ');
chk('the server keeps command output (and still drops what it does not know)', acc.ok && tail === 'user:/context || cmd:Context Usage\n70k/1m', [acc, tail]);
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}

console.log(res.join('\n'));
const failed = res.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${res.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
