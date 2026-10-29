'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { createProfiles } = require('../agent/claude-profiles');
test('Linux real process: both entry commands and background resume share history and retain API/model/network', { skip: process.platform !== 'linux' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cc-linux-')), root = path.join(home, 'cc-environments');
  const original = { HOME: process.env.HOME, AME_CC_HOME: process.env.AME_CC_HOME, PATH: process.env.PATH };
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin); fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), '{"hooks":{"Stop":[]},"permissions":{"allow":["Read"]}}');
  fs.writeFileSync(path.join(home, '.claude.json'), '{"history":"shared"}');
  for (const [name, model, proxy] of [['deepseek', 'deepseek-flash[1m]', ''], ['apinebula', 'opus', 'http://proxy.fixture:10808']]) {
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model, env: {
      ANTHROPIC_BASE_URL: 'https://' + name + '.example/anthropic', ANTHROPIC_AUTH_TOKEN: name + '-fixture-key', HTTPS_PROXY: proxy } }));
  }
  const cli = [
    '#!' + process.execPath,
    "const fs=require('fs');const args=process.argv.slice(2),i=args.indexOf('--settings');",
    "const s=JSON.parse(fs.readFileSync(args[i+1]));Object.assign(process.env,s.env);",
    "fs.writeFileSync(process.env.AME_CAPTURE_LOG,JSON.stringify({args,model:s.model,api:process.env.ANTHROPIC_BASE_URL,proxy:process.env.HTTPS_PROXY,marker:process.env.AME_CLAUDE_API}));",
    "process.stdin.resume();",
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'claude'), cli, { mode: 0o755 });
  process.env.HOME = home; process.env.AME_CC_HOME = root; process.env.PATH = bin + path.delimiter + original.PATH;
  try {
    const profiles = createProfiles(); profiles.install();
    for (const [id, model] of [['deepseek', 'deepseek-flash[1m]'], ['nebula', 'opus']]) {
      const log = path.join(home, id + '.json');
      const result = cp.spawnSync(path.join(home, '.local/bin/claude-' + id), ['--resume', 'shared-record'],
        { cwd: home, env: { ...process.env, AME_CAPTURE_LOG: log }, input: 'fixture prompt', encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      const data = JSON.parse(fs.readFileSync(log));
      assert.equal(data.model, model); assert.equal(data.marker, id);
      assert.ok(data.args.includes('user,project,local'));
      assert.deepEqual(data.args.slice(-2), ['--resume', 'shared-record']);
      assert.equal(!!data.proxy, id === 'nebula');
    }
    const { resumePlan } = require('../../app/claude-api'), { resume } = require('../../headless/resume');
    const log = path.join(home, 'background.json');
    const plan = resumePlan('deepseek', { PATH: process.env.PATH, HOME: home, HTTPS_PROXY: 'http://previous:1',
      ANTHROPIC_AUTH_TOKEN: 'previous-api-token', AME_CAPTURE_LOG: log }, { cwd: home, args: ['-p', '--resume', 'shared-record'] });
    assert.equal(plan.ok, true, plan.msg);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('background fixture timed out')), 5000);
      const r = resume('shared-record', home, plan.env, 'fixture prompt', () => { clearTimeout(timer); plan.cleanup(); resolve(); }, false, '', plan.command);
      if (!r.ok) { clearTimeout(timer); reject(new Error(r.msg)); }
    });
    const data = JSON.parse(fs.readFileSync(log));
    assert.equal(data.model, 'deepseek-flash[1m]');
    assert.equal(data.api, 'https://deepseek.example/anthropic');
    assert.equal(data.proxy, ''); assert.equal(data.marker, 'deepseek');
    assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{"history":"shared"}');
    assert.equal(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'), '{"hooks":{"Stop":[]},"permissions":{"allow":["Read"]}}');
  } finally {
    for (const [k, v] of Object.entries(original)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
