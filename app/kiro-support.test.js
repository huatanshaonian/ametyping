'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// a synthetic Kiro session store (one jsonl + its .json) under a temp KIRO_HOME, in the real on-disk shape
function makeStore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-kiro-store-'));
  const dir = path.join(home, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(dir, { recursive: true });
  const jsonl = [
    { version: 1, kind: 'Prompt', data: { message_id: 'm0', content: [{ kind: 'text', data: '帮我改一下 main.rs' }], meta: { timestamp: 1700000000 } } },
    { version: 1, kind: 'AssistantMessage', data: { message_id: 'm1', content: [
      { kind: 'thinking', data: { text: 'let me look', signature: 's', redactedContent: [], modelId: 'x', toolsDigest: 'd' } },
      { kind: 'text', data: '好的，我先看看文件。' },
      { kind: 'toolUse', data: { toolUseId: 't0', name: 'read', input: { __tool_use_purpose: 'inspect', operations: [{ path: 'D:/proj/src/main.rs' }] } } },
    ] } },
    { version: 1, kind: 'ToolResults', data: { message_id: 'm1', content: [{ kind: 'toolResult', data: { toolUseId: 't0', content: [], status: 'success' } }], results: [{ toolUseId: 't0', status: 'success' }] } },
    { version: 1, kind: 'AssistantMessage', data: { message_id: 'm2', content: [
      { kind: 'text', data: '改完了。' },
      { kind: 'toolUse', data: { toolUseId: 't1', name: 'write', input: { path: 'D:/proj/src/main.rs' } } },
      { kind: 'toolUse', data: { toolUseId: 't2', name: 'shell', input: { command: 'cargo test' } } },
    ] } },
    { version: 1, kind: 'ToolResults', data: { message_id: 'm2', content: [{ kind: 'toolResult', data: { toolUseId: 't2', status: 'error' } }], results: [{ toolUseId: 't2', status: 'error' }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, SID + '.jsonl'), jsonl);
  fs.writeFileSync(path.join(dir, SID + '.json'), JSON.stringify({
    session_id: SID, cwd: 'D:/proj', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:05:00Z',
    title: '帮我改一下 main.rs', session_created_reason: 'user_prompt',
    session_state: { version: 'v1', conversation_metadata: { user_turn_metadatas: [
      { model: 'claude-sonnet-4.5', context_usage_percentage: 12.5 },
    ] } },
  }));
  return { home, dir };
}

function withStore(fn) {
  const { home, dir } = makeStore();
  const prev = process.env.KIRO_HOME;
  process.env.KIRO_HOME = path.join(home, '.kiro');
  delete require.cache[require.resolve('./kiro-records')];
  const kiro = require('./kiro-records');
  try { return fn(kiro, dir); }
  finally {
    if (prev === undefined) delete process.env.KIRO_HOME; else process.env.KIRO_HOME = prev;
    delete require.cache[require.resolve('./kiro-records')];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('recordsOf turns the jsonl log into slim records (user/assistant/tool/sys), folding thinking away', () => {
  withStore((kiro, dir) => {
    const file = path.join(dir, SID + '.jsonl');
    const recs = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) { if (line.trim()) recs.push(...kiro.recordsOf(JSON.parse(line))); }
    const user = recs.filter((r) => r.role === 'user');
    const asst = recs.filter((r) => r.role === 'assistant');
    const tools = recs.filter((r) => r.role === 'tool');
    assert.equal(user.length, 1);
    assert.equal(user[0].text, '帮我改一下 main.rs');
    assert.equal(user[0].t, 1700000000 * 1000);                 // Unix seconds -> ms
    assert.equal(asst.length, 2);
    assert.ok(asst.every((r) => !/let me look/.test(r.text)), 'thinking content is folded away');
    assert.equal(tools.length, 3);                               // read, write, shell
    const read = tools.find((r) => r.x && r.x.op === 'read');
    assert.deepEqual(read.x.p, ['D:/proj/src/main.rs']);
    const write = tools.find((r) => r.x && r.x.op === 'write');
    assert.deepEqual(write.x.p, ['D:/proj/src/main.rs']);
    const shell = tools.find((r) => r.x && r.x.op === 'cmd');
    assert.equal(shell.x.cmd, 'cargo test');
    assert.ok(recs.some((r) => r.role === 'sys' && /出错/.test(r.text)), 'an error tool result is flagged');
  });
});

test('metaOf/titleOf/fileOf/recentFiles read the sibling .json', () => {
  withStore((kiro, dir) => {
    const file = path.join(dir, SID + '.jsonl');
    const m = kiro.metaOf(file);
    assert.equal(m.id, SID);
    assert.equal(m.cwd, 'D:/proj');
    assert.equal(m.title, '帮我改一下 main.rs');
    assert.equal(m.sub, false);                                  // session_created_reason is not "subagent"
    assert.deepEqual(m.model, { providerID: '', id: 'claude-sonnet-4.5' });
    assert.equal(kiro.titleOf(SID), '帮我改一下 main.rs');
    assert.equal(kiro.fileOf(SID), file);
    assert.equal(kiro.fileOf('kiro:' + SID), file);              // the "kiro:" prefix is stripped
    assert.equal(kiro.fileOf('not-a-uuid'), null);
    assert.ok(kiro.recentFiles(60 * 60e3).some((f) => f.file === file));
  });
});

test('session_created_reason "subagent" alone does NOT hide a top-level session; a real parent does', () => {
  const { home, dir } = makeStore();
  const prev = process.env.KIRO_HOME; process.env.KIRO_HOME = path.join(home, '.kiro');
  delete require.cache[require.resolve('./kiro-records')];
  try {
    const kiro = require('./kiro-records');
    // Kiro tags many top-level sessions "subagent" with parent_id null -- these MUST still be listed
    fs.writeFileSync(path.join(dir, SID + '.json'), JSON.stringify({ session_id: SID, cwd: 'D:/p', title: 't', session_created_reason: 'subagent', parent_id: null }));
    assert.equal(kiro.metaOf(path.join(dir, SID + '.jsonl')).sub, false, 'subagent + parent_id:null is a root session');
    // only a real parent pointer marks it as a nested sub-session
    const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    fs.writeFileSync(path.join(dir, CHILD + '.jsonl'), '');
    fs.writeFileSync(path.join(dir, CHILD + '.json'), JSON.stringify({ session_id: CHILD, cwd: 'D:/p', title: 'c', session_created_reason: 'subagent', parent_id: SID }));
    assert.equal(kiro.metaOf(path.join(dir, CHILD + '.jsonl')).sub, true, 'a real parent_id makes it a sub-session');
  } finally {
    if (prev === undefined) delete process.env.KIRO_HOME; else process.env.KIRO_HOME = prev;
    delete require.cache[require.resolve('./kiro-records')];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the model name maps to the right vendor badge', () => {
  const { aiOf } = require('./ai-providers');
  assert.deepEqual(aiOf({ providerID: '', id: 'claude-sonnet-4.5' }), { slug: 'anthropic', name: 'Anthropic' });
  assert.equal(aiOf({ providerID: '', id: 'auto' }), null);     // the dynamic "auto" model: only the Kiro mark, no vendor
});

test('every model family Kiro can switch to resolves to a vendor badge', () => {
  const { aiOf } = require('./ai-providers');
  // the model ids Kiro exposes across its providers (docs: /model, /effort)
  const expect = {
    'claude-sonnet-4.5': 'anthropic', 'claude-opus-4.7': 'anthropic', 'anthropic.claude-3-5-sonnet-20241022-v2:0': 'anthropic',
    'openai-gpt-5.4': 'openai', 'openai-gpt-5.5-1p': 'openai', 'openai-gpt-oss-20b': 'openai',
    'gemini-2.5-pro': 'google', 'minimax-m2': 'minimax', 'glm-4.6': 'zhipuai', 'kimi-k2.5': 'moonshotai',
    'qwen3-coder': 'alibaba', 'nemotron-super-3-120b': 'nvidia',
  };
  for (const [id, slug] of Object.entries(expect)) {
    const r = aiOf({ providerID: '', id });
    assert.ok(r && r.slug === slug, `${id} -> ${r ? r.slug : '(no badge)'}, expected ${slug}`);
  }
  assert.equal(aiOf({ providerID: '', id: 'auto' }), null);     // dynamic model: no vendor guess
});

test('kiro-cli resumeArgs builds the headless resume command; findKiro walks the process chain', () => {
  const kiroCli = require('./kiro-cli');
  assert.deepEqual(kiroCli.resumeArgs(SID, '继续'), ['chat', '--resume-id', SID, '--no-interactive', '--trust-all-tools', '继续']);
  assert.deepEqual(kiroCli.resumeArgs('kiro:' + SID, 'x'), ['chat', '--resume-id', SID, '--no-interactive', '--trust-all-tools', 'x']);
  assert.equal(kiroCli.resumeArgs('bad', 'x'), null);
  // findKiro: the outermost kiro-cli.exe in the ancestor chain, shim skipped
  const chain = [{ pid: 20, name: 'conhost.exe' }, { pid: 19, name: 'kiro-cli.exe' }, { pid: 18, name: 'node.exe' }, { pid: 8, name: 'WindowsTerminal.exe' }];
  const f = kiroCli.findKiro(chain, 0);
  assert.equal(f.pid, 19);
  assert.equal(kiroCli.findKiro([{ pid: 1, name: 'explorer.exe' }], 0), null);
});

test('kiro-sessions remember / list / forget', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-kiro-sess-'));
  const kiroSessions = require('./kiro-sessions');
  try {
    kiroSessions.remember({ provider: 'kiro', rawSession: SID, claudePid: 4321, processIdentity: 'boot:42', cwd: 'D:/p', title: 't' }, home);
    const list = kiroSessions.list(home);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, SID);
    assert.equal(list[0].pid, 4321);
    assert.equal(list[0].identity, 'boot:42');
    // a non-kiro session, or one without a process identity, is not stored
    kiroSessions.remember({ provider: 'codex', rawSession: SID, claudePid: 5, processIdentity: 'x' }, home);
    kiroSessions.remember({ provider: 'kiro', rawSession: SID, claudePid: 6 }, home);   // no identity
    kiroSessions.forget(SID, home);
    assert.equal(kiroSessions.list(home).length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
