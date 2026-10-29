'use strict';
const { test, describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');

const { handleEvent, mapHook, decisionFor, decision, parseArgs, cleanUserRequest } = require('./agy-hook');
const { install, uninstall, mergeHooks, removeHooks, commandFor, EVENTS } = require('./install-agy-hooks');

describe('Antigravity (agy) Hook & Installer', () => {
  const rootId = '11111111-2222-3333-4444-555555555555';
  const subId = '99999999-8888-7777-6666-555555555555';
  const cwd = path.resolve('D:/work/demo-agy');

  it('SessionStart maps to /event/idle with provider agy, session, project, cwd, transcript, model and ai', () => {
    const input = {
      conversation_id: rootId,
      workspacePaths: [cwd],
      transcriptPath: path.join(cwd, 'transcript.jsonl'),
      modelName: 'gemini-2.5-pro',
      hook_event_name: 'SessionStart',
    };
    const r = handleEvent(input);
    assert.equal(r.endpoint, '/event/idle');
    assert.equal(r.route, '/event/idle');
    assert.equal(r.payload.provider, 'agy');
    assert.equal(r.payload.session, rootId);
    assert.equal(r.payload.cwd, cwd);
    assert.equal(r.payload.project, 'demo-agy');
    assert.equal(r.payload.transcript, path.join(cwd, 'transcript.jsonl'));
    assert.ok(r.payload.model);
    assert.equal(r.payload.model.providerID, 'google');
    assert.equal(r.payload.model.id, 'gemini-2.5-pro');
    assert.ok(r.payload.ai);
    assert.equal(r.payload.ai.slug, 'google');
  });

  it('PreInvocation maps to /event/message with prompt text', () => {
    const input = {
      conversationId: rootId,
      lastUserInput: '<USER_REQUEST>请重构训练模块代码</USER_REQUEST>',
      hook_event_name: 'PreInvocation',
    };
    const r = handleEvent(input);
    assert.equal(r.endpoint, '/event/message');
    assert.equal(r.payload.session, rootId);
    assert.equal(r.payload.prompt, '请重构训练模块代码');
    assert.match(r.payload.text, /请重构训练模块代码/);
  });

  it('PreToolUse distinguishes thinking vs reading tools and unquotes JSON-stringified tool_input', () => {
    // 1. run_command -> thinking
    const runRes = handleEvent({
      conversationId: rootId,
      tool_name: 'run_command',
      tool_input: '{"CommandLine":"npm test"}',
      hook_event_name: 'PreToolUse',
    });
    assert.equal(runRes.endpoint, '/event/thinking');
    assert.match(runRes.payload.text, /npm test/);

    // 2. edit_file -> thinking
    const editRes = handleEvent({
      conversationId: rootId,
      toolCall: { name: 'edit_file', args: { Path: '"app/index.js"' } },
      hook_event_name: 'PreToolUse',
    });
    assert.equal(editRes.endpoint, '/event/thinking');
    assert.match(editRes.payload.text, /index\.js/);

    // 3. write_file -> thinking
    const writeRes = handleEvent({
      conversationId: rootId,
      toolCall: { name: 'write_file', args: { Path: 'docs/README.md' } },
      hook_event_name: 'PreToolUse',
    });
    assert.equal(writeRes.endpoint, '/event/thinking');
    assert.match(writeRes.payload.text, /README\.md/);

    // 4. read_file -> reading
    const readRes = handleEvent({
      conversationId: rootId,
      toolCall: { name: 'read_file', args: { Path: 'package.json' } },
      hook_event_name: 'PreToolUse',
    });
    assert.equal(readRes.endpoint, '/event/reading');
    assert.match(readRes.payload.text, /package\.json/);

    // 5. search_web -> reading
    const searchRes = handleEvent({
      conversationId: rootId,
      toolCall: { name: 'search_web', args: { query: 'Antigravity hooks' } },
      hook_event_name: 'PreToolUse',
    });
    assert.equal(searchRes.endpoint, '/event/reading');
    assert.match(searchRes.payload.text, /Antigravity hooks/);

    // 6. invoke_subagent -> thinking
    const subRes = handleEvent({
      conversationId: rootId,
      toolCall: { name: 'invoke_subagent', args: { Role: 'Code Reviewer' } },
      hook_event_name: 'PreToolUse',
    });
    assert.equal(subRes.endpoint, '/event/thinking');
    assert.match(subRes.payload.text, /Code Reviewer/);
  });

  it('PreToolUse with ask_question routes to /permission with normalized questions', () => {
    const input = {
      conversationId: rootId,
      tool_name: 'ask_question',
      tool_input: {
        questions: [
          {
            question: '是否确认提交？',
            header: '确认',
            is_multi_select: false,
            options: ['是', '否'],
          },
        ],
      },
      hook_event_name: 'PreToolUse',
    };
    const r = handleEvent(input);
    assert.ok(r.permission);
    assert.equal(r.endpoint, '/permission');
    assert.equal(r.permission.tool, 'AskUserQuestion');
    assert.equal(r.permission.session, rootId);
    assert.equal(r.permission.input.questions.length, 1);
    assert.equal(r.permission.input.questions[0].question, '是否确认提交？');
    assert.equal(r.permission.input.questions[0].options[0].label, '是');

    // Test answering ask_question: returns permissionDecision 'deny' with formatted answers
    const perm = r.permission;
    const answered = decisionFor({
      choice: 'allow',
      updatedInput: { answers: { '是否确认提交？': '是' } },
    }, perm);
    assert.equal(answered.permissionDecision, 'deny');
    assert.match(answered.permissionDecisionReason, /已由用户在糖糖看板回答：/);
    assert.match(answered.permissionDecisionReason, /- 是否确认提交？: 是/);

    // Test chat reason for ask_question
    const chatDec = decisionFor({
      choice: 'deny',
      message: '用户选择稍后再处理',
    }, perm);
    assert.equal(chatDec.permissionDecision, 'deny');
    assert.equal(chatDec.permissionDecisionReason, '用户选择稍后再处理');
  });

  it('PermissionRequest returns allow, allow + updatedPermissions (always), deny + message, or {} (defer)', () => {
    const input = {
      conversationId: rootId,
      hook_event_name: 'PermissionRequest',
      tool_name: 'run_command',
      tool_input: { CommandLine: 'npm run build' },
    };
    const r = handleEvent(input);
    assert.ok(r.permission);
    assert.equal(r.permission.tool, 'Bash');
    assert.equal(r.permission.alwaysRule, 'command(npm)');

    const perm = r.permission;

    // allow
    assert.deepEqual(decisionFor({ choice: 'allow' }, perm), {
      decision: 'allow',
      permissionDecision: 'allow',
    });

    // always -> allow + updatedPermissions
    const alwaysRes = decisionFor({ choice: 'always' }, perm);
    assert.equal(alwaysRes.decision, 'allow');
    assert.equal(alwaysRes.permissionDecision, 'allow');
    assert.deepEqual(alwaysRes.updatedPermissions, ['command(npm)']);
    assert.deepEqual(alwaysRes.permissionOverrides, ['command(npm)']);

    // deny + message
    const denyRes = decisionFor({ choice: 'deny', message: '禁止运行 build 命令' }, perm);
    assert.equal(denyRes.decision, 'deny');
    assert.equal(denyRes.permissionDecision, 'deny');
    assert.equal(denyRes.message, '禁止运行 build 命令');

    // defer -> {}
    assert.deepEqual(decisionFor({ choice: 'defer' }, perm), {});
  });

  it('SubagentStart and SubagentStop handle parent mapping in $TMPDIR/ame-agy-root-<id> and agentId forwarding', () => {
    const mapFile = path.join(os.tmpdir(), `ame-agy-root-${subId}`);
    try { fs.unlinkSync(mapFile); } catch {}

    // SubagentStart: records parent mapping and forwards agentId
    const startRes = handleEvent({
      conversationId: rootId,
      subagentConversationId: subId,
      agentName: 'worker',
      hook_event_name: 'SubagentStart',
    });
    assert.equal(startRes.endpoint, '/event/thinking');
    assert.equal(startRes.payload.session, rootId);
    assert.equal(startRes.payload.agentId, subId);
    assert.ok(fs.existsSync(mapFile), 'Mapping file should be written in $TMPDIR');
    assert.equal(fs.readFileSync(mapFile, 'utf8').trim(), rootId);

    // Subsequent tool call from the subagent using only its conversationId
    const subToolRes = handleEvent({
      conversationId: subId,
      toolCall: { name: 'run_command', args: { CommandLine: 'pytest' } },
      hook_event_name: 'PreToolUse',
    });
    assert.equal(subToolRes.payload.session, rootId);
    assert.equal(subToolRes.payload.agentId, subId);

    // SubagentStop: deletes mapping and forwards agentId
    const stopRes = handleEvent({
      conversationId: rootId,
      subagentConversationId: subId,
      hook_event_name: 'SubagentStop',
    });
    assert.equal(stopRes.endpoint, '/event/thinking');
    assert.equal(stopRes.payload.session, rootId);
    assert.equal(stopRes.payload.agentId, subId);
    assert.ok(!fs.existsSync(mapFile), 'Mapping file should be deleted on SubagentStop');
  });

  it('Stop maps to /event/done with last_assistant_message', () => {
    const input = {
      conversationId: rootId,
      last_assistant_message: '任务已顺利完成，所有测试通过。',
      hook_event_name: 'Stop',
    };
    const r = handleEvent(input);
    assert.equal(r.endpoint, '/event/done');
    assert.equal(r.payload.session, rootId);
    assert.equal(r.payload.last_assistant_message, '任务已顺利完成，所有测试通过。');
    assert.match(r.payload.text, /任务已顺利完成/);
  });

  it('SessionEnd maps to /event/quit', () => {
    const input = {
      conversationId: rootId,
      hook_event_name: 'SessionEnd',
    };
    const r = handleEvent(input);
    assert.equal(r.endpoint, '/event/quit');
    assert.equal(r.payload.session, rootId);
  });

  describe('install-agy-hooks.js', () => {
    let tmpDir;
    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-agy-hooks-test-'));
    });
    after(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('install(dir) creates hooks.json with top-level "ametyping" and all 9 lifecycle events', () => {
      install(tmpDir);
      const target = path.join(tmpDir, 'hooks.json');
      assert.ok(fs.existsSync(target));
      const content = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.ok(content.ametyping);

      const expectedEvents = [
        'SessionStart',
        'PreInvocation',
        'PreToolUse',
        'PostToolUse',
        'PostInvocation',
        'SubagentStart',
        'SubagentStop',
        'Stop',
        'SessionEnd',
      ];
      assert.equal(EVENTS.length, 9);
      for (const ev of expectedEvents) {
        assert.ok(content.ametyping[ev], `Missing hook event ${ev}`);
        assert.ok(Array.isArray(content.ametyping[ev]));
      }
    });

    it('install(dir) preserves existing hook groups and backs up before modifying', () => {
      const target = path.join(tmpDir, 'hooks.json');
      const customConfig = {
        'custom-gate': {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo custom' }] }],
        },
      };
      fs.writeFileSync(target, JSON.stringify(customConfig, null, 2));

      install(tmpDir);

      // Verify backup created
      const files = fs.readdirSync(tmpDir);
      assert.ok(files.some((f) => f.startsWith('hooks.json.ame-backup-')));

      // Verify custom-gate preserved and ametyping added
      const updated = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.ok(updated['custom-gate']);
      assert.ok(updated.ametyping);
      assert.equal(updated['custom-gate'].PreToolUse[0].matcher, 'Bash');
    });

    it('install(dir) throws on malformed JSON without overwriting', () => {
      const target = path.join(tmpDir, 'hooks.json');
      const badContent = '{ "custom-gate": "broken json ...';
      fs.writeFileSync(target, badContent);

      assert.throws(() => {
        install(tmpDir);
      }, SyntaxError);

      assert.equal(fs.readFileSync(target, 'utf8'), badContent);
    });

    it('uninstall(dir) removes "ametyping" while keeping other hook groups', () => {
      const target = path.join(tmpDir, 'hooks.json');
      const existing = {
        'custom-gate': {
          Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
        },
      };
      fs.writeFileSync(target, JSON.stringify(mergeHooks(existing), null, 2));

      uninstall(tmpDir);

      const remaining = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.equal(remaining.ametyping, undefined);
      assert.ok(remaining['custom-gate']);
      assert.equal(remaining['custom-gate'].Stop[0].hooks[0].command, 'echo bye');
    });
  });

  describe('Real Child Process Interaction', () => {
    function runChild(port, input, argEvent = '') {
      return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'agy-hook.js');
        const args = [scriptPath];
        if (argEvent) args.push(argEvent);
        const p = spawn(process.execPath, args, {
          env: { ...process.env, AME_PORT: String(port) },
          windowsHide: true,
        });
        let stdout = '', stderr = '';
        const timeout = setTimeout(() => { p.kill(); reject(new Error('hook timed out')); }, 5000);
        p.stdout.on('data', (c) => stdout += c);
        p.stderr.on('data', (c) => stderr += c);
        p.on('error', reject);
        p.on('exit', (code) => {
          clearTimeout(timeout);
          resolve({ code, stdout, stderr });
        });
        p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
      });
    }

    it('real hook process -> HTTP relay -> decision / event delivery', async (t) => {
      let choice = 'allow', received;
      const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => body += c);
        req.on('end', () => {
          received = { route: req.url, body: JSON.parse(body || '{}') };
          if (req.url === '/permission') {
            res.setHeader('Content-Type', 'application/json');
            if (choice === 'ask-answer') {
              res.end(JSON.stringify({
                choice: 'allow',
                updatedInput: { answers: { '选择分支': 'main' } },
              }));
            } else if (choice === 'always') {
              res.end(JSON.stringify({ choice: 'always', always: true }));
            } else if (choice === 'deny') {
              res.end(JSON.stringify({ choice: 'deny', message: '操作被管理员拒绝' }));
            } else if (choice === 'defer') {
              res.end(JSON.stringify({ choice: 'defer' }));
            } else {
              res.end(JSON.stringify({ choice: 'allow' }));
            }
          } else {
            res.statusCode = 200;
            res.end();
          }
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => { server.closeAllConnections(); server.close(); });
      const port = server.address().port;

      // 1. SessionStart event
      const startRes = await runChild(port, {
        conversationId: rootId,
        cwd: 'D:/work/demo',
        modelName: 'gemini-2.5-pro',
        hook_event_name: 'SessionStart',
      });
      assert.equal(startRes.code, 0);
      assert.equal(received.route, '/event/idle');
      assert.equal(received.body.provider, 'agy');

      // 2. Permission Request -> always
      choice = 'always';
      const permRes = await runChild(port, {
        conversationId: rootId,
        hook_event_name: 'PermissionRequest',
        tool_name: 'run_command',
        tool_input: { CommandLine: 'git push origin main' },
      });
      assert.equal(permRes.code, 0);
      assert.equal(received.route, '/permission');
      const alwaysParsed = JSON.parse(permRes.stdout);
      assert.equal(alwaysParsed.decision, 'allow');
      assert.equal(alwaysParsed.permissionDecision, 'allow');
      assert.deepEqual(alwaysParsed.updatedPermissions, ['command(git)']);

      // 3. Ask question -> answered
      choice = 'ask-answer';
      const askRes = await runChild(port, {
        conversationId: rootId,
        hook_event_name: 'PreToolUse',
        tool_name: 'ask_question',
        tool_input: {
          questions: [{ question: '选择分支', options: ['main', 'dev'] }],
        },
      });
      assert.equal(askRes.code, 0);
      const askParsed = JSON.parse(askRes.stdout);
      assert.equal(askParsed.permissionDecision, 'deny');
      assert.match(askParsed.permissionDecisionReason, /已由用户在糖糖看板回答：/);
      assert.match(askParsed.permissionDecisionReason, /- 选择分支: main/);

      // 4. Stop event
      const stopRes = await runChild(port, {
        conversationId: rootId,
        hook_event_name: 'Stop',
        last_assistant_message: '执行完成',
      });
      assert.equal(stopRes.code, 0);
      assert.equal(received.route, '/event/done');
      assert.equal(received.body.last_assistant_message, '执行完成');

      // 5. Malformed stdin handles gracefully
      const malformedRes = await runChild(port, '{ bad json');
      assert.equal(malformedRes.code, 0);
      assert.deepEqual(JSON.parse(malformedRes.stdout), {});
    });
  });
});
