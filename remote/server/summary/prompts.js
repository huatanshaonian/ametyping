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
  todos: { type: 'array', items: obj({ ref: str, done: { type: 'boolean' }, evidence: str }) },
  plans: { type: 'array', items: obj({ title: str, project: str, session: str }) },
  keywords: strs,
  artifacts: { type: 'array', items: obj({ ref: str, note: str }) },
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

// the day: sessions (condensed transcript, or their own summary when long) + the important items still open
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

const hm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function dayPrompt({ from, to, sessions, todos = [], artifacts = [], events = [], brief = false }) {
  const parts = [
    ...(brief ? ['（这是补录的旧日报：写得简略些——每个项目 summary 一两句，done 最多 3 条，decisions 只写真正重要的；open 只列这一天新产生的未完成事项；产出物的说明照常写。）'] : []),
    `下面是用户在 ${fmtTime(from)} 到 ${fmtTime(to)} 之间和 AI 编程助手（Claude Code / Codex）的全部会话摘录${todos.length ? '，以及用户标记为重要、还没完成的计划' : ''}。请写一份给用户自己看的工作日报。`,
    '要求：',
    '- 按项目归类：同一个项目可能分散在多个会话、多台电脑，合并成一项；name 用简短好认的项目名。sessions 列出属于它的会话编号（如 S1）。',
    '- ' + CAT_HELP + ' 参考每个会话的「分类提示」，但以内容为准。杂活（chore）只写一句 summary，done / decisions / unfinished 留空。',
    '- done 写做成了什么（具体结果，不写过程）；decisions 写重要决定及原因；unfinished 写这次提到但没做完、推迟、打算以后做的事。',
    '- open：这段时间新产生的未完成事项（提到了但没做完、推迟、打算以后做的），每条写成一句可执行的话，ref 填空字符串、status 填 open，不要重复；杂活里的小事不必列。' + (todos.length ? '「重要计划」里已有的不要再放进 open。' : ''),
    todos.length ? '- todos：逐条检查「重要计划」：这段时间的会话里明确做完了，done=true，evidence 写一句依据（在哪个会话做了什么）；没做、只做了一部分或看不出来，done=false、evidence 空。宁可不判完成，也不要误判。ref 只填编号如 T1。' : '- todos：返回空数组。',
    '- plans：只列摘录里明确出现「写了计划」的计划（标题、项目、会话编号），没有就返回空数组，不要把未完成事项当成计划。',
    '- 会话编号（sessions、plans 的 session）只填 S1 这样的编号本身。',
    '- artifacts：给「产出物」里的每个文件写一句用途说明（note，不超过 30 字，例如「画 RCS 对比图的脚本」），ref 填编号如 A1；看不出用途就写空字符串。没有产出物就返回空数组。',
    '- headline：一句话概括这段时间做了什么（不超过 40 字）。keywords：10～20 个方便以后搜索的关键词（项目名、文件名、技术名词，中英文都可以）。',
    ...(events.length ? ['- 「日程」来自用户的 Google 日历，只作背景：和某个项目相关的（会议、汇报、截止等）可以在那个项目的 summary 里顺带提到；没有会话记录对应的日程不要编造工作内容，也不要为日程单独列项目。'] : []),
    '- 用简体中文，简洁，不要客套；不要编造摘录里没有的内容。',
    '',
  ];
  if (events.length) {
    parts.push('## 日程（Google 日历）');
    for (const e of events.slice(0, 30)) parts.push(`- ${e.allDay ? '全天' : `${fmtTime(e.start)}–${hm(e.end)}`} ${e.title}${e.location ? '（' + e.location + '）' : ''}`);
    parts.push('');
  }
  if (todos.length) {
    parts.push('## 重要计划（用户标记为重要、还没完成的事）');
    todos.forEach((t) => parts.push(`${t.ref}. [${t.project || '未分类'}] ${t.text}（${new Date(t.created).getMonth() + 1}月${new Date(t.created).getDate()}日记下${t.due ? '，' + t.due.slice(5) + ' 截止' : ''}）`));
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
  if (artifacts.length) {
    parts.push('', '## 产出物（写在 Git 仓库之外、或还没提交的文件）');
    for (const a of artifacts) parts.push(`${a.ref}. ${a.path}（电脑 ${a.machine}，${a.sessions.join('、')}，${a.op === 'write' ? '新写' : '修改'}${a.size ? '，' + kb(a.size) : ''}）`);
  }
  return parts.join('\n');
}

module.exports = { DAY_SCHEMA, SESSION_SCHEMA, sessionPrompt, dayPrompt };
