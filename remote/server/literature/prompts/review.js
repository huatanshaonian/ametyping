// 回顾 (monthly, quarterly): the model looks back over a period -- what the user did (reports), read (cards, their own
// understanding), took or skipped from the push, and, for a quarter, what the field published -- and proposes how the
// questions and the line should change, each proposal with its grounds, next to an account of the progress on every
// question. Nothing here changes the profile: the user approves each change (review.js).
'use strict';

const str = { type: 'string' }, bool = { type: 'boolean' }, strs = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });
const CHANGES = ['修改', '细化', '分叉', '合并', '搁置', '解决', '新增'];
const PROGRESS = ['有进展', '停滞', '已解决', '未开始'];
const DIMS = ['贴合工作', '领域前沿', '文献空白', '方法与验证'];

const SEARCH_SCHEMA = obj({ queries: strs });
const REVIEW_SCHEMA = obj({
  summary: str,
  progress: { type: 'array', items: obj({ q: str, state: str, note: str, evidence: str }) },
  changes: { type: 'array', items: obj({ type: str, q: strs, text: str, dim: str, children: { type: 'array', items: obj({ text: str, dim: str }) }, reason: str, evidence: str, refs: strs }) },
  line: obj({ change: bool, text: str, reason: str }),
  next: strs,
});

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const qLines = (qs) => qs.map((q) => `${q.ref}【${q.dim || '未分'}${q.status === 'shelved' ? '，搁置中' : ''}】${q.text}${q.why ? `（${cut(q.why, 120)}）` : ''}`).join('\n') || '（还没有问题）';

// a quarter's review: what to look up first (the last year's literature on the questions as they stand)
function searchPrompt(line, qs) {
  return [
    '用户要做一次季度研究回顾。先决定去检索哪些近一年的文献，来判断这些问题在领域里的现状有没有变化（有人解决了、出现了新方法、出现了新问题）。',
    '研究主线：' + cut(line, 3000), '当前的问题：', qLines(qs), '',
    'queries：6～10 条英文检索式，每条 2～5 个词（不带引号），覆盖最重要的几个问题和主线的各个分支。',
  ].join('\n');
}

// m: { kind: 'month' | 'quarter', from, to (YYYY-MM-DD), line, questions: [{ ref, text, dim, why, state, status }],
//      history: [lines], weeks: [lines], days: [lines], cards: [lines], kept: [titles], skipped: [titles], fresh: [{ ref, title, venue, year, abstract }] }
function reviewPrompt(m) {
  const quarter = m.kind === 'quarter';
  return [
    `为一位博士生做${quarter ? '季度' : '月度'}研究回顾（${m.from} 到 ${m.to}）。目的：让“研究主线和问题”跟上实际的进展——哪些问题有了答案、哪些该改写得更具体、哪些该分成几个、哪些不再重要，并指出成果进展和下一步。你只提建议，每一条都由用户亲自批准，所以要具体、有依据、宁缺毋滥。`,
    '', '## 研究主线', cut(m.line, 5000), '', '## 当前的问题（Q 编号只在这次回顾里用）', qLines(m.questions),
    m.history.length ? '\n## 这段时间里问题和主线已经发生的变动\n' + m.history.join('\n') : '',
    m.weeks.length ? '\n## 这段时间的周报\n' + m.weeks.join('\n') : '',
    m.days.length ? '\n## 这段时间的日报（每天一行）\n' + m.days.join('\n') : '',
    !m.weeks.length && !m.days.length ? '\n（这段时间没有工作日报）' : '',
    m.cards.length ? '\n## 这段时间读过、做了卡片的文献\n' + m.cards.join('\n') : '\n（这段时间没有新的文献卡片）',
    m.kept.length ? '\n## 每日推送里收下的\n' + m.kept.map((t) => '- ' + cut(t, 140)).join('\n') : '',
    m.skipped.length ? '\n## 每日推送里跳过的（说明这些方向用户不感兴趣）\n' + m.skipped.map((t) => '- ' + cut(t, 140)).join('\n') : '',
    m.fresh.length ? '\n## 近一年领域里的新文献（按相关度；用户库里没有）\n' + m.fresh.map((w) => `${w.ref}：${w.title}（${w.venue || ''} ${w.year || ''}）${w.abstract ? '\n  ' + cut(w.abstract, 320) : ''}`).join('\n') : '',
    '', '## 要给出的',
    '- summary：这段时间的总体判断，3～6 句：实际在做什么、离主线的目标近了多少、最值得注意的一件事。直说，不要客套。',
    `- progress：对每个当前问题给一条（q 写编号如 "Q3"）：state 用 ${PROGRESS.join(' / ')} 之一；note 说明进展到哪里或卡在哪里；evidence 写依据（哪天的日报、哪篇文献卡片）。没有任何依据的写“未开始”，不要编。`,
    `- changes：建议的变动，可以为空数组。type 用 ${CHANGES.join(' / ')} 之一：`,
    '  - 修改：问题的提法不准确或方向变了（q 一个编号，text 新的提法）。',
    '  - 细化：问题太笼统，这段时间的工作或文献让它可以说得更具体（q 一个编号，text 更具体的提法）。',
    '  - 分叉：一个问题实际上变成了几个可以分别推进的子问题（q 一个编号，children 2～4 个子问题，各带 dim；text 留空）。',
    '  - 合并：几个问题其实是一回事（q 多个编号，text 合并后的提法）。',
    '  - 搁置：这段时间完全没碰、和实际工作也脱节的问题（q 一个编号）。  - 解决：有明确依据表明已经回答了（q 一个编号）。',
    `  - 新增：工作或文献里冒出来、现有问题没有覆盖的新问题（q 空数组，text 问题，dim 用 ${DIMS.join(' / ')} 之一）。`,
    `  每条都要有 reason（为什么该这样改）和 evidence（具体依据：日报日期、文献题目${m.fresh.length ? '、新文献编号' : ''}）。${m.fresh.length ? 'refs：支撑这条变动的新文献编号（如 ["N3"]），没有就空数组。' : 'refs 填空数组。'}dim 不适用时填空字符串，children 不适用时填空数组。`,
    quarter ? '- line：主线是否需要调整（实际工作的重心变了、目标变了、增加或放弃了一个分支）。需要时 change 填 true，text 给出调整后的完整主线（在原文基础上改，保留仍然成立的部分），reason 说明；不需要就 change 填 false、其余空字符串。'
      : '- line：月度回顾不动主线，change 填 false、text 和 reason 填空字符串。',
    '- next：下一阶段建议做的 2～5 件事，动词开头、具体可执行，说明对应哪个问题。',
    '用中文；术语保留英文原词。文中提到文献用《题目》，不要用编号以外的代号。',
  ].filter((x) => x !== '').join('\n');
}

module.exports = { SEARCH_SCHEMA, REVIEW_SCHEMA, searchPrompt, reviewPrompt, CHANGES, PROGRESS, DIMS };
