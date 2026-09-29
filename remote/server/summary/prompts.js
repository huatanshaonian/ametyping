// What the model is asked, and the JSON it must answer with (codex exec --output-schema: strict, so every object
// lists all its properties as required and allows no others).
'use strict';
const { CATS, NAMES } = require('./classify');

const str = { type: 'string' }, strs = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });
const cat = { type: 'string', enum: CATS };

const DAY_SCHEMA = obj({
  headline: str,
  projects: { type: 'array', items: obj({ name: str, category: cat, summary: str, done: strs, decisions: strs, unfinished: strs, sessions: strs }) },
  open: { type: 'array', items: obj({ ref: str, text: str, project: str, status: { type: 'string', enum: ['open', 'done', 'dropped'] } }) },
  plans: { type: 'array', items: obj({ title: str, project: str, session: str }) },
  keywords: strs,
});
const SESSION_SCHEMA = obj({ summary: str, category: cat, done: strs, decisions: strs, unfinished: strs });

const CAT_HELP = `分类（category）：research=${NAMES.research}（仿真、电磁计算、论文、数据处理等学术工作）；personal=${NAMES.personal}（自己做的软件、工具、网站、小玩意儿）；chore=${NAMES.chore}（配置环境/代理、装软件、一次性小问题、简单问答，不是在推进某个项目）。`;

const fmtTime = (t) => { const d = new Date(t); return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// a long session first becomes a short summary of its own
function sessionPrompt(d, hint) {
  return [
    '下面是用户和 AI 编程助手（Claude Code 或 Codex）的一段会话摘录（工具输出已省略，助手的长回复已截短）。',
    '请总结这段会话，给用户本人回顾用。用简体中文，简洁具体，不要客套，不要编造摘录里没有的内容。',
    'summary：两三句话说清楚在做什么、结果如何；done：做成了什么（写结果，不写过程）；decisions：重要的决定和原因；unfinished：提到了但没做完、推迟或打算以后做的事。',
    CAT_HELP + (hint.cat ? ` 分类提示：${NAMES[hint.cat]}（${hint.why}），以内容为准。` : ''),
    '',
    `会话：${d.title || d.project || d.id}；电脑：${d.machine}；目录：${d.cwd || '未知'}`,
    '',
    d.text,
  ].join('\n');
}

// the day: sessions (condensed transcript, or their own summary when long) + what was still open before
function dayPrompt({ from, to, sessions, open }) {
  const parts = [
    `下面是用户在 ${fmtTime(from)} 到 ${fmtTime(to)} 之间和 AI 编程助手（Claude Code / Codex）的全部会话摘录，以及之前记下的未完成事项。请写一份给用户自己看的工作日报。`,
    '要求：',
    '- 按项目归类：同一个项目可能分散在多个会话、多台电脑，合并成一项；name 用简短好认的项目名。sessions 列出属于它的会话编号（如 S1）。',
    '- ' + CAT_HELP + ' 参考每个会话的「分类提示」，但以内容为准。杂活（chore）只写一句 summary，done / decisions / unfinished 留空。',
    '- done 写做成了什么（具体结果，不写过程）；decisions 写重要决定及原因；unfinished 写这次提到但没做完、推迟、打算以后做的事。',
    '- open 是滚动的「计划了但还没做」清单：之前的每一条都要返回（ref 填它的编号如 O1，若这次已完成 status=done，明确放弃 status=dropped，否则 open，text 可按新情况改写）；再加入这次新产生的未完成事项（ref 填空字符串）。每条写成一句可执行的话，不要重复。杂活里的小事不必进清单。',
    '- plans：这次新写的计划（摘录里「写了计划」），给出标题、项目、会话编号。',
    '- headline：一句话概括这段时间做了什么（不超过 40 字）。keywords：10～20 个方便以后搜索的关键词（项目名、文件名、技术名词，中英文都可以）。',
    '- 用简体中文，简洁，不要客套；不要编造摘录里没有的内容。',
    '',
  ];
  if (open.length) {
    parts.push('## 之前的未完成事项');
    open.forEach((o, i) => parts.push(`O${i + 1}. [${o.project || '未分类'}] ${o.text}（${o.since} 记下）`));
    parts.push('');
  }
  parts.push('## 会话');
  for (const s of sessions) {
    const d = s.digest;
    parts.push('', `### ${s.key} · ${d.title || d.project || '未命名'} · 电脑 ${d.machine} · 目录 ${d.cwd || '未知'} · 用时约 ${d.activeMin} 分钟${s.hint.cat ? ` · 分类提示：${NAMES[s.hint.cat]}（${s.hint.why}）` : ''}`);
    if (d.files.length) parts.push('改动的文件：' + d.files.slice(0, 20).map((f) => f.path).join('、') + (d.files.length > 20 ? ` 等 ${d.files.length} 个` : ''));
    if (s.summary) {
      const m = s.summary;
      parts.push(`（会话较长，以下是它的摘要）${m.summary}`);
      if (m.done.length) parts.push('做成：' + m.done.join('；'));
      if (m.decisions.length) parts.push('决定：' + m.decisions.join('；'));
      if (m.unfinished.length) parts.push('未完成：' + m.unfinished.join('；'));
      if (d.plans.length) parts.push('写了计划：' + d.plans.map((p) => `「${p.title}」`).join('、'));
    } else parts.push(d.text);
  }
  return parts.join('\n');
}

module.exports = { DAY_SCHEMA, SESSION_SCHEMA, sessionPrompt, dayPrompt };
