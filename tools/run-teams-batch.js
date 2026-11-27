#!/usr/bin/env node
// Batch-extract University / Lab / PI team profiles & collaboration edges for all papers in kb_struct.sqlite.
// Resumable: skips papers that already have team links.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'remote', 'server');
const cfg = JSON.parse(fs.readFileSync(path.join(SERVER, 'config.json'), 'utf8'));
const litCfg = cfg.literature || {};
const dataDir = path.resolve(SERVER, cfg.dataDir || 'data');
const litDir = path.join(dataDir, 'literature');

const { createMirror } = require(path.join(SERVER, 'literature', 'zotero', 'mirror'));
const { createWebdav } = require(path.join(SERVER, 'literature', 'zotero', 'webdav'));
const { createFulltext } = require(path.join(SERVER, 'literature', 'fulltext'));
const { createHttp } = require(path.join(SERVER, 'literature', 'http'));
const { createEgress } = require(path.join(SERVER, 'egress'));
const { openKbStruct } = require(path.join(SERVER, 'literature', 'kb-struct'));
const { createStream } = require(path.join(SERVER, 'literature', 'stream'));
const { createLitAsker } = require(path.join(__dirname, 'lib', 'lit-ask'));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PROVIDER = opt('--provider', 'google');
const MODEL = opt('--model', 'gemini-4-neon');
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
  const asker = createLitAsker({ serverDir: SERVER, cfg, dataDir, egress, provider: PROVIDER, model: MODEL, effort: '', log });
  const ask = asker.ask;

  const stream = createStream({ kbStruct, mirror, fulltext, ask, log: () => {} });
  const keys = new Set();
  for (const sid of ['plasma_rcs_v1', 'aero_stealth_v1']) {
    for (const ev of kbStruct.listEvidence(sid) || []) keys.add(ev.zoteroKey);
  }
  const todo = [...keys].filter((k) => kbStruct.teamsOfPaper(k).length === 0);
  log(`TEAMS BATCH: total=${keys.size}, todo=${todo.length}, skipped=${keys.size - todo.length}`);

  let idx = 0, ok = 0, fail = 0;
  const concurrency = 4;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (idx < todo.length) {
      const k = todo[idx++];
      const pos = idx;
      try {
        const r = await stream.extractTeamsForPaper(k);
        if (r && r.ok) {
          ok++;
          if (pos % 15 === 0 || pos === todo.length) log(`  [${pos}/${todo.length}] ok=${ok} fail=${fail} last=${k} (${(r.teams || []).map((t) => t.institution).join(', ')})`);
        } else {
          fail++;
        }
      } catch (e) {
        fail++;
        log(`  [${pos}/${todo.length}] ERR ${k}: ${e.message}`);
      }
    }
  }));

  const g = kbStruct.teamGraph();
  log(`ALL TEAMS DONE: ok=${ok} fail=${fail} teams=${g.nodes.length} edges=${g.edges.length}`);
  kbStruct.close();
}

main().catch((e) => { log('FATAL: ' + (e.stack || e.message)); process.exit(1); });
