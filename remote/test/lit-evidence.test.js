// evidence.js: extraction with md5 idempotence, quote-check retry, batch, Markdown / CSV export.
// Runs against mocks (ask, fulltext, mirror, kbStruct, schemas); when kb-struct.js and evidence-schemas.js are present
// one more test runs the engine on the real store and the real quote checker.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEvidence, buildPrompt, csvCell } = require('../server/literature/evidence');

const LIT = path.join(__dirname, '..', 'server', 'literature');
const haveReal = fs.existsSync(path.join(LIT, 'kb-struct.js')) && fs.existsSync(path.join(LIT, 'evidence-schemas.js'));

// ---- mocks -------------------------------------------------------------------------------------------------------
const SCHEMA = { id: 'plasma_rcs_v1', name: '等离子体鞘套 RCS', description: 'test', fields: [
  { key: 'em_method', label: '电磁算法', hint: 'FDTD/MoM' },
  { key: 'peak_ne', label: '峰值电子密度', hint: 'm^-3' },
  { key: 'key_result', label: '关键结论', hint: '' },
] };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').toLowerCase();
const mockSchemas = {
  getSchema: (id) => (id === SCHEMA.id ? SCHEMA : null),
  buildExtractSchema: () => ({ type: 'object', properties: { fields: { type: 'object' }, claims: { type: 'array' } } }),
  verifyExtraction(id, raw, pages) {
    const fields = {}, unverified = [];
    let n = 0, ok = 0;
    for (const f of SCHEMA.fields) {
      const c = { ...((raw.fields || {})[f.key] || {}) };
      if (!c.value) { fields[f.key] = { ...c, verified: 1, matchedPage: 0 }; continue; }
      n++;
      const hit = c.quote && norm(pages[c.page - 1]).includes(norm(c.quote));
      fields[f.key] = { ...c, verified: hit ? 1 : 0, matchedPage: hit ? c.page : 0 };
      if (hit) ok++; else unverified.push(f.key);
    }
    const claims = (raw.claims || []).map((c) => ({ ...c, verified: c.quote && norm(pages[c.page - 1]).includes(norm(c.quote)) ? 1 : 0 }));
    return { fields, claims, verifiedRatio: n ? ok / n : 1, unverifiedFields: unverified };
  },
};

function mockKb() {
  const ev = new Map(), cl = new Map();
  return {
    ev, cl,
    getEvidence: (k, s) => ev.get(k + '|' + s) || null,
    saveEvidence: (e) => ev.set(e.zoteroKey + '|' + e.schemaId, { humanVerified: 0, model: '', ...e, updated: Date.now() }),
    listEvidence: (s) => [...ev.values()].filter((e) => e.schemaId === s),
    replaceClaims: (k, s, claims) => cl.set(k + '|' + s, claims),
  };
}

const PAGES = {
  AAAA1111: ['Plasma sheath RCS. Introduction text.', 'We use the FDTD method with a Drude model.', 'The peak electron density reaches 1e18 m^-3 at 60 km.', 'Conclusions: RCS drops by 20 dB at X band.'],
  BBBB2222: ['A "quoted", title page', 'Method of moments, with commas, and | pipes.'],
};
function mockFulltext(md5 = { AAAA1111: 'md5-a', BBBB2222: 'md5-b' }) {
  return { md5, forItem: async (k) => (PAGES[k] ? { pages: PAGES[k], md5: md5[k] } : { missing: 'nopdf' }) };
}
const mirror = { item: (k) => ({
  AAAA1111: { key: 'AAAA1111', title: 'Plasma sheath RCS', year: '2021', citekey: 'li2021plasma', creators: ['Li, A'] },
  BBBB2222: { key: 'BBBB2222', title: 'Title, with "quotes"\nand newline | pipe', year: '2019', citekey: 'wang2019' },
}[k] || null) };

const GOOD = { fields: {
  em_method: { value: 'FDTD + Drude', unit: '', page: 2, quote: 'We use the FDTD method' },
  peak_ne: { value: '1e18', unit: 'm^-3', page: 3, quote: 'peak electron density reaches 1e18 m^-3' },
  key_result: { value: 'X 波段 RCS 降 20 dB', unit: 'dB', page: 4, quote: 'RCS drops by 20 dB at X band' },
}, claims: [{ condition: '60 km', conclusion: 'RCS drops 20 dB', metric: 'RCS', page: 4, quote: 'RCS drops by 20 dB' }] };
const BAD = { fields: { ...GOOD.fields, peak_ne: { value: '1e19', unit: 'm^-3', page: 3, quote: 'electron density of 1e19 invented' } }, claims: GOOD.claims };

