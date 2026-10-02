// 「让 GPT 起草」: what the model is asked to write a mail from your points (and, for a reply / forward, the mail it is
// about), and the JSON it answers with. It drafts only -- the text goes into the editor for you to change and send.
'use strict';

const str = { type: 'string' };
const DRAFT_SCHEMA = { type: 'object', additionalProperties: false, properties: { subject: str, text: str }, required: ['subject', 'text'] };
const TONES = { formal: '正式、礼貌（写给老师、领导、部门或外单位）', brief: '简洁、直接（写给熟悉的同事、同学）', casual: '轻松、随和' };
const ORIG_MAX = 6000;

// d: { mode, points, tone, subject, text (what is written so far), to, orig: { from, date, subject, text } | null, me: { name, address } }
function draftPrompt(d) {
  const o = d.orig;
  const parts = [
    `请帮用户写一封邮件的正文。他是中国科学院的研究生 / 科研人员，发件邮箱 ${d.me.address}${d.me.name ? '（' + d.me.name + '）' : ''}。`,
    `- 这封信是：${{ new: '一封新邮件', reply: '对下面这封邮件的回复', all: '对下面这封邮件的回复（回复全部）', forward: '把下面这封邮件转发出去，附上几句说明' }[d.mode] || '一封新邮件'}。`,
    d.to ? `- 收件人：${d.to}` : '',
    `- 语气：${TONES[d.tone] || TONES.formal}。`,
    `- 他想说的要点：${d.points || '（没写要点：根据原邮件写一封合适的回复）'}`,
    d.text && d.text.trim() ? `- 他已经写了一部分，可以在此基础上改写：\n${d.text.trim().slice(0, 3000)}` : '',
    '- 要求：语言跟原邮件一致（原邮件是英文就用英文，否则用简体中文）；称呼和结尾按收件人与语气写好；不要编造他没说的事实、日期、数字，需要他补充的地方用【】标出，例如【具体时间】；不要写签名（会自动加上）；不要把原邮件抄进正文（回复时原文会自动附在后面）。',
    '- subject：邮件主题。回复 / 转发时沿用原主题（已带 Re: / Fwd: 的保持原样），新邮件按要点拟一个简短主题。text：正文，纯文本。',
  ];
  if (o) {
    const t = String(o.text || '');
    parts.push('', `## 原邮件`, `发件人：${o.from}`, `时间：${o.date}`, `主题：${o.subject || '（无主题）'}`, '', t.length > ORIG_MAX ? t.slice(0, ORIG_MAX) + '\n……（后面省略）' : t);
  } else if (d.subject) parts.push('', `（他已经填的主题：${d.subject}）`);
  return parts.filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
}

module.exports = { DRAFT_SCHEMA, TONES, draftPrompt };
