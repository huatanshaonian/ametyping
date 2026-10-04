// The interest profile: the user writes an account of the work (研究自述). 梳理 is research, not a summary: the model
// first drafts a main line from the account and the searches to make (planPrompt); the papers that matter are then looked
// up -- in the user's Zotero library and, through OpenAlex, the last years' literature -- and the model works out the
// questions from both, in several dimensions (closest to the work / the field's frontier / gaps others left / method and
// validation), each with what others asked and answered and the papers it rests on (questionsPrompt). The user corrects
// the line and the questions; the model then goes through the whole Zotero library with that line as the frame and fills in the rest in detail -- the line's
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

// the dimensions the questions are laid out in
const DIMS = ['贴合工作', '领域前沿', '文献空白', '方法与验证'];
const PLAN_SCHEMA = obj({ line: str, queries: strs, libWords: strs });
const QUESTIONS_SCHEMA = obj({ line: str, questions: { type: 'array', items: obj({ dim: str, text: str, why: str, state: str, refs: strs }) }, unclear: strs });

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const workBlock = (work) => (work.length ? work.map((r) => `- ${r.date}：${cut(r.headline, 80)}${(r.projects || []).length ? ' | ' + r.projects.map((p) => `${p.name}：${cut(p.summary, 60)}`).join('；') : ''}`) : ['（没有）']);

// step 1 of 梳理: the account -> a first main line, and what to look up (in the library and the literature)
function planPrompt(story, work, collections) {
  return [
    '下面是一位博士生自己写的「研究自述」：在做什么、遇到了什么问题，想到哪写到哪，可能不系统，也可能不全面。',
    '这一步先把它理成一条研究主线的初稿，并定下要去查的文献（下一步会据此翻用户的文献库、检索近几年的文献，再归纳问题）：',
    '- line：研究主线初稿。一两句话说总目标，再分点列出几条研究线（每条：做什么、用什么方法、进展到哪），最后说怎么衔接、要做出什么。忠于自述，300～700 字。',
    '- queries：去 OpenAlex 检索近几年文献用的英文检索式，6～10 条（2～5 个词，不加引号），覆盖主线的每条线，也要有能找到该领域最新进展、综述和公开难题的检索式。',
    '- libWords：在用户文献库里找相关文献用的词，10～25 个，中英文都要（库里有中文文献），短词（如「鞘套」「plasma sheath」「RCS」「伴随」）。',
    '', '## 研究自述', story, '',
    '## 最近的工作日报（只用来理解用户的用词和近况，以自述为准）', ...workBlock(work),
    '', '## 用户文献库的分类（文献数）', collections.map(([n, c]) => `${n}（${c}）`).join('；'),
  ].join('\n');
}

// step 2 of 梳理: the account + the first line + the library's papers that matter (L1..) + the last years' literature
// (N1..) -> the line again, and the questions in dimensions, each grounded in papers
function questionsPrompt(story, line, lib, fresh, work) {
  return [
    '你在帮一位博士生找准要研究的科学问题。用户自己的总结可能不全面，所以不能只复述自述：要结合下面的文献——用户库里的（L 编号）和近几年的新文献（N 编号）——',
    '看别人提出了什么问题、回答到了什么程度、还缺什么，再结合用户的工作归纳问题（中文，术语保留原文）。',
    '- line：在初稿基础上修订研究主线（忠于自述；可以根据文献把各条线的定位说得更准，但不要添加用户没在做的方向），300～800 字。',
    `- questions：8～14 个问题，按维度展开，dim 只能是：${DIMS.join('、')}。`,
    '    贴合工作 = 直接卡住用户当前进度、和自述最贴近的（3～4 个）；领域前沿 = 近几年别人正在攻、和主线相关、用户可能还没关注的（2～3 个）；',
    '    文献空白 = 别人提出了但没回答好、或结论互相矛盾、用户有条件去做的（2～3 个）；方法与验证 = 方法怎么选、结果拿什么验证和对比（2～3 个）。',
    '    每个维度内按重要性排序。text 写成具体的问题（不要空泛）；why 一句话：为什么对用户重要（引自述或主线）；',
    '    state 2～3 句：领域现状——谁提出过/在做、回答到什么程度、还缺什么（说明文字里提到文献写简短题目或「作者 年份」，不要写编号）；',
    '    refs 依据的文献编号（如 L3、N7，1～4 个，必须出自下面的列表；没有文献依据的问题写空数组，但这样的问题要少）。',
    '- unclear：自述里含糊、矛盾、缺失、需要用户说清楚的地方（0～4 条，写成对用户的提问）。', '',
    '## 研究自述', story, '', '## 研究主线初稿', line, '',
    '## 最近的工作日报', ...workBlock(work), '',
    '## 用户文献库里相关的文献（* 表示有用户的批注）',
    ...(lib.length ? lib.map((x) => `[${x.ref}]${x.notes ? '*' : ''} ${cut(x.title, 150)} | ${cut(x.venue, 50)} ${x.year || ''}${x.abstract ? ' | ' + cut(x.abstract, 400) : ''}`) : ['（没找到）']),
    '', '## 近几年的相关文献（OpenAlex 检索）',
    ...(fresh.length ? fresh.map((x) => `[${x.ref}] ${cut(x.title, 150)} | ${cut(x.venue, 50)} ${x.year || ''}${x.abstract ? ' | ' + cut(x.abstract, 500) : ''}`) : ['（没检索到：网络不通或没有结果）']),
  ].join('\n');
}

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
    '- ntrs：在 NASA 技术报告库（NTRS）和 DTIC 老报告库检索用的英文短检索式，6～12 条，每条只要 2～3 个词（这两个库是关键词检索，词多了几乎查不到），如 plasma sheath、reentry blackout、RAM C、radar cross section；挑 NASA/NACA 和美军研究机构做过大量工作的分支。',
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

module.exports = { FILL_SCHEMA, fillPrompt, PLAN_SCHEMA, planPrompt, QUESTIONS_SCHEMA, questionsPrompt, DIMS };
