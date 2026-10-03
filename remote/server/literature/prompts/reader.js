// The deep reading: the user writes what they understood first, then the model compares it with the paper; the
// conversation about the paper (each turn sent with the card, the pages that matter and the talk so far -- nothing
// depends on the model remembering); 沉淀: findings from the talk turned into proposed edits of the card; and the
// topic pages (a review of a subject built from cards, its gaps, a related-work paragraph with \cite{citekey}).
'use strict';
const { questionsBlock } = require('./feed');

const str = { type: 'string' }, strs = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });

const FEEDBACK_SCHEMA = obj({ feedback: str, missed: strs, askBack: str });
const CHAT_SCHEMA = obj({ answer: str, askBack: str });
const DISTILL_SCHEMA = obj({ ops: { type: 'array', items: obj({ section: str, text: str, reason: str }) } });
const TOPIC_SCHEMA = obj({ overview: str, evidence: strs, disagreements: strs, gaps: strs });
const RELATED_SCHEMA = obj({ paragraph: str, used: strs });

const CARD_SECTIONS = ['问题', '方法', '关键假设', '主要结果', '与我的关系', '可以采取的行动', '可复用的公式与数据', '疑点', '值得追的文献', '历史与后续', '我的理解', '关系'];
const cut = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const pagesBlock = (pages) => pages.map((p) => `[p.${p.page}]\n${p.text}`).join('\n\n');

function feedbackPrompt(it, card, pages, mine) {
  return [
    '用户在深读一篇文献前，先用自己的话写下了理解。请对照原文给出反馈（中文，像一位耐心的导师）：',
    '- feedback：哪些理解对、哪些偏了或漏了（指出原文页码 [p.N]），2～5 句，具体；',
    '- missed：用户没注意到但对用户的问题重要的点（0～3 条）；',
    '- askBack：一个反问，检验用户是否真的抓住了关键（例如关于假设的适用条件）。', '',
    `文献：${it.title}`, card ? '卡片：\n' + cut(card, 4000) : '', '用户写的理解：\n' + cut(mine, 3000), '', '原文（标了页码）：', pagesBlock(pages),
  ].filter((x) => x !== '').join('\n');
}

// turns: [{ q, a }] (oldest first); sel: text the user selected in the PDF
function chatPrompt(profile, it, card, pages, turns, q, sel) {
  return [
    '你在陪一位博士生精读一篇文献。回答用中文，术语保留原文，公式用 LaTeX（行内 $...$，独立 $$...$$）。',
    '回答要依据原文，引用处标页码 [p.N]；原文里没有的要明说“原文没有写”，可以补充你的背景知识但要标明“（背景知识）”。',
    '用户的目标是把阅读变成产出：回答时尽量联系用户的问题，说明能怎么用。',
    'askBack：在合适时给出一个反问，促使用户自己思考（检验理解、追问适用条件、或建议下一步看哪里）；不需要时给空字符串。', '',
    '用户现在要解决的问题：', questionsBlock(profile), '',
    `文献：${it.title}（${it.venue || ''} ${it.year || ''}）`, card ? '卡片：\n' + cut(card, 5000) : '', '',
    '相关原文（标了页码）：', pagesBlock(pages), '',
    turns.length ? '之前的对话：\n' + turns.map((t) => `用户：${cut(t.q, 1500)}\n你：${cut(t.a, 2500)}`).join('\n\n') : '',
    sel ? '用户在 PDF 里选中的文字：\n' + cut(sel, 3000) : '', '', '用户的问题：' + q,
  ].filter((x) => x !== '').join('\n');
}

function distillPrompt(it, card, turns) {
  return [
    '把下面这段关于文献的对话里“值得留下来”的结论，整理成对文献卡片的补充（中文，简洁，保留页码 [p.N]）。',
    `可用的小节：${CARD_SECTIONS.join('、')}。每条 op：section 选一个小节，text 是要追加到该小节的 Markdown（列表项用 "- " 开头），reason 一句话说明来自对话的哪里。`,
    '只留下有信息量的结论（澄清的概念、发现的假设、可执行的行动、疑点），寒暄和重复卡片已有内容的不要；没有值得留下的就给空数组。', '',
    `文献：${it.title}`, '现有卡片：\n' + cut(card, 5000), '', '对话：\n' + turns.map((t) => `用户：${cut(t.q, 1500)}\n助手：${cut(t.a, 3000)}`).join('\n\n'),
  ].join('\n');
}

// cards: [{ citekey, title, text }]
function topicPrompt(profile, name, current, cards) {
  return [
    `为用户的专题「${name}」写一页综述（中文，术语保留原文），只依据下面的文献卡片，引用写成 [[citekey]]。`,
    '这是用户自己的综述：重在比较、判断和用户能做什么，而不是逐篇摘要。', '用户现在要解决的问题：', questionsBlock(profile), '',
    '字段：overview 综述正文（几段，讲清这个专题的主线、主要方法和结论的演进）；evidence 关键证据，每条一句并带引用；',
    'disagreements 文献之间的分歧或矛盾（带引用）；gaps 空白与机会：没人做过、条件不同、结论冲突的地方——用户自己的创新点可能从这里来（具体）。', '',
    current ? '现有的专题页（在此基础上更新，保留用户写的判断）：\n' + cut(current, 6000) : '', '卡片：',
    ...cards.map((c) => `### [[${c.citekey}]] ${c.title}\n${cut(c.text, 2500)}`),
  ].filter((x) => x !== '').join('\n');
}

function relatedPrompt(name, topic, cards) {
  return [
    `为学位论文或投稿写一段“相关工作”（${name}），中文学术写法，引用用 LaTeX \\cite{citekey}（citekey 用下面给的）。`,
    '按思路组织而不是逐篇罗列；指出现有工作的不足，自然引出研究的必要性。只依据给出的材料，不要编造文献。used：用到的 citekey。', '',
    '专题页：\n' + cut(topic, 6000), '', '卡片：', ...cards.map((c) => `### ${c.citekey}：${c.title}\n${cut(c.text, 1500)}`),
  ].join('\n');
}

module.exports = { FEEDBACK_SCHEMA, CHAT_SCHEMA, DISTILL_SCHEMA, TOPIC_SCHEMA, RELATED_SCHEMA, CARD_SECTIONS, feedbackPrompt, chatPrompt, distillPrompt, topicPrompt, relatedPrompt };
