// 摘要对照: abstracts into Chinese, a sentence at a time, each with the sentence it renders -- so that the window can
// set them side by side (translate.js checks that the sentences given back are the abstract's own).
'use strict';

const str = { type: 'string' };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });

const TRANSLATE_SCHEMA = obj({ items: { type: 'array', items: obj({ ref: str, segs: { type: 'array', items: obj({ src: str, zh: str }) } }) } });

// texts: [{ ref, text }]; field: the user's research in a line or two (which sense of a term is meant)
function translatePrompt(texts, field = '') {
  return [
    '把下面每段论文摘要译成中文，给研究生和原文逐句对照着读。',
    field ? '读者的研究方向（用来确定术语取哪个意思）：' + field + '\n' : '',
    '要求：',
    '- 按句切分。segs 的每一项是原文的一句（src）和它的译文（zh），顺序和原文一致，一句不漏。',
    '- src 原样照抄，一个字符都不要改（不要纠正拼写、不要改标点、不要合并或改写句子）。',
    '- 译文忠实、通顺，用该领域通行的中文术语；缩写、符号、公式、数字和单位保持原样（如 RCS、FDTD、10 dB）；人名、型号不译。',
    '- 不增不减，不加解释和评论。',
    '- items 里每段摘要一项，ref 用它的编号。', '',
    ...texts.map((t) => `### ${t.ref}\n${t.text}`),
  ].filter((x) => x !== '').join('\n');
}

module.exports = { TRANSLATE_SCHEMA, translatePrompt };
