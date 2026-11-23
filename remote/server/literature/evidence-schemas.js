// Fixed domain schemas for structured literature evidence extraction
// + code-level verbatim quote verifier (zero hallucination gate).
'use strict';

const SCHEMAS = {
  plasma_rcs_v1: {
    id: 'plasma_rcs_v1',
    name: '等离子体鞘套与电磁散射 / RCS (v1)',
    description: '高超声速等离子体鞘套流场-热化学-电磁衰减与 RCS 散射结构化证据表',
    fields: [
      { key: 'flight_condition', label: '飞行工况', hint: '马赫数、飞行高度、攻角、来流温度/密度/压力等' },
      { key: 'geometry', label: '几何外形', hint: '飞行器/目标外形及特征尺寸（如 RAM-C II 钝锥、球头半径、半锥角、总长）' },
      { key: 'flow_chem_model', label: '流场与化学模型', hint: 'N-S/DSMC、多组分化学反应模型（如 Park 7/11 组分）、热力学非平衡（双温模型）、壁面催化条件' },
      { key: 'em_method', label: '电磁方法', hint: '电磁求解或测试方法（如 ADE-FDTD、MoM、PO/GO、WKB、传输矩阵 TMM、实验测量）' },
      { key: 'freq_pol', label: '频段与极化', hint: '工作频率/波段（GHz）、极化方式（HH/VV/圆极化）及入射/散射角度' },
      { key: 'peak_ne', label: '峰值电子密度', hint: '峰值电子数密度 ne（含单位 cm^-3 或 m^-3）或对应等离子体频率' },
      { key: 'collision_freq', label: '碰撞频率', hint: '电子碰撞频率模型及典型量级（Hz 或 rad/s）' },
      { key: 'validation_source', label: '验证基准', hint: '对照验证来源（如 RAM-C II 飞行试验、激波管实验、Mie 解析解、商业软件对比）' },
      { key: 'key_result', label: '核心定量结果', hint: '主要电磁衰减（dB）、RCS 增减量（dB/dBsm）或透射/反射特征变化' },
      { key: 'limitations', label: '假设与局限', hint: '主要简化假设、适用边界或作者指出的不足（如忽略外磁场、1D 分层近似、无烧蚀等）' },
    ],
  },
  aero_stealth_v1: {
    id: 'aero_stealth_v1',
    name: '气动隐身一体化与高频散射优化 (v1)',
    description: '隐身飞行器气动/电磁耦合仿真、代理模型与多目标优化结构化证据表',
    fields: [
      { key: 'geometry', label: '外形与参数化', hint: '飞行器/部件构型及几何参数化方式（如飞翼/进气道、CST/FFD/NURBS、设计变量数）' },
      { key: 'flight_regime', label: '气动工况', hint: '设计马赫数、雷诺数、高度、攻角或升力系数约束' },
      { key: 'aero_solver', label: '气动求解器', hint: '气动计算方法与湍流模型（如 RANS/Euler/面元法、SA/SST、网格量）' },
      { key: 'em_method', label: '电磁求解方法', hint: 'RCS 计算方法（如 PO/PTD/SBR、MLFMA/MoM、FEM、吸波材料/阻抗边界）' },
      { key: 'freq_pol_angle', label: '频段极化与角域', hint: '计算频率（GHz）、极化方式（HH/VV）及威胁方位/俯仰角域' },
      { key: 'surrogate_opt', label: '代理与优化算法', hint: '代理模型与优化器（如 Kriging/ANN/POD、NSGA-II/伴随法/多目标优化）' },
      { key: 'validation_source', label: '验证基准', hint: '气动与电磁验证依据（风洞数据、暗室 RCS 测量、FEKO/Fluent 基准算例）' },
      { key: 'key_result', label: '核心优化结果', hint: '气动性能（如 L/D、Cd）与 RCS 均值/峰值降幅（dB 或 dBsm）权衡结果' },
      { key: 'compute_cost', label: '计算代价', hint: '单次评估耗时、样本数/迭代次数及 CPU/GPU 硬件开销' },
      { key: 'limitations', label: '假设与局限', hint: '模型局限或未覆盖项（如单点优化、忽略腔体/缝隙/边缘绕射、仅高频近似）' },
    ],
  },
};

