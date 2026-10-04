// 读图: what the model is asked when it reads a few of a paper's pages as images -- a faithful transcription, page by
// page, in Markdown with the equations in LaTeX; nothing summed up, what it cannot make out marked [?].
'use strict';

const str = { type: 'string' };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });
const VISION_SCHEMA = obj({ pages: { type: 'array', items: obj({ page: { type: 'integer' }, md: str }) } });
const UNSURE = '[?]';

// it: the item; pages: [{ page, hint }] in the order of the images (hint: the PDF's own text of that page, may be '')
function visionPrompt(it, pages) {
  const hints = pages.filter((p) => String(p.hint || '').trim());
  return [
    `下面 ${pages.length} 张图依次是文献《${it.title}》PDF 的第 ${pages.map((p) => p.page).join('、')} 页。把每一页逐字转写成 Markdown，按页给出 pages: [{ page, md }]（page 用上面的页码）。`,
    '要求：',
    '- 照原文的语言逐字抄：不翻译、不总结、不改写、不补全。分栏的页面先左栏后右栏；页眉、页脚、页码可以省略。',
    '- 公式一律用 LaTeX：行内 $...$，独立公式 $$...$$，有式号的在公式末尾写 \\tag{式号}。上下标、撇号、帽子、粗体矢量、积分上下限都照原样。',
    '- 表格用 Markdown 表格。图只写一行：[图 n：图题；横轴、纵轴是什么，曲线或内容简述]。',
    `- 看不清、拿不准的符号或数字写 ${UNSURE}，不要猜。`,
    hints.length ? '- 下面附了这几页 PDF 自带的文字层（直接从文件里抽出来的，公式常常是乱的），只用来核对单词拼写和数字；和图片不一致时以图片为准。' : '',
    ...hints.map((p) => `\n### 第 ${p.page} 页的文字层\n${String(p.hint).slice(0, 6000)}`),
  ].filter((x) => x !== '').join('\n');
}

module.exports = { VISION_SCHEMA, visionPrompt, UNSURE };