function setup({ answers, fulltext = mockFulltext(), delay = 0 } = {}) {
  const kb = mockKb();
  const calls = [];
  let inflight = 0, peak = 0;
  const ask = async (prompt, schema) => {
    calls.push({ prompt, schema });
    inflight++; peak = Math.max(peak, inflight);
    try {
      if (delay) await new Promise((r) => setImmediate(r));
      const a = typeof answers === 'function' ? answers(prompt, calls.length) : answers[Math.min(calls.length - 1, answers.length - 1)];
      if (a instanceof Error) throw a;
      return JSON.parse(JSON.stringify(a));
    } finally { inflight--; }
  };
  const ev = createEvidence({ kbStruct: kb, mirror, fulltext, ask, modelName: 'mock-model', schemas: mockSchemas });
  return { ev, kb, calls, peak: () => peak };
}

// ---- buildPrompt -------------------------------------------------------------------------------------------------
test('buildPrompt: page markers, rules, retry hint and truncation', () => {
  const p = buildPrompt(mirror.item('AAAA1111'), PAGES.AAAA1111, SCHEMA);
  assert.match(p, /\[Page 1\]\nPlasma sheath RCS/);
  assert.match(p, /\[Page 4\]\nConclusions/);
  assert.match(p, /禁止编造/);
  assert.match(p, /""/);
  assert.match(p, /逐字/);
  assert.match(p, /peak_ne（峰值电子密度）/);
  assert.doesNotMatch(p, /纠错/);
  const r = buildPrompt(null, PAGES.AAAA1111, SCHEMA, { retryFields: ['peak_ne', 'em_method'] });
  assert.match(r, /纠错.*peak_ne, em_method/);

  const long = Array.from({ length: 40 }, (_, i) => (i === 20 ? 'Numerical results and validation. ' : 'filler text. ') + `page${i + 1} ` + 'x'.repeat(5000));
  const t = buildPrompt(null, long, SCHEMA, { maxChars: 30000 });
  const body = t.slice(t.indexOf('论文原文'));
  assert.ok(body.length < 32000, 'truncated to about maxChars');
  assert.match(body, /\[Page 1\]/);
  assert.match(body, /\[Page 2\]/);
  assert.match(body, /\[Page 40\]/);
  assert.match(body, /\[Page 21\]\nNumerical results/, 'keeps the results page');
  assert.doesNotMatch(body, /\[Page 10\]/);
  const order = [...body.matchAll(/\[Page (\d+)\]/g)].map((m) => +m[1]);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'pages in order');
});

// ---- extractOne --------------------------------------------------------------------------------------------------
test('extractOne: extracts, saves, then skips the same md5, force re-runs', async () => {
  const { ev, kb, calls } = setup({ answers: [GOOD] });
  const r = await ev.extractOne('AAAA1111');
  assert.equal(r.ok, true); assert.equal(r.skipped, false);
  assert.equal(r.verifiedRatio, 1); assert.deepEqual(r.unverifiedFields, []); assert.equal(r.claimsCount, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /\[Page 3\]/);
  assert.ok(calls[0].schema && calls[0].schema.properties);
  const saved = kb.getEvidence('AAAA1111', 'plasma_rcs_v1');
  assert.equal(saved.pdfMd5, 'md5-a'); assert.equal(saved.model, 'mock-model'); assert.equal(saved.fields.peak_ne.verified, 1);
  assert.equal(kb.cl.get('AAAA1111|plasma_rcs_v1').length, 1);

  const again = await ev.extractOne('AAAA1111');
  assert.deepEqual(again, { ok: true, zoteroKey: 'AAAA1111', skipped: true });
  assert.equal(calls.length, 1, 'no model call when the PDF is unchanged');

  const forced = await ev.extractOne('AAAA1111', { force: true });
  assert.equal(forced.skipped, false); assert.equal(calls.length, 2);
});

test('extractOne: a changed PDF (new md5) is extracted again', async () => {
  const ft = mockFulltext();
  const { ev, calls } = setup({ answers: [GOOD], fulltext: ft });
  await ev.extractOne('AAAA1111');
  ft.md5.AAAA1111 = 'md5-a2';
  const r = await ev.extractOne('AAAA1111');
  assert.equal(r.skipped, false); assert.equal(calls.length, 2);
});

