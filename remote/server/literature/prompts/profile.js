// The interest profile: the user writes the research's main line (主线) and the questions being worked on; the model
// then goes through the whole Zotero library with that line as the frame and fills in the rest in detail -- the line's
// branches (each with what it covers, how well the library covers it, representative papers and search phrases),
// questions the user may have missed (suggestions only), and what to follow so that every branch is watched, the thin
// ones above all. The user edits all of it and confirms; the feed and every card use it.
'use strict';

const str = { type: 'string' }, strs = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });

const FILL_SCHEMA = obj({
  branches: { type: 'array', items: obj({ name: str, desc: str, coverage: str, keywords: strs, papers: strs }) },
  suggestQuestions: { type: 'array', items: obj({ text: str, why: str }) },
  venues: strs,
  extraVenues: strs,
  authors: strs,
  keywords: strs,
  arxiv: strs,
  ntrs: strs,
  seeds: strs,
});

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// line: the user's main line; questions: [text] the user wrote (most important first); lib: { items, venues, authors,
// collections } (prompt lines below); work: recent daily reports
function fillPrompt(line, questions, lib, work) {
  const lines = [
    '你在帮一位博士生把研究主线落实成文献画像。下面「研究主线」是用户自己写的，以它为准、从全局出发：',
    '不要只盯着文献库里文献最多的方向，主线里的每一部分都要照顾到；文献库里很少甚至没有的部分，恰恰是以后推送要补的。',
    '画像的用途：每天推送最多 2 篇新文献（期刊、arXiv、NASA NTRS 老报告），并把每次阅读挂到用户的问题上，让阅读变成产出。', '',
    '## 研究主线（用户写的）', line, '',
    questions.length ? '## 用户现在要解决的问题（越靠前越重要）\n' + questions.map((q, i) => `Q${i + 1}. ${q}`).join('\n') : '## 用户还没写问题',
    '',
    '请通读下面的整个文献库，按主线写出（中文，术语保留英文）：',
    '- branches：把主线拆成 4～10 个分支（研究板块），覆盖主线的全部内容，顺序跟主线一致。每个分支：',
    '    name 分支名（短）；desc 2～4 句：这个分支在用户的研究里做什么、关键的物理问题/方法、库里已有的文献大致讲到哪里、还缺什么；',
    '    coverage 库里的覆盖程度，只能填「充足」「一般」「较少」之一；keywords 3～8 个英文检索词（期刊里的常用写法）；',
    '    papers 库里最能代表这个分支的 2～6 篇文献编号（下面列表里的 key，优先有批注 * 的；没有合适的就少给，不要硬凑）。',
    '- suggestQuestions：0～4 个用户可能漏掉、但对主线重要的问题（不要重复用户已写的），why 说明理由；没有就给空数组。',
    '- venues：值得每天追的期刊/会议（出自下面库里的期刊列表，覆盖各个分支，按重要性排序，最多 12 个）。',
    '- extraVenues：库里没有、但对较少覆盖的分支很重要的期刊（写期刊全名，最多 4 个，没有就空数组）。',
    '- authors：值得追的作者（出自库里反复出现的作者，写库里的写法，覆盖不同分支，最多 12 个）。',
    '- keywords：给 OpenAlex / arXiv 检索新文献用的英文检索式（2～4 个词一组，不加引号），每个分支至少 1 条，共 8～16 条，覆盖较少的分支可以多给。',
    '- arxiv：相关的 arXiv 分类代码（如 physics.plasm-ph、physics.comp-ph、eess.SP、physics.flu-dyn），最多 6 个。',
    '- ntrs：在 NASA 技术报告库检索老报告用的英文检索式（3～10 条，挑那些 NASA/NACA 做过大量工作的分支）。',
    '- seeds：库里最核心的 4～10 篇文献编号，尽量每个分支都有一篇（系统会追踪“谁引用了它们”）。',
    '注意：文献编号（方括号里的 8 位字母数字）只用在 papers 和 seeds 里；desc、why 等说明文字里提到文献时写它的简短题目或「作者 年份」，不要写编号。',
    '',
  ];
  lines.push('## 分类（文献数）', lib.collections.map(([n, c]) => `${n}（${c}）`).join('；'), '');
  lines.push('## 期刊/会议（篇数）', lib.venues.slice(0, 60).map(([n, c]) => `${n}（${c}）`).join('；'), '');
  lines.push('## 常见作者（篇数）', lib.authors.slice(0, 50).map(([n, c]) => `${n}（${c}）`).join('；'), '');
  lines.push('## 最近的工作日报（了解用户这几天在做什么）');
  if (!work.length) lines.push('（没有）');
  for (const r of work) lines.push(`- ${r.date}：${cut(r.headline, 80)}${(r.projects || []).length ? ' | ' + r.projects.map((p) => `${p.name}：${cut(p.summary, 80)}`).join('；') : ''}`);
  lines.push('', '## 整个文献库（* 表示有用户的批注或笔记）');
  for (const it of lib.items) lines.push(`- [${it.key}]${it.notes ? '*' : ''} ${cut(it.title, 150)} | ${cut(it.venue, 50)} ${it.year || ''} | ${it.collections.join('、') || '未分类'}${it.abstract ? ' | ' + cut(it.abstract, 160) : ''}`);
  return lines.join('\n');
}

module.exports = { FILL_SCHEMA, fillPrompt };
