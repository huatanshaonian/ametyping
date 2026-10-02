// Documents in the search index (server/search-index/docs.js via summary/search-docs.js): daily reports, notes,
// artifacts, mail -- the same answers as the scan, kept in step with changes, mail found by its whole text, the same
// notice in two mailboxes once, an account removed, the index failing.
const fs = require('fs'), path = require('path'), os = require('os');
const idx = require('../server/search-index');
const { createSearch } = require('../server/summary/search');
const { createReports } = require('../server/summary/reports');
const { createNotes } = require('../server/notes');
const { createMailStore } = require('../server/mail/store');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x).slice(0, 500)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-sdocs-'));
  try {
    const D = path.join(T, 'data'); fs.mkdirSync(D);
    const reports = createReports(path.join(D, 'reports'));
    reports.save({ date: '2026-09-20', headline: '给 FDTD 加密了网格', keywords: ['mesh_refine.py'], projects: [{ name: 'FDTD 网格', summary: '界面附近加密', done: ['网格数 400 → 460'] }], open: [], plans: [], sessions: [{ key: 'S1', note: { did: '跑通了收敛曲线', open: [], ideas: ['两侧各加 5 层'] } }] });
    reports.save({ date: '2026-09-21', headline: '配置代理和群晖', projects: [{ name: 'Windose', summary: '看板搜索改用 SQLite' }], open: [{ text: '验证天线增益' }], plans: [] });
    const notes = createNotes({ dataDir: D });
    const n1 = notes.save({ text: '组会记录\n讨论了散射截面的计算方法 RCS' }).id;
    notes.save({ text: '买菜清单：鸡蛋 牛奶' });
    let arts = [{ machine: 'pc', path: 'D:/work/plot_rcs.py', note: '画 RCS 对比图的脚本', last: '2026-09-20', sha: 'a1', size: 10 },
      { machine: 'dell97', path: '/home/u/mesh_check.sh', note: '检查网格质量', last: '2026-09-21', sha: 'b2', size: 20 }];
    const artifacts = { list: () => arts };
    const ms = createMailStore({ dataDir: D });
    const longBody = '各位老师：\n' + '这是一段很长的正文。'.repeat(40) + '\n请于 2026-10-15 前提交报销单据，逾期不予受理。';
    const mailRec = (acc, uid, subject, text, date, extra = {}) => ({ key: `${acc}:1:${uid}`, acc, uid, mid: `<${acc}-${uid}@x>`, date: Date.parse(date), from: { name: '财务处', address: 'cw@example.edu.cn' }, to: [{ name: '我', address: 'me@example.edu.cn' }], subject, text, att: [{ name: '报销单模板.xlsx', size: 1 }], ...extra });
    ms.add(mailRec('a', 1, '关于年度报销的通知', longBody, '2026-09-25T09:00:00'));
    ms.add(mailRec('b', 7, '关于年度报销的通知', longBody, '2026-09-25T09:00:05', { mid: '<b-7@x>' }));   // the same notice, the other mailbox
    ms.add(mailRec('a', 2, 'ResearchGate 推荐', '新论文：Fast RCS computation with MLFMA', '2026-09-26T08:00:00', { from: { name: 'ResearchGate', address: 'no-reply@researchgate.net' }, att: [] }));
    const base = { storeDir: D, reports, notes, artifacts, sessions: () => ({}), mail: () => ms };
    const scan = createSearch(base);
    const index = idx.open({ dataDir: D });
    const viaIdx = createSearch({ ...base, index });
    const kinds = (r) => ({ reports: r.reports.map((x) => x.date).sort().join(), notes: r.notes.map((x) => x.title).sort().join(), artifacts: r.artifacts.map((x) => x.path).sort().join() });
    for (const q of ['网格', 'mesh_refine', 'RCS', '代理 群晖', '散射', '天线', '鸡蛋', '收敛曲线', '没有这个词', 'sqlite']) {
      const a = kinds(scan.search(q)), b = kinds(viaIdx.search(q));
      chk(`reports / notes / artifacts as the scan: "${q}"`, JSON.stringify(a) === JSON.stringify(b), { scan: a, index: b });
    }
    const r1 = viaIdx.search('收敛曲线');
    chk('a report found by its conversations\' notes, with the passage', r1.reports.length === 1 && r1.reports[0].date === '2026-09-20' && r1.reports[0].snippet.includes('收敛曲线') && r1.reports[0].headline === '给 FDTD 加密了网格', r1.reports);
    // mail: by its whole text (the scan only sees the start), the two copies once, attachments and sender searchable
    const m1 = viaIdx.search('逾期不予受理');
    chk('mail: found by text far into the body; the notice in two mailboxes is one result', m1.mail.length === 1 && m1.mail[0].subject === '关于年度报销的通知' && m1.mail[0].snippet.includes('逾期不予受理'), m1.mail);
    chk('mail: the scan (no index) only sees subject / sender / start', scan.search('逾期不予受理').mail.length === 0 && scan.search('报销').mail.length === 1, scan.search('报销').mail);
    chk('mail: by attachment name and by sender', viaIdx.search('报销单模板').mail.length === 1 && viaIdx.search('researchgate').mail.length === 1 && viaIdx.search('MLFMA').mail[0].from.name === 'ResearchGate', viaIdx.search('researchgate').mail);
    // in step with changes
    notes.save({ id: n1, text: '组会记录\n改成讨论天线阵列' }); await sleep(5);
    chk('note edited: the new text found, the old gone', viaIdx.search('天线阵列').notes.length === 1 && viaIdx.search('散射').notes.length === 0, [viaIdx.search('天线阵列').notes, viaIdx.search('散射').notes]);
    notes.remove(n1);
    chk('note removed: gone', viaIdx.search('天线阵列').notes.length === 0, viaIdx.search('天线阵列').notes);
    await sleep(20);
    reports.save({ date: '2026-09-21', headline: '重写后的日报', projects: [{ name: 'Windose', summary: '改为部署到群晖' }], open: [], plans: [] });
    chk('report rewritten: new words found, old gone', viaIdx.search('部署到群晖').reports.length === 1 && viaIdx.search('代理 群晖').reports.length === 0, viaIdx.search('代理 群晖').reports);
    reports.save({ date: '2026-09-22', headline: '新的一天 kumquat', projects: [], open: [], plans: [] });
    chk('a new report found', viaIdx.search('kumquat').reports.map((x) => x.date).join() === '2026-09-22', viaIdx.search('kumquat').reports);
    arts = arts.map((a) => (a.sha === 'a1' ? { ...a, note: '画天线方向图的脚本' } : a));
    chk('artifact note changed: found by the new note', viaIdx.search('方向图').artifacts.length === 1 && viaIdx.search('对比图').artifacts.length === 0, viaIdx.search('对比图').artifacts);
    arts = arts.filter((a) => a.sha !== 'b2');
    chk('artifact gone: not found', viaIdx.search('网格质量').artifacts.length === 0, viaIdx.search('网格质量').artifacts);
    ms.add(mailRec('a', 3, '会议通知 pomelo', '周五下午开会', '2026-09-27T10:00:00'));
    chk('new mail found right away', viaIdx.search('pomelo').mail.length === 1, viaIdx.search('pomelo').mail);
    ms.removeAccount('a');
    const after = viaIdx.search('报销');
    chk('an account removed: its mail gone, the other mailbox\'s copy still found', after.mail.length === 1 && after.mail[0].acc === 'b' && viaIdx.search('pomelo').mail.length === 0, after.mail);
    // nothing indexed twice after reopening
    index.close();
    const again = idx.open({ dataDir: D });
    const viaAgain = createSearch({ ...base, index: again });
    chk('reopened: same answers, nothing doubled', viaAgain.search('报销').mail.length === 1 && viaAgain.search('kumquat').reports.length === 1 && viaAgain.search('网格').reports.length === 1, viaAgain.search('网格').reports);
    // the index failing: the scan answers
    const broken = { ...again, ready: () => true, docs: { sync() { throw new Error('disk I/O error'); }, tail() {}, find() {} } };
    chk('index failing: reports / notes found by the scan', createSearch({ ...base, index: broken }).search('kumquat').reports.length === 1, 0);
    again.close();
  } catch (e) { res.push('FAIL script ' + e.stack); }
  finally { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} }
  console.log(res.join('\n'));
})();