function getSchema(schemaId) {
  if (!schemaId || !Object.prototype.hasOwnProperty.call(SCHEMAS, schemaId)) return null;
  return SCHEMAS[schemaId];
}

function listSchemas() {
  return Object.values(SCHEMAS);
}

function buildExtractSchema(schemaId) {
  const schema = getSchema(schemaId);
  if (!schema) throw new Error(`Unknown schema: ${schemaId}`);

  const fieldProps = {};
  const fieldKeys = [];
  for (const f of schema.fields) {
    fieldKeys.push(f.key);
    fieldProps[f.key] = {
      type: 'object',
      description: `${f.label}：${f.hint}`,
      properties: {
        value: { type: 'string', description: '抽取的数值或结论，原文未提及则填空字符串' },
        unit: { type: 'string', description: '物理单位，无单位或未提及则填空字符串' },
        page: { type: 'integer', description: '1-based 原文页码，未提及填 0' },
        quote: { type: 'string', description: '支持该字段的原文逐字引文片段' },
      },
      required: ['value', 'unit', 'page', 'quote'],
    };
  }

  return {
    type: 'object',
    properties: {
      fields: {
        type: 'object',
        properties: fieldProps,
        required: fieldKeys,
      },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            condition: { type: 'string', description: '工况、无量纲参数或假设条件' },
            conclusion: { type: 'string', description: '定量或定性结论' },
            metric: { type: 'string', description: '关键数值与单位，无则填空字符串' },
            page: { type: 'integer', description: '1-based 原文页码' },
            quote: { type: 'string', description: '支持该结论的原文逐字引文片段' },
          },
          required: ['condition', 'conclusion', 'metric', 'page', 'quote'],
        },
      },
    },
    required: ['fields', 'claims'],
  };
}

function collapseSpacedLetters(s) {
  // Repair legacy OCR letter-spacing (e.g. "r e f l e c t i o n" -> "reflection", "a l t i t u d e" -> "altitude")
  // only for runs of 3+ space-separated single ASCII letters on word boundaries.
  return s.replace(/(?<![a-z0-9])([a-z](?: [a-z]){2,})(?![a-z0-9])/g, (m) => m.replace(/ /g, ''));
}

function normalizeForMatch(s) {
  if (s == null) return '';
  let out = String(s).normalize('NFKC');
  // Remove soft hyphens and hyphenated line breaks (e.g. "electro-\nmagnetic" -> "electromagnetic")
  out = out.replace(/\u00AD/g, '');
  out = out.replace(/-\r?\n\s*/g, '');
  // Full-width space and full-width ASCII -> half-width (kept as belt-and-suspenders after NFKC)
  out = out.replace(/\u3000/g, ' ');
  out = out.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  // Normalize common typographic punctuation
  out = out.replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-');
  // Collapse whitespace, lowercase, and repair legacy OCR spaced letters
  out = out.replace(/\s+/g, ' ').trim().toLowerCase();
  return collapseSpacedLetters(out);
}

// Numbers as the paper and the answer write them: 1.2e12, 10.5, 71, and "1.2 × 10^12" / thousands separators /
// PDF dropped-decimal scientific notation ("1 8 × 1011" -> "1.8e11") in the same form, so a value can be checked
// against its quote without weakening tamper detection.
function canonNumbers(s) {
  let t = String(s == null ? '' : s).normalize('NFKC');
  // PDF dropped decimal + superscript merged with 10: "1 8 × 1011" -> "1.8e11", "2 0 × 1010" -> "2.0e10"
  t = t.replace(/(?<![\d.])(\d)\s+(\d)\s*(?:×|\*|x)\s*10\s*\^?\s*([+-]?\d+)(?!\d)/gi, '$1.$2e$3');
  t = t.replace(/(\d)\s*(?:×|\*|x)\s*10\s*\^?\s*([+-]?\d+)/gi, '$1e$2');
  t = t.replace(/(?<![\d.])\d{1,3}(?:,\d{3})+(?![\d])/g, (m) => m.replace(/,/g, ''));
  return t.toLowerCase();
}

