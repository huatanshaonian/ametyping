// The interest profile, drafted by the model from the user's Zotero library and recent daily reports: what the research
// is about, the questions being worked on now (everything pushed or read is tied to one of them), and what to follow
// (journals, authors, search words, arXiv categories, NTRS searches, the key papers whose citations are watched).
// The user edits and confirms it in the 文献 window (画像); the feed runs on it.
'use strict';

const str = { type: 'string' }, strs = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });

const PROFILE_SCHEMA = obj({
  summary: str,
  topics: { type: 'array', items: obj({ name: str, keywords: strs }) },
  questions: { type: 'array', items: obj({ text: str, why: str }) },
  venues: strs,
  authors: strs,
  keywords: strs,
  arxiv: strs,
  ntrs: strs,
  seeds: strs,
});

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// lib: { items: [{ key, title, venue, year, collections: [names], tags, notes: n, abstract }], venues: [[name, n]], authors: [[name, n]],
//        collections: [[name, n]] }; work: [{ date, headline, projects: [{ name, summary }] }]; current: the profile so far (or null)
function profilePrompt(lib, work, current) {
  const lines = [
    '你在帮一位博士生整理用户的文献兴趣画像。用户是中国科学院的博士生，方向与飞行器（再入、高超声速）的电磁散射、等离子体鞘套、通信黑障、RCS 建模有关（以用户的文献库为准）。',
    '画像的用途：每天从期刊、arXiv、NASA NTRS 推送最多 2 篇新文献，并把每次阅读挂到用户“当前要解决的问题”上，让阅读变成产出，而不是仪式。',
    '',
    '请根据下面用户的 Zotero 文献库（分类、常见期刊和作者、带批注的文献说明用户真正读过）和最近的工作日报，写出：',
    '- summary：两三句话，用户在研究什么（具体到物理问题和方法），用中文。',
    '- topics：4～8 个研究主题，每个给 3～8 个英文检索词（期刊里常用的术语写法，如 "plasma sheath", "radar cross section"）。',
    '- questions：3～6 个用户“现在要解决的问题”，从最近的日报和最近加入、批注过的文献推断；写成用户自己会说的具体问题（如“鞘套电子密度剖面在 RCS 计算里怎么取”），why 说明从哪里看出来的。',
    '- venues：值得每天追的期刊/会议名称（必须出自用户库里的期刊列表，按重要性排序，最多 10 个）。',
    '- authors：值得追的作者（出自用户库里反复出现的作者，最多 10 个，写库里的写法）。',
    '- keywords：给 OpenAlex / arXiv 检索新文献用的 5～12 个英文检索式（2～4 个词一组）。',
    '- arxiv：相关的 arXiv 分类代码（如 physics.plasm-ph、physics.comp-ph、eess.SP），最多 5 个，不相关就留空。',
    '- ntrs：在 NASA 技术报告库检索老报告用的 3～8 个英文检索式（如 "reentry plasma sheath attenuation"、"RAM C flight experiment"）。',
    '- seeds：用户库里最核心的 3～8 篇文献的编号（下面列表中的 key），系统会追踪“谁引用了它们”。',
    '',
  ];
  if (current) lines.push('用户之前确认过的画像（在此基础上更新，保留用户明确写过的问题）：', JSON.stringify({ summary: current.summary, questions: (current.questions || []).map((q) => q.text) }), '');
  lines.push('## 分类（文献数）', lib.collections.map(([n, c]) => `${n}（${c}）`).join('；'), '');
  lines.push('## 常见期刊/会议（篇数）', lib.venues.slice(0, 40).map(([n, c]) => `${n}（${c}）`).join('；'), '');
  lines.push('## 常见作者（篇数）', lib.authors.slice(0, 40).map(([n, c]) => `${n}（${c}）`).join('；'), '');
  lines.push('## 最近的工作日报');
  if (!work.length) lines.push('（没有）');
  for (const r of work) lines.push(`- ${r.date}：${cut(r.headline, 80)}${(r.projects || []).length ? ' | ' + r.projects.map((p) => `${p.name}：${cut(p.summary, 80)}`).join('；') : ''}`);
  lines.push('', '## 文献库（* 表示有用户的批注；最近加入的在前）');
  for (const it of lib.items) lines.push(`- [${it.key}]${it.notes ? '*' : ''} ${cut(it.title, 160)} | ${cut(it.venue, 60)} ${it.year || ''} | 分类：${it.collections.join('、') || '无'}${it.abstract ? ' | ' + cut(it.abstract, 220) : ''}`);
  return lines.join('\n');
}

module.exports = { PROFILE_SCHEMA, profilePrompt };
