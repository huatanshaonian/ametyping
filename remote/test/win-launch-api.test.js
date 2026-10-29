'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createRemoteControl } = require('../../app/remote-control');
test('Windows new-window launch invokes the user launcher in the chosen project, with safely quoted prompt', { skip: process.platform !== 'win32' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cc-window-')), root = path.join(home, 'cc-environments');
  fs.mkdirSync(path.join(root, 'apinebula'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Start-CC.ps1'), '# existing launcher');
  fs.writeFileSync(path.join(root, 'apinebula/settings.json'), JSON.stringify({ model: 'opus',
    env: { ANTHROPIC_BASE_URL: 'https://n.example', ANTHROPIC_AUTH_TOKEN: 'private-key-fixture' } }));
  const old = process.env.AME_CC_HOME, oldPath = process.env.PATH; process.env.AME_CC_HOME = root;
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'claude.exe'), ''); process.env.PATH = bin;
  const calls = [];
  const bridge = { launch: async (...args) => { calls.push(args); return 1234; }, screen: async () => null };
  const rc = createRemoteControl({ sessions: new Map(), permissions: { list: () => [] }, bridge,
    procAlive: async () => false, pushBubble() {}, home: () => home });
  try {
    const r = await rc.launch(home, "fixture & 'quoted'", '', 'claude', { id: 'nebula', local: true });
    assert.equal(r.ok, true, r.msg);
    const args = calls[0][1], cmd = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.match(cmd, /Start-CC\.ps1/); assert.match(cmd, /-EnvironmentName 'apinebula'/);
    assert.ok(cmd.includes("-ProjectDir '" + home + "'")); assert.ok(cmd.includes("'fixture & ''quoted'''"));
    assert.match(cmd, /AME_CLAUDE_API='nebula'/); assert.match(cmd, /finally/);
    assert.doesNotMatch(cmd, /private-key-fixture/);
    assert.ok(args.includes('Bypass'));
    assert.equal((await rc.launch(home, '', '', 'claude', { id: 'missing', local: true })).ok, false);
    assert.equal(calls.length, 1);
  } finally { process.env.PATH = oldPath; if (old === undefined) delete process.env.AME_CC_HOME; else process.env.AME_CC_HOME = old; }
});
