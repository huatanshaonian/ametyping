'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function mergeClaudeJson(existingObj, { node = process.execPath, script = path.join(__dirname, 'tools', 'ame-mesh.js'), remove = false } = {}) {
  const out = existingObj && typeof existingObj === 'object' && !Array.isArray(existingObj)
    ? JSON.parse(JSON.stringify(existingObj))
    : {};
  if (remove) {
    if (out.mcpServers && typeof out.mcpServers === 'object' && !Array.isArray(out.mcpServers)) {
      delete out.mcpServers['ame-mesh'];
    }
  } else {
    out.mcpServers = out.mcpServers && typeof out.mcpServers === 'object' && !Array.isArray(out.mcpServers)
      ? out.mcpServers
      : {};
    out.mcpServers['ame-mesh'] = {
      type: 'stdio',
      command: node,
      args: [script, 'mcp'],
      env: {},
    };
  }
  return out;
}

function mergeAgyJson(existingObj, { node = process.execPath, script = path.join(__dirname, 'tools', 'ame-mesh.js'), remove = false } = {}) {
  const out = existingObj && typeof existingObj === 'object' && !Array.isArray(existingObj)
    ? JSON.parse(JSON.stringify(existingObj))
    : {};
  if (remove) {
    if (out.mcpServers && typeof out.mcpServers === 'object' && !Array.isArray(out.mcpServers)) {
      delete out.mcpServers['ame-mesh'];
    }
  } else {
    out.mcpServers = out.mcpServers && typeof out.mcpServers === 'object' && !Array.isArray(out.mcpServers)
      ? out.mcpServers
      : {};
    out.mcpServers['ame-mesh'] = {
      command: node,
      args: [script, 'mcp'],
    };
  }
  return out;
}

