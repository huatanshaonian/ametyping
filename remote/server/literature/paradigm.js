// M4: Vector-clustered cross-paper contradiction analysis + SQL/in-memory paradigm matrix.
// Gracefully degrades when embedding or LLM is offline.
'use strict';
const crypto = require('crypto');

const VALID_VERDICTS = new Set(['consistent', 'contradiction', 'boundary_diff']);
const VALID_STATUSES = new Set(['pending', 'confirmed', 'dismissed']);
const EMPTY_VALUE_RE = /^(?:null|n\/a|na|none|无|-|—)$/i;
const UNKNOWN_LABEL = '未说明';
const EMBED_BATCH_SIZE = 16;

const CONTRADICTION_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['consistent', 'contradiction', 'boundary_diff'],
      description: '跨论文结论关系：consistent（一致）、contradiction（实质矛盾）、boundary_diff（边界条件或工况差异导致的不同结果）',
    },
    topic: {
      type: 'string',
      description: '该组结论共同讨论的物理主题（简短中文概括）',
    },
    summary: {
      type: 'string',
      description: '简明分析各篇论文结论的一致性、分歧点及物理/数值成因',
    },
    param_diff: {
      type: 'array',
      description: '导致差异的关键参数或假设对比列表',
      items: {
        type: 'object',
        properties: {
          param: { type: 'string', description: '参数或假设名称（如壁面催化、化学模型、网格/电磁算法）' },
          values: {
            type: 'array',
            items: { type: 'string' },
            description: '各篇论文对应的取值或设定',
          },
        },
        required: ['param', 'values'],
      },
    },
  },
  required: ['verdict', 'topic', 'summary', 'param_diff'],
};

function normalizeVec(v) {
  if (!v || typeof v.length !== 'number' || v.length === 0) return null;
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = Number(v[i]);
    if (!Number.isFinite(x)) return null;
    sumSq += x * x;
  }
  if (sumSq === 0) return null;
  const inv = 1 / Math.sqrt(sumSq);
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Number(v[i]) * inv;
  return out;
}

function dot(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function claimText(c) {
  return `${c.condition || ''} -> ${c.conclusion || ''} ${c.metric || ''}`.replace(/\s+/g, ' ').trim();
}

function clusterTopicOf(claims) {
  const first = claims[0];
  if (!first) return '';
  const raw = [first.condition, first.conclusion].filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim();
  return raw.length > 80 ? raw.slice(0, 79) + '…' : raw;
}

function clusterIdOf(schemaId, claims) {
  const ids = claims.map((c) => String(c.id || `${c.zoteroKey}:${c.page}`)).sort();
  const h = crypto.createHash('sha1').update(`${schemaId}|${ids.join(',')}`).digest('hex').slice(0, 12);
  return `contra_${h}`;
}

function normalizeLabel(v, maxLen = 40) {
  if (v == null) return UNKNOWN_LABEL;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || EMPTY_VALUE_RE.test(s)) return UNKNOWN_LABEL;
  return s.length > maxLen ? s.slice(0, maxLen - 1).trim() + '…' : s;
}

function buildContradictionPrompt(schemaId, cluster, evidenceMap, mirror) {
  const lines = [
    `你在对结构化文献知识库（Schema: ${schemaId}）中语义相近的跨论文已核验结论做一致性与矛盾分析。`,
    '',
    '请判断下面这组来自不同论文的结论之间属于：',
    '- consistent：结论在量级与趋势上基本一致',
    '- contradiction：相同或高度可比工况下给出相反或难以调和的定量结论',
    '- boundary_diff：结论不同但可由物理边界条件、工况参数、化学/电磁模型差异解释',
    '',
    '请严格按给定 JSON Schema 输出 verdict、topic、summary、param_diff。',
    '',
    '待比对结论：',
  ];

  cluster.claims.forEach((c, idx) => {
    const it = mirror && typeof mirror.item === 'function' ? mirror.item(c.zoteroKey) : null;
    const label = it ? `${it.citekey || c.zoteroKey} (${it.year || '?'}, ${it.title || ''})` : c.zoteroKey;
    lines.push(`${idx + 1}. [${c.zoteroKey}] ${label}`);
    lines.push(`   - 条件: ${c.condition || '未说明'}`);
    lines.push(`   - 结论: ${c.conclusion || ''}${c.metric ? `（指标: ${c.metric}）` : ''}`);
    if (c.quote) lines.push(`   - 原文 (p.${c.page || 0}): "${c.quote}"`);
  });

  const keys = [...new Set(cluster.claims.map((c) => c.zoteroKey))];
  const paramLines = [];
  for (const k of keys) {
    const ev = evidenceMap.get(k);
    if (!ev || !ev.fields) continue;
    const pairs = Object.entries(ev.fields)
      .map(([fk, cell]) => {
        const val = cell && typeof cell === 'object' ? cell.value : cell;
        const unit = cell && typeof cell === 'object' ? cell.unit : '';
        if (val == null || !String(val).trim()) return null;
        return `${fk}=${String(val).trim()}${unit ? ' ' + unit : ''}`;
      })
      .filter(Boolean);
    if (pairs.length) paramLines.push(`- [${k}]: ${pairs.join('; ')}`);
  }

  if (paramLines.length) {
    lines.push('', '涉及论文的关键参数：', ...paramLines);
  }

  return lines.join('\n');
}

