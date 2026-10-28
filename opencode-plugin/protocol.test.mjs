// The OpenCode plugin's pure parts: event mapping, the conversation mirror's records, and the screen text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordsForMessages, mapEvent, screenText, toolLine, toolExtra } from './protocol.js';

const user = { id: 'm1', type: 'user', time: { created: 1700000000000 }, text: '把字体改一下' };
const assistant = {
  id: 'm2', type: 'assistant', time: { created: 1700000001000, completed: 1700000003000 }, finish: 'stop',
  content: [
    { type: 'text', text: '改好了。' },
    { type: 'reasoning', text: 'SECRET-REASONING' },
    { type: 'tool', id: 'c1', name: 'shell', state: { status: 'completed', input: { command: 'npm test' }, content: [] } },
    { type: 'tool', id: 'c2', name: 'edit', state: { status: 'completed', input: { filePath: 'src/font.css' }, content: [] } },
  ],
};

test('tool lines: the same one-line form as the other providers', () => {
  assert.equal(toolLine('bash', { command: 'npm test' }), '运行 npm test');
  assert.equal(toolLine('shell', { command: ['cmd.exe', '/c', 'npm test'] }), '运行 npm test');
  assert.equal(toolLine('edit', { filePath: '/a/b/gui.py' }), '修改 gui.py');
  assert.equal(toolLine('read', { filePath: 'gui.py' }), '读 gui.py');
  assert.equal(toolLine('task', { description: 'review it' }), '子代理：review it');
  assert.equal(toolLine('mystery', {}), '使用 mystery');
  assert.deepEqual(toolExtra('bash', { command: 'ls' }), { op: 'cmd', cmd: 'ls' });
  assert.deepEqual(toolExtra('edit', { filePath: 'a.js' }), { op: 'edit', p: ['a.js'] });
});

test('records: finished text in full, tools one line, reasoning and tool output left out', () => {
  const recs = recordsForMessages([user, assistant], 'D:\\proj');
  assert.equal(recs.length, 4);
  assert.deepEqual([recs[0].role, recs[0].text], ['user', '把字体改一下']);
  assert.deepEqual([recs[1].role, recs[1].text], ['assistant', '改好了。']);
  assert.deepEqual([recs[2].role, recs[3].role], ['tool', 'tool']);
  assert.equal(recs[0].cwd, 'D:\\proj');
  const text = JSON.stringify(recs);
  assert.ok(!/SECRET-REASONING/.test(text));
  assert.ok(/运行 npm test/.test(text) && /修改 font\.css/.test(text));
});

test('records: a message still streaming waits for its next event', () => {
  const partial = { ...assistant, time: { created: 1700000001000 }, finish: undefined };
  const recs = recordsForMessages([partial], '/p');
  assert.equal(recs.filter((r) => r.role === 'assistant').length, 0);
  assert.equal(recs.filter((r) => r.role === 'tool').length, 2);   // the tools already ran
});

test('records: compaction is a note, not a user message', () => {
  const recs = recordsForMessages([{ id: 'c', type: 'compaction', status: 'completed', time: { created: 1 } }], '/p');
  assert.deepEqual(recs.map((r) => [r.role, r.text]), [['sys', '（上下文已压缩）']]);
});

test('events: progress maps onto the pet/dashboard vocabulary', () => {
  const st = { cwd: '/work/proj', title: '标题', lastText: '改好了。', transcript: '/x.jsonl' };
  const d = (type, data = {}) => ({ id: 'evt1', type, data: { sessionID: 'ses_x', ...data } });
  assert.equal(mapEvent(d('session.execution.started'), st).name, 'thinking');
  assert.deepEqual([mapEvent(d('session.execution.succeeded'), st).name, mapEvent(d('session.execution.succeeded'), st).text], ['done', '完成了：改好了。']);
  assert.equal(mapEvent(d('session.execution.failed', { error: { message: 'boom' } })).text, '出错了：boom');
  assert.equal(mapEvent(d('session.execution.interrupted')).name, 'paused');
  assert.equal(mapEvent(d('session.compaction.started')).text, '正在压缩上下文');
  assert.equal(mapEvent(d('session.created')).name, 'idle');
  assert.equal(mapEvent(d('session.renamed', { title: '新名字' }), st).name, 'meta');
  assert.equal(mapEvent(d('session.renamed', { title: '新名字' }), st).title, '新名字');
  assert.equal(mapEvent(d('session.deleted')).name, 'quit');
  assert.equal(mapEvent(d('server.connected')), null);
  const perm = mapEvent(d('permission.asked', { id: 'p1', action: 'bash', resources: ['npm test'], save: ['npm *'] }));
  assert.deepEqual(perm, { type: 'permission', action: 'bash', resources: ['npm test'], save: ['npm *'], message: undefined, metadata: undefined });
});

test('screen: a readable rendering of the conversation', () => {
  const text = screenText([user, assistant]);
  assert.ok(/> 把字体改一下/.test(text) && /改好了。/.test(text) && /\[ 运行 npm test \]/.test(text));
});
