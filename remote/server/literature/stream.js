// High-density Twitter-style literature stream + University/Lab/Team graph (kb_struct.sqlite).
'use strict';
const crypto = require('crypto');

const TEAM_SCHEMA = {
  type: 'object',
  properties: {
    teams: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          institution: { type: 'string', description: '大学或科研院所标准名（如 西北工业大学 / NASA Langley Research Center）' },
          lab: { type: 'string', description: '学院/重点实验室/课题组名，未知留空' },
          pi: { type: 'string', description: '通讯作者或团队负责人姓名，未知留空' },
          bio: { type: 'string', description: '一句话客观概括该团队在这篇论文体现的研究方向与技术特点（≤50字，不要提问）' },
          tags: { type: 'array', items: { type: 'string' }, description: '2～4 个方法或方向标签（如 ADE-FDTD / 飞翼气动隐身 / 等离子体鞘套）' },
        },
        required: ['institution', 'lab', 'pi', 'bio', 'tags'],
      },
    },
  },
  required: ['teams'],
};

const INST_ALIASES = [
  [/nanjing university of aeronautics and astronautics|南京航空航天大学|南航/i, '南京航空航天大学'],
  [/national university of defense technology|国防科学技术大学|国防科技大学|国防科大/i, '国防科技大学'],
  [/northwestern polytechnical university|西北工业大学|西工大/i, '西北工业大学'],
  [/beihang university|beijing university of aeronautics and astronautics|北京航空航天大学|北航/i, '北京航空航天大学'],
  [/university of electronic science and technology of china|电子科技大学|成电/i, '电子科技大学'],
  [/xidian university|西安电子科技大学|西电/i, '西安电子科技大学'],
  [/harbin institute of technology|哈尔滨工业大学|哈工大/i, '哈尔滨工业大学'],
  [/tsinghua university|清华大学/i, '清华大学'],
  [/peking university|北京大学/i, '北京大学'],
  [/beijing institute of technology|北京理工大学|北理工/i, '北京理工大学'],
  [/chinese academy of sciences|中国科学院|中科院/i, '中国科学院'],
  [/china aerodynamics research and development center|中国空气动力研究与发展中心|气动中心/i, '中国空气动力研究与发展中心'],
  [/science applications international corp(?:oration)?|\bsaic\b/i, 'SAIC'],
  [/university of illinois.*urbana[- ]?champaign|\buiuc\b/i, 'UIUC'],
  [/nasa langley research center/i, 'NASA Langley'],
  [/nasa glenn research center/i, 'NASA Glenn'],
  [/air force research laboratory|\bafrl\b/i, 'AFRL'],
  [/university of texas at austin/i, 'UT Austin'],
  [/massachusetts institute of technology|\bmit\b/i, 'MIT'],
  [/stanford university/i, 'Stanford University'],
  [/university of michigan/i, 'University of Michigan'],
  [/brown university/i, 'Brown University'],
  [/new york university/i, 'New York University'],
];

function canonicalizeInstitution(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  for (const [re, canon] of INST_ALIASES) {
    if (re.test(s)) return canon;
  }
  return s;
}

function teamIdOf(institution, lab, pi) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const inst = canonicalizeInstitution(institution);
  const key = [norm(inst), norm(pi || lab)].filter(Boolean).join('|') || 'unknown';
  return 'team_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

function extractCardHighlights(card) {
  if (!card || !Array.isArray(card.sections)) return { results: [], doubt: '' };
  const resSec = card.sections.find((s) => s.title === '主要结果');
  const results = resSec
    ? resSec.text.split('\n').map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean).slice(0, 3)
    : [];
  const doubtSec = card.sections.find((s) => s.title === '疑点');
  const doubt = doubtSec
    ? (doubtSec.text.split('\n').map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean)[0] || '').slice(0, 140)
    : '';
  return { results, doubt };
}

