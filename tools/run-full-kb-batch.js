#!/usr/bin/env node
// Full-library evidence extraction & paradigm contradiction batch runner (runs on NAS).
// Resumable: skips papers already extracted with unchanged PDF MD5 unless --force is passed.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'remote', 'server');
const cfg = JSON.parse(fs.readFileSync(path.join(SERVER, 'config.json'), 'utf8'));
const litCfg = cfg.literature || {};
const dataDir = path.resolve(SERVER, cfg.dataDir || 'data');
const litDir = path.join(dataDir, 'literature');
const outDir = path.join(litDir, 'pilot-out');
fs.mkdirSync(outDir, { recursive: true });

const { createMirror } = require(path.join(SERVER, 'literature', 'zotero', 'mirror'));
const { createWebdav } = require(path.join(SERVER, 'literature', 'zotero', 'webdav'));
const { createFulltext } = require(path.join(SERVER, 'literature', 'fulltext'));
const { createHttp } = require(path.join(SERVER, 'literature', 'http'));
const { createEgress } = require(path.join(SERVER, 'egress'));
const { openKbStruct } = require(path.join(SERVER, 'literature', 'kb-struct'));
const { createEvidence } = require(path.join(SERVER, 'literature', 'evidence'));
const { createParadigm } = require(path.join(SERVER, 'literature', 'paradigm'));
const { createGoogleAiKey, runGoogleAi } = require(path.join(SERVER, 'ai', 'google-ai-api'));
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
  const kbStruct = openKbStruct({ dir: litDir, log });

  const gKey = createGoogleAiKey({ dataDir });
  if (!gKey.has()) throw new Error('Google AI Studio key missing in ' + dataDir);

  const ask = (prompt, schemaJson) => runGoogleAi({
    key: gKey.get(),
    model: 'gemini-2.5-flash',
    effort: '',
    prompt,
    schema: schemaJson,
    egress,
    timeoutMs: 300000,
  });

  const evidence = createEvidence({ kbStruct, mirror, fulltext, ask, modelName: 'gemini-2.5-flash', log: () => {} });

  const plasmaKeys = new Set();
  for (const c of mirror.collections()) {
    if (c.name === '等离子体RCS' || c.name === '等离子体鞘套电磁散射') {
      for (const it of mirror.inCollection(c.key)) {
        if (fulltext.hasPdf(it.key)) plasmaKeys.add(it.key);
      }
    }
  }

  const aeroKeys = new Set();
  for (const c of mirror.collections()) {
    if (['气动隐身', '调研工作', '每日文献', '基础理论'].includes(c.name)) {
      for (const it of mirror.inCollection(c.key)) {
        if (!plasmaKeys.has(it.key) && fulltext.hasPdf(it.key)) aeroKeys.add(it.key);
      }
    }
  }

  log(`BATCH PLAN: plasma_rcs_v1=${plasmaKeys.size} PDFs, aero_stealth_v1=${aeroKeys.size} PDFs`);

  async function runQueue(schemaId, keys, concurrency = 3) {
    const list = [...keys];
    const t0 = Date.now();
    const r = await evidence.extractBatch(list, {
      schemaId,
      concurrency,
      force: false,
      onProgress: ({ done, total, result: x }) => {
        if (x.skipped) return;
        const what = !x.ok
          ? `ERR ${x.reason}${x.error ? ': ' + String(x.error).slice(0, 120) : ''}`
          : `OK ratio=${Math.round((x.verifiedRatio || 0) * 100)}% claims=${x.claimsCount || 0}`;
        log(`[${schemaId}] ${done}/${total} ${x.zoteroKey} ${what}`);
      },
    });
    fs.writeFileSync(path.join(outDir, `evidence-${schemaId}.md`), evidence.exportMarkdown(schemaId));
    fs.writeFileSync(path.join(outDir, `evidence-${schemaId}.csv`), evidence.exportCsv(schemaId));
    log(`DONE [${schemaId}]: total=${r.total} ok=${r.ok} skipped=${r.skipped} failed=${r.failed} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  await runQueue('plasma_rcs_v1', plasmaKeys, 2);
  await runQueue('aero_stealth_v1', aeroKeys, 3);

  const askParsed = async (prompt, schemaJson) => {
    const r = await ask(prompt, schemaJson);
    return r.parsed || JSON.parse(r.text);
  };
  const embed = cfg.embed ? embedMod.open({ dataDir, cfg: cfg.embed, log: () => {} }) : null;
  const paradigm = createParadigm({ kbStruct, embed, mirror, ask: askParsed, log });
  for (const sid of ['plasma_rcs_v1', 'aero_stealth_v1']) {
    try {
      log(`Running paradigm.analyzeContradictions(${sid})...`);
      const res = await paradigm.analyzeContradictions(sid, { threshold: 0.68, maxClusters: 12 });
      log(`DONE paradigm [${sid}]: clusters=${(res.items || res.clusters || []).length}`);
    } catch (e) {
      log(`ERR paradigm [${sid}]: ${e.message}`);
    }
  }
  if (embed && typeof embed.close === 'function') embed.close();
  kbStruct.close();
  log('ALL BATCH COMPLETE');
}

main().catch((e) => {
  log('FATAL: ' + (e.stack || e.message));
  process.exit(1);
});
