// 周报: Monday..Sunday written from that week's daily reports (not from the conversations again -- a short prompt).
// Numbers are counted here: minutes per kind of work, days with work, sessions, chores, artifacts; what is still
// open at the week's end is the last day's list. The model merges each project's progress over the days and picks
// what the week was about.
'use strict';
const { CATS, NAMES } = require('./classify');

const str = { type: 'string' }, strs = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });
const WEEK_SCHEMA = obj({
  headline: str,
  projects: { type: 'array', items: obj({ name: str, category: { type: 'string', enum: CATS }, summary: str, progress: strs }) },
  highlights: strs,
});

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const WEEK = '日一二三四五六';
// the 7 dates of the week starting on Monday `start`
const datesOf = (start) => Array.from({ length: 7 }, (_, i) => { const d = new Date(start + 'T12:00:00'); d.setDate(d.getDate() + i); return dayOf(d); });
// the Monday of the week `date` is in
function mondayOf(date) { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayOf(d); }

// todos (server/todos.js, optional): the important items still open when the week is written
function createWeekly({ reports, ask, todos = null, log = () => {} }) {
  function weekPrompt(start, dailies) {
    const parts = [
      `下面是用户 ${start} 这一周每天的工作日报（由 AI 根据他和编程助手的对话写成）。请写一份给他自己看的周报。`,
      '要求：',
      `- projects：把同一个项目在几天里的进展合并成一项（名字相近的算同一个）；只写 research（${NAMES.research}）和 personal（${NAMES.personal}），杂活不要列。`,
      '  summary 一两句说这周这个项目推进到哪了；progress 按时间顺序写 2～5 条关键进展（写结果，不写过程）。',
      '- highlights：这一周最值得记住的 1～3 件事（做成的大事、重要的决定）。',
      '- headline：一句话概括这一周（不超过 40 字）。',
      '- 用简体中文，简洁，不要客套；不要编造日报里没有的内容。', '',
    ];
    for (const r of dailies) {
      const d = new Date(r.date + 'T12:00:00');
      parts.push(`## ${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}${r.brief ? '（补录的简略日报）' : ''}：${r.headline || ''}`);
      for (const p of r.projects || []) {
        if (p.category === 'chore') continue;
        parts.push(`- [${NAMES[p.category] || p.category}] ${p.name}（${p.minutes || 0} 分钟）：${p.summary || ''}` +
          `${(p.done || []).length ? '；做成：' + p.done.join('；') : ''}${(p.decisions || []).length ? '；决定：' + p.decisions.join('；') : ''}` +
          `${(p.unfinished || []).length ? '；没做完：' + p.unfinished.join('；') : ''}`);
      }
      const chores = (r.projects || []).filter((p) => p.category === 'chore');
      if (chores.length) parts.push(`- 杂活 ${chores.length} 件：${chores.map((p) => p.name).join('、')}`);
    }
    return parts.join('\n');
  }

  // the weekly report of the week starting on Monday `start` (null when that week has no daily report)
  async function generateWeek(start) {
    const dates = datesOf(start);
    const dailies = dates.map((d) => reports.get(d)).filter(Boolean);
    if (!dailies.length) return null;
    const byCat = Object.fromEntries(CATS.map((c) => [c, 0]));
    let chores = 0;
    for (const r of dailies) for (const p of r.projects || []) { if (CATS.includes(p.category)) byCat[p.category] += p.minutes || 0; if (p.category === 'chore') chores++; }
    const artifacts = dailies.flatMap((r) => (r.artifacts || []).map((a) => ({ date: r.date, machine: a.machine, path: a.path, note: a.note, sha: a.backed ? a.sha : '' })));
    const last = [...dailies].reverse().find((r) => !r.brief) || dailies[dailies.length - 1];
    const ans = await ask(weekPrompt(start, dailies), WEEK_SCHEMA, 'weekly');
    const w = {
      start, end: dates[6], generatedAt: Date.now(), headline: ans.headline || '',
      projects: (ans.projects || []).filter((p) => p.category !== 'chore'), highlights: ans.highlights || [],
      days: dailies.map((r) => ({ date: r.date, headline: r.headline || '', minutes: r.stats ? r.stats.minutes : 0, brief: !!r.brief })),
      open: todos ? todos.open().map((t) => ({ text: t.text, project: t.project, due: t.due })) : (last.open || []).filter((o) => o.status === 'open'),
      todosDone: dailies.flatMap((r) => (r.todosDone || []).map((t) => ({ ...t, date: r.date }))),
      artifacts: artifacts.slice(0, 40),
      stats: { minutes: dailies.reduce((n, r) => n + (r.stats ? r.stats.minutes : 0), 0), byCat, chores, days: dailies.filter((r) => r.stats && r.stats.sessions).length,
        sessions: dailies.reduce((n, r) => n + (r.stats ? r.stats.sessions : 0), 0), artifacts: artifacts.length },
    };
    reports.saveWeek(w);
    log(`周报 ${start} ~ ${w.end} 已生成：${dailies.length} 份日报`);
    return w;
  }

  // the most recent finished week (its Sunday has a daily report) that has no weekly report yet
  function pendingWeek() {
    const sundays = reports.list().map((x) => x.date).filter((d) => new Date(d + 'T12:00:00').getDay() === 0);
    const s = sundays[0];
    return s && !reports.hasWeek(mondayOf(s)) ? mondayOf(s) : null;
  }
  return { generateWeek, pendingWeek, mondayOf, datesOf };
}

module.exports = { createWeekly, WEEK_SCHEMA, mondayOf };