function createParadigm({ kbStruct, embed = null, mirror = null, ask = null, log = () => {} }) {
  if (!kbStruct) throw new Error('createParadigm 需要 kbStruct');

  async function clusterClaims(schemaId, { threshold = 0.72, minClusterSize = 2, maxClusters = 20 } = {}) {
    const claims = kbStruct.listClaims({ schemaId, onlyVerified: true }) || [];
    const minSize = Math.max(2, Number(minClusterSize) || 2);
    if (claims.length < minSize) return { ok: true, clusters: [] };

    if (!embed || !embed.client || typeof embed.client.embed !== 'function') {
      return { ok: false, reason: 'embed-off', clusters: [] };
    }

    const texts = claims.map(claimText);
    const vecs = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      let res;
      try {
        res = await embed.client.embed(batch);
      } catch (e) {
        const reason = String((e && e.message) || e || 'embed-error');
        log(`范式聚类：embed 失败：${reason}`);
        return { ok: false, reason, clusters: [] };
      }
      const batchVecs = Array.isArray(res) ? res : res && Array.isArray(res.vectors) ? res.vectors : null;
      if (!batchVecs || batchVecs.length !== batch.length) {
        return { ok: false, reason: 'embed-invalid', clusters: [] };
      }
      for (const raw of batchVecs) {
        vecs.push(normalizeVec(raw));
      }
    }

    // Greedy clustering by cosine similarity against normalized cluster centroid
    const groups = [];
    const thr = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.72;
    for (let i = 0; i < claims.length; i++) {
      const v = vecs[i];
      if (!v) continue;
      let bestIdx = -1;
      let bestSim = -1;
      for (let g = 0; g < groups.length; g++) {
        const sim = dot(v, groups[g].centroid);
        if (sim >= thr && sim > bestSim) {
          bestSim = sim;
          bestIdx = g;
        }
      }
      if (bestIdx >= 0) {
        const grp = groups[bestIdx];
        grp.claims.push(claims[i]);
        for (let d = 0; d < grp.sum.length; d++) grp.sum[d] += v[d];
        grp.centroid = normalizeVec(grp.sum) || grp.centroid;
      } else {
        groups.push({
          claims: [claims[i]],
          sum: Float64Array.from(v),
          centroid: v,
        });
      }
    }

    const limit = Math.max(1, Number(maxClusters) || 20);
    const clusters = groups
      .filter((g) => {
        if (g.claims.length < minSize) return false;
        const papers = new Set(g.claims.map((c) => c.zoteroKey));
        return papers.size >= 2;
      })
      .sort((a, b) => b.claims.length - a.claims.length || String(a.claims[0].id || '').localeCompare(String(b.claims[0].id || '')))
      .slice(0, limit)
      .map((g) => ({
        topic: clusterTopicOf(g.claims),
        claims: g.claims,
      }));

    return { ok: true, clusters };
  }

  async function analyzeContradictions(schemaId, { threshold = 0.72 } = {}) {
    const clustered = await clusterClaims(schemaId, { threshold });
    if (!clustered.ok) {
      return { ok: false, reason: clustered.reason || 'embed-off', analyzed: 0, items: [] };
    }
    if (!clustered.clusters.length) {
      return { ok: true, analyzed: 0, items: [] };
    }
    if (typeof ask !== 'function') {
      return { ok: false, reason: 'no-llm', analyzed: 0, items: [] };
    }

    const evidenceCache = new Map();
    const getEv = (k) => {
      if (!evidenceCache.has(k)) {
        evidenceCache.set(k, kbStruct.getEvidence(k, schemaId));
      }
      return evidenceCache.get(k);
    };

    const items = [];
    for (const cluster of clustered.clusters) {
      for (const c of cluster.claims) getEv(c.zoteroKey);
      const prompt = buildContradictionPrompt(schemaId, cluster, evidenceCache, mirror);
      let ans;
      try {
        ans = await ask(prompt, CONTRADICTION_SCHEMA);
      } catch (e) {
        log(`矛盾分析：簇「${cluster.topic}」调用模型失败：${(e && e.message) || e}`);
        continue;
      }
      const rawVerdict = ans && typeof ans.verdict === 'string' ? ans.verdict.trim() : '';
      const verdict = VALID_VERDICTS.has(rawVerdict) ? rawVerdict : 'boundary_diff';
      const topic = (ans && typeof ans.topic === 'string' && ans.topic.trim()) || cluster.topic;
      const summary = (ans && typeof ans.summary === 'string' && ans.summary.trim()) || '';
      const paramDiff = Array.isArray(ans && ans.param_diff)
        ? ans.param_diff
            .filter((p) => p && typeof p === 'object' && p.param)
            .map((p) => ({
              param: String(p.param),
              values: Array.isArray(p.values) ? p.values.map((x) => String(x)) : [],
            }))
        : [];

      const id = clusterIdOf(schemaId, cluster.claims);
      const claimIds = cluster.claims.map((c) => c.id);
      const saved = kbStruct.saveContradiction({
        id,
        schemaId,
        topic,
        claimIds,
        verdict,
        summary,
        paramDiff,
        status: 'pending',
      });
      items.push(saved);
    }

    return { ok: true, analyzed: items.length, items };
  }

  function listContradictions(schemaId, opts = {}) {
    if (schemaId && typeof schemaId === 'object') {
      return kbStruct.listContradictions(schemaId);
    }
    return kbStruct.listContradictions({
      schemaId: schemaId || null,
      status: opts && opts.status ? opts.status : null,
    });
  }

  function updateContradictionStatus(id, status) {
    const st = String(status || '').trim();
    if (!VALID_STATUSES.has(st)) {
      throw new Error(`无效的矛盾状态：${status}（仅支持 pending | confirmed | dismissed）`);
    }
    return kbStruct.updateContradictionStatus(id, st);
  }

  function canonicalizeBucket(fieldKey, rawVal) {
    const raw = normalizeLabel(rawVal);
    if (raw === '未提及') return raw;
    const s = raw.toLowerCase();
    const fk = String(fieldKey || '').toLowerCase();
    if (fk === 'em_method') {
      if (/\bplrc\b/.test(s)) return 'PLRC-FDTD';
      if (/\btrc\b|trapezoidal recursive/.test(s)) return 'TRC-FDTD';
      if (/\bade\b|auxiliary differential/.test(s)) return 'ADE-FDTD';
      if (/\badi\b|alternating direction/.test(s)) return 'ADI-FDTD';
      if (/\bz[-\s]?transform|z-fdtd|zfdtd/.test(s)) return 'Z-FDTD';
      if (/\bjec\b|current density convolution/.test(s)) return 'JEC-FDTD';
      if (/\brc[-\s]?fdtd|recursive convolution/.test(s)) return 'RC-FDTD';
      if (/\bfdtd\b/.test(s)) return 'FDTD';
      if (/\bwkb\b/.test(s)) return 'WKB';
      if (/\btmm\b|transfer matrix|传输矩阵/.test(s)) return 'TMM';
      if (/\bmlfma\b|\bfmm\b|\bmom\b|method of moments|矩量法/.test(s)) return 'MoM / MLFMA';
      if (/\bpo\b|\bptd\b|\bsbr\b|\bgo\b|physical optics|物理光学|弹跳射线/.test(s)) return 'PO / PTD / SBR';
      if (/\bfem\b|finite element|有限元/.test(s)) return 'FEM';
      if (/\bmie\b|解析解|analytical/.test(s)) return 'Analytical / Mie';
    } else if (fk === 'flow_chem_model' || fk === 'aero_solver') {
      if (/park.*11|11[-\s]?species|11组分/.test(s)) return 'Park 11-species';
      if (/park.*7|7[-\s]?species|7组分/.test(s)) return 'Park 7-species';
      if (/park|two-temperature|双温|化学非平衡|non-?equilibrium/.test(s)) return 'Non-eq CFD (Park/2T)';
      if (/\bdsmc\b/.test(s)) return 'DSMC';
      if (/\brans\b|sst|spalart|k-omega|k-epsilon/.test(s)) return 'RANS';
      if (/\beuler\b/.test(s)) return 'Euler';
      if (/navier|n-s|cfd/.test(s)) return 'Navier-Stokes / CFD';
      if (/epstein|uniform|slab|分层|均匀|drude/.test(s)) return 'Analytic / Slab Plasma';
    } else if (fk === 'surrogate_opt') {
      if (/kriging|gaussian process|\bgpr\b|co-kriging/.test(s)) return 'Kriging / GP';
      if (/nsga|genetic|\bga\b|evolutionary|遗传/.test(s)) return 'NSGA-II / GA';
      if (/adjoint|伴随/.test(s)) return 'Adjoint';
      if (/neural|\bann\b|\bdnn\b|\bcnn\b|\bpinn\b|mlp|deep learning|神经/.test(s)) return 'Neural Network / DL';
      if (/\bpod\b|reduced[-\s]?order|降阶/.test(s)) return 'POD / ROM';
      if (/\bpso\b|particle swarm|粒子群/.test(s)) return 'PSO';
    }
    return raw;
  }

  function buildMatrix(schemaId, { rowField = 'flow_chem_model', colField = 'em_method' } = {}) {
    const list = kbStruct.listEvidence(schemaId) || [];
    const rowCounts = new Map();
    const colCounts = new Map();
    const cellMap = new Map();

    for (const ev of list) {
      const fields = ev && ev.fields && typeof ev.fields === 'object' ? ev.fields : {};
      const rCell = fields[rowField];
      const cCell = fields[colField];
      const rLabel = canonicalizeBucket(rowField, rCell && typeof rCell === 'object' ? rCell.value : rCell);
      const cLabel = canonicalizeBucket(colField, cCell && typeof cCell === 'object' ? cCell.value : cCell);

      rowCounts.set(rLabel, (rowCounts.get(rLabel) || 0) + 1);
      colCounts.set(cLabel, (colCounts.get(cLabel) || 0) + 1);

      const pairKey = `${rLabel}\0${cLabel}`;
      let entry = cellMap.get(pairKey);
      if (!entry) {
        entry = { count: 0, keys: [] };
        cellMap.set(pairKey, entry);
      }
      entry.count++;
      entry.keys.push(ev.zoteroKey);
    }

    const sortLabels = (countsMap) =>
      [...countsMap.keys()].sort((a, b) => {
        if (a === UNKNOWN_LABEL && b !== UNKNOWN_LABEL) return 1;
        if (b === UNKNOWN_LABEL && a !== UNKNOWN_LABEL) return -1;
        return countsMap.get(b) - countsMap.get(a) || a.localeCompare(b);
      });

    const rows = sortLabels(rowCounts);
    const cols = sortLabels(colCounts);
    const cells = {};
    const gaps = [];

    for (const r of rows) {
      cells[r] = {};
      for (const c of cols) {
        const entry = cellMap.get(`${r}\0${c}`);
        if (entry) {
          cells[r][c] = { count: entry.count, keys: [...entry.keys] };
        } else {
          cells[r][c] = { count: 0, keys: [] };
          if (r !== UNKNOWN_LABEL && c !== UNKNOWN_LABEL) {
            gaps.push({ row: r, col: c });
          }
        }
      }
    }

    return {
      schemaId,
      rowField,
      colField,
      rows,
      cols,
      cells,
      gaps,
      totalPapers: list.length,
    };
  }

  return {
    clusterClaims,
    analyzeContradictions,
    listContradictions,
    updateContradictionStatus,
    buildMatrix,
  };
}

module.exports = { createParadigm, CONTRADICTION_SCHEMA };