test('extractOne: failed quote check retries once with retryFields, keeps the better answer', async () => {
  const { ev, kb, calls } = setup({ answers: [BAD, GOOD] });
  const r = await ev.extractOne('AAAA1111');
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0].prompt, /纠错/);
  assert.match(calls[1].prompt, /纠错.*peak_ne/);
  assert.equal(r.verifiedRatio, 1); assert.deepEqual(r.unverifiedFields, []); assert.equal(r.attempts, 2);
  assert.equal(kb.getEvidence('AAAA1111', 'plasma_rcs_v1').fields.peak_ne.value, '1e18');

  // the retry is worse: the first answer stays
  const worse = { fields: { em_method: { value: 'MoM', page: 1, quote: 'nope nope nope' }, peak_ne: BAD.fields.peak_ne, key_result: { value: 'x', page: 4, quote: 'made up' } }, claims: [] };
  const s = setup({ answers: [BAD, worse] });
  const r2 = await s.ev.extractOne('AAAA1111');
  assert.equal(s.calls.length, 2);
  assert.ok(Math.abs(r2.verifiedRatio - 2 / 3) < 1e-9);
  assert.deepEqual(r2.unverifiedFields, ['peak_ne']);
  assert.equal(s.kb.getEvidence('AAAA1111', 'plasma_rcs_v1').fields.em_method.value, 'FDTD + Drude');
  assert.equal(r2.claimsCount, 1);

  // still failing after the one retry: no third call
  const s3 = setup({ answers: [BAD, BAD, GOOD] });
  await s3.ev.extractOne('AAAA1111');
  assert.equal(s3.calls.length, 2);

  // maxRetries 0: no retry
  const s0 = setup({ answers: [BAD, GOOD] });
  await s0.ev.extractOne('AAAA1111', { maxRetries: 0 });
  assert.equal(s0.calls.length, 1);

  // the retry call throws: the first answer is still saved
  const se = setup({ answers: [BAD, new Error('429')] });
  const re = await se.ev.extractOne('AAAA1111');
  assert.equal(re.ok, true); assert.ok(se.kb.getEvidence('AAAA1111', 'plasma_rcs_v1'));
});

test('extractOne: no PDF / no text returns ok:false without throwing or calling the model', async () => {
  const { ev, calls, kb } = setup({ answers: [GOOD] });
  assert.deepEqual(await ev.extractOne('ZZZZ9999'), { ok: false, zoteroKey: 'ZZZZ9999', reason: 'nopdf' });
  const empty = setup({ answers: [GOOD], fulltext: { forItem: async () => ({ pages: [], md5: 'x' }) } });
  assert.deepEqual(await empty.ev.extractOne('AAAA1111'), { ok: false, zoteroKey: 'AAAA1111', reason: 'no-text' });
  const nul = setup({ answers: [GOOD], fulltext: { forItem: async () => null } });
  assert.equal((await nul.ev.extractOne('AAAA1111')).reason, 'no-text');
  assert.equal(calls.length, 0); assert.equal(kb.ev.size, 0);
});

// ---- extractBatch ------------------------------------------------------------------------------------------------
test('extractBatch: limited concurrency, one failure does not stop the batch', async () => {
  const keys = ['AAAA1111', 'BBBB2222', 'ZZZZ9999', 'CCCC3333', 'AAAA1111'];
  PAGES.CCCC3333 = ['page one text', 'page two'];
  const ft = mockFulltext({ AAAA1111: 'a', BBBB2222: 'b', CCCC3333: 'c' });
  const { ev, peak } = setup({ fulltext: ft, delay: 1, answers: (prompt) => (/page one text/.test(prompt) ? new Error('model down') : GOOD) });
  const seen = [];
  const r = await ev.extractBatch(keys, { concurrency: 2, onProgress: (p) => seen.push(p.done) });
  delete PAGES.CCCC3333;
  assert.equal(r.total, 4, 'duplicate keys collapsed');
  assert.equal(r.results.length, 4);
  assert.equal(r.ok, 2); assert.equal(r.skipped, 0); assert.equal(r.failed, 2);
  assert.equal(r.results[2].reason, 'nopdf');
  assert.equal(r.results[3].ok, false); assert.equal(r.results[3].reason, 'error'); assert.match(r.results[3].error, /model down/);
  assert.ok(peak() <= 2, 'at most 2 at once'); assert.equal(peak(), 2, 'runs in parallel');
  assert.deepEqual(seen, [1, 2, 3, 4]);

  const again = await ev.extractBatch(['AAAA1111', 'BBBB2222'], { concurrency: 3 });
  assert.equal(again.skipped, 2); assert.equal(again.ok, 0);
});

