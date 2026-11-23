#!/usr/bin/env node
// Evidence-table pilot (docs/literature-kb-architecture.md, M1): run 30-50 papers of one Zotero collection (or given
// item keys) through remote/server/literature/evidence.js with Google AI Studio, and write the table as Markdown and
// CSV for spot checks. Meant to run on the NAS next to the server's data (the Zotero mirror, the WebDAV folder, the
// PDF text cache and the Google AI Studio key); results go to <data-dir>/literature/kb_struct.sqlite.
//
//   node tools/lit-evidence-pilot.js --collection "等离子体鞘套" --schema plasma_rcs_v1 --limit 30 --out ./pilot
//   node tools/lit-evidence-pilot.js --keys ABCD1234,EFGH5678 --dry-run
//
// Options:
//   --data-dir <dir>     the server's data directory (default: from the server config, else remote/server/data)
//   --config <file>      the server's config.json (default: $AME_REMOTE_CONFIG, else remote/server/config.json);
//                        literature.webdavDir / literature.pdftotext / summary.proxies are read from it
//   --webdav-dir <dir>   Zotero's WebDAV folder (overrides the config)
//   --pdftotext <bin>    pdftotext binary (overrides the config)
//   --collection <name>  a Zotero collection by name (its sub-collections included)
//   --keys <k1,k2>       Zotero item keys
//   --schema <id>        plasma_rcs_v1 (default) | aero_stealth_v1
//   --limit <N>          at most N papers (default 30); papers with a PDF are taken first
//   --model <id>         Google AI Studio model (default gemini-2.5-flash)
//   --effort <e>         low | medium | high (thinking budget, Gemini 2.5)
//   --concurrency <N>    papers at once (default 2)
//   --force              extract again even when the PDF has not changed
//   --out <dir>          where evidence-<schema>.md / .csv go (default ./lit-evidence-out)
//   --dry-run            only list the chosen papers and their PDF coverage; no model calls
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'remote', 'server');

function parseArgs(argv) {
  const o = { schema: 'plasma_rcs_v1', limit: 30, model: 'gemini-2.5-flash', concurrency: 2, out: 'lit-evidence-out', dryRun: false, force: false };
  const flags = { '--dry-run': 'dryRun', '--force': 'force' };
  const vals = { '--data-dir': 'dataDir', '--config': 'config', '--webdav-dir': 'webdavDir', '--pdftotext': 'pdftotext', '--collection': 'collection', '--keys': 'keys',
    '--schema': 'schema', '--limit': 'limit', '--model': 'model', '--effort': 'effort', '--concurrency': 'concurrency', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    if (flags[a]) { o[flags[a]] = true; continue; }
    if (!vals[a]) throw new Error('不认识的参数：' + a);
    if (v == null) { v = argv[++i]; if (v == null) throw new Error(a + ' 缺少取值'); }
    o[vals[a]] = v;
  }
  o.limit = Math.max(1, parseInt(o.limit, 10) || 30);
  o.concurrency = Math.max(1, Math.min(8, parseInt(o.concurrency, 10) || 2));
  o.keys = o.keys ? String(o.keys).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : [];
  return o;
}

