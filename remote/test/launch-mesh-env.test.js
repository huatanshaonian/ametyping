'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { createRemoteControl, cleanMeshEnv: winCleanMeshEnv } = require('../../app/remote-control');
const { cleanMeshEnv: linuxCleanMeshEnv, buildTail } = require('../../headless/launch');

test('cleanMeshEnv accepts only valid AME_PROJECT_ID and AME_NODE_ID strings', () => {
  for (const clean of [winCleanMeshEnv, linuxCleanMeshEnv]) {
    assert.equal(clean(null), null);
    assert.equal(clean(undefined), null);
    assert.equal(clean('proj_1'), null);
    assert.equal(clean(['AME_PROJECT_ID']), null);
    assert.equal(clean({}), null);
    assert.equal(clean({ OTHER: 'abc', PATH: '/tmp' }), null);
    assert.equal(clean({ AME_PROJECT_ID: 123, AME_NODE_ID: true }), null);
    assert.equal(clean({ AME_PROJECT_ID: '', AME_NODE_ID: 'bad value' }), null);
    assert.equal(clean({ AME_PROJECT_ID: 'a;rm -rf /', AME_NODE_ID: '$(calc)' }), null);
    assert.equal(clean({ AME_PROJECT_ID: 'a'.repeat(61) }), null);

    const maxId = 'A'.repeat(60);
    assert.deepEqual(
      clean({ AME_PROJECT_ID: maxId, AME_NODE_ID: 'node_01-alpha', EXTRA: 'ignored' }),
      { AME_PROJECT_ID: maxId, AME_NODE_ID: 'node_01-alpha' },
    );
    assert.deepEqual(clean({ AME_PROJECT_ID: 'proj-1' }), { AME_PROJECT_ID: 'proj-1' });
  }
});

