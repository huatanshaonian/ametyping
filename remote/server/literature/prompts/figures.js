// 图表: what the model is asked when it looks at a few of a paper's pages for their figures -- where each one is on
// its page (so that it can be cut out: render/crop.mjs puts a box that is a little off right), its caption as printed,
// and what can be seen in it. What the figure means for the paper is written later, by the deep card's model, which has
// the whole text (prompts/card.js).
'use strict';

const str = { type: 'string' }, num = { type: 'number' };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });
const FIG_SCHEMA = obj({ figs: { type: 'array', items: obj({ page: { type: 'integer' }, label: str, x0: num, y0: num, x1: num, y1: num, caption: str, desc: str }) } });

// it: the item; pages: the page numbers, in the order of the images
function figuresPrompt(it, pages) {
  return [
    `下面 ${pages.length} 张图依次是文献《${it.title}》PDF 的第 ${pages.join('、')} 页。找出这些页上的图（Figure / Fig. / 图：曲线图、云图、示意图、照片、流程图），按 figs: [...] 给出，每张图一项：`,
    '- page：它在第几页（用上面的页码）。',
    '- label：文中的编号，照原样写（如 "Fig. 3"、"图 5"）；没有编号写空字符串。',
    '- x0, y0, x1, y1：这张图在页面上的范围，用页面宽、高的比例表示（0～1，原点在页面左上角；x0、y0 是左上角，x1、y1 是右下角）。',
    '  要把整张图框进去：坐标轴的刻度和标签、图例、色标、所有子图和它们的 (a)(b) 标注都在内；不要把图题和正文框进去。拿不准边界时宁可略大一点。',
    '- caption：图题原文，照抄，不翻译。',
    '- desc：用中文写这张图画了什么（3～5 句）：横轴、纵轴是什么量和单位；各条曲线 / 各个子图分别是什么；能直接从图上读出的趋势或数值。只写看得见的，不要推测结论。',
    '规则：同一个编号下的多个子图算一张图，框住全部子图；表格、公式、算法框不算图；期刊的标志、页眉页脚里的小图不算；没有图的页不用写，都没有就给空数组。',
  ].join('\n');
}

module.exports = { FIG_SCHEMA, figuresPrompt };
