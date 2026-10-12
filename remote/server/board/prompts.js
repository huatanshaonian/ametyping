// What 画板 asks the model, and the shape of its answers.
//   还原 (restore): the handwritten page as a picture -> the same page set in type: every piece of writing, formula,
//     box and arrow where it was drawn (a 1000-wide grid), only straightened and lined up; plus the text档 (Markdown).
//     The page is laid out from these pieces by the web page (public/js/apps/board-sheet.js): the model writes no HTML
//     here, so nothing is "designed" at this step.
//   设计 (design): the restored page -> one self-contained HTML document with a real layout. Formulas stay LaTeX
//     between dollars; the page draws them (KaTeX), the model does not need to.
'use strict';

const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' };
const KINDS = ['text', 'math', 'rect', 'round', 'ellipse', 'diamond', 'line', 'arrow', 'table'];
const ITEM_KEYS = ['kind', 'x', 'y', 'x2', 'y2', 'text', 'size', 'color', 'bold', 'dashed'];
const RESTORE_SCHEMA = { type: 'object', additionalProperties: false, required: ['title', 'items', 'markdown', 'unsure'], properties: {
  title: str,
  items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ITEM_KEYS,
    properties: { kind: { type: 'string', enum: KINDS }, x: num, y: num, x2: num, y2: num, text: str, size: num, color: str, bold: bool, dashed: bool } } },
  markdown: str,
  unsure: { type: 'array', items: str },
} };
const DESIGN_SCHEMA = { type: 'object', additionalProperties: false, required: ['html', 'note'], properties: { html: str, note: str } };

const MAX_ITEMS = 600, MAX_HTML = 400000;

// w, h: the picture's size in pixels; note: what the user added (may be '')
function restorePrompt({ w, h, note }) {
  const H = Math.round(1000 * h / w);
  return [
    '这张图片是用户在手写板上的一页手稿（白底）：可能有手写的文字、数学公式、流程图、思维导图、表格、草图和各种标注。',
    '请把它「誊清」：内容和布局都不变，只是把手写体换成印刷体、把歪的线拉直、把本来想对齐的东西对齐。这一步不做任何设计，也不要改写、补充、删减或重新组织内容。',
    '',
    `坐标：图片左上角是 (0, 0)，宽记作 1000，高是 ${H}（同一单位，所以这张图的范围是 x 0–1000、y 0–${H}）。所有坐标都用这个单位，不是像素。`,
    '',
    '把手稿拆成一个个元素写进 items，每个元素：',
    '- kind = "text"：一段文字。(x, y) 是它左上角，(x2, y2) 是右下角。text 是内容，手稿里换行的地方用 \\n；行内的公式写成 $...$ 的 LaTeX。标题、小标题、列表的每一条、图旁的注释都各是一个 text。',
    '- kind = "math"：单独成行的公式。text 是 LaTeX 源码，不带 $。位置同 text。连续几行推导可以各写一个，也可以用 aligned 环境写成一个。',
    '- kind = "rect" / "round" / "ellipse" / "diamond"：方框、圆角框、椭圆（圆）、菱形。(x, y)–(x2, y2) 是它的外框，text 是框里的字（没有就 ""，里面的公式同样写 $...$）。框里的字不要再另写一个 text。',
    '- kind = "line" / "arrow"：线段、箭头。从 (x, y) 到 (x2, y2)，箭头指向 (x2, y2)。text 是写在线旁的字（没有就 ""）。拐弯的连线拆成几段 line，最后一段用 arrow；弯曲的线用两三段直线近似。连着框的线，端点要落在框的边上。',
    '- kind = "table"：表格。(x, y)–(x2, y2) 是外框，text 每行一行、单元格之间用 | 分开（第一行是表头）。',
    '- size：字的高度（一行字从顶到底，同一坐标单位）。同一层级的文字用同一个 size；线和没有字的框填 0。',
    '- color：手稿里这一笔的颜色，写成 #rrggbb；普通的黑 / 深灰色笔迹填 ""。bold：标题或明显加粗、描粗的填 true。dashed：虚线填 true。',
    '',
    '对齐：只做「看得出本意」的对齐——同一列的条目左边对齐，同一行的框上下对齐、大小一致，明显想画成水平或竖直的线画成水平或竖直。相对位置（谁在谁的上下左右、谁连着谁、大致隔多远）必须保持，不要把东西挪到别处，也不要为了好看重新排版。',
    '',
    '公式要特别仔细：逐个符号还原，上下标、分式、根号、求和 / 积分的上下限、矢量和张量的记号、希腊字母、括号的配对都不能省略或「顺手改对」；手稿上写的是什么就是什么。看不清的符号按最可能的写，并在 unsure 里说明是哪里、你猜的是什么。',
    '涂掉、划掉的内容不要誊；手稿里用圈、下划线、星号做的强调，用对应的元素（ellipse、line）或 bold 表示。纯粹的图画（示意草图、曲线图）无法誊成文字时，用 line / ellipse 等画出大致轮廓，并用一个 text 注明「（草图：……）」。',
    '',
    'markdown：这一页的文字档，给以后检索和继续加工用。按阅读顺序整理成 Markdown：标题、列表、表格；公式用 $...$ 和 $$...$$；流程图和思维导图用缩进的列表或「A → B」这样的文字把结构讲清楚（谁连到谁、箭头上的字）。内容同样不增不减。',
    'title：给这一页起一个十几个字以内的标题（手稿自己有标题就用它）。',
    'unsure：看不清或拿不准的地方，每条一句话；没有就是空数组。',
    note ? '\n用户的补充说明：' + note : '',
  ].filter((l) => l !== '').join('\n');
}

