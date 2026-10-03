// A message sent while Claude Code is busy waits in a queue and reaches Claude mid-turn as a "queued_command"
// attachment, not as a user message: it must still show as what you said (app/transcript.js), through the agent's
// reader and the panel's merge -- background tasks' notifications, which come the same way, must not.
const path = require('path');
const R = path.resolve(__dirname, '..', '..');
const { recordsOf, mergeRecords } = require(R + '/app/transcript');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));

const att = (a, ts = '2026-10-03T18:57:05Z') => ({ type: 'attachment', uuid: 'x', timestamp: ts, attachment: { type: 'queued_command', ...a } });
const r1 = recordsOf(att({ prompt: '在你工作时插进来的一句', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true }));
chk('a queued message is a user record, with its time', r1.length === 1 && r1[0].role === 'user' && r1[0].text === '在你工作时插进来的一句' && r1[0].t === Date.parse('2026-10-03T18:57:05Z'), r1);
chk('a background task\'s notification queued the same way is not', recordsOf(att({ prompt: '<task-notification>…</task-notification>', commandMode: 'task-notification', humanTurn: false })).length === 0, 0);
chk('not a prompt (other modes) is not', recordsOf(att({ prompt: 'ls', commandMode: 'bash', humanTurn: true })).length === 0, 0);
chk('a prompt given as blocks: its text', recordsOf(att({ prompt: [{ type: 'text', text: '第一段' }, { type: 'image' }, { type: 'text', text: '第二段' }], commandMode: 'prompt' }))[0].text === '第一段\n第二段', 0);
chk('other attachments are not', recordsOf({ type: 'attachment', attachment: { type: 'edited_text_file', filename: 'a.js' } }).length === 0, 0);
// in order with the conversation, as the panel merges it
const out = [];
mergeRecords(out, recordsOf({ type: 'user', uuid: 'u1', timestamp: '2026-10-03T18:50:00Z', message: { role: 'user', content: '先做 A' } }));
mergeRecords(out, recordsOf({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-03T18:51:00Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '在做 A' }] } }));
mergeRecords(out, recordsOf(att({ prompt: '顺便把 B 也做了', commandMode: 'prompt', humanTurn: true }, '2026-10-03T18:52:00Z')));
mergeRecords(out, recordsOf({ type: 'assistant', uuid: 'a2', timestamp: '2026-10-03T18:53:00Z', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '好，A 和 B 都做了' }] } }));
chk('in the conversation where it reached Claude', JSON.stringify(out.map((m) => m.role + ':' + m.text)) === JSON.stringify(['user:先做 A', 'assistant:在做 A', 'user:顺便把 B 也做了', 'assistant:好，A 和 B 都做了']), out);
console.log(res.join('\n'));
