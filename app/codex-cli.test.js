'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-codex-cli-'));
process.env.USERPROFILE = process.env.HOME = HOME;                  // (codex-records.js looks under the home folder)
const codexCli = require('./codex-cli');
const records = require('./codex-records');
const transcript = require('./transcript');
const { createRemoteControl } = require('./remote-control');

const P = (pid, name) => ({ pid, name });
test('the Codex process of a hook: in a terminal, from the desktop app, started by us', () => {
  const cli = codexCli.findCodex([P(9, 'powershell.exe'), P(8, 'codex.exe'), P(7, 'node.exe'), P(6, 'pwsh.exe'), P(5, 'WindowsTerminal.exe')], 1);
  assert.deepEqual(cli, { pid: 8, parent: P(6, 'pwsh.exe'), own: false });        // npm's node.exe shim skipped
  assert.deepEqual(codexCli.findCodex([P(8, 'codex.exe'), P(6, 'cmd.exe')], 1).parent, P(6, 'cmd.exe'));
  assert.equal(codexCli.findCodex([P(8, 'codex.exe'), P(7, 'Codex.exe'), P(6, 'explorer.exe')], 1).parent.name, 'Codex.exe');   // the app: no shell
  assert.equal(codexCli.findCodex([P(9, 'powershell.exe'), P(8, 'codex.exe'), P(7, 'node.exe'), P(6, 'cmd.exe'), P(1, 'AmeTyping.exe')], 1).own, true);
  assert.equal(codexCli.findCodex([P(9, 'powershell.exe'), P(8, 'claude.exe')], 1), null);
});

function fakeBridge() {
  const log = [];
  const ok = { ok: true, v: '' };
  return { log, send: async (pid, t) => (log.push(['send', pid, t]), ok), type: async (pid, t) => (log.push(['type', pid, t]), ok),
    key: async (pid, k) => (log.push(['key', pid, k]), ok), ancestors: async () => [] };
}
test('a reply typed into Codex: one line as it is; several with Ctrl+J between them, Enter last', async () => {
  const b = fakeBridge();
  await codexCli.send(b, 5, '你好');
  assert.deepEqual(b.log, [['send', 5, '你好']]);
  b.log.length = 0;
  assert.equal((await codexCli.send(b, 5, '第一行\r\n\n第三行')).ok, true);
  assert.deepEqual(b.log, [['type', 5, '第一行'], ['key', 5, 'ctrlj'], ['key', 5, 'ctrlj'], ['type', 5, '第三行'], ['key', 5, 'enter']]);
});
test('reply to a Codex session through remote-control: its terminal when it is open, refused while it asks', async () => {
  const b = fakeBridge();
  const s = { id: 'codex:t', rawSession: 't', provider: 'codex', state: 'done', lines: [], claudePid: 5, terminal: true };
  let cards = [];
  const rc = createRemoteControl({ sessions: new Map([[s.id, s]]), permissions: { list: () => cards }, bridge: b, procAlive: async () => true, pushBubble: () => {}, home: () => HOME });
  assert.deepEqual(await rc.chatSend(s.id, 'a\nb'), { ok: true });
  assert.deepEqual(b.log.map((x) => x[0] + ':' + x[2]), ['key:clear', 'type:a', 'key:ctrlj', 'type:b', 'key:enter']);
  assert.deepEqual(await rc.chatKey(s.id, 'esc'), { ok: true });                   // keys reach it like Claude Code's
  cards = [{ id: 1 }];
  assert.match((await rc.chatSend(s.id, 'x')).msg, /等你确认/);
  cards = []; s.terminal = false;
  assert.match((await rc.chatSend(s.id, 'x')).msg, /不在终端里/);                    // the desktop app
});

test('a rollout read for the panel: found by its thread id, a first line longer than one read, the conversation', () => {
  const id = '01a0aaaa-0000-7000-8000-000000000001';
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const dir = path.join(HOME, '.codex', 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-x-${id}.jsonl`);
  const L = (o) => JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + '\n';
  fs.writeFileSync(file,
    L({ type: 'session_meta', payload: { id, cwd: 'D:\\work\\proj', base_instructions: { text: '说明'.repeat(60000) } } }) +
    L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '改一下字体' }] } }) +
    L({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['pwsh', '-c', 'ls'] }) } }) +
    L({ type: 'response_item', payload: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: '改好了。' }] } }) +
    L({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 1200 }, model_context_window: 760000 } } }));
  assert.deepEqual(records.metaOf(file), { id, cwd: 'D:\\work\\proj', sub: false });
  assert.equal(records.fileOf(id), file);
  assert.equal(records.fileOf('01a0aaaa-0000-7000-8000-00000000ffff'), null);
  assert.equal(records.fileOf('../x'), null);
  const cache = { file };
  assert.equal(transcript.poll(cache, records.recordsOf), true);
  assert.deepEqual(cache.msgs.map((m) => m.role + ':' + (m.text || m.items.join())), ['user:改一下字体', 'tool:运行 ls', 'assistant:改好了。']);
  assert.equal(cache.msgs.ctx, '1200/760000');
  fs.appendFileSync(file, L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '再大一点' }] } }));
  assert.equal(transcript.poll(cache, records.recordsOf), true);
  assert.equal(cache.msgs.at(-1).text, '再大一点');
  fs.rmSync(HOME, { recursive: true, force: true });
});
