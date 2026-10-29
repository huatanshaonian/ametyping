'use strict';
const { test, describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-agy-support-'));
process.env.AGY_HOME = tmpHome;

const agyRecords = require('./agy-records');
const agySessions = require('./agy-sessions');
const agyCli = require('./agy-cli');
const headlessAgy = require('../headless/agy');
const agySubagents = require('../remote/agent/agy-subagents');
const records = require('../remote/agent/records');

const ROOT_ID = '12345678-1234-4234-8234-123456789abc';
const SUB_ID = '87654321-4321-4321-8321-cba987654321';
const CWD = path.resolve('D:/projects/demo-agy');

describe('Antigravity Support Module Tests', () => {
  before(() => {
    // 1. Setup brain/<ROOT_ID>/.system_generated/logs/transcript.jsonl
    const rootBrain = path.join(tmpHome, 'brain', ROOT_ID, '.system_generated', 'logs');
    fs.mkdirSync(rootBrain, { recursive: true });
    const rootTransFile = path.join(rootBrain, 'transcript.jsonl');

    const lines = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content: 'Model Selection: Model: gemini-2.5-pro\nActive Workspaces:\n- ' + CWD + '\n<USER_REQUEST>测试主会话标题</USER_REQUEST>',
        created_at: new Date(Date.now() - 30000).toISOString(),
        cwd: CWD,
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        content: '准备就绪',
        created_at: new Date(Date.now() - 20000).toISOString(),
        cwd: CWD,
      }),
    ];
    fs.writeFileSync(rootTransFile, lines.join('\n') + '\n');

    // 2. Setup history.jsonl
    fs.writeFileSync(
      path.join(tmpHome, 'history.jsonl'),
      JSON.stringify({ conversationId: ROOT_ID, workspace: CWD, display: '历史记录中的标题' }) + '\n'
    );

    // 3. Setup subagent descriptor brain/<ROOT_ID>/.system_generated/subagents/<SUB_ID>.json
    const subDescDir = path.join(tmpHome, 'brain', ROOT_ID, '.system_generated', 'subagents');
    fs.mkdirSync(subDescDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDescDir, `${SUB_ID}.json`),
      JSON.stringify({
        subagentDescriptor: { typeName: 'researcher', role: '文档调研员' },
        workspaceUris: ['file://' + (process.platform === 'win32' ? '/' : '') + CWD.replace(/\\/g, '/')],
        state: 'RUNNING',
      })
    );

    // 4. Setup subagent transcript brain/<SUB_ID>/.system_generated/logs/transcript.jsonl
    const subBrain = path.join(tmpHome, 'brain', SUB_ID, '.system_generated', 'logs');
    fs.mkdirSync(subBrain, { recursive: true });
    fs.writeFileSync(
      path.join(subBrain, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>分析代码架构</USER_REQUEST>',
        created_at: new Date(Date.now() - 10000).toISOString(),
        cwd: CWD,
      }) + '\n' +
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'read_file', args: { Path: 'package.json' } }],
        created_at: new Date(Date.now() - 5000).toISOString(),
        cwd: CWD,
      }) + '\n'
    );
  });

  after(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  describe('app/agy-records.js file & metadata functions', () => {
    it('fileOf finds transcript for conversation ID', () => {
      const file = agyRecords.fileOf(ROOT_ID, tmpHome);
      assert.ok(file);
      assert.ok(file.includes(ROOT_ID));
      assert.ok(file.endsWith('transcript.jsonl'));
    });

    it('allFiles returns all conversation transcript files', () => {
      const files = agyRecords.allFiles(tmpHome);
      assert.equal(files.length, 2);
      assert.ok(files.some((f) => f.includes(ROOT_ID)));
      assert.ok(files.some((f) => f.includes(SUB_ID)));
    });

    it('recentFiles returns files sorted by mtime', () => {
      const recents = agyRecords.recentFiles(60000, Date.now(), tmpHome);
      assert.ok(recents.length >= 2);
      assert.ok(recents.some((r) => r.id === ROOT_ID));
      assert.ok(recents.some((r) => r.id === SUB_ID));
    });

    it('titleOf resolves title from history.jsonl or transcript', () => {
      const title = agyRecords.titleOf(ROOT_ID, tmpHome);
      assert.equal(title, '历史记录中的标题');
    });

    it('metaOf parses session metadata, model, AI, and subagent relations', () => {
      const rootFile = agyRecords.fileOf(ROOT_ID, tmpHome);
      const rootMeta = agyRecords.metaOf(rootFile, tmpHome);
      assert.equal(rootMeta.id, ROOT_ID);
      assert.equal(rootMeta.cwd, CWD);
      assert.equal(rootMeta.sub, false);
      assert.ok(rootMeta.model);
      assert.equal(rootMeta.model.providerID, 'google');
      assert.equal(rootMeta.model.id, 'gemini-2.5-pro');
      assert.ok(rootMeta.ai);
      assert.equal(rootMeta.ai.slug, 'google');

      const subFile = agyRecords.fileOf(SUB_ID, tmpHome);
      const subMeta = agyRecords.metaOf(subFile, tmpHome);
      assert.equal(subMeta.id, SUB_ID);
      assert.equal(subMeta.sub, true);
      assert.equal(subMeta.parent, ROOT_ID);
      assert.equal(subMeta.agentName, '文档调研员');
    });
  });

  describe('app/agy-records.js recordsOf parsing', () => {
    it('parses USER_INPUT with <USER_REQUEST> and skips EPHEMERAL/TASK_NOTIFICATION', () => {
      // 1. Standard user request
      const r1 = agyRecords.recordsOf({
        step_index: 0,
        type: 'USER_INPUT',
        content: 'System info\n<USER_REQUEST>请优化性能</USER_REQUEST>',
        created_at: '2026-10-30T00:00:00.000Z',
      });
      assert.equal(r1.length, 1);
      assert.equal(r1[0].role, 'user');
      assert.equal(r1[0].text, '请优化性能');

      // 2. Ephemeral message skipped
      const r2 = agyRecords.recordsOf({
        step_index: 1,
        type: 'USER_INPUT',
        content: '<EPHEMERAL_MESSAGE>transient guidelines</EPHEMERAL_MESSAGE>',
        created_at: '2026-10-30T00:00:01.000Z',
      });
      assert.equal(r2.length, 0);

      // 3. Task notification skipped
      const r3 = agyRecords.recordsOf({
        step_index: 2,
        type: 'USER_INPUT',
        content: '<TASK_NOTIFICATION>Background task finished</TASK_NOTIFICATION>',
        created_at: '2026-10-30T00:00:02.000Z',
      });
      assert.equal(r3.length, 0);
    });

    it('parses PLANNER_RESPONSE with tool_calls (cmd, write, edit, read) and extras', () => {
      const resp = agyRecords.recordsOf({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'npm run test' } },
          { name: 'write_file', args: { Path: 'src/main.js' } },
          { name: 'edit_file', args: { Path: 'src/utils.js' } },
          { name: 'read_file', args: { Path: 'README.md' } },
        ],
        content: '已执行命令并修改文件',
        token_usage: { input_tokens: 2500, output_tokens: 300, cache_read_tokens: 200 },
        created_at: '2026-10-30T00:01:00.000Z',
      });

      assert.equal(resp.length, 6); // 4 tool calls + 1 assistant content + 1 ctx record

      // Tool 1: cmd
      assert.equal(resp[0].role, 'tool');
      assert.equal(resp[0].x.op, 'cmd');
      assert.equal(resp[0].x.cmd, 'npm run test');

      // Tool 2: write
      assert.equal(resp[1].role, 'tool');
      assert.equal(resp[1].x.op, 'write');
      assert.deepEqual(resp[1].x.p, ['src/main.js']);

      // Tool 3: edit
      assert.equal(resp[2].role, 'tool');
      assert.equal(resp[2].x.op, 'edit');
      assert.deepEqual(resp[2].x.p, ['src/utils.js']);

      // Tool 4: read
      assert.equal(resp[3].role, 'tool');
      assert.equal(resp[3].x.op, 'read');
      assert.deepEqual(resp[3].x.p, ['README.md']);

      // Assistant text
      assert.equal(resp[4].role, 'assistant');
      assert.equal(resp[4].text, '已执行命令并修改文件');
      assert.equal(resp[4].mid, 'step-5');

      // Ctx token usage: 2500 + 300 + 200 = 3000
      assert.equal(resp[5].role, 'ctx');
      assert.equal(resp[5].text, '3000/1000000');
    });

    it('populates o.uuid and o.timestamp so remote reader streams valid records and cwd', () => {
      const rootFile = agyRecords.fileOf(ROOT_ID, tmpHome);
      const reader = records.createReader(rootFile, 0, agyRecords.recordsOf);
      reader.cwd = CWD;

      const batch = records.readNext(reader);
      assert.ok(batch);
      assert.equal(batch.cwd, CWD);
      assert.ok(batch.recs.length >= 2);
      assert.equal(batch.recs[0].role, 'user');
      assert.equal(batch.recs[0].text, '测试主会话标题');
      assert.ok(batch.recs[0].t > 0);
      assert.equal(batch.recs[1].role, 'assistant');
      assert.equal(batch.recs[1].text, '准备就绪');
      assert.ok(batch.recs[1].t > 0);
    });
  });

  describe('app/agy-sessions.js', () => {
    const sessionHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-agy-sessions-'));
    after(() => {
      try { fs.rmSync(sessionHome, { recursive: true, force: true }); } catch {}
    });

    it('remember, list, and forget manage session registry', () => {
      agySessions.remember({
        id: ROOT_ID,
        pid: 9876,
        cwd: CWD,
        title: '活跃会话',
      }, sessionHome);

      const list1 = agySessions.list(sessionHome);
      assert.equal(list1.length, 1);
      assert.equal(list1[0].id, ROOT_ID);
      assert.equal(list1[0].pid, 9876);
      assert.equal(list1[0].cwd, CWD);

      agySessions.forget(ROOT_ID, sessionHome);
      const list2 = agySessions.list(sessionHome);
      assert.equal(list2.length, 0);
    });
  });

  describe('app/agy-cli.js', () => {
    it('AGY_EXE regex matches agy and agy.exe', () => {
      assert.ok(agyCli.AGY_EXE.test('agy'));
      assert.ok(agyCli.AGY_EXE.test('agy.exe'));
      assert.ok(agyCli.AGY_EXE.test('AGY.EXE'));
      assert.ok(!agyCli.AGY_EXE.test('node.exe'));
      assert.ok(!agyCli.AGY_EXE.test('claude.exe'));
    });

    it('findAgy discovers agy in process chain skipping launcher shims', () => {
      const chain = [
        { pid: 101, name: 'agy.exe' },
        { pid: 100, name: 'cmd.exe' },
        { pid: 90, name: 'WindowsTerminal.exe' },
      ];
      const found = agyCli.findAgy(chain);
      assert.ok(found);
      assert.equal(found.pid, 101);
      // cmd.exe is a shim (e.g. agy.cmd), so parent skips to WindowsTerminal.exe
      assert.equal(found.parent.pid, 90);
    });

    it('greet interacts with screen prompts and sends message', async () => {
      let typed = [];
      const mockBridge = {
        screens: [
          'Do you trust the contents of this project?\n❯ 2. No\n1. Yes',
          'Antigravity CLI\nType your message below:',
        ],
        screenIdx: 0,
        async screen() {
          return this.screens[this.screenIdx++] || 'Antigravity CLI\nType your message below:';
        },
        async key(_pid, k) { typed.push('key:' + k); return { ok: true }; },
        async type(_pid, t) { typed.push('type:' + t); return { ok: true }; },
        async send(_pid, t) { typed.push('send:' + t); return { ok: true }; },
      };

      await agyCli.greet(mockBridge, 101, '你好糖糖');
      assert.ok(typed.some((e) => e === 'key:enter' || e === 'send:你好糖糖' || e === 'type:你好糖糖'));
    });

    it('started detects running agy descendant process', async () => {
      const mockBridge = {
        async descendants(pid) {
          if (pid === 200) return [{ pid: 201, name: 'agy.exe' }];
          return [];
        },
        async alive() { return true; },
      };

      const foundPid = await agyCli.started(mockBridge, 200, 2);
      assert.equal(foundPid, 201);
    });
  });

  describe('headless/agy.js', () => {
    it('threadOf parses agy session UUIDs', () => {
      assert.equal(headlessAgy.threadOf('agy:' + ROOT_ID), ROOT_ID);
      assert.equal(headlessAgy.threadOf('codex:' + ROOT_ID), null);
      assert.equal(headlessAgy.threadOf('invalid-id'), null);
    });

    it('execResumeArgs formats CLI arguments', () => {
      const args = headlessAgy.execResumeArgs(ROOT_ID);
      assert.deepEqual(args, ['--conversation', ROOT_ID, '-p', '--dangerously-skip-permissions']);
    });
  });

  describe('remote/agent/agy-subagents.js', () => {
    it('scan(home) scans descriptors and returns subagents grouped by parent conversation', () => {
      const map = agySubagents.scan(tmpHome);
      assert.ok(map instanceof Map);
      const rows = map.get('agy:' + ROOT_ID);
      assert.ok(rows, 'Expected rows for parent agy:' + ROOT_ID);
      assert.equal(rows.length, 1);
      const sub = rows[0];
      assert.equal(sub.id, SUB_ID);
      assert.equal(sub.type, 'researcher');
      assert.equal(sub.name, '文档调研员');
      assert.equal(sub.state, 'run');
      assert.match(sub.act, /package\.json/);
      assert.ok(sub.t0 > 0);
      assert.ok(sub.last > 0);
    });
  });
});
