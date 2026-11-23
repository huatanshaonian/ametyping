// Structured evidence tables (docs/literature-kb-architecture.md, M3): a paper's full text through a domain schema
// (evidence-schemas.js) into one row of fixed physical fields + a list of claims, each cell with the page and a verbatim
// quote. The quotes are checked against the PDF text in code (verifyExtraction); a paper whose quotes do not all check
// out is asked once more, naming the fields that failed, and the better of the two answers is kept in kb_struct.sqlite
// (kb-struct.js). A paper already done from the same PDF (same md5) is skipped unless forced.
'use strict';

const DEFAULT_SCHEMA = 'plasma_rcs_v1';

// pages worth keeping when the paper is too long: the method and the results
const KEEP_WORDS = /\b(method|methods|methodology|model|numerical|simulation|solver|formulation|setup|results?|validation|comparison|discussion|conclusions?|experiment(al)?|measurement)\b|方法|模型|数值|仿真|计算|结果|验证|对比|结论|实验|测量/gi;

// the paper's pages as `[Page N]` blocks within maxChars: everything if it fits, else the first pages, the
// method / result pages and the last page (in page order), each cut to its share when one alone is too long
function pagesBlock(pages, maxChars) {
  const blocks = pages.map((t, i) => `[Page ${i + 1}]\n${String(t || '')}`);
  const total = blocks.reduce((n, b) => n + b.length + 2, 0);
  if (total <= maxChars) return { text: blocks.join('\n\n'), truncated: false };
  const n = pages.length, per = Math.max(2000, Math.floor(maxChars / Math.min(n, 12)));
  const cut = (i) => (blocks[i].length > per ? blocks[i].slice(0, per) + '\n…' : blocks[i]);
  const pick = new Set();
  let used = 0;
  const take = (i) => { if (i < 0 || i >= n || pick.has(i)) return; const len = cut(i).length + 2; if (used + len > maxChars) return; pick.add(i); used += len; };
  take(0); take(1); take(n - 1);
  const scored = [];
  for (let i = 2; i < n - 1; i++) { const m = String(pages[i] || '').match(KEEP_WORDS); scored.push({ i, s: (m ? m.length : 0) / Math.sqrt(1 + String(pages[i] || '').length / 3000) }); }
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  for (const { i } of scored) take(i);
  const text = [...pick].sort((a, b) => a - b).map(cut).join('\n\n');
  return { text, truncated: true };
}

function itemLine(item) {
  if (!item) return '';
  const who = Array.isArray(item.creators) && item.creators.length ? item.creators.slice(0, 3).join('; ') + (item.creators.length > 3 ? ' et al.' : '') : '';
  return [item.title && `标题：${item.title}`, who && `作者：${who}`, item.year && `年份：${item.year}`, item.venue && `期刊/会议：${item.venue}`, item.doi && `DOI：${item.doi}`].filter(Boolean).join('\n');
}

function buildPrompt(item, pages, schema, { retryFields = [], maxChars = 160000 } = {}) {
  const fields = (schema && Array.isArray(schema.fields) ? schema.fields : []);
  const { text, truncated } = pagesBlock(Array.isArray(pages) ? pages : [], maxChars);
  const lines = [
    `你在为一篇论文填写结构化证据表「${(schema && (schema.name || schema.id)) || ''}」。${(schema && schema.description) || ''}`,
    '',
    '要求：',
    '1. 严格按给定的 JSON Schema 输出，只依据下面的论文原文抽取，禁止编造、推测或引用论文之外的知识。',
    '2. 原文里找不到的字段，value、unit、quote 都填空字符串 ""，page 填 0。',
    '3. 每一格的 quote 必须逐字抄录自对应页的原文（保留原文语言、数字和单位，不改写、不翻译），且必须是原文中一段连续的句子或表格行，严禁使用 ... 或 … 省略号拼接两处文本；长度以能支撑 value 的一两句为宜。',
    '4. 若 value 包含具体数值且来自表格或正文，quote 必须直接抄录含这些数值的原始句子或表格行，不得只抄“见 Table 1”或类似指向性说明。',
    '5. page 填数字页码，即原文中 [Page N] 标记的 N。',
    '6. value 用简洁的中文或原文术语概括；unit 填物理量单位（没有则留空）。',
    '7. claims 列出论文的主要定量结论：condition（条件/参数）、conclusion（结论）、metric（指标，可空）、page、quote，同样逐字引用连续原文，严禁使用 ... 省略号拼接。',
    '',
    '字段：',
    ...fields.map((f) => `- ${f.key}（${f.label || f.key}）${f.hint ? '：' + f.hint : ''}`),
  ];
  if (retryFields && retryFields.length) {
    lines.push('', `纠错：上一次抽取中以下字段的 quote 未能在原文对应页找到：${retryFields.join(', ')}。`,
      '这次请对这些字段严格从原文逐字复制 quote，并核对 page；如果原文确实没有依据，就把该字段的 value、quote 留空。');
  }
  const meta = itemLine(item);
  if (meta) lines.push('', '论文信息：', meta);
  lines.push('', truncated ? '论文原文（篇幅过长，只保留了开头、方法与结果相关页和末页）：' : '论文原文：', text);
  return lines.join('\n');
}