test('Windows launch keeps direct exe/args without meshEnv and wraps in PowerShell with meshEnv', { skip: process.platform !== 'win32' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-mesh-win-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const claudeExe = path.join(bin, 'claude.exe');
  const opencodeExe = path.join(bin, 'opencode.exe');
  fs.writeFileSync(claudeExe, '');
  fs.writeFileSync(opencodeExe, '');

  const oldPath = process.env.PATH;
  const oldCcHome = process.env.AME_CC_HOME;
  process.env.PATH = bin;
  process.env.AME_CC_HOME = path.join(home, 'cc-environments');

  const calls = [];
  const bridge = {
    launch: async (...args) => { calls.push(args); return 4321; },
    screen: async () => null,
  };
  const rc = createRemoteControl({
    sessions: new Map(),
    permissions: { list: () => [] },
    bridge,
    procAlive: async () => false,
    pushBubble() {},
    home: () => home,
  });

  try {
    // 1) Claude without meshEnv: exact direct exe/args/cwd
    const r1 = await rc.launch(home, 'hello world', '', 'claude', null);
    assert.equal(r1.ok, true, r1.msg);
    assert.deepEqual(calls[0], [claudeExe, ['hello world'], home]);

    // 2) Claude with invalid-only meshEnv: treated as null, still direct
    const r2 = await rc.launch(home, 'hello', '', 'claude', null, { BAD: 'x', AME_PROJECT_ID: 'bad space' });
    assert.equal(r2.ok, true, r2.msg);
    assert.deepEqual(calls[1], [claudeExe, ['hello'], home]);

    // 3) Claude with valid meshEnv: PowerShell sets $env:AME_PROJECT_ID and $env:AME_NODE_ID
    const r3 = await rc.launch(home, 'hello', '', 'claude', null, {
      AME_PROJECT_ID: 'proj_1',
      AME_NODE_ID: 'node-2',
      INJECT: '$(calc)',
    });
    assert.equal(r3.ok, true, r3.msg);
    assert.equal(calls[2][0], 'powershell.exe');
    const psArgs3 = calls[2][1];
    const cmd3 = Buffer.from(psArgs3[psArgs3.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.match(cmd3, /\$env:AME_PROJECT_ID = 'proj_1';/);
    assert.match(cmd3, /\$env:AME_NODE_ID = 'node-2';/);
    assert.doesNotMatch(cmd3, /INJECT|calc/);
    assert.ok(cmd3.includes(`& '${claudeExe}' 'hello'`));

    // 4) OpenCode without meshEnv: direct exe/args/cwd
    const r4 = await rc.launch(home, 'fix bug', '', 'opencode', null);
    assert.equal(r4.ok, true, r4.msg);
    assert.deepEqual(calls[3], [opencodeExe, ['--prompt', 'fix bug'], home]);

    // 5) OpenCode with meshEnv: PowerShell wrapper sets $env:* before & opencode.exe
    const r5 = await rc.launch(home, 'fix bug', '', 'opencode', null, { AME_PROJECT_ID: 'p9', AME_NODE_ID: 'n9' });
    assert.equal(r5.ok, true, r5.msg);
    assert.equal(calls[4][0], 'powershell.exe');
    const psArgs5 = calls[4][1];
    const cmd5 = Buffer.from(psArgs5[psArgs5.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.match(cmd5, /^\$env:AME_PROJECT_ID = 'p9'; \$env:AME_NODE_ID = 'n9'; & /);
    assert.ok(cmd5.includes(`'${opencodeExe}' '--prompt' 'fix bug'`));

    // 6) Claude with local API profile + meshEnv: $env:* prepended before profile windowCommand
    const ccRoot = process.env.AME_CC_HOME;
    fs.mkdirSync(path.join(ccRoot, 'apinebula'), { recursive: true });
    fs.writeFileSync(path.join(ccRoot, 'Start-CC.ps1'), '# fixture');
    fs.writeFileSync(path.join(ccRoot, 'apinebula', 'settings.json'), JSON.stringify({
      model: 'opus',
      env: { ANTHROPIC_BASE_URL: 'https://n.example', ANTHROPIC_AUTH_TOKEN: 'tok' },
    }));
    const r6 = await rc.launch(home, 'hi', '', 'claude', { id: 'nebula', local: true }, { AME_PROJECT_ID: 'p_api', AME_NODE_ID: 'n_api' });
    assert.equal(r6.ok, true, r6.msg);
    assert.equal(calls[5][0], 'powershell.exe');
    const psArgs6 = calls[5][1];
    assert.ok(psArgs6.includes('Bypass'));
    const cmd6 = Buffer.from(psArgs6[psArgs6.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.match(cmd6, /^\$env:AME_PROJECT_ID = 'p_api'; \$env:AME_NODE_ID = 'n_api'; \$windosePreviousApi=/);
    assert.match(cmd6, /Start-CC\.ps1/);
  } finally {
    process.env.PATH = oldPath;
    if (oldCcHome === undefined) delete process.env.AME_CC_HOME;
    else process.env.AME_CC_HOME = oldCcHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('headless/launch.js passes syntax check and formats agy/other tails properly', () => {
  const launchPath = path.resolve(__dirname, '../../headless/launch.js');
  cp.execFileSync(process.execPath, ['-c', launchPath], { stdio: 'pipe' });

  assert.equal(buildTail({ agy: true, prompt: '  hello agy  ' }), " -i 'hello agy'");
  assert.equal(buildTail({ agy: true, model: 'claude-sonnet-5-5-medium', prompt: 'hi' }), " --model 'claude-sonnet-5-5-medium' -i 'hi'");
  assert.equal(buildTail({ agy: true, model: 'bad;rm -rf /', prompt: 'hi' }), " -i 'hi'");
  assert.equal(buildTail({ agy: true, prompt: '   ' }), '');
  assert.equal(buildTail({ agy: true, prompt: '' }), '');
  assert.equal(buildTail({ agy: true, agyThread: '11111111-2222-3333-4444-555555555555', prompt: 'ignored' }),
    " --conversation '11111111-2222-3333-4444-555555555555'");
  assert.equal(buildTail({ thread: 't-123' }), " resume 't-123'");
  assert.equal(buildTail({ kiro: true, prompt: 'hi kiro' }), " chat 'hi kiro'");
  assert.equal(buildTail({ kiroThread: 'k-123' }), " chat --resume-id 'k-123'");
  assert.equal(buildTail({ resume: '22222222-2222-3333-4444-555555555555' }),
    " --resume '22222222-2222-3333-4444-555555555555'");
  assert.equal(buildTail({ prompt: 'hi claude' }), " 'hi claude'");
});

test('headless/launch.js injects meshEnv into agy envFile and opencode tmux command without live tmux', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-mesh-headless-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const agyPath = path.join(bin, 'agy');
  const ocPath = path.join(bin, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  fs.writeFileSync(agyPath, '');
  fs.writeFileSync(ocPath, '');

  const launchModPath = require.resolve('../../headless/launch');
  const origExecFile = cp.execFile;
  const captured = [];

  cp.execFile = (file, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    const tmuxArgs = file === 'systemd-run' ? args.slice(args.indexOf('tmux') + 1) : args;
    const cmd = tmuxArgs[tmuxArgs.length - 1];
    let envContents = '';
    const m = /^\. '([^']+)'/.exec(cmd);
    if (m && fs.existsSync(m[1])) envContents = fs.readFileSync(m[1], 'utf8');
    captured.push({ file, tmuxArgs, cmd, envContents });
    done(new Error('mock-tmux-stop'), '', 'mock-tmux-stop');
  };

  delete require.cache[launchModPath];
  const { launch } = require('../../headless/launch');

  try {
    await launch({
      cwd: tmp,
      prompt: '  run check  ',
      env: { PATH: bin },
      tool: 'agy',
      meshEnv: { AME_PROJECT_ID: 'proj_linux', AME_NODE_ID: 'node_linux', BAD: 'x' },
    });
    assert.equal(captured.length, 1);
    assert.match(captured[0].cmd, / -i 'run check'$/);
    assert.match(captured[0].envContents, /^export AME_PROJECT_ID='proj_linux'$/m);
    assert.match(captured[0].envContents, /^export AME_NODE_ID='node_linux'$/m);
    assert.doesNotMatch(captured[0].envContents, /BAD=/);

    await launch({
      cwd: tmp,
      prompt: 'open check',
      env: { PATH: bin },
      tool: 'opencode',
      meshEnv: { AME_PROJECT_ID: 'proj_oc', AME_NODE_ID: 'node_oc' },
    });
    assert.equal(captured.length, 2);
    assert.match(captured[1].cmd, /^export AME_PROJECT_ID='proj_oc' AME_NODE_ID='node_oc'; exec /);
  } finally {
    cp.execFile = origExecFile;
    delete require.cache[launchModPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
