// A stand-in for `codex exec` in the summary tests: logs its arguments and prompt (FAKE_CODEX_LOG), answers with JSON
// shaped by the schema it was given (a day report or a session summary), or fails (FAKE_CODEX_FAIL).
const fs = require('fs');
const args = process.argv.slice(2);
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
const out = args[args.indexOf('-o') + 1];
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt, proxy: process.env.HTTPS_PROXY || '' }) + '\n');
  if (process.env.FAKE_CODEX_FAIL) { process.stderr.write('ERROR: stream disconnected\n'); process.exit(1); }
  let answer;
  if (schema.properties.items && /新邮件/.test(prompt)) {
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
  fs.writeFileSync(out, JSON.stringify(answer));
});