function createStream({ kbStruct, mirror, cards = null, fulltext = null, ask = null, log = () => {} }) {
  function extractTagsFromEvidence(ev) {
    const tags = [];
    if (!ev || !ev.fields) return tags;
    for (const fk of ['em_method', 'flow_chem_model', 'aero_solver', 'surrogate_opt']) {
      const f = ev.fields[fk];
      const v = f && typeof f === 'object' ? f.value : f;
      if (!v || v === '未提及' || v === '未说明') continue;
      const short = String(v).split(/[，,;；(（]/)[0].trim().slice(0, 22);
      if (short && !tags.includes(short)) tags.push(short);
    }
    return tags.slice(0, 4);
  }

  async function extractTeamsForPaper(zoteroKey) {
    if (!kbStruct || !mirror || !ask) return { ok: false, reason: 'unavailable' };
    const item = mirror.item(zoteroKey);
    if (!item) return { ok: false, reason: 'not-found' };
    let textChunks = [];
    if (fulltext) {
      try {
        const ft = await fulltext.forItem(zoteroKey);
        if (ft && ft.pages && ft.pages.length) {
          textChunks.push('[第 1 页]\n' + String(ft.pages[0].text || '').slice(0, 2200));
          if (ft.pages.length >= 2) textChunks.push('[第 2 页]\n' + String(ft.pages[1].text || '').slice(0, 1200));
          if (ft.pages.length >= 3) textChunks.push(`[末页 p.${ft.pages.length}]\n` + String(ft.pages[ft.pages.length - 1].text || '').slice(-1400));
        }
      } catch {}
    }
    const prompt = [
      '请从下面论文的元数据、前两页与末页文字中提取完成该工作的大学/科研院所、实验室/团队和通讯作者（PI）。',
      '要求：1) 最多提取 2 个核心单位/团队（第一单位 + 主要合作单位）；2) 中文论文用中文标准校名（如“南京航空航天大学”“国防科技大学”“西北工业大学”），英文论文保留标准校名；3) bio 用一句客观陈述概括该团队在本篇体现的方向与技术特点（≤50字）；4) 只要正文或页眉/页脚/末页作者简介里有单位信息就务必提取，禁止编造，不要向用户提问。',
      '',
      `标题：${item.title || ''}`,
      `作者：${(item.creators || []).slice(0, 8).join('; ')}`,
      `来源：${item.venue || ''} ${item.year || ''}`,
      `摘要：${String(item.abstract || '').slice(0, 900)}`,
      textChunks.length ? '\n' + textChunks.join('\n\n') : '',
    ].filter(Boolean).join('\n');

    let ans;
    try {
      const raw = await ask(prompt, TEAM_SCHEMA);
      ans = (raw && (raw.data || raw.parsed)) || (typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch (e) {
      log(`团队抽取失败 ${zoteroKey}：${e.message}`);
      return { ok: false, reason: 'llm-error', error: e.message };
    }
    const list = Array.isArray(ans && ans.teams) ? ans.teams : [];
    const saved = [];
    for (let i = 0; i < list.length && i < 3; i++) {
      const t = list[i];
      const inst = canonicalizeInstitution(t && t.institution);
      if (!inst) continue;
      const lab = String((t && t.lab) || '').trim();
      const pi = String((t && t.pi) || '').trim();
      const bio = String((t && t.bio) || '').trim().slice(0, 140);
      const tags = Array.isArray(t && t.tags) ? t.tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6) : [];
      const id = teamIdOf(inst, lab, pi);
      const team = kbStruct.upsertTeam({ id, institution: inst, lab, pi, bio, tags });
      kbStruct.linkPaperTeam({ zoteroKey, teamId: id, role: i === 0 ? 'primary' : 'collaborator' });
      saved.push(team);
    }
    return { ok: true, zoteroKey, teams: saved };
  }

  function listStream({ teamId = '', tag = '', q = '', onlyCards = false, limit = 80 } = {}) {
    const items = mirror ? mirror.items() : [];
    const cardMap = new Map();
    if (cards && typeof cards.all === 'function') {
      for (const c of cards.all()) cardMap.set(c.key, c);
    }
    const evMap = new Map();
    if (kbStruct) {
      for (const sid of ['plasma_rcs_v1', 'aero_stealth_v1']) {
        for (const ev of kbStruct.listEvidence(sid) || []) {
          if (!evMap.has(ev.zoteroKey)) evMap.set(ev.zoteroKey, ev);
        }
      }
    }
    const teamFilterKeys = teamId && kbStruct ? new Set(kbStruct.papersOfTeam(teamId)) : null;
    const ql = String(q || '').trim().toLowerCase();
    const tagl = String(tag || '').trim().toLowerCase();

    const out = [];
    for (const it of items) {
      if (teamFilterKeys && !teamFilterKeys.has(it.key)) continue;
      const card = cardMap.get(it.key) || null;
      const ev = evMap.get(it.key) || null;
      if (onlyCards && !card) continue;
      if (!card && !ev && !teamFilterKeys) continue;

      const teams = kbStruct ? kbStruct.teamsOfPaper(it.key) : [];
      const evTags = extractTagsFromEvidence(ev);
      const teamTags = teams.flatMap((t) => t.tags || []);
      const tags = [...new Set([...evTags, ...teamTags])].slice(0, 5);

      const fields = (ev && ev.fields) || {};
      const keyResult = fields.key_result && fields.key_result.value ? String(fields.key_result.value).slice(0, 180) : '';
      const method = (fields.em_method && fields.em_method.value) || (fields.surrogate_opt && fields.surrogate_opt.value) || '';
      const oneLine = (card && card.oneLine) || keyResult || String(it.abstract || '').slice(0, 160);

      if (tagl && !tags.some((t) => t.toLowerCase().includes(tagl))) continue;
      if (ql) {
        const hay = [it.title, oneLine, keyResult, method, ...tags, ...teams.map((t) => `${t.institution} ${t.lab} ${t.pi}`)].join(' ').toLowerCase();
        if (!hay.includes(ql)) continue;
      }

      const fullCard = card && cards && typeof cards.find === 'function' ? cards.find(it.key) : null;
      const hi = extractCardHighlights(fullCard);

      out.push({
        key: it.key,
        citekey: it.citekey || '',
        title: it.title || '',
        authors: (it.creators || []).slice(0, 4),
        year: it.year || '',
        venue: it.venue || '',
        added: it.added || 0,
        hasCard: !!card,
        cardStatus: card ? card.status : '',
        starred: !!(card && card.starred),
        cover: card ? card.cover || '' : '',
        figs: card ? card.figs || 0 : 0,
        oneLine,
        results: hi.results,
        doubt: hi.doubt,
        keyResult,
        method: String(method || '').slice(0, 80),
        verifiedRatio: ev ? ev.verifiedRatio : null,
        schemaId: ev ? ev.schemaId : '',
        teams,
        tags,
      });
    }

    // Prioritize items with deep cards & figures, then starred, then newest
    out.sort((a, b) => {
      const score = (x) => (x.cardStatus === 'deep' || x.cardStatus === 'reviewed' ? 4 : x.hasCard ? 2 : 0) + (x.cover ? 2 : 0) + (x.starred ? 2 : 0) + (x.teams.length ? 1 : 0);
      return score(b) - score(a) || (Number(b.year) || 0) - (Number(a.year) || 0) || b.added - a.added;
    });
    return { items: out.slice(0, Math.max(1, Math.min(200, Number(limit) || 80))), total: out.length };
  }

  function teamDetail(teamId) {
    if (!kbStruct) return null;
    const team = kbStruct.getTeam(teamId);
    if (!team) return null;
    const graph = kbStruct.teamGraph();
    const collaborators = [];
    for (const e of graph.edges) {
      if (e.from === teamId || e.to === teamId) {
        const otherId = e.from === teamId ? e.to : e.from;
        const other = graph.nodes.find((n) => n.id === otherId);
        if (other) collaborators.push({ ...other, sharedPapers: e.weight });
      }
    }
    collaborators.sort((a, b) => b.sharedPapers - a.sharedPapers);
    const papers = listStream({ teamId, limit: 100 }).items;
    return { team, collaborators, papers };
  }

  return { extractTeamsForPaper, listStream, teamDetail, teamGraph: () => (kbStruct ? kbStruct.teamGraph() : { nodes: [], edges: [] }), TEAM_SCHEMA };
}

module.exports = { createStream };
