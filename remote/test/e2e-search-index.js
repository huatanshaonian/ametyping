// server/search-index.js: build, incremental, rebuild (deleted / damaged / older layout), short Chinese terms, terms
// spread over records, and the same answers as the plain scan through summary/search.js. PERF=1 adds a timing run
// on ~60 MB of made-up conversations.
const fs = require('fs'), path = require('path'), os = require('os');
const { createStore } = require('../server/store');
const idx = require('../server/search-index');   // (first: node:sqlite then loads without its warning)
const { createSearch } = require('../server/summary/search');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x).slice(0, 600)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(20); return f(); };

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-sidx-'));
  try {
    const D = path.join(T, 'data');
    const st = createStore(D);
    const t = (d, h) => Date.parse(`2026-09-${d}T${h}:00:00`);
    let off = {};
    const put = (m, id, recs) => { const from = off[m + id] || 0, to = from + 100; off[m + id] = to; st.accept(m, { id, from, to, recs: recs.map((r, i) => ({ i, ...r })), project: 'p', title: id }); };
    put('pc', 'A', [{ role: 'user', text: '把界面附近的网格加密一下', t: t(10, 10) }, { role: 'assistant', text: '好的，两侧各加 5 层。Mesh refined.', t: t(10, 11), mid: 'm1' },
      { role: 'tool', items: ['运行 python mesh_refine.py'], x: { op: 'cmd', cmd: 'python mesh_refine.py --layers 5' }, t: t(10, 12) }]);
    put('dell 97', 'codex:B', [{ role: 'user', text: '网格收敛怎么验证', t: t(11, 9) }, { role: 'assistant', text: '看 RCS 曲线的变化', t: t(12, 9) }]);
    put('pc', 'C', [{ role: 'user', text: '配置一下代理', t: t(12, 20) }, { role: 'title', text: '不该被搜到的标题', t: t(12, 20) }, { role: 'ctx', text: '1000/200000', t: t(12, 20) }]);
    st.flush();
    const sessions = () => st.sessions();
    const scan = createSearch({ storeDir: D, reports: { list: () => [], get: () => null }, artifacts: null, sessions });
    let index = idx.open({ dataDir: D });
    chk('opened (node:sqlite available)', !!index, 0);
    st.onAppend((f) => index && index.touched(f));
    index.sweep();
    chk('ready after the sweep', await until(() => index.ready()), 0);
    const viaIdx = createSearch({ storeDir: D, reports: { list: () => [], get: () => null }, artifacts: null, sessions, index });
    const ids = (r) => r.sessions.map((s) => s.machine + '|' + s.id).sort().join(',');
    for (const q of ['网格', '网格加密', 'MESH', 'mesh_refine', '--layers 5', '网格 RCS', '代理', '标题', '没有这个词', '5 层', 'p']) {
      const a = scan.search(q, { scope: 'sessions' }), b = viaIdx.search(q, { scope: 'sessions' });
      chk(`same sessions as the scan: "${q}"`, ids(a) === ids(b), { scan: ids(a), index: ids(b) });
    }
    const r1 = viaIdx.search('网格 RCS', { scope: 'sessions' });
    chk('terms in different records of one session: found, with a passage', r1.sessions.length === 1 && r1.sessions[0].id === 'codex:B' && r1.sessions[0].machine === 'dell 97' && /网格/.test(r1.sessions[0].hits[0].snippet), r1);
    const f2 = index.find(['网格'], {});
    chk('2-character Chinese term (LIKE): both sessions', f2.length === 2, f2);
    chk('title and context records are not indexed', !index.find(['不该被搜到']).length && !index.find(['200000']).length, 0);
    // a record holding every term ranks first, even when older
    put('pc', 'D', [{ role: 'user', text: '网格', t: t(20, 1) }, { role: 'assistant', text: '加密', t: t(20, 2) }]); st.flush();
    const r2 = index.find(['网格', '加密'], {});
    chk('incremental: the new session is found right after the store wrote it', r2.some((s) => s.session === 'D'), r2);
    chk('ranking: a record with every term first (A), then the newer spread one (D)', r2[0].session === 'A' && r2[0].all && r2[1].session === 'D' && !r2[1].all, r2.map((s) => [s.session, s.all]));
    // rebuild: deleted
    index.close(); for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(path.join(D, 'search.db' + s)); } catch {}
    index = idx.open({ dataDir: D }); index.sweep(); await until(() => index.ready());
    chk('deleted index: built again with the same answers', index.find(['网格', '加密'], {}).map((s) => s.session).join() === 'A,D', index.find(['网格', '加密'], {}));
    // damaged
    index.close(); for (const s of ['-wal', '-shm']) try { fs.unlinkSync(path.join(D, 'search.db' + s)); } catch {}
    fs.writeFileSync(path.join(D, 'search.db'), 'this is not a database'.repeat(100));
    const logs = []; index = idx.open({ dataDir: D, log: (m) => logs.push(m) }); index && index.sweep(); await until(() => index && index.ready());
    chk('damaged index: set aside as .bad and rebuilt', !!index && fs.existsSync(path.join(D, 'search.db.bad')) && index.find(['mesh'], {}).length === 1 && logs.some((l) => /重建/.test(l)), logs);
    // an older layout
    index.close();
    { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(D, 'search.db')); db.prepare("UPDATE meta SET v = '0' WHERE k = 'version'").run(); db.close(); }
    index = idx.open({ dataDir: D }); index.sweep(); await until(() => index.ready());
    chk('older layout: rebuilt, nothing doubled', index.find(['layers'], {}).length === 1 && index.find(['layers'], { hitsPerSession: 10 })[0].hits.length === 1, index.find(['layers'], { hitsPerSession: 10 }));
    // a file appended to outside the store (a restart in between): the sweep reads on
    fs.appendFileSync(path.join(D, '2026-09-10', 'pc', 'A.jsonl'), JSON.stringify({ role: 'user', text: '重启之间写进来的 zebra77', t: t(10, 13) }) + '\n');
    index.close(); index = idx.open({ dataDir: D }); index.sweep(); await until(() => index.ready());
    chk('reopened: a file that grew meanwhile is read on from where it stood', index.find(['zebra77'], {}).length === 1 && index.find(['网格加密'], { hitsPerSession: 10 })[0].hits.length === 1, index.find(['zebra77'], {}));
    // a session busy on its own: its rows stay one chunk however often it is caught up; two at once: right answers
    const { DatabaseSync } = require('node:sqlite');
    const chunkCount = () => { const db = new DatabaseSync(path.join(D, 'search.db')); const n = db.prepare('SELECT count(*) AS n FROM chunks').get().n; db.close(); return n; };
    const before = chunkCount();
    for (let k = 0; k < 20; k++) { put('pc', 'E', [{ role: 'user', text: '单独忙的会话 第' + k + '句 kiwi' + k, t: t(25, 10) + k * 1000 }]); st.flush(); index.find(['kiwi' + k], {}); }
    chk('one session caught up 20 times: one chunk', chunkCount() - before === 1, chunkCount() - before);
    for (let k = 0; k < 10; k++) {
      put('pc', 'F', [{ role: 'user', text: '交替 F' + k + ' mango', t: t(26, 10) + k * 1000 }]); st.flush(); index.find(['mango'], {});
      put('pc', 'G', [{ role: 'user', text: '交替 G' + k + ' mango papaya', t: t(26, 10) + k * 1000 + 1 }]); st.flush(); index.find(['mango'], {});
    }
    const fg = index.find(['mango'], { hitsPerSession: 20 });
    chk('two sessions written in turns: each finds its own records', fg.length === 2 && fg.every((s) => s.hits.length === 10 && s.hits.every((h) => h.text.includes(s.session === 'F' ? ' F' : ' G'))), fg.map((s) => [s.session, s.hits.length]));
    chk('two terms where only one session has both', index.find(['mango', 'papaya'], {}).map((s) => s.session).join() === 'G', index.find(['mango', 'papaya'], {}));
    // a file written anew (shorter): its old rows go, the new ones are found
    const fE = path.join(D, '2026-09-25', 'pc', 'E.jsonl');
    fs.writeFileSync(fE, JSON.stringify({ role: 'user', text: '重写后的内容 lychee', t: t(25, 11) }) + '\n');
    index.touched(fE);
    chk('a rewritten file: old rows gone, new ones found', !index.find(['kiwi3'], {}).length && index.find(['lychee'], {}).length === 1 && index.find(['mango'], {}).length === 2, [index.find(['kiwi3'], {}), index.find(['lychee'], {})]);
    // not ready yet: the scan answers
    const slow = { ready: () => false, find: () => { throw new Error('should not be asked'); } };
    const viaSlow = createSearch({ storeDir: D, reports: { list: () => [], get: () => null }, artifacts: null, sessions, index: slow });
    chk('index not ready: the scan answers', viaSlow.search('zebra77', { scope: 'sessions' }).sessions.length === 1, 0);
    const broken = { ready: () => true, find: () => { throw new Error('disk I/O error'); } };
    chk('index failing: the scan answers', createSearch({ storeDir: D, reports: { list: () => [], get: () => null }, artifacts: null, sessions, index: broken }).search('zebra77', { scope: 'sessions' }).sessions.length === 1, 0);
    index.close();

    if (process.env.PERF) {
      // a vocabulary like real text: a few very common words, a long tail (Zipf); the words of the queries placed by rank
      const P = path.join(T, 'perf'), CJK = '网格加密收敛曲线天线散射代理配置脚本结果论文图表模型参数电磁仿真求解频率网络数据文件目录函数变量测试部署服务器端口日志错误调试';
      const named = ['的', '网格', 'python', '收敛', 'feko', '散射', '曲线', 'solver'];          // ranks 0, 3, 10, 40, 150, 400, 900, 1500
      const ranks = [0, 3, 10, 40, 150, 400, 900, 1500];
      const vocab = Array.from({ length: 3000 }, (_, i) => (i % 3 ? 'w' + i.toString(36) : CJK[i % CJK.length] + CJK[(i * 7) % CJK.length] + (i > 60 ? i : '')));
      ranks.forEach((r, i) => { vocab[r] = named[i]; });
      const cum = []; let z = 0; for (let i = 0; i < vocab.length; i++) { z += 1 / (i + 1); cum.push(z); }
      const pick = () => { const x = Math.random() * z; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; } return vocab[lo]; };
      const rnd = (n) => Array.from({ length: n }, pick).join(' ');
      let bytes = 0, files = 0;
      for (let d = 0; d < 200; d++) {
        const day = new Date(Date.UTC(2026, 0, 1) + d * 864e5).toISOString().slice(0, 10);
        for (let s = 0; s < 6; s++) {
          const dir = path.join(P, day, 'pc'); fs.mkdirSync(dir, { recursive: true });
          const lines = []; for (let k = 0; k < 120; k++) lines.push(JSON.stringify({ role: k % 2 ? 'assistant' : 'user', text: rnd(40) + (Math.random() < .001 ? ' needle42' : ''), t: Date.parse(day) + k * 6e4 }));
          const body = lines.join('\n') + '\n'; fs.writeFileSync(path.join(dir, `s${d}-${s}.jsonl`), body); bytes += Buffer.byteLength(body); files++;
        }
      }
      let t0 = Date.now(); const pi = idx.open({ dataDir: P }); pi.sweep(); await until(() => pi.ready(), 600000);
      const build = Date.now() - t0, dbSize = fs.statSync(path.join(P, 'search.db')).size;
      const time = (terms) => { const a = Date.now(); const r = pi.find(terms, { maxSessions: 200, hitsPerSession: 1 }); return [Date.now() - a, r.length]; };
      console.log(`PERF ${(bytes / 1e6).toFixed(1)} MB in ${files} files; build ${build} ms; index ${(dbSize / 1e6).toFixed(1)} MB`);
      for (const q of [['needle42'], ['网格'], ['python'], ['收敛'], ['feko'], ['散射'], ['solver'], ['python', 'feko'], ['收敛', '曲线']]) console.log('PERF query', JSON.stringify(q), time(q));
      const sc = createSearch({ storeDir: P, reports: { list: () => [], get: () => null }, artifacts: null, sessions: () => ({}) });
      t0 = Date.now(); sc.search('needle42', { scope: 'sessions' }); console.log('PERF scan (first, reads files)', Date.now() - t0, 'ms');
      t0 = Date.now(); sc.search('needle42', { scope: 'sessions' }); console.log('PERF scan (cached in memory)', Date.now() - t0, 'ms');
      pi.close();
    }
  } catch (e) { res.push('FAIL script ' + e.stack); }
  finally { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} }
  console.log(res.join('\n'));
})();