function mergeCodexToml(existingText = '', { node = process.execPath, script = path.join(__dirname, 'tools', 'ame-mesh.js'), remove = false } = {}) {
  const lines = String(existingText || '').split(/\r?\n/);
  const outLines = [];
  let inSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\[mcp_servers\.(?:ame-mesh|"ame-mesh"|'ame-mesh')\]\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^\s*\[.+\]\s*$/.test(line)) {
        inSection = false;
        outLines.push(line);
      } else {
        continue;
      }
    } else {
      outLines.push(line);
    }
  }

  let cleaned = outLines.join('\n').trimEnd();
  if (remove) {
    return cleaned ? cleaned + '\n' : '';
  }

  const block = `[mcp_servers.ame-mesh]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(script)}, "mcp"]`;
  return cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`;
}

function mergeOpenCodeJson(existingObj, { node = process.execPath, script = path.join(__dirname, 'tools', 'ame-mesh.js'), remove = false } = {}) {
  const out = existingObj && typeof existingObj === 'object' && !Array.isArray(existingObj)
    ? JSON.parse(JSON.stringify(existingObj))
    : {};
  if (remove) {
    if (out.mcp && typeof out.mcp === 'object' && !Array.isArray(out.mcp)) {
      delete out.mcp['ame-mesh'];
    }
  } else {
    out.mcp = out.mcp && typeof out.mcp === 'object' && !Array.isArray(out.mcp)
      ? out.mcp
      : {};
    out.mcp['ame-mesh'] = {
      type: 'local',
      command: [node, script, 'mcp'],
      enabled: true,
    };
  }
  return out;
}

function safeAtomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const backupFile = filePath + '.ame-backup-mcp';
  if (fs.existsSync(filePath) && !fs.existsSync(backupFile)) {
    try {
      fs.copyFileSync(filePath, backupFile);
    } catch {}
  }

  const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, content, 'utf8');
  fs.renameSync(tmpFile, filePath);
}

function installAll({
  home = os.homedir(),
  node = process.execPath,
  script = path.join(__dirname, 'tools', 'ame-mesh.js'),
  remove = false,
  quiet = false,
} = {}) {
  const updated = [];
  const unchanged = [];
  const skipped = [];

  // 1. Claude Code
  const claudePath = path.join(home, '.claude.json');
  const claudeDir = path.join(home, '.claude');
  if (fs.existsSync(claudePath) || fs.existsSync(claudeDir)) {
    let existing = {};
    let oldRaw = '';
    let parseOk = true;
    if (fs.existsSync(claudePath)) {
      try {
        oldRaw = fs.readFileSync(claudePath, 'utf8');
        const clean = oldRaw.replace(/^\uFEFF/, '').trim();
        existing = clean ? JSON.parse(clean) : {};
      } catch {
        parseOk = false;
        skipped.push('claude');
      }
    }
    if (parseOk) {
      if (!fs.existsSync(claudePath) && remove) {
        unchanged.push('claude');
      } else {
        const nextObj = mergeClaudeJson(existing, { node, script, remove });
        const nextRaw = JSON.stringify(nextObj, null, 2) + '\n';
        if (fs.existsSync(claudePath) && oldRaw === nextRaw) {
          unchanged.push('claude');
        } else {
          safeAtomicWrite(claudePath, nextRaw);
          updated.push('claude');
        }
      }
    }
  } else {
    skipped.push('claude');
  }

  // 2. Antigravity
  const agyDir = process.env.AGY_CONFIG_DIR || path.join(home, '.gemini', 'config');
  const agyPath = path.join(agyDir, 'mcp_config.json');
  const agyHomeDir = path.join(home, '.gemini');
  if (Boolean(process.env.AGY_CONFIG_DIR) || fs.existsSync(agyHomeDir)) {
    let existing = {};
    let oldRaw = '';
    let parseOk = true;
    if (fs.existsSync(agyPath)) {
      try {
        oldRaw = fs.readFileSync(agyPath, 'utf8');
        const clean = oldRaw.replace(/^\uFEFF/, '').trim();
        existing = clean ? JSON.parse(clean) : {};
      } catch {
        parseOk = false;
        skipped.push('agy');
      }
    }
    if (parseOk) {
      if (!fs.existsSync(agyPath) && remove) {
        unchanged.push('agy');
      } else {
        const nextObj = mergeAgyJson(existing, { node, script, remove });
        const nextRaw = JSON.stringify(nextObj, null, 2) + '\n';
        if (fs.existsSync(agyPath) && oldRaw === nextRaw) {
          unchanged.push('agy');
        } else {
          safeAtomicWrite(agyPath, nextRaw);
          updated.push('agy');
        }
      }
    }
  } else {
    skipped.push('agy');
  }

  // 3. Codex
  const codexDir = process.env.CODEX_HOME || path.join(home, '.codex');
  const codexPath = path.join(codexDir, 'config.toml');
  if (fs.existsSync(codexPath) || fs.existsSync(codexDir)) {
    let oldRaw = '';
    if (fs.existsSync(codexPath)) {
      oldRaw = fs.readFileSync(codexPath, 'utf8');
    }
    if (!fs.existsSync(codexPath) && remove) {
      unchanged.push('codex');
    } else {
      const nextRaw = mergeCodexToml(oldRaw, { node, script, remove });
      if (fs.existsSync(codexPath) && oldRaw === nextRaw) {
        unchanged.push('codex');
      } else {
        safeAtomicWrite(codexPath, nextRaw);
        updated.push('codex');
      }
    }
  } else {
    skipped.push('codex');
  }

  // 4. OpenCode
  const openCodeDir = process.env.OPENCODE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  const openCodePath = path.join(openCodeDir, 'opencode.json');
  if (fs.existsSync(openCodePath) || fs.existsSync(openCodeDir)) {
    let existing = {};
    let oldRaw = '';
    let parseOk = true;
    if (fs.existsSync(openCodePath)) {
      oldRaw = fs.readFileSync(openCodePath, 'utf8');
      try {
        const clean = oldRaw.replace(/^\uFEFF/, '').trim();
        existing = clean ? JSON.parse(clean) : {};
      } catch {
        // 若 JSON.parse 失败（例如是带注释的 JSONC），跳过不覆盖
        parseOk = false;
        skipped.push('opencode');
      }
    }
    if (parseOk) {
      if (!fs.existsSync(openCodePath) && remove) {
        unchanged.push('opencode');
      } else {
        const nextObj = mergeOpenCodeJson(existing, { node, script, remove });
        const nextRaw = JSON.stringify(nextObj, null, 2) + '\n';
        if (fs.existsSync(openCodePath) && oldRaw === nextRaw) {
          unchanged.push('opencode');
        } else {
          safeAtomicWrite(openCodePath, nextRaw);
          updated.push('opencode');
        }
      }
    }
  } else {
    skipped.push('opencode');
  }

  if (!quiet) {
    if (updated.length) console.log(`[ame-mesh-mcp] updated: ${updated.join(', ')}`);
    if (unchanged.length) console.log(`[ame-mesh-mcp] unchanged: ${unchanged.join(', ')}`);
    if (skipped.length) console.log(`[ame-mesh-mcp] skipped: ${skipped.join(', ')}`);
  }

  return { updated, unchanged, skipped };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const remove = args.includes('--remove');
  installAll({ remove });
}

module.exports = {
  mergeClaudeJson,
  mergeAgyJson,
  mergeCodexToml,
  mergeOpenCodeJson,
  installAll,
};