// ---- export ------------------------------------------------------------------------------------------------------
test('exportMarkdown / exportCsv: values, pages, marks and escaping', async () => {
  const { ev } = setup({ answers: (prompt) => (/Method of moments/.test(prompt)
    ? { fields: { em_method: { value: 'MoM, "EFIE" | PO', unit: '', page: 2, quote: 'Method of moments, with commas' }, peak_ne: { value: '', page: 0, quote: '' }, key_result: { value: 'line1\nline2', page: 1, quote: 'not in text at all' } }, claims: [] }
    : GOOD) });
  await ev.extractOne('AAAA1111', { maxRetries: 0 });
  await ev.extractOne('BBBB2222', { maxRetries: 0 });

  const md = ev.exportMarkdown('plasma_rcs_v1');
  const lines = md.trim().split('\n');
  const head = lines.find((l) => l.startsWith('| 论文'));
  assert.equal(head, '| 论文 | 年份 | citekey | 核验率 | 电磁算法 | 峰值电子密度 | 关键结论 |');
  const rowA = lines.find((l) => l.includes('li2021plasma'));
  assert.match(rowA, /\| Plasma sheath RCS \| 2021 \| li2021plasma \| 100% \|/);
  assert.match(rowA, /1e18 m\^-3 \(p\.3\) ✓/);
  const rowB = lines.find((l) => l.includes('wang2019'));
  assert.match(rowB, /Title, with "quotes" and newline \\\| pipe/);
  assert.match(rowB, /MoM, "EFIE" \\\| PO \(p\.2\) ✓/);
  assert.match(rowB, /line1 line2 \(p\.1\) ⚠/);
  assert.match(rowB, /✓ \|  \| line1/, 'empty field is an empty cell');
  for (const l of lines.filter((x) => x.startsWith('| '))) assert.equal(l.split(/(?<!\\)\|/).length, head.split('|').length, 'same column count: ' + l);
  assert.ok(lines.indexOf(rowB) < lines.indexOf(rowA), 'sorted by year');

  const csv = ev.exportCsv('plasma_rcs_v1');
  assert.ok(csv.startsWith('\ufeff'), 'UTF-8 BOM');
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(csv.startsWith('\ufeffzotero_key,title,year,citekey,verified_ratio,human_verified,model,em_method,em_method_unit,em_method_page,em_method_verified,em_method_quote,peak_ne,'));
  assert.ok(csv.includes('BBBB2222,"Title, with ""quotes""\nand newline | pipe",2019,wang2019,0.500,0,mock-model,"MoM, ""EFIE"" | PO",,2,1,"Method of moments, with commas",,,,,,"line1\nline2",,1,0,not in text at all\r\n'), csv);
  assert.ok(csv.includes('AAAA1111,Plasma sheath RCS,2021,li2021plasma,1.000,0,mock-model,FDTD + Drude,,2,1,We use the FDTD method,1e18,m^-3,3,1,'));
  assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell('x\r\ny'), '"x\r\ny"');
  assert.equal(csvCell(null), ''); assert.equal(csvCell(0), '0'); assert.equal(csvCell('plain'), 'plain');
  assert.throws(() => ev.exportCsv('nope'), /未知/);
});

// ---- the real store and quote checker, when worker-kb-store's files are in -----------------------------------------
test('with the real kb-struct.js and evidence-schemas.js', { skip: haveReal ? false : 'kb-struct.js / evidence-schemas.js not present yet' }, async () => {
  const { openKbStruct } = require('../server/literature/kb-struct');
  const schemas = require('../server/literature/evidence-schemas');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-lit-evidence-'));
  const kb = openKbStruct({ dir });
  try {
    const schema = schemas.getSchema('plasma_rcs_v1');
    assert.ok(schema && schema.fields.length >= 3);
    const blank = Object.fromEntries(schema.fields.map((f) => [f.key, { value: '', unit: '', page: 0, quote: '' }]));
    const good = { fields: { ...blank, em_method: GOOD.fields.em_method, peak_ne: GOOD.fields.peak_ne }, claims: GOOD.claims };
    const bad = { fields: { ...good.fields, peak_ne: BAD.fields.peak_ne }, claims: GOOD.claims };
    const calls = [];
    const ev = createEvidence({ kbStruct: kb, mirror, fulltext: mockFulltext(), ask: async (p, s) => { calls.push(s); return JSON.parse(JSON.stringify(calls.length === 1 ? bad : good)); }, modelName: 'mock' });
    const r = await ev.extractOne('AAAA1111');
    assert.equal(r.ok, true); assert.equal(calls.length, 2, 'retried after the invented quote');
    assert.equal(r.verifiedRatio, 1);
    assert.equal(r.claimsCount, 1);
    const saved = kb.getEvidence('AAAA1111', 'plasma_rcs_v1');
    assert.equal(saved.pdfMd5, 'md5-a'); assert.equal(saved.fields.peak_ne.value, '1e18');
    assert.equal(kb.listClaims({ schemaId: 'plasma_rcs_v1', zoteroKey: 'AAAA1111' }).length, 1);
    assert.equal((await ev.extractOne('AAAA1111')).skipped, true);
    assert.match(ev.exportMarkdown('plasma_rcs_v1'), /li2021plasma/);
    assert.match(ev.exportCsv('plasma_rcs_v1'), /^\ufeffzotero_key,/);
  } finally {
    try { kb.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
