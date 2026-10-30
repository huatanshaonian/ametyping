'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFiles } = require('../agent/files');
const { createFsCatalog } = require('../server/fs-catalog');

test('files.tree builds shallow structure, skips node_modules and secrets', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-vfs-'));
  try {
    const proj = path.join(tmp, 'cem_solver');
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.git', 'HEAD'), 'ref: refs/heads/feature/session-mesh\n');
    fs.writeFileSync(path.join(proj, 'src', 'ribbon.py'), 'print("ok")\n');
    fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1\n');

    const files = createFiles({ roots: [tmp] });
    const res = await files.tree(proj, { maxDepth: 3 });

    assert.equal(res.gitBranch, 'feature/session-mesh');
    const names = res.tree.map((x) => x.name);
    assert.ok(names.includes('src'));
    assert.ok(names.includes('node_modules'));
    assert.ok(!names.includes('.env'), '.env secret file must be excluded');

    const nm = res.tree.find((x) => x.name === 'node_modules');
    assert.equal(nm.skipped, true, 'node_modules should be marked skipped');
    assert.equal(nm.children, undefined);

    const src = res.tree.find((x) => x.name === 'src');
    assert.equal(src.dir, true);
    assert.equal(src.children.length, 1);
    assert.equal(src.children[0].name, 'ribbon.py');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fs-catalog stores dual-track notes, protects userNote from AI overwrite, and syncs snapshots', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cat-'));
  try {
    let sentMsg = null;
    const machines = new Map();
    const fakeSock = {
      readyState: 1,
      send(raw) { sentMsg = JSON.parse(raw); },
    };
    machines.set('gpu-box', { name: 'gpu-box', online: true, files: true, sockets: new Set([fakeSock]) });

    const cat = createFsCatalog({ dataDir: tmp, machines });

    // 1. User sets tag and userNote
    const r1 = cat.setNote({
      machine: 'gpu-box',
      path: '/data/cem_solver',
      tag: 'solver',
      userNote: 'CEM求解器主代码库，勿删 build',
      aiNote: '',
      byAi: false,
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.item.tag, 'solver');
    assert.equal(r1.item.userNote, 'CEM求解器主代码库，勿删 build');

    // 2. AI updates aiNote; userNote must remain untouched even if AI passes userNote
    const r2 = cat.setNote({
      machine: 'gpu-box',
      path: '/data/cem_solver',
      tag: 'results',
      userNote: '恶意覆盖',
      aiNote: '包含 AnalyticRibbonIntegrator，使用 conda cem_env',
      byAi: true,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.item.tag, 'solver', 'AI must not overwrite existing user tag');
    assert.equal(r2.item.userNote, 'CEM求解器主代码库，勿删 build', 'AI must not overwrite userNote');
    assert.equal(r2.item.aiNote, '包含 AnalyticRibbonIntegrator，使用 conda cem_env');

    // 3. Simulate agent replying to the background tree sync
    assert.ok(sentMsg && sentMsg.t === 'fs' && sentMsg.op === 'tree');
    const handled = cat.fromAgent({ name: 'gpu-box' }, {
      t: 'fs-res',
      rid: sentMsg.rid,
      ok: true,
      path: '/data/cem_solver',
      sep: '/',
      freeBytes: 500 * 1024 * 1024 * 1024,
      gitBranch: 'main',
      count: 2,
      tree: [{ name: 'test_algorithms.py', dir: false, size: 1024, mtime: 1000 }],
    });
    assert.equal(handled, true);

    const item = cat.get('gpu-box', '/data/cem_solver');
    assert.ok(item.snapshot);
    assert.equal(item.snapshot.gitBranch, 'main');
    assert.equal(item.snapshot.tree[0].name, 'test_algorithms.py');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
