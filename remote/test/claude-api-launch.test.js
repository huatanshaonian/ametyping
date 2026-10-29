'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

test('packaged pet loads the provider module from Electron resources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cc-package-'));
  try {
    const resources = path.join(root, 'resources'), app = path.join(resources, 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../app/claude-api.js'), path.join(app, 'claude-api.js'));
    fs.copyFileSync(path.resolve(__dirname, '../agent/claude-profiles.js'), path.join(resources, 'claude-profiles.js'));
    const result = cp.spawnSync(process.execPath, ['-e',
      'process.resourcesPath=process.argv[1];const api=require(process.argv[2]);if(typeof api.createProfiles!=="function"||!api.resumePlan("").ok)process.exit(1);', resources, path.join(app, 'claude-api.js')],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../app/package.json')));
    assert.match(pkg.scripts.dist, /--extra-resource=\.\.\/remote\/agent\/claude-profiles\.js/);
    assert.ok(pkg.build.extraResources.some(x => x.to === 'claude-profiles.js'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('standalone launcher -Check reports either independent entry without printing credentials', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cc-cli-')), root = path.join(home, 'cc-environments');
  for (const [dir, model] of [['apinebula', 'opus'], ['deepseek', 'deepseek-flash[1m]']]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'settings.json'), JSON.stringify({ model, env: {
      ANTHROPIC_BASE_URL: 'https://' + dir + '.example', ANTHROPIC_AUTH_TOKEN: 'invented-cli-key' } }));
    const result = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../agent/claude-profiles.js'), dir, '-Check'],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, AME_CC_HOME: root } });
    assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout, /invented-cli-key/);
    assert.equal(JSON.parse(result.stdout).model, model);
  }
});
