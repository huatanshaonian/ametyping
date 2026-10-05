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
  // (the page images: real PNG files?)
  const images = args.filter((a) => a.startsWith('--image=')).map((a) => a.slice('--image='.length));
  const png = images.every((f) => { try { return fs.readFileSync(f).subarray(0, 8).toString('hex') === '89504e470d0a1a0a'; } catch { return false; } });
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ kind: Object.keys(schema.properties || {}).join(','), prompt, images: images.length, png }) + '\n');
  const P = schema.properties || {};
  let a;
  if (P.pages && P.pages.items && P.pages.items.properties && P.pages.items.properties.md) {
    // 读图: one transcription per page asked for (page 2 has a symbol it could not make out)
    const nos = ((/PDF 的第 ([\d、]+) 页/.exec(prompt) || [])[1] || '').split('、').map(Number).filter(Boolean);
    a = { pages: png && images.length === nos.length ? nos.map((p) => ({ page: p, md: `读图第 ${p} 页：$n_e(z)=n_0 e^{-z/H}$ \\tag{${p}}` + (p === 2 ? ' 碰撞频率 $\\nu_{[?]}$' : '') })) : [] };
  } else if (P.items && schema.properties.items.items && schema.properties.items.items.properties.folder) {
    // 调研工作: a folder for each paper of the batch
    a = { items: [...prompt.matchAll(/^(P\d+)：(.*)$/gm)].map((m) => ({ ref: m[1], folder: /wake/i.test(m[2]) ? '高超声速尾迹' : '等离子体鞘套' })) };
  } else if (P.progress && P.changes) {
    // 回顾: progress on every question, changes of each kind (one of a kind that does not exist), a new line for a quarter
    const qs = [...prompt.matchAll(/^(Q\d+)【/gm)].map((m) => m[1]), quarter = /季度研究回顾/.test(prompt);
    a = { summary: '这段时间主要在算鞘套的 RCS，离验证还差实测数据。',
      progress: qs.map((q, i) => ({ q, state: i === 0 ? '有进展' : '未开始', note: i === 0 ? '剖面已经能取了' : '没有记录', evidence: i === 0 ? '读了《RAM C》的卡片' : '' })),
      changes: quarter ? [{ type: '新增', q: [], text: '尾迹对 RCS 的贡献有多大', dim: '领域前沿', children: [], reason: '近一年的文献在关注尾迹', evidence: '检索结果', refs: [] }]
        : [{ type: '细化', q: ['Q1'], text: '鞘套电子密度剖面取 RAM C 实测还是 CFD 结果', dim: '', children: [], reason: '已经有两种来源了', evidence: '速读卡', refs: [] },
          { type: '分叉', q: ['Q2'], text: '', dim: '', children: [{ text: '用飞行试验数据验证', dim: '方法与验证' }, { text: '用解析解验证', dim: '方法与验证' }], reason: '两条路可以分别走', evidence: '日报', refs: [] },
          { type: '搁置', q: ['Q3'], text: '', dim: '', children: [], reason: '这段时间没碰', evidence: '', refs: [] },
          { type: '新增', q: [], text: '碰撞频率在低空怎么取', dim: '文献空白', children: [], reason: '对话里发现的', evidence: '沉淀', refs: [] },
          { type: '乱写', q: ['Q1'], text: 'x', dim: '', children: [], reason: '', evidence: '', refs: [] }, { type: '修改', q: ['Q99'], text: '不存在的问题', dim: '', children: [], reason: '', evidence: '', refs: [] }],
      line: quarter ? { change: true, text: '总目标（调整后）：鞘套与尾迹的电磁散射', reason: '重心移到了尾迹' } : { change: true, text: '月度不该改主线', reason: 'x' },
      next: ['用 RAM C 的剖面重算一次 RCS（对应 Q1）'] };
  } else if (P.folder) {
    // 收下: the folder under 每日文献 (an existing one when the list has it)
    const want = /plasma|sheath/i.test((/^文献：(.*)$/m.exec(prompt) || [])[1] || '') ? '等离子体鞘套' : '其他';
    a = { folder: want, why: prompt.includes(`- ${want}（`) ? '已有这个文件夹' : '新主题' };
  } else if (P.queries) {
    // 梳理, step 1: a first line from the account, what to search, the words for the library
    const story = (/## 研究自述\n([\s\S]*?)\n\n## /.exec(prompt) || [])[1] || '';
    a = { line: '初稿：' + story.slice(0, 20), queries: ['plasma sheath electron density', 'reentry communication blackout'], libWords: ['plasma', '鞘套', 'radar cross section'] };
  } else if (P.unclear) {
    // 梳理, step 2: the line again and the questions in dimensions, grounded in the library (L) and new papers (N)
    const story = (/## 研究自述\n([\s\S]*?)\n\n## /.exec(prompt) || [])[1] || '';
    a = { line: '总目标：' + story.slice(0, 20) + '\n1. 等离子体鞘套电磁散射\n2. RCS 高频方法与验证',
      questions: [
        { dim: '贴合工作', text: '鞘套电子密度剖面在 RCS 计算里怎么取', why: '自述里说卡在剖面', state: '[N1] 测了黑障时的剖面，[L1] 用流场算过后向散射', refs: ['L1', 'N1'] },
        { dim: '方法与验证', text: 'RCS 计算结果拿什么验证', why: '自述里提到没有实测数据', state: '公开的飞行试验数据很少', refs: ['N2', 'X9'] },
        { dim: '领域前沿', text: '近几年的鞘套剖面测量能否给出可用的输入', why: '新文献', state: '见 [N2]', refs: ['N2', 'N3'] }],
      unclear: ['气动隐身协同优化是你自己做，还是合作方做？'] };
  } else if (P.seeds) {
    // 按主线补全: the branches (one the library covers, one it hardly does), a suggestion, what to follow
    const key = (/^- \[([A-Z0-9]{8})\]/m.exec(prompt) || [])[1] || '';
    a = { branches: [{ name: '等离子体鞘套电磁散射', desc: `库里有代表作 [${key}]，讲到了后向散射`, coverage: '充足', keywords: ['plasma sheath', 'reentry', 'electron density'], papers: key ? [key, 'NOTAKEY1'] : [] },
        { name: '气动隐身协同优化', desc: '库里几乎没有', coverage: '较少', keywords: ['aerodynamic stealth design'], papers: [] }],
      suggestQuestions: [{ text: '有没有可以对比的飞行试验数据', why: '主线里提到验证' }, { text: 'RCS 计算结果拿什么验证', why: '（和用户已写的重复，应被去掉）' }],
      venues: ['IEEE Transactions on Antennas and Propagation', 'AIAA Journal'], extraVenues: ['Radio Science'], authors: ['Sun, Wei'],
      keywords: ['"plasma sheath" RCS', 'communication blackout', 'electron density profile', 'hypersonic wake', 'plasma FDTD'], arxiv: ['physics.plasm-ph'], ntrs: ['reentry plasma attenuation'], seeds: key ? [key] : [] };
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
      relations: other ? [{ citekey: other, type: '对比', note: '方法不同' }] : [],
      vision: /vision：这篇有 \d+ 页/.test(prompt) ? { worth: true, pages: '2', why: '第 2 页有碰撞频率的推导' } : { worth: false, pages: '', why: '' } };
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