const emptyValue = (v) => v == null || /^(|null|n\/a|none|无)$/i.test(String(v).trim());

// RFC 4180: a field with a quote, comma or line break goes in quotes, quotes doubled
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const mdCell = (v) => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim();

function createEvidence({ kbStruct, mirror, fulltext, ask, modelName = '', log = () => {}, schemas = null }) {
  if (!kbStruct || !fulltext || typeof ask !== 'function') throw new Error('createEvidence 需要 kbStruct、fulltext 和 ask');
  let S = schemas;
  const lib = () => (S || (S = require('./evidence-schemas')));
  const itemOf = (k) => (mirror && typeof mirror.item === 'function' ? mirror.item(k) : null);

  async function extractOne(zoteroKey, { schemaId = DEFAULT_SCHEMA, force = false, maxRetries = 1 } = {}) {
    const schema = lib().getSchema(schemaId);
    if (!schema) throw new Error('未知的证据表 Schema：' + schemaId);
    const item = itemOf(zoteroKey);
    const ft = await fulltext.forItem(zoteroKey);
    if (!ft || ft.missing || !Array.isArray(ft.pages) || !ft.pages.length) return { ok: false, zoteroKey, reason: (ft && ft.missing) || 'no-text' };
    const old = kbStruct.getEvidence(zoteroKey, schemaId);
    if (old && old.pdfMd5 && old.pdfMd5 === ft.md5 && !force) return { ok: true, zoteroKey, skipped: true };

    const extractSchema = lib().buildExtractSchema(schemaId);
    let best = null, retryFields = [], attempts = 0;
    maxRetries = Math.max(0, +maxRetries || 0);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const prompt = buildPrompt(item, ft.pages, schema, { retryFields });
      let raw;
      try { raw = await ask(prompt, extractSchema); }
      catch (e) { if (!best) throw e; log(`证据表：${zoteroKey} 重试失败，保留第一次结果：${e.message}`); break; }
      attempts++;
      const v = lib().verifyExtraction(schemaId, raw || {}, ft.pages);
      if (!best || v.verifiedRatio > best.verifiedRatio) best = v;
      if (!v.unverifiedFields || !v.unverifiedFields.length || attempt >= maxRetries) break;
      retryFields = v.unverifiedFields;
      log(`证据表：${zoteroKey} 有 ${retryFields.length} 个字段原文核验未通过（${retryFields.join(', ')}），重试`);
    }
    kbStruct.saveEvidence({ zoteroKey, schemaId, pdfMd5: ft.md5 || '', fields: best.fields, verifiedRatio: best.verifiedRatio, humanVerified: 0, model: modelName });
    const claims = Array.isArray(best.claims) ? best.claims : [];
    kbStruct.replaceClaims(zoteroKey, schemaId, claims);
    return { ok: true, zoteroKey, skipped: false, verifiedRatio: best.verifiedRatio, unverifiedFields: best.unverifiedFields || [], claimsCount: claims.length, attempts };
  }

  async function extractBatch(keys, { schemaId = DEFAULT_SCHEMA, concurrency = 2, force = false, maxRetries = 1, onProgress = null } = {}) {
    const list = [...new Set((keys || []).filter(Boolean))];
    const results = new Array(list.length);
    let next = 0, done = 0;
    async function worker() {
      while (next < list.length) {
        const i = next++, key = list[i];
        let r;
        try { r = await extractOne(key, { schemaId, force, maxRetries }); }
        catch (e) { r = { ok: false, zoteroKey: key, reason: 'error', error: String((e && e.message) || e) }; log(`证据表：${key} 抽取失败：${r.error}`); }
        results[i] = r; done++;
        if (typeof onProgress === 'function') { try { onProgress({ done, total: list.length, result: r }); } catch {} }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(+concurrency || 1, list.length)) }, worker));
    const ok = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.ok && r.skipped).length;
    return { total: list.length, ok, skipped, failed: list.length - ok - skipped, results };
  }

  function rowsOf(schemaId) {
    const schema = lib().getSchema(schemaId);
    if (!schema) throw new Error('未知的证据表 Schema：' + schemaId);
    const rows = (kbStruct.listEvidence(schemaId) || []).map((e) => ({ e, it: itemOf(e.zoteroKey) || {} }));
    rows.sort((a, b) => String(a.it.year || '').localeCompare(String(b.it.year || '')) || String(a.it.title || a.e.zoteroKey).localeCompare(String(b.it.title || b.e.zoteroKey)));
    return { schema, rows };
  }
  const cellOf = (f) => (f && typeof f === 'object' ? f : { value: f });
  const pageOf = (c) => +c.matchedPage || +c.page || 0;

  function exportMarkdown(schemaId = DEFAULT_SCHEMA) {
    const { schema, rows } = rowsOf(schemaId);
    const fields = schema.fields || [];
    const head = ['论文', '年份', 'citekey', '核验率', ...fields.map((f) => f.label || f.key)];
    const out = [`# 证据表：${schema.name || schema.id}`, '', `Schema \`${schema.id}\`，共 ${rows.length} 篇。✓ 表示引文已在原文对应页找到，⚠ 表示未通过原文核验；p.N 为页码。`, '',
      '| ' + head.map(mdCell).join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'];
    for (const { e, it } of rows) {
      const cells = [it.title || e.zoteroKey, it.year || '', it.citekey || e.zoteroKey, `${Math.round((+e.verifiedRatio || 0) * 100)}%${e.humanVerified ? ' 人工' : ''}`];
      for (const f of fields) {
        const c = cellOf((e.fields || {})[f.key]);
        if (emptyValue(c.value)) { cells.push(''); continue; }
        const p = pageOf(c);
        cells.push(`${c.value}${c.unit ? ' ' + c.unit : ''}${p ? ` (p.${p})` : ''} ${+c.verified === 1 ? '✓' : '⚠'}`);
      }
      out.push('| ' + cells.map(mdCell).join(' | ') + ' |');
    }
    return out.join('\n') + '\n';
  }

  function exportCsv(schemaId = DEFAULT_SCHEMA) {
    const { schema, rows } = rowsOf(schemaId);
    const fields = schema.fields || [];
    const head = ['zotero_key', 'title', 'year', 'citekey', 'verified_ratio', 'human_verified', 'model'];
    for (const f of fields) head.push(f.key, f.key + '_unit', f.key + '_page', f.key + '_verified', f.key + '_quote');
    const lines = [head.map(csvCell).join(',')];
    for (const { e, it } of rows) {
      const r = [e.zoteroKey, it.title || '', it.year || '', it.citekey || '', (+e.verifiedRatio || 0).toFixed(3), e.humanVerified ? 1 : 0, e.model || ''];
      for (const f of fields) {
        const c = cellOf((e.fields || {})[f.key]);
        const empty = emptyValue(c.value);
        r.push(empty ? '' : c.value, empty ? '' : c.unit || '', empty ? '' : pageOf(c) || '', empty ? '' : +c.verified === 1 ? 1 : 0, empty ? '' : c.quote || '');
      }
      lines.push(r.map(csvCell).join(','));
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  return { extractOne, extractBatch, exportMarkdown, exportCsv };
}

module.exports = { createEvidence, buildPrompt, csvCell };
