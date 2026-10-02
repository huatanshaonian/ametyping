// /btw pairing (app/transcript.js) through the agent's reader and the store; the agent's command scan
const fs = require('fs'), path = require('path'), os = require('os');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-btw-'));
const { recordsOf } = require('../../app/transcript');
const records = require('../agent/records');
const { createStore } = require('../server/store');
const { scan } = require('../agent/commands');
const J = (o) => JSON.stringify(o) + '\n';
const fork = (name, suf, args, ts) => ({ type: 'system', subtype: 'local_command', content: `<local-command-stdout>⑂ forked ${name} (${suf})</local-command-stdout>`, commandRun: { command: 'btw', args }, timestamp: ts });
const note = (id, result, ts, status = 'completed') => ({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<result>${result}</result>\n</task-notification>` });
chk('usage line (no fork): nothing', !recordsOf({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Usage: /btw <your question></local-command-stdout>', commandRun: { command: 'btw', args: '' } }, {}).length, 0);
chk('an answer without its question (no state) is left out', !recordsOf(note('ax-00000000000000aa', 'hi', '2026-10-01T10:00:00Z'), {}).length, 0);
chk('another background task is not an answer', (() => { const st = {}; recordsOf(fork('x', 'aa', 'q', '2026-10-01T10:00:00Z'), st); return !recordsOf(note('b7712732t', 'out', '2026-10-01T10:00:01Z'), st).length && !recordsOf(note('ay-00000000000000aa', 'out', '2026-10-01T10:00:01Z'), st).length; })(), 0);
// through the reader: question and answer in different reads
const f = path.join(T, 's.jsonl');
fs.writeFileSync(f, J({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: '主任务' } }) + J(fork('demo', 'beef', '要几层？', '2026-10-01T10:00:05Z')));
const rd = records.createReader(f, 0);
const b1 = records.readNext(rd); rd.offset = b1.to;
fs.appendFileSync(f, J(note('ademo-0123456789abbeef', '五层。', '2026-10-01T10:00:20Z', 'running')) + J(note('ademo-0123456789abbeef', '五层。', '2026-10-01T10:00:30Z')) + J(note('ademo-0123456789abbeef', '五层。', '2026-10-01T10:00:31Z')) + J(note('ademo-0123456789abbeef', '追问后：六层。', '2026-10-01T10:01:00Z')));
const b2 = records.readNext(rd);
chk('reader: the question as a user record', b1.recs.some((r) => r.role === 'user' && r.text === '/btw 要几层？'), b1.recs);
chk('reader: answers in a later read, once each (not while running), a follow-up is a new one', JSON.stringify(b2.recs.map((r) => [r.role, r.text])) === JSON.stringify([['btw', '五层。'], ['btw', '追问后：六层。']]), b2.recs);
const st = createStore(path.join(T, 'data'));
st.accept('pc', { id: 'S', from: 0, to: b1.to, recs: b1.recs }); st.accept('pc', { id: 'S', from: b1.to, to: b2.to, recs: b2.recs });
const kept = st.records('pc', 'S', 0, Date.parse('2027-01-01'));
chk('store keeps the answers', kept.filter((r) => r.role === 'btw').length === 2, kept.map((r) => r.role));
// the command scan
const H = path.join(T, 'home'), C = path.join(H, '.claude');
fs.mkdirSync(path.join(C, 'commands', 'tools'), { recursive: true });
fs.writeFileSync(path.join(C, 'commands', 'a.md'), '---\ndescription: "带引号的说明"\n---\nbody');
fs.writeFileSync(path.join(C, 'commands', 'b.md'), '# 标题当说明\n\n正文');
fs.writeFileSync(path.join(C, 'commands', 'tools', 'c.md'), 'first line');
fs.writeFileSync(path.join(C, 'commands', 'bad name.md'), 'x');
fs.mkdirSync(path.join(C, 'skills', 'sk'), { recursive: true }); fs.writeFileSync(path.join(C, 'skills', 'sk', 'SKILL.md'), '---\nname: skill-x\ndescription: 技能说明\n---\n');
const P = path.join(T, 'plug'); fs.mkdirSync(path.join(P, 'commands'), { recursive: true }); fs.writeFileSync(path.join(P, 'commands', 'go.md'), '---\ndescription: 插件命令\n---\n');
fs.mkdirSync(path.join(C, 'plugins'), { recursive: true });
fs.writeFileSync(path.join(C, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'myplug@market': [{ installPath: P }] } }));
const list = scan(H), by = Object.fromEntries(list.map((c) => [c.name, c]));
chk('scan: commands, namespaces, skills, plugins; bad names dropped', by.a && by.a.desc === '带引号的说明' && by.b.desc === '标题当说明' && by['tools:c'] && by['skill-x'] && by['skill-x'].src === 'skill' &&
  by['myplug:go'] && by['myplug:go'].desc === '插件命令' && !list.some((c) => c.name.includes(' ')), list);
chk('scan: no .claude at all is an empty list', scan(path.join(T, 'nobody')).length === 0, 0);
fs.rmSync(T, { recursive: true, force: true });
console.log(res.join('\n'));
