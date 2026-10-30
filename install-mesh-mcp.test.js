'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  mergeClaudeJson,
  mergeAgyJson,
  mergeCodexToml,
  mergeOpenCodeJson,
  installAll,
} = require('./install-mesh-mcp');

describe('install-mesh-mcp', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const script = 'D:\\ametyping\\tools\\ame-mesh.js';

  describe('mergeClaudeJson', () => {
    it('installs into an empty object', () => {
      const res = mergeClaudeJson({}, { node, script });
      assert.deepEqual(res, {
        mcpServers: {
          'ame-mesh': {
            type: 'stdio',
            command: node,
            args: [script, 'mcp'],
            env: {},
          },
        },
      });
    });

    it('preserves other top-level keys and existing mcpServers', () => {
      const initial = {
        theme: 'dark',
        verbose: true,
        mcpServers: {
          pycharm: {
            command: 'pycharm-mcp',
            args: ['--stdio'],
          },
        },
      };
      const res = mergeClaudeJson(initial, { node, script });
      assert.equal(res.theme, 'dark');
      assert.equal(res.verbose, true);
      assert.deepEqual(res.mcpServers.pycharm, initial.mcpServers.pycharm);
      assert.deepEqual(res.mcpServers['ame-mesh'], {
        type: 'stdio',
        command: node,
        args: [script, 'mcp'],
        env: {},
      });
    });

    it('updates node and script path idempotently', () => {
      const first = mergeClaudeJson({}, { node, script });
      const second = mergeClaudeJson(first, { node, script });
      assert.deepEqual(first, second);

      const updated = mergeClaudeJson(first, { node: 'new-node', script: 'new-script' });
      assert.equal(updated.mcpServers['ame-mesh'].command, 'new-node');
      assert.deepEqual(updated.mcpServers['ame-mesh'].args, ['new-script', 'mcp']);
    });

    it('removes ame-mesh when remove: true', () => {
      const initial = {
        other: 1,
        mcpServers: {
          'ame-mesh': { command: node, args: [script, 'mcp'] },
          pycharm: { command: 'pycharm-mcp' },
        },
      };
      const res = mergeClaudeJson(initial, { remove: true });
      assert.equal(res.other, 1);
      assert.equal(res.mcpServers['ame-mesh'], undefined);
      assert.deepEqual(res.mcpServers.pycharm, { command: 'pycharm-mcp' });
    });
  });

  describe('mergeAgyJson', () => {
    it('installs into an empty object', () => {
      const res = mergeAgyJson({}, { node, script });
      assert.deepEqual(res, {
        mcpServers: {
          'ame-mesh': {
            command: node,
            args: [script, 'mcp'],
          },
        },
      });
    });

    it('preserves other top-level keys and existing mcpServers', () => {
      const initial = {
        rules: ['rule1'],
        mcpServers: {
          sqlite: {
            command: 'sqlite-mcp',
          },
        },
      };
      const res = mergeAgyJson(initial, { node, script });
      assert.deepEqual(res.rules, ['rule1']);
      assert.deepEqual(res.mcpServers.sqlite, { command: 'sqlite-mcp' });
      assert.deepEqual(res.mcpServers['ame-mesh'], {
        command: node,
        args: [script, 'mcp'],
      });
    });

    it('is idempotent and removes when remove: true', () => {
      const installed = mergeAgyJson({}, { node, script });
      const again = mergeAgyJson(installed, { node, script });
      assert.deepEqual(installed, again);

      const removed = mergeAgyJson(installed, { remove: true });
      assert.equal(removed.mcpServers['ame-mesh'], undefined);
    });
  });

  describe('mergeCodexToml', () => {
    it('installs into an empty text', () => {
      const res = mergeCodexToml('', { node, script });
      assert.ok(res.includes('[mcp_servers.ame-mesh]'));
      assert.ok(res.includes(`command = ${JSON.stringify(node)}`));
      assert.ok(res.includes(`args = [${JSON.stringify(script)}, "mcp"]`));
    });

    it('preserves comments and other sections', () => {
      const initial = [
        '# Global configuration for Codex',
        'model = "o3-mini"',
        '',
        '[projects]',
        'work = "D:\\\\work"',
        '',
        '[mcp_servers.node_repl]',
        'command = "node"',
        'args = ["-i"]',
      ].join('\n');

      const res = mergeCodexToml(initial, { node, script });
      assert.ok(res.includes('# Global configuration for Codex'));
      assert.ok(res.includes('model = "o3-mini"'));
      assert.ok(res.includes('[projects]'));
      assert.ok(res.includes('work = "D:\\\\work"'));
      assert.ok(res.includes('[mcp_servers.node_repl]'));
      assert.ok(res.includes('[mcp_servers.ame-mesh]'));
      assert.ok(res.includes(`command = ${JSON.stringify(node)}`));
    });

    it('is idempotent on repeated runs', () => {
      const initial = 'model = "o3"\n\n[projects]\nfoo = "bar"';
      const first = mergeCodexToml(initial, { node, script });
      const second = mergeCodexToml(first, { node, script });
      assert.equal(first, second);
    });

    it('updates paths when node/script change', () => {
      const first = mergeCodexToml('', { node: 'old-node', script: 'old-script' });
      const second = mergeCodexToml(first, { node: 'new-node', script: 'new-script' });
      assert.ok(!second.includes('old-node'));
      assert.ok(second.includes('new-node'));
      assert.ok(second.includes('new-script'));
    });

    it('removes ame-mesh section cleanly when remove: true', () => {
      const initial = [
        '# Header',
        '[mcp_servers.other]',
        'command = "other"',
        '',
        '[mcp_servers.ame-mesh]',
        'command = "node"',
        'args = ["tools/ame-mesh.js", "mcp"]',
        '',
        '[projects]',
        'name = "test"',
      ].join('\n');

      const res = mergeCodexToml(initial, { remove: true });
      assert.ok(res.includes('# Header'));
      assert.ok(res.includes('[mcp_servers.other]'));
      assert.ok(res.includes('[projects]'));
      assert.ok(res.includes('name = "test"'));
      assert.ok(!res.includes('ame-mesh'));
      assert.ok(!res.includes('tools/ame-mesh.js'));
    });
  });

  describe('mergeOpenCodeJson', () => {
    it('installs into an empty object', () => {
      const res = mergeOpenCodeJson({}, { node, script });
      assert.deepEqual(res, {
        mcp: {
          'ame-mesh': {
            type: 'local',
            command: [node, script, 'mcp'],
            enabled: true,
          },
        },
      });
    });

    it('preserves existing plugins, providers, and other mcp entries', () => {
      const initial = {
        plugins: ['ametyping-plugin'],
        provider: { current: 'anthropic' },
        mcp: {
          fetch: {
            type: 'local',
            command: ['fetch'],
          },
        },
      };
      const res = mergeOpenCodeJson(initial, { node, script });
      assert.deepEqual(res.plugins, ['ametyping-plugin']);
      assert.deepEqual(res.provider, { current: 'anthropic' });
      assert.deepEqual(res.mcp.fetch, { type: 'local', command: ['fetch'] });
      assert.deepEqual(res.mcp['ame-mesh'], {
        type: 'local',
        command: [node, script, 'mcp'],
        enabled: true,
      });
    });

    it('is idempotent and removes when remove: true', () => {
      const first = mergeOpenCodeJson({}, { node, script });
      const second = mergeOpenCodeJson(first, { node, script });
      assert.deepEqual(first, second);

      const removed = mergeOpenCodeJson(first, { remove: true });
      assert.equal(removed.mcp['ame-mesh'], undefined);
    });
  });

  describe('installAll end-to-end in isolated tmp home', () => {
    let tmpHome;
    let origEnv;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-test-mesh-mcp-'));
      origEnv = {
        AGY_CONFIG_DIR: process.env.AGY_CONFIG_DIR,
        CODEX_HOME: process.env.CODEX_HOME,
        OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      };
      delete process.env.AGY_CONFIG_DIR;
      delete process.env.CODEX_HOME;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
    });

    afterEach(() => {
      for (const k of Object.keys(origEnv)) {
        if (origEnv[k] !== undefined) process.env[k] = origEnv[k];
        else delete process.env[k];
      }
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {}
    });

    it('skips targets when tool directories do not exist', () => {
      const res = installAll({ home: tmpHome, quiet: true });
      assert.equal(res.updated.length, 0);
      assert.equal(res.skipped.length, 4);
      assert.ok(res.skipped.includes('claude'));
      assert.ok(res.skipped.includes('agy'));
      assert.ok(res.skipped.includes('codex'));
      assert.ok(res.skipped.includes('opencode'));
    });

    it('installs to all 4 tools, creates .ame-backup-mcp, remains idempotent, and uninstalls cleanly', () => {
      // 1. Setup mock directories and files
      // Claude: ~/.claude dir + ~/.claude.json
      fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
      const claudeFile = path.join(tmpHome, '.claude.json');
      fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: { pycharm: { command: 'pycharm' } } }, null, 2));

      // Antigravity: ~/.gemini dir + ~/.gemini/config/mcp_config.json
      fs.mkdirSync(path.join(tmpHome, '.gemini', 'config'), { recursive: true });
      const agyFile = path.join(tmpHome, '.gemini', 'config', 'mcp_config.json');
      fs.writeFileSync(agyFile, JSON.stringify({ mcpServers: { custom: { command: 'c' } } }, null, 2));

      // Codex: ~/.codex dir + config.toml
      fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
      const codexFile = path.join(tmpHome, '.codex', 'config.toml');
      fs.writeFileSync(codexFile, '# codex config\nmodel = "o3"\n');

      // OpenCode: ~/.config/opencode/opencode.json
      fs.mkdirSync(path.join(tmpHome, '.config', 'opencode'), { recursive: true });
      const openCodeFile = path.join(tmpHome, '.config', 'opencode', 'opencode.json');
      fs.writeFileSync(openCodeFile, JSON.stringify({ provider: 'anthropic' }, null, 2));

      // First run: all 4 should be updated
      const res1 = installAll({ home: tmpHome, node, script, quiet: true });
      assert.equal(res1.updated.length, 4);
      assert.equal(res1.unchanged.length, 0);
      assert.equal(res1.skipped.length, 0);

      // Verify files updated
      const claudeObj = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
      assert.deepEqual(claudeObj.mcpServers.pycharm, { command: 'pycharm' });
      assert.equal(claudeObj.mcpServers['ame-mesh'].command, node);

      const agyObj = JSON.parse(fs.readFileSync(agyFile, 'utf8'));
      assert.deepEqual(agyObj.mcpServers.custom, { command: 'c' });
      assert.equal(agyObj.mcpServers['ame-mesh'].command, node);

      const codexText = fs.readFileSync(codexFile, 'utf8');
      assert.ok(codexText.includes('# codex config'));
      assert.ok(codexText.includes('[mcp_servers.ame-mesh]'));

      const openCodeObj = JSON.parse(fs.readFileSync(openCodeFile, 'utf8'));
      assert.equal(openCodeObj.provider, 'anthropic');
      assert.equal(openCodeObj.mcp['ame-mesh'].enabled, true);

      // Verify backup files were created with .ame-backup-mcp
      assert.ok(fs.existsSync(claudeFile + '.ame-backup-mcp'));
      assert.ok(fs.existsSync(agyFile + '.ame-backup-mcp'));
      assert.ok(fs.existsSync(codexFile + '.ame-backup-mcp'));
      assert.ok(fs.existsSync(openCodeFile + '.ame-backup-mcp'));

      // Verify backup contents match original
      const claudeBackup = JSON.parse(fs.readFileSync(claudeFile + '.ame-backup-mcp', 'utf8'));
      assert.equal(claudeBackup.mcpServers['ame-mesh'], undefined);
      assert.deepEqual(claudeBackup.mcpServers.pycharm, { command: 'pycharm' });

      // Second run: idempotent, updated.length === 0, unchanged.length === 4
      const res2 = installAll({ home: tmpHome, node, script, quiet: true });
      assert.equal(res2.updated.length, 0);
      assert.equal(res2.unchanged.length, 4);

      // Uninstall test with remove: true
      const resRemove = installAll({ home: tmpHome, node, script, remove: true, quiet: true });
      assert.equal(resRemove.updated.length, 4);

      const claudeObjAfterRemove = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
      assert.equal(claudeObjAfterRemove.mcpServers['ame-mesh'], undefined);
      assert.deepEqual(claudeObjAfterRemove.mcpServers.pycharm, { command: 'pycharm' });

      const codexTextAfterRemove = fs.readFileSync(codexFile, 'utf8');
      assert.ok(!codexTextAfterRemove.includes('ame-mesh'));
      assert.ok(codexTextAfterRemove.includes('# codex config'));

      // Second uninstall run: unchanged.length === 4
      const resRemove2 = installAll({ home: tmpHome, node, script, remove: true, quiet: true });
      assert.equal(resRemove2.updated.length, 0);
      assert.equal(resRemove2.unchanged.length, 4);
    });

    it('skips opencode.json if it contains unparseable comments (JSONC)', () => {
      fs.mkdirSync(path.join(tmpHome, '.config', 'opencode'), { recursive: true });
      const openCodeFile = path.join(tmpHome, '.config', 'opencode', 'opencode.json');
      const jsoncContent = '{\n  // A comment\n  "provider": "anthropic"\n}\n';
      fs.writeFileSync(openCodeFile, jsoncContent);

      const res = installAll({ home: tmpHome, node, script, quiet: true });
      assert.ok(res.skipped.includes('opencode'));
      // Ensure file content was not overwritten or corrupted
      assert.equal(fs.readFileSync(openCodeFile, 'utf8'), jsoncContent);
    });
  });
});
