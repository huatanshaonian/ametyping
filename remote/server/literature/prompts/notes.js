// 笔记 › 认字: what the model is asked when it reads a note the user wrote by hand beside a paper -- the words as
// written, equations in LaTeX, nothing added.
'use strict';

const NOTE_SCHEMA = { type: 'object', additionalProperties: false, properties: { transcript: { type: 'string' } }, required: ['transcript'] };

// it: the paper; n: the note (page, sel)
function notePrompt(it, n) {
  return [
    `图里是读文献《${it.title}》时手写的一条笔记${n.page ? `（写在读到第 ${n.page} 页的时候）` : ''}。把它转写成文字，放进 transcript。`,
    n.sel ? `写的时候选中的原文是：“${String(n.sel).slice(0, 600)}”——只用来帮助认出专业词，不要抄进去。` : '',
    '要求：',
    '- 照写的内容逐字转写，中文、英文按原样；保留分行，列表写成 Markdown 列表。不总结、不补充、不解释、不改正写错的地方。',
    '- 公式用 LaTeX：行内 $...$，单独一行的用 $$...$$。',
    '- 箭头、圈、划线这类记号用文字或符号表示（→、⇒、≈ 等）；画的示意图写一行 [草图：画的是什么]。',
    '- 认不出的字写 [?]，不要猜。',
  ].filter(Boolean).join('\n');
}

module.exports = { NOTE_SCHEMA, notePrompt };