function usage() {
  const src = fs.readFileSync(__filename, 'utf8').split('\n');
  return src.slice(1, src.findIndex((l) => l.startsWith("'use strict'"))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}

function loadConfig(file) {
  const f = file || process.env.AME_REMOTE_CONFIG || path.join(SERVER, 'config.json');
  try { return { file: f, cfg: JSON.parse(fs.readFileSync(f, 'utf8')) }; }
  catch (e) { if (file) throw new Error(`读不了配置 ${f}：${e.message}`); return { file: '', cfg: {} }; }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(usage()); return 0; }
  if (!o.collection && !o.keys.length) throw new Error('请给 --collection <名称> 或 --keys <k1,k2>（--help 查看用法）');

  const { file: cfgFile, cfg } = loadConfig(o.config);
  const litCfg = cfg.literature || {};
  const dataDir = path.resolve(o.dataDir || (cfgFile ? path.resolve(path.dirname(cfgFile), cfg.dataDir || 'data') : path.join(SERVER, 'data')));
  const litDir = path.join(dataDir, 'literature');
  if (!fs.existsSync(path.join(litDir, 'zotero.json'))) throw new Error(`${litDir} 下没有 zotero.json（Zotero 镜像）：请用 --data-dir 指向服务器的数据目录`);

  const { createMirror } = require(path.join(SERVER, 'literature', 'zotero', 'mirror'));
  const { createWebdav } = require(path.join(SERVER, 'literature', 'zotero', 'webdav'));
  const { createFulltext } = require(path.join(SERVER, 'literature', 'fulltext'));
  const { createHttp } = require(path.join(SERVER, 'literature', 'http'));
  const { createEgress } = require(path.join(SERVER, 'egress'));
  const { getSchema } = require(path.join(SERVER, 'literature', 'evidence-schemas'));

  const schema = getSchema(o.schema);
  if (!schema) throw new Error('未知的 Schema：' + o.schema);
  const log = (s) => console.error('  · ' + s);
  const proxies = (cfg.summary && cfg.summary.proxies) || [];
  const litProxies = Array.isArray(litCfg.proxies) ? litCfg.proxies : proxies;
  const http = createHttp({ egress: litProxies.length ? createEgress({ proxies: litProxies, log }) : null, viaProxy: litCfg.viaProxy || ['ntrs.nasa.gov', 'archive.org', 'dtic.mil'] });

  // the mirror as last saved by the server (no Zotero calls from here)
  const mirror = createMirror({ api: null, dir: litDir, log });
  const webdav = createWebdav({ dir: o.webdavDir || litCfg.webdavDir || '' });
  const fulltext = createFulltext({ dir: litDir, mirror, webdav, bin: o.pdftotext || litCfg.pdftotext || 'pdftotext', http, log });

  // the papers
  let items;
  if (o.keys.length) {
    items = o.keys.map((k) => mirror.item(k) || { key: k, title: '（Zotero 镜像里没有这一条）', missing: true });
  } else {
    const col = mirror.collectionByName(o.collection);
    if (!col) {
      const names = mirror.collections().map((c) => c.name).slice(0, 40);
      throw new Error(`Zotero 里没有名为「${o.collection}」的分类。现有分类（前 40 个）：${names.join('、')}`);
    }
    items = mirror.inCollection(col.key);
  }
  const withPdf = items.map((it) => ({ it, pdf: !it.missing && fulltext.hasPdf(it.key) }));
  const chosen = [...withPdf.filter((x) => x.pdf), ...withPdf.filter((x) => !x.pdf)].slice(0, o.limit);
  const cover = chosen.filter((x) => x.pdf).length;

  console.log(`Schema：${schema.id}（${schema.name || ''}），${o.collection ? `分类「${o.collection}」共 ${items.length} 篇，其中 ${withPdf.filter((x) => x.pdf).length} 篇有 PDF；` : ''}选中 ${chosen.length} 篇，有 PDF ${cover} 篇（${chosen.length ? Math.round((cover / chosen.length) * 100) : 0}%）`);
  for (const { it, pdf } of chosen) console.log(`  ${pdf ? '📄' : '··'} ${it.key}  ${it.year || '    '}  ${String(it.title || '').slice(0, 90)}`);
  if (o.dryRun) { console.log('（--dry-run：没有调用模型）'); return 0; }
  if (!cover) throw new Error('选中的论文都没有可读的 PDF');

  const { createGoogleAiKey, runGoogleAi } = require(path.join(SERVER, 'ai', 'google-ai-api'));
  const key = createGoogleAiKey({ dataDir });
  if (!key.has()) throw new Error(`${dataDir}/google-ai-api.json 里没有 Google AI Studio key（控制面板 › AI 模型 里设置）`);
  const egress = proxies.length ? createEgress({ proxies, log }) : null;
  const ask = (prompt, schemaJson) => runGoogleAi({ key: key.get(), model: o.model, effort: o.effort || '', prompt, schema: schemaJson, egress, timeoutMs: 300000 });

  const { openKbStruct } = require(path.join(SERVER, 'literature', 'kb-struct'));
  const { createEvidence } = require(path.join(SERVER, 'literature', 'evidence'));
  const kbStruct = openKbStruct({ dir: litDir, log });
  try {
    const ev = createEvidence({ kbStruct, mirror, fulltext, ask, modelName: o.model, log });
    const t0 = Date.now();
    const keys = chosen.filter((x) => x.pdf).map((x) => x.it.key);
    console.log(`\n开始抽取 ${keys.length} 篇（模型 ${o.model}，并发 ${o.concurrency}${o.force ? '，强制重跑' : ''}）`);
    const r = await ev.extractBatch(keys, { schemaId: schema.id, concurrency: o.concurrency, force: o.force, onProgress: ({ done, total, result: x }) => {
      const what = !x.ok ? `失败 ${x.reason}${x.error ? '：' + String(x.error).slice(0, 120) : ''}` : x.skipped ? '跳过（PDF 未变）'
        : `核验 ${Math.round(x.verifiedRatio * 100)}%，结论 ${x.claimsCount} 条${x.unverifiedFields.length ? '，未通过：' + x.unverifiedFields.join(',') : ''}`;
      console.log(`  [${done}/${total}] ${x.zoteroKey} ${what}`);
    } });

    fs.mkdirSync(o.out, { recursive: true });
    const md = path.resolve(o.out, `evidence-${schema.id}.md`), csv = path.resolve(o.out, `evidence-${schema.id}.csv`);
    fs.writeFileSync(md, ev.exportMarkdown(schema.id));
    fs.writeFileSync(csv, ev.exportCsv(schema.id));

    const done = r.results.filter((x) => x.ok && !x.skipped);
    const avg = done.length ? done.reduce((n, x) => n + x.verifiedRatio, 0) / done.length : null;
    const all = kbStruct.listEvidence(schema.id);
    const avgAll = all.length ? all.reduce((n, e) => n + (+e.verifiedRatio || 0), 0) / all.length : null;
    console.log(`\n汇总：共 ${r.total} 篇，成功 ${r.ok}，跳过 ${r.skipped}，失败 ${r.failed}，用时 ${Math.round((Date.now() - t0) / 1000)} s`);
    console.log(`  平均原文核验通过率：本次 ${avg == null ? '—' : (avg * 100).toFixed(1) + '%'}；表内全部 ${all.length} 篇 ${avgAll == null ? '—' : (avgAll * 100).toFixed(1) + '%'}`);
    for (const x of r.results.filter((y) => !y.ok)) console.log(`  失败 ${x.zoteroKey}：${x.reason}${x.error ? ' ' + String(x.error).slice(0, 160) : ''}`);
    console.log(`  导出：${md}\n        ${csv}`);
    return r.failed && !r.ok && !r.skipped ? 1 : 0;
  } finally {
    try { kbStruct.close(); } catch {}
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error('错误：' + ((e && e.message) || e)); process.exitCode = 2; });
}

module.exports = { parseArgs };
