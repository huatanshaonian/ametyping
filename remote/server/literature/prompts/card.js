// Cards: what the model is asked to write about one paper.
//   quick  from the abstract (and the first pages when the PDF is there): what it is, how it relates to the user's
//          questions, whether it is worth reading -- and, without a PDF, whether the full text is worth getting
//   deep   from the full text: the full card, every claim with its page ([p.5]), ending in what the user can do with it
// The card always ends with "meaning for my question" and "actions": reading is meant to turn into work.
'use strict';
const { questionsBlock, directionOf } = require('./feed');

const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' }, strs = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });

const QUICK_SCHEMA = obj({ oneLine: str, problem: str, method: str, results: strs, relevance: str, question: num, worth: str, getPdf: obj({ worth: bool, why: str }) });
const DEEP_SCHEMA = obj({
  oneLine: str, problem: str, method: str, assumptions: strs, results: strs, relevance: str, question: num, actions: strs,
  reusable: strs, doubts: strs, follow: strs, history: str,
  relations: { type: 'array', items: obj({ citekey: str, type: str, note: str }) },
  vision: obj({ worth: bool, pages: str, why: str }),
  figures: { type: 'array', items: obj({ id: str, title: str, reading: str }) },
});

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const pagesBlock = (pages) => pages.map((p) => `[p.${p.page}]\n${p.text}`).join('\n\n');
const head = (it) => `文献：${it.title}\n作者：${(it.creators || it.authors || []).slice(0, 6).join('; ')}\n来源：${it.venue || ''} ${it.year || ''}${it.number ? '，报告号 ' + it.number : ''}\n`;

// it: the item; pages: [{ page, text }] or []; notes: the user's annotations as lines
function quickPrompt(profile, it, pages, notes) {
  return [
    '为用户写一张文献“速读卡”（中文；术语保留英文原词）。目的不是复述，而是让用户 5 分钟内判断：这篇讲了什么、和自己的哪个问题有关、值不值得深读。',
    '用户的研究主线：' + directionOf(profile), '用户现在要解决的问题：', questionsBlock(profile), '',
    head(it), `摘要：${cut(it.abstract, 3000) || '（无）'}`,
    notes.length ? '用户的批注：\n' + notes.map((n) => '- ' + cut(n, 300)).join('\n') : '',
    pages.length ? '正文开头几页（标了页码）：\n' + pagesBlock(pages) : '（没有正文，只能依据摘要）', '',
    '字段：oneLine 一句话说清它做了什么、得到什么（40～80 字）；problem 它要解决的问题；method 方法（具体到模型/数值方法/实验）；',
    'results 2～4 条主要结果（有数就写数；依据正文时句末标页码如 [p.3]，只依据摘要的不标）；',
    'relevance 和用户哪个问题有关、能拿来做什么（具体）；question 相关问题编号（无关填 0）；worth 一句话：值不值得深读、读哪部分；',
    'getPdf：没有正文时，worth 表示是否值得去手动找全文（付费墙的论文，要通过所里的订阅下载），why 说明理由；已有正文时填 false 和空字符串。',
    '不要编造摘要和正文里没有的内容。',
  ].filter((x) => x !== '').join('\n');
}

