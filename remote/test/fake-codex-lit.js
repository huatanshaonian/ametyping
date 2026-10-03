// A stand-in for `codex exec` in the literature tests: answers by the shape of the schema it is given (profile, ranking,
// review questions, quick / deep card, feedback, chat, distill, topic, related work) and logs the prompt (FAKE_CODEX_LOG).
// The daily report's and the mail's questions (the server runs those too) get minimal answers.
const fs = require('fs');
const args = process.argv.slice(2);
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
const out = args[args.indexOf('-o') + 1];
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ kind: Object.keys(schema.properties || {}).join(','), prompt }) + '\n');
  const P = schema.properties || {};
  let a;
  if (P.seeds) {
    const key = (/^- \[([A-Z0-9]{8})\]/m.exec(prompt) || [])[1] || '';
    a = { summary: '再入飞行器等离子体鞘套的电磁散射与 RCS 建模', topics: [{ name: '等离子体鞘套', keywords: ['plasma sheath', 'reentry', 'electron density'] }],
      questions: [{ text: '鞘套电子密度剖面在 RCS 计算里怎么取', why: '最近的日报' }, { text: 'RCS 计算结果拿什么验证', why: '批注' }],
      venues: ['IEEE Transactions on Antennas and Propagation', 'AIAA Journal'], authors: ['Sun, Wei'], keywords: ['plasma sheath RCS'], arxiv: ['physics.plasm-ph'], ntrs: ['reentry plasma attenuation'], seeds: key ? [key] : [] };
  } else if (P.items && schema.properties.items.items && schema.properties.items.items.properties.score) {
    const refs = [...prompt.matchAll(/^### (C\d+)\n题目：(.*)$/gm)];
    a = { items: refs.map((m) => /plasma|sheath/i.test(m[2]) ? { ref: m[1], score: /blackout/i.test(m[2]) ? 9 : 8, question: 1, why: '给出了鞘套电子密度的实测剖面，可作为 RCS 计算输入', fun: false }
      : { ref: m[1], score: 2, question: 0, why: '无关', fun: false }) };
  } else if (P.recall) a = { why: '和你的问题 Q1 有关，很久没回顾了', recall: ['它用的电子密度模型是什么？', '主要结论里的衰减量是多少？'] };
  else if (P.getPdf) {
    const none = /（没有正文，只能依据摘要）/.test(prompt);
    a = { oneLine: '测量了再入鞘套的电子密度并给出 RCS 变化', problem: '鞘套对雷达散射的影响', method: 'FDTD + 实测剖面', results: none ? ['RCS 下降约 10 dB'] : ['RCS 下降约 10 dB [p.1]'],
      relevance: '可作为你 RCS 计算的输入', question: 1, worth: '值得深读第 3 节', getPdf: none ? { worth: true, why: '需要正文里的剖面数据' } : { worth: false, why: '' } };
  } else if (P.actions) {
    const other = (/^- (\w+)：/m.exec(prompt.split('用户已有的卡片：')[1] || '') || [])[1];
    a = { oneLine: '深读：鞘套剖面与 RCS', problem: '问题', method: '方法 $n_e(z)$', assumptions: ['假设碰撞频率恒定'], results: ['结果一 [p.1]', '结果二 [p.2]'], relevance: '直接相关', question: 1,
      actions: ['用第 2 页的剖面重算 X 波段 RCS'], reusable: ['式 (3) 的碰撞频率模型 [p.2]'], doubts: ['推导跳步'], follow: ['Smith 1990：原始数据'], history: '',
      relations: other ? [{ citekey: other, type: '对比', note: '方法不同' }] : [] };
  } else if (P.missed) a = { feedback: '你抓住了主线，但漏了假设的适用条件 [p.1]', missed: ['碰撞频率的取值'], askBack: '这个假设在 60 km 以下还成立吗？' };
  else if (P.askBack) a = { answer: '原文第 1 页给出了剖面 [p.1]。（背景知识）通常用指数分布。', askBack: '你的工况和它一样吗？' };
  else if (P.ops) a = { ops: [{ section: '疑点', text: '- 对话发现：碰撞频率取常数在低空不成立 [p.1]', reason: '第 1 轮' }, { section: '不存在的小节', text: '- 归到我的笔记', reason: '第 1 轮' }] };
  else if (P.gaps) { const k = (/^### \[\[([^\]]+)\]\]/m.exec(prompt) || [])[1] || 'x'; a = { overview: `主线综述 [[${k}]]`, evidence: [`证据 [[${k}]]`], disagreements: [], gaps: ['低空碰撞频率没人测过'] }; }
  else if (P.paragraph) { const k = (/^### (\S+)：/m.exec(prompt) || [])[1] || 'x'; a = { paragraph: `已有研究 \\cite{${k}} 测量了鞘套剖面。`, used: [k] }; }
  else if (P.terms) a = { terms: ['x'] };
  else if (P.answer) a = { answer: '没找到', sources: [] };
  else if (P.headline) a = { headline: '', projects: [], open: [], plans: [], keywords: [], todos: [], artifacts: [], notes: [] };
  else if (P.items) a = { items: [] };
  else a = {};
  fs.writeFileSync(out, JSON.stringify(a));
});
