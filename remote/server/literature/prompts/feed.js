// The daily choice: the model scores the new papers found today against the profile -- above all the questions being
// worked on -- and says in one line why each matters; and for a review pick from the user's own library, writes a few
// questions to answer from memory before re-reading (active recall), using what the user once annotated.
'use strict';

const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });

const RANK_SCHEMA = obj({ items: { type: 'array', items: obj({ ref: str, score: num, question: num, why: str, fun: bool }) } });
const REVIEW_SCHEMA = obj({ why: str, recall: { type: 'array', items: str } });

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function questionsBlock(profile) {
  const qs = (profile.questions || []).filter((q) => q.status !== 'done');
  return qs.length ? qs.map((q, i) => `Q${i + 1}. ${q.text}`).join('\n') : '（还没有确认的问题，按研究方向判断）';
}

// cands: [{ ref, title, venue, year, abstract, source }]; fb: { kept: [titles], skipped: [titles] } -- what the user did
// with earlier picks (the model calibrates on them)
function rankPrompt(profile, cands, fb = { kept: [], skipped: [] }) {
  return [
    '你在为用户挑选今天值得读的新文献（每天最多推 2 篇，宁缺毋滥）。用户的研究方向：', profile.summary || '（见问题）', '',
    '用户现在要解决的问题：', questionsBlock(profile), '',
    fb.kept.length ? '用户最近收下的推荐（说明这类是用户要的）：\n' + fb.kept.map((t) => '- ' + cut(t, 120)).join('\n') + '\n' : '',
    fb.skipped.length ? '用户最近跳过的推荐（这类要更严格）：\n' + fb.skipped.map((t) => '- ' + cut(t, 120)).join('\n') + '\n' : '',
    '给下面每篇打分 score（0～10）：9～10 = 直接帮用户解决某个问题（方法、数据、可对比的结果）；7～8 = 和问题明显相关、值得读；5～6 = 同方向但关系不大；0～4 = 无关或只是关键词撞上。',
    'question：最相关的问题编号（如 Q2 填 2），都不相关填 0。',
    'why：一句中文，说清“它和你的哪个问题有关、能拿来做什么”（例如“给出了 RAM C-II 的实测电子密度剖面，可直接作为你 RCS 计算的输入”），不要复述标题，30～60 字。',
    'fun：不直接相关但可能启发思路的有趣工作填 true。',
    '只依据题目和摘要判断；没有摘要的按题目保守打分。', '',
    ...cands.map((c) => `### ${c.ref}\n题目：${c.title}\n来源：${c.venue || c.source} ${c.year || ''}\n摘要：${cut(c.abstract, 900) || '（无摘要）'}`),
  ].join('\n');
}

// it: { title, venue, year, abstract }, notes: the user's annotations / notes on it, card: the card's text if any
function reviewPrompt(profile, it, notes, card) {
  return [
    '这是用户自己文献库里的一篇旧文献，今天推给用户复习。复习方式是“先回忆、再对照”：先让用户凭记忆回答几个问题，再打开文献和用户当年的批注对照。',
    '用户现在要解决的问题：', questionsBlock(profile), '',
    `文献：${it.title}（${it.venue || ''} ${it.year || ''}）`, `摘要：${cut(it.abstract, 1200) || '（无）'}`,
    notes.length ? '用户当年的批注 / 笔记：\n' + notes.map((n) => '- ' + cut(n, 300)).join('\n') : '（用户没有在这篇上做过批注，按补读处理：问题帮用户抓住要点）',
    card ? '已有的卡片：\n' + cut(card, 2500) : '', '',
    'why：一句中文，为什么今天值得回顾它（尽量联系到上面的某个问题）。',
    'recall：2～3 个回忆问题，具体到这篇的内容（方法的关键假设、主要结论里的数、和用户问题的关系），不要泛泛而问；有批注时围绕用户批注过的地方。',
  ].filter((x) => x !== '').join('\n');
}

module.exports = { RANK_SCHEMA, REVIEW_SCHEMA, rankPrompt, reviewPrompt, questionsBlock };
