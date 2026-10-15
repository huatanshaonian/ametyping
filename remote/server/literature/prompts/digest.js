// 分段总结: what the model is asked for one part of a report too long to be read whole for its deep card -- detailed
// notes in the text's own order, every point with its page, the equations, numbers and figures kept as they are, so
// that the deep card written from all the parts' notes can still quote them.
'use strict';

const DIGEST_SCHEMA = { type: 'object', additionalProperties: false, properties: { notes: { type: 'string' } }, required: ['notes'] };
const block = (pages) => pages.map((p) => `[p.${p.page}]\n${p.text}`).join('\n\n');

// it: the paper; part: { i, of, from, to } (1-based part, its first and last page labels); n: the paper's pages;
// pages: the part's pages [{ page, text }]; before / after: the page just outside it on each side (or null), for context
function digestPrompt(it, part, n, pages, before, after) {
  return [
    `文献《${it.title}》${it.year ? `（${it.year}）` : ''}共 ${n} 页，太长，没法整篇交给写深读卡的模型。全文分成 ${part.of} 段，这是第 ${part.i} 段：第 ${part.from}～${part.to} 页。`,
    '把这一段整理成详细的阅读笔记（Markdown，中文；术语、符号保留原文），之后会和其他段的笔记一起用来写深读卡。要求：',
    '- 按原文顺序，按原文的章节分小标题；每条末尾标页码 [p.N]（N 用上面给的页码）。',
    '- 公式照原文写成 LaTeX（行内 $...$，单独的 $$...$$），保留式号；推导只写关键步骤和用到的假设。',
    '- 数值、参数取值、实验或计算条件完整保留；表格里的关键数据照抄（可以写成 Markdown 表格）。',
    '- 提到的图写清 Fig. 几画的是什么、能读出什么结论或数值。',
    '- 作者的结论、判断、提到的局限都保留。不要加自己的评价，不要省略数字。',
    '- 长度大约是原文的五分之一；参考文献列表只记和正文论证有关的几条。',
    (before || after) ? '- 标了「衔接用」的页属于相邻的段，只用来理解上下文（比如跨页的推导、表格），不要为它们单独写笔记。' : '',
    '把笔记放进 notes。', '',
    before ? `### 衔接用：上一段的最后一页\n[p.${before.page}]\n${before.text}\n` : '',
    `### 第 ${part.from}～${part.to} 页`, block(pages),
    after ? `\n### 衔接用：下一段的第一页\n[p.${after.page}]\n${after.text}` : '',
  ].filter((x) => x !== '').join('\n');
}

module.exports = { DIGEST_SCHEMA, digestPrompt };
