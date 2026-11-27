#!/usr/bin/env node
// Batch-generate deep cards (with cropped figures + Top-5 kb_struct comparison) using Google AI Studio.
// Resumable: skips papers that already have a deep/reviewed card.
// Usage: node tools/run-cards-batch.js [--limit 70] [--provider google|agy|magpie|auto] [--model gemini-4-neon] [--effort low] [--agy-ssh dell97] [--concurrency 2]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'remote', 'server');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Math.max(1, parseInt(opt('--limit', '70'), 10) || 70);
const PROVIDER = opt('--provider', 'google');
const MODEL = opt('--model', 'gemini-4-neon');
const EFFORT = opt('--effort', 'low');
const AGY_SSH = opt('--agy-ssh', '');
const CONCURRENCY = Math.max(1, Math.min(4, parseInt(opt('--concurrency', '2'), 10) || 2));

const cfg = JSON.parse(fs.readFileSync(path.join(SERVER, 'config.json'), 'utf8'));
const litCfg = cfg.literature || {};
const dataDir = path.resolve(SERVER, cfg.dataDir || 'data');
const litDir = path.join(dataDir, 'literature');

const { createMirror } = require(path.join(SERVER, 'literature', 'zotero', 'mirror'));
const { createWebdav } = require(path.join(SERVER, 'literature', 'zotero', 'webdav'));
const { createFulltext } = require(path.join(SERVER, 'literature', 'fulltext'));
const { createHttp } = require(path.join(SERVER, 'literature', 'http'));
const { createEgress } = require(path.join(SERVER, 'egress'));
const { createKb } = require(path.join(SERVER, 'literature', 'kb'));
const { createProfile } = require(path.join(SERVER, 'literature', 'profile'));
const { createCards } = require(path.join(SERVER, 'literature', 'cards'));
const { createFigures } = require(path.join(SERVER, 'literature', 'figures'));
const { createDigest } = require(path.join(SERVER, 'literature', 'digest'));
const { openKbStruct } = require(path.join(SERVER, 'literature', 'kb-struct'));
const { createLitAsker } = require(path.join(__dirname, 'lib', 'lit-ask'));
const embedMod = require(path.join(SERVER, 'embed'));

const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);

async function main() {
  const proxies = (cfg.summary && cfg.summary.proxies) || [];
  const litProxies = Array.isArray(litCfg.proxies) ? litCfg.proxies : proxies;
  const egress = litProxies.length ? createEgress({ proxies: litProxies, log: () => {} }) : null;
  const http = createHttp({ egress, viaProxy: litCfg.viaProxy || ['ntrs.nasa.gov', 'archive.org', 'dtic.mil'] });
  const mirror = createMirror({ api: null, dir: litDir, log: () => {} });
  const webdav = createWebdav({ dir: litCfg.webdavDir || '' });
  const fulltext = createFulltext({ dir: litDir, mirror, webdav, bin: litCfg.pdftotext || 'pdftotext', http, log: () => {} });
  const kb = createKb({ dir: path.resolve(SERVER, litCfg.kbDir || path.join(litDir, 'kb')), log: () => {} });
  const kbStruct = openKbStruct({ dir: litDir, log });
  const embed = cfg.embed ? embedMod.open({ dataDir, cfg: cfg.embed, log: () => {} }) : null;
  const asker = createLitAsker({ serverDir: SERVER, cfg, dataDir, egress, provider: PROVIDER, model: MODEL, effort: EFFORT, agySsh: AGY_SSH, log });
  const askGoogle = asker.ask;

  const profile = createProfile({ dir: litDir, mirror, ask: askGoogle, log: () => {} });
  const digest = createDigest({ dir: litDir, ask: askGoogle, log: () => {} });
  const figures = createFigures({ dir: litDir, kbDir: kb.dir, mirror, fulltext, ask: askGoogle, log: () => {} });
  const fakeApi = { canWrite: () => false };
  const cards = createCards({
    kb, mirror, fulltext, profile,
    ask: askGoogle, askDeep: askGoogle, api: fakeApi,
    vision: null, figures, digest,
    writeNotes: false, kbStruct, embed, log: () => {},
  });

  // Prioritize: 等离子体RCS -> 多保真、多模态 -> 调研工作 -> 每日文献 -> rcs模型 (newest first)
  const priorityCols = ['等离子体RCS', '等离子体鞘套电磁散射', '多保真、多模态', '调研工作', '每日文献', 'rcs模型', '气动隐身'];
  const picked = [];
  const seen = new Set();
  for (const cname of priorityCols) {
    const col = mirror.collectionByName(cname);
    if (!col) continue;
    const items = mirror.inCollection(col.key).sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || b.added - a.added);
    for (const it of items) {
      if (seen.has(it.key) || !fulltext.hasPdf(it.key)) continue;
      const cur = cards.find(it.key);
      if (cur && /deep|reviewed/.test(String(cur.meta.status || ''))) continue;
      seen.add(it.key);
      picked.push(it.key);
      if (picked.length >= LIMIT) break;
    }
    if (picked.length >= LIMIT) break;
  }

  log(`CARDS BATCH: model=${MODEL} limit=${LIMIT} selected=${picked.length} concurrency=${CONCURRENCY}`);
  let idx = 0, ok = 0, fail = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < picked.length) {
      const k = picked[idx++];
      const pos = idx;
      try {
        const r = await cards.makeDeep(k);
        ok++;
        log(`  [${pos}/${picked.length}] OK ${k} -> ${r.path}`);
      } catch (e) {
        fail++;
        log(`  [${pos}/${picked.length}] ERR ${k}: ${e.message}`);
      }
    }
  }));

  log(`ALL CARDS DONE: ok=${ok} fail=${fail} totalCards=${cards.all().length}`);
  if (embed && embed.close) embed.close();
  kbStruct.close();
}

main().catch((e) => { log('FATAL: ' + (e.stack || e.message)); process.exit(1); });