// pages: the text, whole ([] when it is given as digest); notes: annotations; mine: the user's own understanding (if written); others: [{ citekey, title }]
// src: { n: the PDF's pages, read: the pages read as images ("1-12"), rest: other pages from the text layer, long: too long to read whole as images,
//        digest: a report too long to give whole -- its parts' notes [{ from, to, notes }] (digest.js) }
// figs: the paper's figures as cut out of its pages [{ id, page, label, caption, desc }] (figures.js) -- the card shows
// the ones the model picks, each with what the model says of it
function deepPrompt(profile, it, pages, notes, mine, others, src = {}, figs = []) {
  return [
    '为用户写一张文献“深读卡”（中文；术语、公式符号保留原文；公式用 LaTeX，行内 $...$）。这张卡要帮用户把阅读变成产出：读完能用它做事。',
    '用户的研究主线：' + directionOf(profile), '用户现在要解决的问题：', questionsBlock(profile), '',
    head(it), `摘要：${cut(it.abstract, 3000) || '（无）'}`,
    notes.length ? '用户的批注（用户真正在意的地方，卡片要回应它们）：\n' + notes.map((n) => '- ' + cut(n, 400)).join('\n') : '',
    mine ? '用户读前写下的理解 / 想从中得到的：\n' + cut(mine, 2000) : '', '',
    src.read ? `正文里第 ${src.read} 页是看原图逐页转写的（公式可信，[?] 表示原图看不清的符号）${src.rest ? `，其余是 PDF 的文字层（公式常有乱码，引用公式时要小心）` : ''}。` : '',
    ...(src.digest ? [`这篇正文太长，没有整篇给你：全文按顺序分成 ${src.digest.length} 段，每段先整理成了详细的阅读笔记（公式、数值、图、结论都保留了，[p.N] 是原文页码，可以直接照着引用）。下面是各段的笔记：`,
      src.digest.map((d) => `### 第 ${d.from}～${d.to} 页的笔记\n${d.notes}`).join('\n\n'), '']
      : ['正文（标了页码）：', pagesBlock(pages), '']),
    '字段：oneLine 一句话总结；problem 问题与动机；method 方法（模型、近似、数值方法、实验条件，具体）；assumptions 关键假设和适用条件（用户套用时最容易出错的地方）；',
    'results 主要结果，3～6 条，有数写数，每条句末标页码 [p.N]；relevance 对用户当前问题的意义（具体到哪个问题、能替代/验证/补充用户的什么）；question 最相关的问题编号（无关填 0）；',
    'actions 2～4 条用户可以马上做的事（如“用 Fig.5 的电子密度剖面重算 X 波段 RCS 并对比”、“复现式 (12) 的碰撞频率模型”），动词开头，具体可执行；',
    'reusable 可复用的公式、参数、数据表（写清在第几页、怎么用）；doubts 疑点与局限（推导跳步、条件苛刻、数据来源不明等）；follow 值得追的参考文献（写出作者、年份、为什么）；',
    'history 如果是老报告/经典文献：它的时代背景、后来被谁发展或取代（不知道就写空字符串，不要编）；',
    'relations 和用户已有卡片的关系（只从下面列出的卡片里选，type 用：延续 / 对比 / 推翻 / 使用其数据 / 方法相同；没有就空数组）。',
    others.length ? '用户已有的卡片：\n' + others.map((o) => `- ${o.citekey}：${cut(o.title, 100)}`).join('\n') : '（用户还没有别的卡片）',
    src.long ? `vision：这篇有 ${src.n} 页，太长，没有整篇看原图，你读到的大多是文字层。如果其中有值得看原图精读的部分（关键推导、公式密集的页、数据表、要读数的图），worth 填 true，pages 写页码范围（如 "12-18, 25"，只挑真正需要的，一般不超过 20 页），why 一句话说明读了能得到什么；没有必要就 worth 填 false、其余空字符串。` : 'vision：填 worth false、pages 和 why 空字符串。',
    figs.length ? '这篇的图已经从页面上裁出来了，卡片里会把图和你的解读放在一起（desc 是看图得到的描述，供你对照正文）：\n' + figs.map((g) => `- [F:${g.id}] ${g.label || '（无编号）'}，第 ${g.page} 页。图题：${cut(g.caption, 300) || '（无）'}\n  画面：${cut(g.desc, 500)}`).join('\n') : '',
    figs.length ? 'figures：从上面的图里挑出理解这篇最关键的，最多 8 张（方法 / 模型示意、关键结果、要读数的图优先；重复的、装饰性的不选），按在文中出现的顺序给出。每张：id 照抄方括号里 F: 后面的编号（如 p4-1）；title 中文短标题（不超过 20 字，说这张图是什么）；reading 解读，3～6 句：这张图说明了什么结论、怎么读它（看哪条曲线、哪个区域、哪个量级）、图上能读出的关键数值、对用户的问题意味着什么或能拿来做什么。不要复述图题，不要写图上看不出、正文里也没有的东西。' : 'figures：这篇没有裁出图，给空数组。',
    src.digest ? '只依据上面的笔记；笔记里没有的不要编造，不确定就写进 doubts。' : '只依据正文；正文里没有的不要编造，不确定就写进 doubts。',
  ].filter((x) => x !== '').join('\n');
}

module.exports = { QUICK_SCHEMA, DEEP_SCHEMA, quickPrompt, deepPrompt };
