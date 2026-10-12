// The answers the fake models give (fake-codex.js, fake-claude.js): JSON shaped by the schema they were given -- a day
// report, a session summary, the mail triage, a draft, 问一问's answer.
'use strict';
function answerFor(schema, prompt) {
  let answer;
  if (schema.properties.subject && schema.properties.text && !schema.properties.headline) {
    // 「让 AI 起草」: a reply keeps the original subject; the points go into the text
    const orig = (/^主题：(.*)$/m.exec(prompt) || [])[1] || '';
    const points = (/^- 他想说的要点：(.*)$/m.exec(prompt) || [])[1] || '';
    answer = { subject: orig ? 'Re: ' + orig : '关于论文的事', text: `老师您好：\n\n${points}\n\n此致\n敬礼` };
  } else if (schema.properties.items && /新邮件/.test(prompt)) {
    // the mail triage: by the subject -- 报销 / 提交 / 报名: something to do (the date in the text is the deadline);
    // 院刊 / ResearchGate: papers (the numbered lines with a link); anything else: nothing
    const parts = prompt.split(/^### /m).slice(1);
    answer = { items: parts.map((p) => {
      const ref = p.split(' ')[0], subject = (/^主题：(.*)$/m.exec(p) || [])[1] || '';
      const date = (/(\d{4}-\d{2}-\d{2}) ?前/.exec(p) || [])[1] || '';
      const none = { ref, kind: 'other', important: false, summary: '与你无关', todo: '', deadline: '', deadlineText: '', picks: [] };
      if (/报销|提交|报名/.test(subject)) return { ...none, kind: 'action', important: true, summary: subject.slice(0, 30), todo: '按通知' + subject.slice(0, 10), deadline: date, deadlineText: date ? `请于 ${date} 前完成` : '' };
      if (/院刊|ResearchGate/.test(subject)) {
        const picks = [...p.matchAll(/^\d+\. (.+?)：?(https?:\/\/\S+)?$/gm)].map((m, i) => ({ title: m[1], url: m[2] || '', why: '和 RCS 有关', fun: i > 0 }));
        return { ...none, kind: 'reading', summary: '期刊推送', picks };
      }
      return none;
    }) };
  } else if (schema.properties.markdown && schema.properties.unsure) {
    // 画板's 誊清: a title, a formula, a small flow chart (two boxes and an arrow with a word on it), a table, one doubt.
    // One item is of a kind that does not exist and one lies outside the page: both must not come through as they are.
    const it = (kind, x, y, x2, y2, text, more = {}) => ({ kind, x, y, x2, y2, text, size: 0, color: '', bold: false, dashed: false, ...more });
    answer = { title: '雷达方程  推导', items: [
      it('text', 60, 40, 420, 90, '雷达方程推导', { size: 44, bold: true }),
      it('text', 60, 120, 600, 190, '接收功率 $P_r$ 随距离\n的四次方衰减', { size: 28 }),
      it('math', 60, 220, 620, 320, 'P_r = \\frac{P_t G^2 \\lambda^2 \\sigma}{(4\\pi)^3 R^4}', { size: 40, color: '#d93025' }),
      it('rect', 80, 400, 300, 480, '发射 <机>', { size: 26 }),
      it('round', 520, 480, 300, 400, '目标 $\\sigma$'),
      it('arrow', 300, 440, 520, 440, '照射', { dashed: true }),
      it('table', 80, 540, 600, 660, '量|单位\n$P_t$|W\n$R$|m'),
      it('blob', 0, 0, 10, 10, '不认识的元素'),
      it('ellipse', 900, 900, 5000, 9000, ''),
    ], markdown: '# 雷达方程推导\n\n接收功率 $P_r$ 随距离的四次方衰减：\n\n$$P_r = \\frac{P_t G^2 \\lambda^2 \\sigma}{(4\\pi)^3 R^4}$$\n\n- 发射机 →（照射）→ 目标\n', unsure: ['分母里的指数看着像 3，也可能是 2'] };
  } else if (schema.properties.html && schema.properties.note) {
    // 画板's 设计稿: a page with a style, a formula between dollars, and things a page must not keep (a script, a
    // picture from the internet, a handler)
    const wish = (/^用户对这次设计的要求：(.*)$/m.exec(prompt) || [])[1] || '';
    answer = { note: '卡片式排版' + (wish ? '；按要求：' + wish : ''), html: '<!doctype html><html><head><title>x</title><style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0}.card{padding:24px;border-radius:12px;background:#1e293b}</style>' +
      '<script>window.parent.document.title="pwned"</script><link rel="stylesheet" href="https://example.com/a.css"></head><body><div class="card" onclick="alert(1)"><h1>雷达方程推导</h1>' +
      '<p>接收功率 $P_r$ 随距离的四次方衰减，价格 $5 和 $10 不是公式。</p><p>$$P_r = \\frac{P_t G^2 \\lambda^2 \\sigma}{(4\\pi)^3 R^4}$$</p><img src="https://example.com/t.png"><svg width="120" height="40"><rect width="120" height="40" fill="#38bdf8"/></svg></div></body></html>' };
  } else if (schema.properties.terms) answer = { terms: ['网格', 'mesh', '网格'] };
  else if (schema.properties.answer) answer = { answer: '加密网格的脚本是 mesh_refine.py [C1]。', sources: ['C1', '[R1]', 'R99'] };
  else if (schema.properties.headline) {
    const keys = [...new Set(prompt.match(/^### (S\d+)/gm) || [])].map((s) => s.slice(4));
    const open = [];
    open.push({ ref: '', text: '验证网格收敛', project: 'FDTD', status: 'open' });
    answer = {
      headline: '给 FDTD 加密了网格',
      projects: [{ name: 'FDTD 网格', category: 'research', summary: '在界面附近加密网格', done: ['网格数 400 → 460'], decisions: ['两侧各加 5 层'], unfinished: ['验证收敛'], sessions: keys.map((k, i) => (i ? k : k + '：/home/u/feko_data')) }],
      open, plans: keys.length ? [{ title: '网格加密计划', project: 'FDTD 网格', session: keys[0] + ' 那个会话' }] : [], keywords: ['FDTD', 'mesh.py'],
      todos: /^T1\. /m.test(prompt) ? [{ ref: 'T1（验证网格收敛）', done: true, evidence: '在 S1 里验证过了' }, { ref: 'T2', done: false, evidence: '' }] : [],
      artifacts: (prompt.match(/^A\d+\. /gm) || []).map((s) => ({ ref: s.slice(0, -2), note: '说明 ' + s.slice(0, -2) })),
      // one note per session (the first decorated, as the model sometimes does) and one for a session that is not there
      notes: [...keys.map((k, i) => ({ session: i ? k : k + '（网格）', did: '做了 ' + k, open: i ? [] : ['验证收敛'], status: i ? 'done' : 'ongoing', ideas: i ? [] : ['两侧各加 5 层更稳'] })),
        { session: 'S99', did: '不存在', open: [], status: 'done', ideas: [] }],
    };
  } else answer = { summary: '一段很长的会话', category: 'research', done: ['做了很多'], decisions: [], unfinished: [] };
  return answer;
}

module.exports = { answerFor };