// every number in the text (exponents kept whole: 1.2e12 is one token, not 1.2 and 12)
function numberTokens(s) {
  return canonNumbers(s).match(/\d+(?:\.\d+)?(?:e[-+]?\d+)?/g) || [];
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// the number stands on its own in the text: 71 not inside 1971 or 71.5, 8.4 not inside 18.4
function hasNumberAtBoundary(text, num) {
  if (!num) return false;
  return new RegExp('(?<![0-9.])' + escapeRe(num) + '(?![0-9])').test(canonNumbers(text));
}

// length of the longest run of characters the two share -- a quote assembled from several places in a paper (or one
// with a word swapped) has only short runs
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  const n = a.length;
  const m = b.length;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  let best = 0;
  for (let i = 1; i <= n; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      if (ca === b.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > best) best = v;
      } else {
        cur[j] = 0;
      }
    }
    const t = prev;
    prev = cur;
    cur = t;
    cur.fill(0);
  }
  return best;
}

function getPageText(pages, pageNum) {
  if (!Array.isArray(pages) || pageNum < 1) return null;
  // Support both string[] (1-based index) and [{ page, text }]
  const direct = pages[pageNum - 1];
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object') {
    if (direct.page == null || Number(direct.page) === pageNum) {
      return typeof direct.text === 'string' ? direct.text : '';
    }
  }
  const found = pages.find((p) => p && typeof p === 'object' && Number(p.page) === pageNum);
  return found && typeof found.text === 'string' ? found.text : null;
}

function verifyQuote(pages, pageNum, quote) {
  if (!quote || typeof quote !== 'string') return { verified: false, matchedPage: 0 };
  if (quote.replace(/\s+/g, '').length < 6) return { verified: false, matchedPage: 0 };
  if (!Array.isArray(pages) || pages.length === 0) return { verified: false, matchedPage: 0 };

  const normQuote = normalizeForMatch(quote);
  if (normQuote.replace(/\s+/g, '').length < 6) return { verified: false, matchedPage: 0 };

  const p = Math.trunc(Number(pageNum));
  if (!Number.isFinite(p) || p < 1) return { verified: false, matchedPage: 0 };

  // Candidate pages: pageNum first, then pageNum - 1 and pageNum + 1
  const candidates = [];
  for (const cand of [p, p - 1, p + 1]) {
    if (cand >= 1 && !candidates.includes(cand)) {
      const text = getPageText(pages, cand);
      if (typeof text === 'string' && text.length > 0) {
        candidates.push({ page: cand, norm: normalizeForMatch(text) });
      }
    }
  }
  if (!candidates.length) return { verified: false, matchedPage: 0 };

  // 1. Exact normalized substring match
  for (const c of candidates) {
    if (c.norm.includes(normQuote)) {
      return { verified: true, matchedPage: c.page };
    }
  }

  // 2. Strict fallback (a quote re-typed from the page: punctuation dropped, a function word omitted, an OCR hiccup).
  // Everything the quote asserts must still be on the page:
  //   a) every number stands on its own there (71 must not be met inside 1971, 8.4 not inside 18.4),
  //   b) every word of the quote (2+ chars: a swapped verb like drops/increases, an inserted "not" fails here) is
  //      there as a whole word, in the quote's order -- not a bag of tokens,
  //   c) every CJK run is there almost verbatim (>= 90% of its longest common run),
  //   d) the longest shared run covers at least 40% of the quote, so a sentence pieced together from several places in
  //      the paper does not pass.
  for (const c of candidates) {
    if (!strictQuoteMatch(normQuote, c.norm)) continue;
    return { verified: true, matchedPage: c.page };
  }

  return { verified: false, matchedPage: 0 };
}

const MIN_CJK_RUN_RATIO = 0.9;
const MIN_SHARED_RUN_RATIO = 0.4;

