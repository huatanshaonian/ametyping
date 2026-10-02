// What the model is asked about a batch of new mail, the JSON it answers with (codex --output-schema: strict), and the
// research interests it judges recommended papers by: inferred from the daily reports' research projects and keywords,
// plus what the user wrote in 邮箱设置.
'use strict';

const str = { type: 'string' };
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });
const KINDS = ['action', 'notice', 'reading', 'other'];

const TRIAGE_SCHEMA = obj({
  items: { type: 'array', items: obj({
    ref: str, kind: { type: 'string', enum: KINDS }, important: { type: 'boolean' }, summary: str, todo: str,
    deadline: str, deadlineText: str,
    picks: { type: 'array', items: obj({ title: str, url: str, why: str, fun: { type: 'boolean' } }) },
  }) },
});

const pad = (n) => String(n).padStart(2, '0');
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const PER_MAIL = 6000;                               // characters of each message's text given to the model

// the research interests: the daily reports' research projects (most recent first) and their keywords, and the user's own words
function interestsOf(reports, extra) {
  const names = new Map(), words = new Map();
  for (const it of reports ? reports.list().slice(0, 60) : []) {
    const r = reports.get(it.date);
    if (!r) continue;
    for (const p of r.projects || []) if (p.category === 'research') names.set(p.name, (names.get(p.name) || 0) + 1);
    for (const k of r.keywords || []) words.set(k, (words.get(k) || 0) + 1);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]);
  return { projects: top(names, 12), keywords: top(words, 30), extra: String(extra || '').trim().slice(0, 1000) };
}

// mails: [{ ref, from, to, cc, toMe, date, subject, text }]
function triagePrompt(mails, interests, today = Date.now()) {
  const parts = [
    `用户是中国科学院的研究生 / 科研人员。他的两个单位邮箱平时主要收到单位的群发通知，以及院刊、ResearchGate、期刊的推送，很少有人单独给他写信。他不想错过要他本人去做的事，也愿意看看有意思的文献。今天是 ${ymd(today)}。`,
    '请逐封判断下面的新邮件：',
    '- kind：action = 需要他本人去做某事（报名、提交材料、填表、报销、缴费、确认、参加会议或考试、按时完成某事等）；notice = 只是告知，但可能影响到他（停电停水停网、放假调休、楼宇或系统变动、政策规定、讲座报告等）；reading = 院刊、期刊、ResearchGate、学术平台的推送或文献推荐；other = 广告、系统自动邮件、与他无关的事。',
    '- important：action 只要可能和一个研究生 / 科研人员有关就为 true（宁可多提醒，不要漏）；notice 只有会实际影响他的才为 true；reading 和 other 一律 false。',
    '- summary：一句话说清楚这封信是什么（不超过 40 字）。',
    '- todo：kind 为 action 时，写他要做的事，一句可执行的话（例如「10 月 15 日前在 ARP 系统提交报销单」）；否则为空字符串。',
    '- deadline：仔细看正文里出现的截止或关键日期（报名截止、提交截止、会议 / 考试时间、生效日期等），换算成 YYYY-MM-DD：只有月日的按邮件日期推断年份；「下周五」「三天内」这类按邮件日期推算；有多个日期取他最需要赶的那个。没有就为空字符串。deadlineText：正文里给出这个日期的那句原话（没有就为空）。',
    '- picks：只对 reading：从邮件里挑值得他看的文章，和研究方向相关的最多 3 篇；另外如果有特别有意思的（不必和方向对口）可以再加 1～2 篇，fun 设为 true。每篇写 title、url（邮件里给出的这篇文章的链接，没有就空字符串）、why（一句话推荐理由）。没有值得看的就返回空数组。其他 kind 返回空数组。',
    '- ref 只填编号本身，如 M1。用简体中文；不要编造邮件里没有的内容。',
    '',
    '## 他的研究方向（从他的工作日报推断，加上他自己写的补充）',
    interests.projects.length ? '科研项目：' + interests.projects.join('、') : '科研项目：（暂无记录）',
    interests.keywords.length ? '常见关键词：' + interests.keywords.join('、') : '',
    interests.extra ? '他自己写的：' + interests.extra : '',
    '',
    '## 新邮件',
  ];
  for (const m of mails) {
    const text = m.text.length > PER_MAIL ? m.text.slice(0, PER_MAIL) + '\n……（后面省略）' : m.text;
    parts.push('', `### ${m.ref} · ${ymd(m.date)} · 发件人：${m.from}${m.toMe ? ' · 直接发给他' : ''}`,
      `收件人：${m.to || '（无）'}${m.cc ? '；抄送：' + m.cc : ''}`, `主题：${m.subject || '（无主题）'}`, '', text || '（没有正文）');
  }
  return parts.filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
}

module.exports = { TRIAGE_SCHEMA, KINDS, triagePrompt, interestsOf, ymd };