// r: the restored page (the cleaned answer above); note: what the user asked for (may be '')
function designPrompt({ r, note }) {
  const items = r.items.map((i) => `${i.kind} (${i.x},${i.y})-(${i.x2},${i.y2})${i.bold ? ' 粗' : ''}${i.color ? ' ' + i.color : ''}: ${JSON.stringify(i.text)}`).join('\n');
  return [
    '下面是用户一页手稿誊清后的内容（图片是誊清前的原稿，供你核对；元素清单里的坐标以宽 1000 为单位，说明各部分在原稿上的位置关系）。',
    '请把它设计成一份好看、专业的 HTML 页面：有清楚的层次、合适的字号和留白、克制而统一的配色；流程图、导图、关系图用内联 SVG 重新画得规整；该用卡片、分栏、表格、时间线的地方就用。可以重新组织版面，但内容一条都不能少，也不要编造原稿没有的内容。',
    '',
    '要求：',
    '- html 是一份完整的 HTML 文档（<!doctype html> 开头），样式全部写在 <style> 里。',
    '- 不要任何脚本，不要引用任何外部资源（外部字体、图片、样式表、链接的图标都不行）；图形一律用内联 SVG 或 CSS 画。',
    '- 公式保持 LaTeX：行内写 $...$，单独成行写 $$...$$。页面会替你渲染，你不要自己用 HTML 拼公式；SVG 里放不了公式，带公式的标注请放在 SVG 外面的 HTML 里（可以用绝对定位叠在图上）。',
    '- 字体用系统字体（中文优先 "PingFang SC", "Microsoft YaHei", "Noto Sans SC"），正文不小于 15px；页面在 360px 到 1200px 宽之间都要好读；打印时不出现被截断的卡片。',
    '- note 用一两句话说明你的设计思路（给用户看）。',
    note ? '\n用户对这次设计的要求：' + note : '',
    '',
    '# 标题', r.title || '（无）',
    '', '# 文字档（Markdown）', r.markdown || '（无）',
    '', '# 元素清单', items || '（无）',
    r.unsure && r.unsure.length ? '\n# 誊清时拿不准的地方\n' + r.unsure.map((u) => '- ' + u).join('\n') : '',
  ].filter((l) => l !== '').join('\n');
}

// the model's answers as they are kept: numbers within the page, known kinds, lengths capped
function cleanRestore(a, { w, h }) {
  const H = Math.round(1000 * h / w);
  const n = (v, max) => (Number.isFinite(+v) ? Math.round(Math.min(max, Math.max(0, +v)) * 10) / 10 : 0);
  const items = [];
  for (const i of (Array.isArray(a && a.items) ? a.items : []).slice(0, MAX_ITEMS)) {
    if (!i || !KINDS.includes(i.kind)) continue;
    const it = { kind: i.kind, x: n(i.x, 1000), y: n(i.y, H), x2: n(i.x2, 1000), y2: n(i.y2, H), text: String(i.text || '').slice(0, 4000),
      size: n(i.size, 300), color: /^#[0-9a-f]{6}$/i.test(i.color) ? i.color.toLowerCase() : '', bold: !!i.bold, dashed: !!i.dashed };
    if (it.kind !== 'line' && it.kind !== 'arrow') {                    // (a box's corners, whichever way they were given)
      [it.x, it.x2] = [Math.min(it.x, it.x2), Math.max(it.x, it.x2)];
      [it.y, it.y2] = [Math.min(it.y, it.y2), Math.max(it.y, it.y2)];
    }
    items.push(it);
  }
  return { w: 1000, h: H, title: String((a && a.title) || '').replace(/\s+/g, ' ').trim().slice(0, 60), items,
    markdown: String((a && a.markdown) || '').slice(0, 200000), unsure: (Array.isArray(a && a.unsure) ? a.unsure : []).slice(0, 40).map((u) => String(u).slice(0, 300)).filter(Boolean) };
}
function cleanDesign(a) {
  const html = String((a && a.html) || '');
  if (html.length > MAX_HTML) throw new Error('设计稿太长了');
  if (!/<[a-z][\s\S]*>/i.test(html)) throw new Error('模型没有给出 HTML');
  return { html, note: String((a && a.note) || '').slice(0, 600) };
}

module.exports = { RESTORE_SCHEMA, DESIGN_SCHEMA, restorePrompt, designPrompt, cleanRestore, cleanDesign, KINDS };