function strictQuoteMatch(normQuote, pageNorm) {
  for (const num of numberTokens(normQuote)) {
    if (!hasNumberAtBoundary(pageNorm, num)) return false;
  }
  const words = normQuote.match(/(?<![a-z0-9])[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*/g) || [];
  let pos = 0;
  for (const w of words) {
    const re = new RegExp('(?<![a-z0-9])' + escapeRe(w) + '(?![a-z0-9])', 'g');
    re.lastIndex = pos;
    const m = re.exec(pageNorm);
    if (!m) return false;
    pos = m.index + m[0].length;
  }
  for (const run of normQuote.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (longestCommonSubstring(run, pageNorm) / run.length < MIN_CJK_RUN_RATIO) return false;
  }
  const rawRatio = longestCommonSubstring(normQuote, pageNorm) / normQuote.length;
  if (rawRatio >= MIN_SHARED_RUN_RATIO) return true;
  const cq = canonNumbers(normQuote);
  const cp = canonNumbers(pageNorm);
  return cq.length > 0 && longestCommonSubstring(cq, cp) / cq.length >= MIN_SHARED_RUN_RATIO;
}

function isEmptyFieldValue(v) {
  if (v == null) return true;
  const s = String(v).trim();
  if (!s) return true;
  return /^(?:null|n\/a|na|none)$/i.test(s);
}

function verifyExtraction(schemaId, extracted, pages) {
  const schema = getSchema(schemaId);
  if (!schema) throw new Error(`Unknown schema: ${schemaId}`);

  const rawFields = extracted && extracted.fields && typeof extracted.fields === 'object' ? extracted.fields : {};
  const rawClaims = Array.isArray(extracted && extracted.claims) ? extracted.claims : [];

  const fields = {};
  const unverifiedFields = [];
  let nonEmptyCount = 0;
  let verifiedNonEmptyCount = 0;

  for (const f of schema.fields) {
    const cell = rawFields[f.key] && typeof rawFields[f.key] === 'object' ? rawFields[f.key] : {};
    const rawVal = cell.value == null ? '' : String(cell.value).trim();
    const unit = cell.unit == null ? '' : String(cell.unit).trim();
    const page = Number.isFinite(Number(cell.page)) ? Math.trunc(Number(cell.page)) : 0;
    const quote = cell.quote == null ? '' : String(cell.quote).trim();

    if (isEmptyFieldValue(rawVal)) {
      fields[f.key] = {
        value: '',
        unit: '',
        page: 0,
        quote: '',
        verified: 1,
        matchedPage: 0,
      };
      continue;
    }

    nonEmptyCount++;
    const res = verifyQuote(pages, page, quote);
    // a real quote with a made-up number in value: every number the value states must be in the quote
    const valueNumbersInQuote = numberTokens(rawVal).every((n) => hasNumberAtBoundary(normalizeForMatch(quote), n));
    const verified = res.verified && valueNumbersInQuote ? 1 : 0;
    if (verified) {
      verifiedNonEmptyCount++;
    } else {
      unverifiedFields.push(f.key);
    }

    fields[f.key] = {
      value: rawVal,
      unit,
      page,
      quote,
      verified,
      matchedPage: res.matchedPage,
    };
  }

  const claims = rawClaims.map((c) => {
    const item = c && typeof c === 'object' ? c : {};
    const page = Number.isFinite(Number(item.page)) ? Math.trunc(Number(item.page)) : 0;
    const quote = item.quote == null ? '' : String(item.quote).trim();
    const res = verifyQuote(pages, page, quote);
    return {
      ...item,
      condition: item.condition == null ? '' : String(item.condition).trim(),
      conclusion: item.conclusion == null ? '' : String(item.conclusion).trim(),
      metric: item.metric == null ? '' : String(item.metric).trim(),
      page,
      quote,
      verified: res.verified ? 1 : 0,
      matchedPage: res.matchedPage,
    };
  });

  const verifiedRatio = nonEmptyCount === 0 ? 1 : verifiedNonEmptyCount / nonEmptyCount;

  return {
    fields,
    claims,
    verifiedRatio,
    unverifiedFields,
  };
}

module.exports = {
  SCHEMAS,
  getSchema,
  listSchemas,
  buildExtractSchema,
  verifyQuote,
  verifyExtraction,
  normalizeForMatch,
};
